/**
 * 不可压缩区（pin）的识别与合并。
 *
 * 契约要求：
 * - 每条 pin 必须携带非空 `pin_reason`，且取值属于 {@link PinReason} 枚举；
 * - 同一条消息命中多个信号时**只产生一条** pin，reason 取优先级更高者；
 * - 局部 pin：只保护含关键信息的字符区间（span），span 之外的内容仍可下沉；
 * - `onPreCompress` 抛异常时**不中断**，退回静态白名单并记 pin_hook_degraded 告警；
 * - 铁律三的 `tool-block-incomplete` pin 是强制项，不因用户钩子返回空而丢失。
 */

import type { CompressConfig } from './config.js';
import type { ContextState, Message, PinRecord, PinReason } from './contract.js';
import { PIN_REASON_PRIORITY } from './contract.js';
import { isBlockCompressible } from './blocks.js';
import {
  KW_CONSTRAINT,
  KW_ERROR,
  KW_PERMISSION,
  KW_REMEMBER,
  RE_COMMAND,
  RE_POSIX_PATH,
  RE_TODO_PENDING,
  RE_URL,
  RE_WINDOWS_PATH,
  hasKeyword,
  matchAll,
} from './patterns.js';

/** 压缩块呈现消息的 id 前缀（与 orchestrator.blockToMessage 一致）。 */
const BLOCK_MSG_PREFIX = 'cb-';

/** pin 解析结果。 */
export interface PinResolveResult {
  readonly pins: readonly PinRecord[];
  /** 是否因 onPreCompress 抛异常而退化为静态白名单。 */
  readonly degraded: boolean;
}

/** 取命中位置所在行的字符区间，作为局部 pin 的 span。 */
function lineSpanOf(text: string, index: number): readonly [number, number] {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const newline = text.indexOf('\n', index);
  const end = newline === -1 ? text.length : newline;
  return [start, end];
}

function pinOf(msg: Message, reason: PinReason, span?: readonly [number, number]): PinRecord {
  if (span === undefined) return { msgId: msg.id, reason, text: msg.content };
  return { msgId: msg.id, span, reason, text: msg.content.slice(span[0], span[1]) };
}

/** 找出文本中首个路径（Windows 优先，其次 POSIX），返回其区间。 */
function firstPathSpan(text: string): readonly [number, number] | null {
  const windows = matchAll(text, RE_WINDOWS_PATH);
  if (windows.length > 0) return [windows[0]!.start, windows[0]!.end];
  const posix = matchAll(text, RE_POSIX_PATH);
  if (posix.length > 0) return [posix[0]!.start, posix[0]!.end];
  return null;
}

/**
 * 静态白名单识别。覆盖八种 reason 中除 `tool-block-incomplete` 之外的全部情形。
 * 顺序无关，最终由 {@link dedupePins} 按优先级收敛。
 *
 * 压缩块呈现消息（id 以 `cb-` 开头的纯文本 user 消息）是系统产物而非用户输入，
 * 不参与任何静态识别 —— 否则再下沉替换它时会触发 pin-in-place 回滚死循环。
 */
