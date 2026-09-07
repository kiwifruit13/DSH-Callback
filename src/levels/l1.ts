/**
 * L1 抽取式去噪。
 *
 * 铁律一约束下，L1 是唯一被强制「输出 ⊆ 输入」的级别：
 * 逐行判定去留，保留的每一行都来自原文，因此天然满足子集性质。
 *
 * 四条规则（`level-sinking` 的 Scenario Outline 逐项锁定）：
 * | 规则名             | 行为 |
 * |---|---|
 * | duplicate-read     | 同一文件的重复读取输出只保留最新一次 |
 * | oversized-stdout   | 超长工具 stdout 只保留首尾若干行 |
 * | repeated-failure   | 连续多次且文本相同的失败输出只保留一条 |
 * | superseded-result  | 已被后续成功结果取代的中间结果删除 |
 *
 * 另有一条反向约束：被后续轮次显式引用的输出不裁剪（referenced-later）。
 */

import type { CompressConfig } from '../config.js';
import type { Message } from '../contract.js';
import { KW_ERROR, matchAll, RE_HASH, RE_POSIX_PATH, RE_URL, RE_UUID, RE_WINDOWS_PATH } from '../patterns.js';

export interface L1Result {
  /** 去噪后的文本（原文行的子集，保持原始顺序）。 */
  readonly text: string;
  /** 命中的规则名，按处理顺序去重排列。 */
  readonly appliedRules: readonly string[];
}

interface WorkRow {
  msgIndex: number;
  line: string;
  /** 该行是否被保留。 */
  keep: boolean;
  /** 命中的规则名；未命中为 null。 */
  rule: string | null;
}

/** 提取输出内容里的可定位指纹：首个路径 / URL / UUID / 哈希 / 命令。 */
function fingerprint(text: string): string | null {
  const patterns = [RE_URL, RE_WINDOWS_PATH, RE_UUID, RE_POSIX_PATH, RE_HASH];
  for (const pattern of patterns) {
    const m = matchAll(text, pattern);
    if (m.length > 0) return m[0]!.value;
  }
  return null;
}

/** 是否为错误输出。 */
function isError(text: string): boolean {
  return KW_ERROR.some((kw) => text.includes(kw));
}

/** 后续 assistant / user 消息文本（用于 referenced-later 检测）。
 *  只认 user / assistant 的显式引用：后续 tool result 天然复用同一指纹
 *  （如重复读同一文件），不能算作「引用」，否则 duplicate-read 永远无法生效。 */
function laterText(msgs: readonly Message[], fromIndex: number): string {
  return msgs
    .slice(fromIndex + 1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => m.content)
    .join('\n');
}

/** 单条消息的行是否被后续消息引用（包含该行提取的指纹即视为引用）。 */
function referencedLater(row: WorkRow, msgs: readonly Message[]): boolean {
  if (row.msgIndex >= msgs.length - 1) return false;
  const fp = fingerprint(row.line);
  if (fp === null || fp.length < 4) return false;
  return laterText(msgs, row.msgIndex).includes(fp);
}

/**
 * 对一个段的原始消息序列执行 L1 去噪。
 * 输出的每一行都可在输入中逐字定位；规则命中记录仅供报告与契约断言使用。
 */
