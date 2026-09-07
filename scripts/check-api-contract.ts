#!/usr/bin/env node
/**
 * API 契约门禁 —— api-plus 方案中 `test_api_contract.py` 的 TypeScript 等价实现。
 *
 * 五类契约，对应集成场景下的真实故障模式：
 *
 * | 契约 | 防什么 |
 * |---|---|
 * | 导出面可访问 | 声明导出了但运行期 `import` 拿到 `undefined`（改名/循环依赖） |
 * | 符号集一致 | 代码新增/删除了导出，但 Manifest 没重跑 |
 * | 枚举成员不漂移 | 枚举值改了但集成方仍按旧值 switch |
 * | 类型签名可解析 | Manifest 记了签名，实时代码里已无此符号 |
 * | TSDoc 覆盖率 | 集成方打开文档一片空白 |
 *
 * 用法：`npm run api:contract`（退出码非 0 即门禁失败）
 */

import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const MANIFEST = path.join(ROOT, 'docs', 'api_manifest.json');
const INDEX_MODULE = '../src/index.js';

/** 公开符号 TSDoc 覆盖率下限。 */
const DOC_COVERAGE_MIN = 0.7;

interface MemberDoc {
  name: string;
  type: string;
  optional: boolean;
  doc: string;
  value?: string;
}

interface SymbolDoc {
  name: string;
  kind: 'interface' | 'type-alias' | 'enum' | 'class' | 'function' | 'const';
  module: string;
  doc: string;
  signature?: string;
  members?: MemberDoc[];
  unionMembers?: Array<{ value: string; doc: string }>;
  value?: string;
}

/** 纯类型符号：运行期不存在值，跳过运行时存在性检查。 */
const TYPE_ONLY_KINDS = new Set<SymbolDoc['kind']>(['interface', 'type-alias']);

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

/* ---------------------------------------------------------------------------
 * 一、Manifest 与实时代码符号集一致
 * ------------------------------------------------------------------------- */

interface LiveSymbol {
  name: string;
  kind: SymbolDoc['kind'];
  module: string;
  members: string[];
  /** 字符串字面量联合类型的全部取值；非此类类型为空数组。 */
  unionValues: string[];
}