export function identifyStaticPins(state: ContextState): PinRecord[] {
  const hits: PinRecord[] = [];
  const { msgs } = state;

  // 用户最新一轮的原始需求（同样排除压缩块呈现消息）
  let latestUser: Message | null = null;
  for (const msg of msgs) {
    if (msg.role === 'user' && !msg.id.startsWith(BLOCK_MSG_PREFIX)) latestUser = msg;
  }

  for (const msg of msgs) {
    if (msg.id.startsWith(BLOCK_MSG_PREFIX)) continue;

    if (msg.role === 'system') {
      hits.push(pinOf(msg, 'system-prompt'));
      continue;
    }

    if (latestUser !== null && msg.id === latestUser.id) {
      hits.push(pinOf(msg, 'latest-user-intent'));
    }

    const content = msg.content;
    if (content.length === 0) continue;

    // 用户硬约束：必须 / 不要 / 原地 / 禁止 …
    if (msg.role === 'user' && hasKeyword(content, KW_CONSTRAINT)) {
      const index = content.search(new RegExp(KW_CONSTRAINT.map(escapeLiteral).join('|')));
      hits.push(pinOf(msg, 'user-constraint', lineSpanOf(content, index < 0 ? 0 : index)));
    }

    // 交付物路径：只 pin 路径本身所在的字符区间
    const pathSpan = firstPathSpan(content);
    if (pathSpan !== null) {
      hits.push(pinOf(msg, 'deliverable-path', pathSpan));
    }

    // 命令与符号：整行保护
    const commands = matchAll(content, RE_COMMAND);
    if (commands.length > 0) {
      hits.push(pinOf(msg, 'deliverable-path', lineSpanOf(content, commands[0]!.start)));
    }

    // URL
    const urls = matchAll(content, RE_URL);
    if (urls.length > 0) {
      hits.push(pinOf(msg, 'deliverable-path', lineSpanOf(content, urls[0]!.start)));
    }

    // 权限确认
    if (hasKeyword(content, KW_PERMISSION)) {
      const index = content.search(new RegExp(KW_PERMISSION.map(escapeLiteral).join('|')));
      hits.push(pinOf(msg, 'permission-grant', lineSpanOf(content, index < 0 ? 0 : index)));
    }

    // 持久性要求
    if (msg.role === 'user' && hasKeyword(content, KW_REMEMBER)) {
      const index = content.search(new RegExp(KW_REMEMBER.map(escapeLiteral).join('|')));
      hits.push(pinOf(msg, 'user-remember', lineSpanOf(content, index < 0 ? 0 : index)));
    }

    // 未完成待办：逐条 pin 所在行；已完成待办不 pin，允许下沉至 L2 的 todos 槽位。
    // 同一消息混合 pending 与 done 时，pending 行仍必须被保护。
    for (const m of matchAll(content, RE_TODO_PENDING)) {
      hits.push(pinOf(msg, 'open-todo', lineSpanOf(content, m.start)));
    }

    // 关键报错
    if (hasKeyword(content, KW_ERROR)) {
      const index = content.search(new RegExp(KW_ERROR.map(escapeLiteral).join('|')));
      hits.push(pinOf(msg, 'error-critical', lineSpanOf(content, index < 0 ? 0 : index)));
    }
  }

  return hits;
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 铁律三强制 pin：不完整或畸形的 tool block 在任何级别都不参与压缩。
 * 这些 pin 是强制项，优先级最高，不随用户钩子的返回值变化。
 */
export function identifyIncompleteBlockPins(state: ContextState): PinRecord[] {
  const byId = new Map(state.msgs.map((m) => [m.id, m]));
  const pins: PinRecord[] = [];
  for (const block of state.blocks) {
    if (isBlockCompressible(block)) continue;
    for (const msgId of block.msgIds) {
      const msg = byId.get(msgId);
      if (msg === undefined) continue;
      pins.push(pinOf(msg, 'tool-block-incomplete'));
    }
  }
  return pins;
}

/** reason 优先级序号，越小越高。未知 reason 排最后。 */
function priorityOf(reason: PinReason): number {
  const index = PIN_REASON_PRIORITY.indexOf(reason);
  return index === -1 ? PIN_REASON_PRIORITY.length : index;
}

/**
 * 合并去重：同一条消息只保留一条 pin，reason 取优先级最高者。
 * 局部 pin（带 span）优先于整条 pin，避免为图省事把整条长消息锁死。
 */
export function dedupePins(hits: readonly PinRecord[]): PinRecord[] {
  const best = new Map<string, PinRecord>();
  for (const hit of hits) {
    const existing = best.get(hit.msgId);
    if (existing === undefined) {
      best.set(hit.msgId, hit);
      continue;
    }
    const better =
      priorityOf(hit.reason) < priorityOf(existing.reason) ||
      (priorityOf(hit.reason) === priorityOf(existing.reason) && hit.span !== undefined && existing.span === undefined);
    if (better) best.set(hit.msgId, hit);
  }
  return [...best.values()];
}

/**
 * 生成本轮全部 pin。
 *
 * 用户钩子 {@link import('./callbacks.js').CompressCallbacks.onPreCompress} 抛异常时：
 * 不中断压缩，退回静态白名单，并记 pin_hook_degraded 告警。
 */
export function resolvePins(
  state: ContextState,
  config: CompressConfig,
  hook?: (state: ContextState, config: CompressConfig) => readonly PinRecord[],
): PinResolveResult {
  const forced = identifyIncompleteBlockPins(state);
  const staticPins = identifyStaticPins(state);

  let userPins: readonly PinRecord[] = [];
  let degraded = false;

  if (hook !== undefined) {
    try {
      userPins = hook(state, config) ?? [];
    } catch (error) {
      degraded = true;
      config.onWarning?.('pin_hook_degraded', { error: String(error) });
      config.onWarning?.('pin_hook_degraded_fallback', { strategy: 'static-whitelist' });
    }
  }

  // 强制 pin 放最后进 dedupe：它的优先级最高，同 msgId 下会胜出
  return { pins: dedupePins([...userPins, ...staticPins, ...forced]), degraded };
}

/** 该消息是否被 pin。 */
export function isPinned(pins: readonly PinRecord[], msgId: string): boolean {
  return pins.some((p) => p.msgId === msgId);
}
