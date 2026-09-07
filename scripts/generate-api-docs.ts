#!/usr/bin/env node
/**
 * API 文档生成器 —— api-plus 方案的 TypeScript 等价实现。
 *
 * 三阶段流水线，中间产物为 API Manifest：
 *
 * ```
 * src/index.ts（导出面）
 *   │ 阶段一 扫描：TypeScript 编译器 API 建 Program，取模块全部导出符号
 *   ▼
 * 符号表
 *   │ 阶段二 提取：解析 alias 到定义处，按种类反射提取（doc / 成员 / 签名 / 枚举值）
 *   ▼
 * API Manifest（唯一中间表示）
 *   │ 阶段三 渲染：四个渲染器消费同一份 Manifest
 *   ▼
 * api_reference.md + api_class_reference.md + api_enums.md + api_manifest.json
 * ```
 *
 * 输出**字节级确定**：无时间戳、无绝对路径、迭代显式排序。
 * 因此 `git diff --exit-code docs/` 可稳定用作门禁。
 *
 * 用法：
 * ```bash
 * node --import tsx scripts/generate-api-docs.ts              # 生成
 * node --import tsx scripts/generate-api-docs.ts --check      # 只比对不写入，漂移则退出码 1
 * ```
 */

import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const OUT_DIR = path.join(ROOT, 'docs');
const PACKAGE_NAME = 'dsh-callback';

/* ============================================================================
 * Manifest 数据结构
 * ========================================================================== */

type SymbolKind = 'interface' | 'type-alias' | 'enum' | 'class' | 'function' | 'const';

interface MemberDoc {
  name: string;
  type: string;
  optional: boolean;
  doc: string;
  /** 枚举成员或字面量取值。 */
  value?: string;
}

interface UnionMemberDoc {
  value: string;
  doc: string;
}

interface SymbolDoc {
  name: string;
  kind: SymbolKind;
  /** 定义所在模块（相对仓库根的路径，POSIX 分隔符）。 */
  module: string;
  doc: string;
  /** 类型别名/常量的类型文本，或函数的签名。 */
  signature?: string;
  /** 接口/类的成员。 */
  members?: MemberDoc[];
  /** 字符串字面量联合类型的取值，含各自的前导注释说明。 */
  unionMembers?: UnionMemberDoc[];
  /** 常量的值文本。 */
  value?: string;
}

interface ApiManifest {
  package: string;
  entry: string;
  symbolCount: number;
  symbols: SymbolDoc[];
}

/* ============================================================================
 * 阶段一：扫描
 * ========================================================================== */

function createProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const program = ts.createProgram([ENTRY], options);
  return { program, checker: program.getTypeChecker() };
}

function collectExportedSymbols(checker: ts.TypeChecker, entry: ts.SourceFile): ts.Symbol[] {
  const moduleSymbol = checker.getSymbolAtLocation(entry);
  if (moduleSymbol === undefined) {
    throw new Error(`无法解析入口模块符号：${ENTRY}`);
  }
  return checker.getExportsOfModule(moduleSymbol);
}

/* ============================================================================
 * 阶段二：提取
 * ========================================================================== */