function collectLiveSymbols(): Map<string, LiveSymbol> {
  const program = ts.createProgram([ENTRY], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(ENTRY);
  if (source === undefined) throw new Error(`找不到入口文件：${ENTRY}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`无法解析入口模块符号：${ENTRY}`);

  const result = new Map<string, LiveSymbol>();
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const decl = target.valueDeclaration ?? target.declarations?.[0];
    if (decl === undefined) continue;
    const kind = kindOf(target);
    if (kind === null) continue;
    const members = kind === 'enum' || kind === 'interface' || kind === 'class'
      ? checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target)).map((p) => p.getName())
      : [];
    // 导出名取 symbol（可能是 `export { X as Y }` 的 Y），
    // 种类与定义位置取 target（别名解析后的原始符号）。
    const exportName = symbol.getName();
    result.set(exportName, {
      name: exportName,
      kind,
      module: path.relative(ROOT, decl.getSourceFile().fileName).split(path.sep).join('/'),
      members,
      unionValues: ts.isTypeAliasDeclaration(decl) ? stringLiteralUnionValues(decl.type, checker) : [],
    });
  }
  return result;
}

/** 取字符串字面量联合类型的全部取值；非纯字面量联合返回空数组。 */
function stringLiteralUnionValues(node: ts.TypeNode, checker: ts.TypeChecker): string[] {
  if (!ts.isUnionTypeNode(node)) return [];
  const values: string[] = [];
  for (const member of node.types) {
    const type = checker.getTypeAtLocation(member);
    if (!type.isStringLiteral()) return [];
    values.push(type.value);
  }
  return values;
}

function kindOf(symbol: ts.Symbol): SymbolDoc['kind'] | null {
  if (symbol.flags & ts.SymbolFlags.RegularEnum) return 'enum';
  if (symbol.flags & ts.SymbolFlags.Class) return 'class';
  if (symbol.flags & ts.SymbolFlags.Interface) return 'interface';
  if (symbol.flags & ts.SymbolFlags.TypeAlias) return 'type-alias';
  if (symbol.flags & ts.SymbolFlags.Function) return 'function';
  if (symbol.flags & (ts.SymbolFlags.BlockScopedVariable | ts.SymbolFlags.Variable)) return 'const';
  return null;
}

/* ---------------------------------------------------------------------------
 * 二、运行期可访问性
 * ------------------------------------------------------------------------- */

async function loadRuntimeModule(): Promise<Record<string, unknown>> {
  try {
    return (await import(INDEX_MODULE)) as Record<string, unknown>;
  } catch (error) {
    fail(`无法加载入口模块 ${INDEX_MODULE}：${String(error)}`);
    return {};
  }
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

async function main(): Promise<void> {
  if (!fs.existsSync(MANIFEST)) {
    fail(`找不到 Manifest：${MANIFEST}，请先运行 npm run api:docs`);
    report();
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as {
    symbolCount: number;
    symbols: SymbolDoc[];
  };
  const live = collectLiveSymbols();
  const runtime = await loadRuntimeModule();

  // 1. 符号集一致（双向）
  const manifestNames = new Set(manifest.symbols.map((s) => s.name));
  for (const name of live.keys()) {
    if (!manifestNames.has(name)) fail(`代码已导出 \`${name}\`，但 Manifest 未记录 —— 请重跑 npm run api:docs`);
  }
  for (const sym of manifest.symbols) {
    const liveSym = live.get(sym.name);
    if (liveSym === undefined) {
      fail(`Manifest 记录了 \`${sym.name}\`，但代码中已不存在`);
      continue;
    }
    if (liveSym.kind !== sym.kind) fail(`\`${sym.name}\` 种类漂移：Manifest=${sym.kind} 实际=${liveSym.kind}`);
    if (liveSym.module !== sym.module) fail(`\`${sym.name}\` 定义模块漂移：Manifest=${sym.module} 实际=${liveSym.module}`);
  }

  // 2. 运行期可访问（值类符号）
  for (const sym of manifest.symbols) {
    if (TYPE_ONLY_KINDS.has(sym.kind)) continue;
    if (runtime[sym.name] === undefined) fail(`导出面声明了 \`${sym.name}\`，但运行期取不到值`);
  }

  // 3. 枚举成员与字面量联合不漂移
  for (const sym of manifest.symbols) {
    const liveSym = live.get(sym.name);
    if (liveSym === undefined) continue;
    if (sym.kind === 'enum' && sym.members !== undefined) {
      const liveSet = new Set(liveSym.members);
      const docSet = new Set(sym.members.map((m) => m.name));
      for (const m of liveSet) if (!docSet.has(m)) fail(`枚举 \`${sym.name}\` 新增成员 \`${m}\`，Manifest 未同步`);
      for (const m of docSet) if (!liveSet.has(m)) fail(`枚举 \`${sym.name}\` 的 Manifest 成员 \`${m}\` 在代码中不存在`);
    }
    if (sym.kind === 'type-alias' && sym.unionMembers !== undefined) {
      const liveValues = new Set(liveSym.unionValues);
      const docValues = new Set(sym.unionMembers.map((m) => m.value));
      for (const v of liveValues) if (!docValues.has(v)) fail(`联合类型 \`${sym.name}\` 新增取值 \`"${v}"\`，Manifest 未同步`);
      for (const v of docValues) if (!liveValues.has(v)) fail(`联合类型 \`${sym.name}\` 的 Manifest 取值 \`"${v}"\` 在代码中不存在`);
    }
  }

  // 4. TSDoc 覆盖率
  const documented = manifest.symbols.filter((s) => s.doc.trim().length > 0).length;
  const coverage = manifest.symbols.length === 0 ? 1 : documented / manifest.symbols.length;
  if (coverage < DOC_COVERAGE_MIN) {
    fail(`公开符号 TSDoc 覆盖率 ${(coverage * 100).toFixed(1)}% 低于下限 ${(DOC_COVERAGE_MIN * 100).toFixed(0)}%`);
  }

  process.stdout.write(`已校验 ${manifest.symbols.length} 个公开符号，TSDoc 覆盖率 ${(coverage * 100).toFixed(1)}%\n`);
  report();
}

// 联合类型的取值漂移改由编译期 AST 比对（stringLiteralUnionValues），
// 不再依赖运行期常量，避免「取不到就静默跳过」的假通过。

function report(): void {
  if (failures.length === 0) {
    process.stdout.write('API 契约门禁通过\n');
    return;
  }
  process.stderr.write(`API 契约门禁失败，共 ${failures.length} 项：\n`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}

void main();