export function l1Denoise(msgs: readonly Message[], config: CompressConfig): L1Result {
  const rules: string[] = [];
  const note = (rule: string): void => {
    if (!rules.includes(rule)) rules.push(rule);
  };

  // 展开为行工作集，行保持消息内的原始顺序
  const rows: WorkRow[] = [];
  msgs.forEach((msg, msgIndex) => {
    for (const line of msg.content.split('\n')) {
      rows.push({ msgIndex, line, keep: true, rule: null });
    }
  });

  // —— 规则 4：superseded-result —— 同一操作的失败结果被后续成功取代
  // 先于 duplicate-read 执行：失败→成功共享同一指纹时，语义上是「被取代」而非「重复读取」
  const successSeen = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const msg = msgs[row.msgIndex];
    if (msg?.role !== 'tool') continue;
    const fp = fingerprint(row.line);
    if (fp === null) continue;
    if (!isError(row.line)) {
      successSeen.add(fp);
      continue;
    }
    if (successSeen.has(fp) && row.keep) {
      // referenced-later 全规则覆盖（P2-7）：被后续显式引用的输出不裁剪
      if (referencedLater(row, msgs)) {
        row.rule = 'referenced-later';
        continue;
      }
      row.keep = false;
      row.rule = 'superseded-result';
    }
  }
  if (rows.some((r) => r.rule === 'superseded-result')) note('superseded-result');

  // —— 规则 1：duplicate-read —— 同一指纹的重复输出保留最新一次
  const byFp = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const fp = fingerprint(row.line);
    if (fp !== null && fp.length >= 4) {
      const list = byFp.get(fp) ?? [];
      list.push(i);
      byFp.set(fp, list);
    }
  });
  for (const indices of byFp.values()) {
    if (indices.length < 2) continue;
    // 消息级语义（P2-7）：契约粒度是「同一文件的重复读取输出只保留最新一次」，
    // 输出 = 消息。同一条消息内的多行是同一次输出，互不为重复；
    // 只在跨消息时去重 —— 保留最新消息的全部行，删除较早消息中的行。
    const msgIndices = new Set(indices.map((i) => rows[i]!.msgIndex));
    if (msgIndices.size < 2) continue;
    const latestMsgIndex = Math.max(...msgIndices);
    for (const i of indices) {
      const row = rows[i]!;
      if (row.msgIndex === latestMsgIndex) continue;
      if (!row.keep) continue; // 已被更高优先级规则（superseded-result）处置
      if (referencedLater(row, msgs)) {
        row.rule = 'referenced-later';
        continue;
      }
      row.keep = false;
      row.rule = 'duplicate-read';
    }
  }
  if (rows.some((r) => r.rule === 'duplicate-read')) note('duplicate-read');

  // —— 规则 2：oversized-stdout —— 超长输出保留首尾
  const msgLineCount = new Map<number, number>();
  for (const row of rows) {
    if (msgs[row.msgIndex]?.role !== 'tool') continue;
    msgLineCount.set(row.msgIndex, (msgLineCount.get(row.msgIndex) ?? 0) + 1);
  }
  for (const [msgIndex, lineCount] of msgLineCount) {
    if (lineCount <= config.l1OversizeLines) continue;
    const indices = rows.map((r, i) => (r.msgIndex === msgIndex ? i : -1)).filter((i) => i >= 0);
    const head = indices.slice(0, config.l1EdgeKeepLines);
    const tail = indices.slice(-config.l1EdgeKeepLines);
    for (const i of indices) {
      const row = rows[i]!;
      if (head.includes(i) || tail.includes(i)) continue;
      if (referencedLater(row, msgs)) {
        row.rule = 'referenced-later';
        continue;
      }
      row.keep = false;
      row.rule = 'oversized-stdout';
    }
  }
  if (rows.some((r) => r.rule === 'oversized-stdout')) note('oversized-stdout');

  // —— 规则 3：repeated-failure —— 连续相同错误文本只留一条
  // 连续性按 tool 消息判定：中间的 assistant 调度消息（「重试」「再跑」）不打断连续失败序列
  let run: number[] = [];
  let runText = '';
  const flushRun = (): void => {
    if (run.length >= 2) {
      const last = run[run.length - 1]!;
      for (const i of run) {
        if (i === last) continue;
        const row = rows[i]!;
        // referenced-later 全规则覆盖（P2-7）：重复失败行若被后续显式引用同样不裁剪
        if (referencedLater(row, msgs)) {
          row.rule = 'referenced-later';
          continue;
        }
        row.keep = false;
        row.rule = 'repeated-failure';
      }
    }
    run = [];
    runText = '';
  };
  rows.forEach((row, i) => {
    const msg = msgs[row.msgIndex];
    if (msg?.role !== 'tool') return; // 非 tool 行不参与，也不打断连续性
    const isFailure = isError(row.line) && row.keep;
    if (isFailure && row.line === runText) {
      run.push(i);
      return;
    }
    flushRun();
    if (isFailure) {
      run = [i];
      runText = row.line;
    }
  });
  flushRun();
  if (rows.some((r) => r.rule === 'repeated-failure')) note('repeated-failure');

  if (rows.some((r) => r.rule === 'referenced-later')) note('referenced-later');

  const kept = rows.filter((r) => r.keep);
  const text = kept.map((r) => r.line).join('\n');
  return { text, appliedRules: rules };
}