function resolveTarget(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function relativeModule(fileName: string): string {
  return path.relative(ROOT, fileName).split(path.sep).join('/');
}

function docOf(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const parts = symbol.getDocumentationComment(checker);
  const text = ts.displayPartsToString(parts).trim();
  // 只取首段作为速查表说明，避免表格被长文档撑爆
  const firstParagraph = text.split(/\n\s*\n/)[0] ?? '';
  return firstParagraph.replace(/\s+/g, ' ').trim();
}

function kindOf(symbol: ts.Symbol): SymbolKind | null {
  if (symbol.flags & ts.SymbolFlags.RegularEnum) return 'enum';
  if (symbol.flags & ts.SymbolFlags.Class) return 'class';
  if (symbol.flags & ts.SymbolFlags.Interface) return 'interface';
  if (symbol.flags & ts.SymbolFlags.TypeAlias) return 'type-alias';
  if (symbol.flags & ts.SymbolFlags.Function) return 'function';
  if (symbol.flags & (ts.SymbolFlags.BlockScopedVariable | ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) return 'const';
  return null;
}

/**
 * 取字符串字面量联合类型的取值列表，并保留每个取值前的 TSDoc 注释。
 * 非联合类型（或含非字面量成员）返回 null。
 *
 * 注释必须走 `getLeadingCommentRanges` 手工取：`type.getText()` 不含前导 trivia。
 */
function unionLiteralMembers(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  sourceText: string,
): UnionMemberDoc[] | null {
  if (!ts.isUnionTypeNode(node)) return null;
  // slice(node.pos, node.end) 而非 getText()：前者保留前导 trivia，内部注释才不丢
  const fullText = sourceText.slice(node.pos, node.end);
  const values: UnionMemberDoc[] = [];
  for (const member of node.types) {
    const type = checker.getTypeAtLocation(member);
    if (!type.isStringLiteral()) return null;
    values.push({ value: type.value, doc: docForLiteral(fullText, type.value) });
  }
  return values.length > 0 ? values : null;
}

/**
 * 在联合类型的完整文本里，反查某个字面量取值前的 TSDoc 注释，压成单行。
 * 注释写在 `|` 之前（`/** … *\/` + 换行 + `| 'value'`），因此只能文本匹配，
 * 不属于 member 节点的前导 trivia。
 */
function docForLiteral(fullText: string, value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 注释体禁止跨越 `*/`，否则非贪婪也会一路吃到前一个注释
  const pattern = new RegExp(`\\/\\*\\*((?:[^*]|\\*(?!\\/))*)\\*\\/\\s*\\|\\s*['"]${escaped}['"]`);
  const match = pattern.exec(fullText);
  if (match === null || match[1] === undefined) return '';
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*+\s?/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

function propertyMembers(symbol: ts.Symbol, checker: ts.TypeChecker, decl: ts.Declaration): MemberDoc[] {
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  const props = checker.getPropertiesOfType(type);
  const members: MemberDoc[] = [];
  for (const prop of props) {
    const propDecl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (propDecl === undefined) continue;
    members.push({
      name: prop.getName(),
      type: checker.typeToString(checker.getTypeOfSymbolAtLocation(prop, propDecl)),
      optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
      doc: docOf(prop, checker),
      ...(propDecl !== undefined && ts.isEnumMember(propDecl)
        ? { value: propDecl.initializer?.getText().replace(/^['"]|['"]$/g, '') ?? prop.getName() }
        : {}),
    });
  }
  void decl;
  return members;
}

function extractSymbol(exportName: string, symbol: ts.Symbol, checker: ts.TypeChecker): SymbolDoc | null {
  const target = resolveTarget(symbol, checker);
  const decl = target.valueDeclaration ?? target.declarations?.[0];
  if (decl === undefined) return null;

  const kind = kindOf(target);
  if (kind === null) return null;

  const base: SymbolDoc = {
    name: exportName,
    kind,
    module: relativeModule(decl.getSourceFile().fileName),
    doc: docOf(target, checker),
  };

  const sourceText = decl.getSourceFile().getFullText();

  // 类型别名：取类型文本 + 字面量联合取值
  if (ts.isTypeAliasDeclaration(decl)) {
    const union = unionLiteralMembers(decl.type, checker, sourceText);
    return {
      ...base,
      signature: decl.type.getText(),
      ...(union !== null ? { unionMembers: union } : {}),
    };
  }

  // 接口 / 类 / 枚举：取成员
  if (
    ts.isInterfaceDeclaration(decl) ||
    ts.isClassDeclaration(decl) ||
    ts.isEnumDeclaration(decl)
  ) {
    if (ts.isEnumDeclaration(decl)) {
      return { ...base, members: propertyMembers(target, checker, decl) };
    }
    return {
      ...base,
      signature: signatureOf(decl, checker, target),
      members: propertyMembers(target, checker, decl),
    };
  }

  // 变量常量
  if (ts.isVariableDeclaration(decl)) {
    return {
      ...base,
      signature: decl.type !== undefined ? decl.type.getText() : checker.typeToString(checker.getTypeOfSymbolAtLocation(target, decl)),
      ...(decl.initializer !== undefined ? { value: truncate(decl.initializer.getText()) } : {}),
    };
  }

  // 函数
  if (ts.isFunctionDeclaration(decl)) {
    return { ...base, signature: signatureOf(decl, checker, target) };
  }

  return base;
}

function signatureOf(decl: ts.Declaration, checker: ts.TypeChecker, symbol: ts.Symbol): string {
  if (ts.isClassDeclaration(decl) && decl.name !== undefined) {
    const ctor = decl.members.find((m) => ts.isConstructorDeclaration(m));
    if (ctor !== undefined) {
      const sig = checker.getSignatureFromDeclaration(ctor as ts.ConstructorDeclaration);
      if (sig !== undefined) return `new ${checker.signatureToString(sig)}`;
    }
    return `class ${decl.name.getText()}`;
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
  const sigs = type.getCallSignatures();
  if (sigs.length > 0) return checker.signatureToString(sigs[0]!);
  return decl.getText().split('\n')[0] ?? '';
}

function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/* ============================================================================
 * 阶段三：渲染
 * ========================================================================== */

const AUTO_HEADER = `> 本文档由 \`scripts/generate-api-docs.ts\` 自动生成，以代码为唯一真相源。
> 人工修改会被下次生成覆盖。若需更新 API 描述，请修改源码 TSDoc 后重新生成。`;

const KIND_LABEL: Record<SymbolKind, string> = {
  interface: '接口',
  'type-alias': '类型别名',
  enum: '枚举',
  class: '类',
  function: '函数',
  const: '常量',
};

function renderReference(manifest: ApiManifest): string {
  const byModule = groupByModule(manifest.symbols);
  const lines: string[] = [
    `# ${PACKAGE_NAME} API 参考`,
    '',
    AUTO_HEADER,
    '',
    `共 ${manifest.symbolCount} 个公开符号，入口 \`${manifest.entry}\`。`,
    '',
  ];

  for (const [module, symbols] of byModule) {
    lines.push(`## ${module}`, '');
    for (const sym of symbols) {
      lines.push(`### \`${sym.name}\``, '');
      lines.push(`**种类**：${KIND_LABEL[sym.kind]} · **定义模块**：\`${sym.module}\``, '');
      if (sym.doc.length > 0) lines.push(sym.doc, '');
      if (sym.signature !== undefined && sym.signature.length > 0) {
        lines.push('```ts', sym.signature, '```', '');
      }
      if (sym.value !== undefined) lines.push(`**值**：\`${sym.value}\``, '');
      if (sym.unionMembers !== undefined && sym.unionMembers.length > 0) {
        lines.push('**取值**：', '');
        for (const v of sym.unionMembers) {
          lines.push(v.doc.length > 0 ? `- \`"${v.value}"\` — ${v.doc}` : `- \`"${v.value}"\``);
        }
        lines.push('');
      }
      if (sym.members !== undefined && sym.members.length > 0) {
        lines.push('| 成员 | 类型 | 可选 | 说明 |', '|---|---|---|---|');
        for (const m of sym.members) {
          lines.push(`| \`${m.name}\` | \`${escapeCell(m.type)}\` | ${m.optional ? '是' : '否'} | ${escapeCell(m.doc)} |`);
        }
        lines.push('');
      }
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function renderClassIndex(manifest: ApiManifest): string {
  const lines: string[] = [
    `# ${PACKAGE_NAME} 符号速查表`,
    '',
    AUTO_HEADER,
    '',
    '| 符号 | 种类 | 定义模块 | 说明 |',
    '|---|---|---|---|',
  ];
  for (const sym of manifest.symbols) {
    lines.push(`| \`${sym.name}\` | ${KIND_LABEL[sym.kind]} | \`${sym.module}\` | ${escapeCell(oneLine(sym.doc))} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderEnums(manifest: ApiManifest): string {
  const enumLike = manifest.symbols.filter(
    (s) => s.kind === 'enum' || (s.unionMembers !== undefined && s.unionMembers.length > 0),
  );
  const lines: string[] = [
    `# ${PACKAGE_NAME} 枚举与字面量联合汇总`,
    '',
    AUTO_HEADER,
    '',
  ];
  for (const sym of enumLike) {
    lines.push(`## \`${sym.name}\``, '');
    lines.push(`**定义模块**：\`${sym.module}\``, '');
    if (sym.doc.length > 0) lines.push(sym.doc, '');
    if (sym.kind === 'enum' && sym.members !== undefined) {
      lines.push('| 成员 | 值 |', '|---|---|');
      for (const m of sym.members) lines.push(`| \`${m.name}\` | \`${m.value ?? m.name}\` |`);
    } else if (sym.unionMembers !== undefined) {
      lines.push('| 取值 | 说明 |', '|---|---|');
      for (const v of sym.unionMembers) lines.push(`| \`"${v.value}"\` | ${escapeCell(v.doc)} |`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd().concat('\n');
}

function renderManifest(manifest: ApiManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
function groupByModule(symbols: SymbolDoc[]): Array<[string, SymbolDoc[]]> {
  const map = new Map<string, SymbolDoc[]>();
  for (const sym of symbols) {
    const list = map.get(sym.module);
    if (list === undefined) map.set(sym.module, [sym]);
    else list.push(sym);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function escapeCell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/* ============================================================================
 * 主流程
 * ========================================================================== */

function main(): void {
  const checkOnly = process.argv.includes('--check');

  const { program, checker } = createProgram();
  const entrySource = program.getSourceFile(ENTRY);
  if (entrySource === undefined) {
    throw new Error(`找不到入口文件：${ENTRY}`);
  }

  const diagnostics = ts.getPreEmitDiagnostics(program).filter(
    (d) => d.file !== undefined && !d.file.fileName.includes('node_modules'),
  );
  if (diagnostics.length > 0) {
    const text = ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    });
    throw new Error(`源码存在类型错误，拒绝生成文档：\n${text}`);
  }

  const symbols: SymbolDoc[] = [];
  for (const symbol of collectExportedSymbols(checker, entrySource)) {
    const doc = extractSymbol(symbol.getName(), symbol, checker);
    if (doc !== null) symbols.push(doc);
  }
  symbols.sort((a, b) => a.name.localeCompare(b.name));

  const manifest: ApiManifest = {
    package: PACKAGE_NAME,
    entry: 'src/index.ts',
    symbolCount: symbols.length,
    symbols,
  };

  const outputs: Array<[string, string]> = [
    ['api_reference.md', renderReference(manifest)],
    ['api_class_reference.md', renderClassIndex(manifest)],
    ['api_enums.md', renderEnums(manifest)],
    ['api_manifest.json', renderManifest(manifest)],
  ];

  if (checkOnly) {
    const drifted: string[] = [];
    for (const [name, content] of outputs) {
      const file = path.join(OUT_DIR, name);
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (existing !== content) drifted.push(name);
    }
    if (drifted.length > 0) {
      process.stderr.write(`API 文档已漂移，请运行 npm run api:docs 重新生成：${drifted.join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`API 文档无漂移（${outputs.length} 份产物，${manifest.symbolCount} 个符号）\n`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of outputs) {
    fs.writeFileSync(path.join(OUT_DIR, name), content, 'utf8');
  }
  process.stdout.write(`已生成 ${outputs.length} 份产物到 docs/，共 ${manifest.symbolCount} 个公开符号\n`);
}

main();
