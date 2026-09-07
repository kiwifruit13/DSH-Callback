/**
 * 契约测试夹具（E2）。
 *
 * - `HistoryBuilder`：链式 DSL 构造会话消息，支持乱序 result、孤儿 result、
 *   不完整 tool_call 等畸形形态（`tool-block-integrity` 八场景的精确表达依赖它）；
 * - stub compressor 家族：全部**确定性**、无网络，替代真实 LLM；
 * - 状态与段的构造辅助。
 */

import type { CompressCallbacks, CompressInput, CompressOutput, SummarySlots } from '../../src/callbacks.js';
import type { CompressConfig } from '../../src/config.js';
import type { Message, Segment, ToolBlock, ToolCall } from '../../src/contract.js';
import { parseToolBlocks, totalTokens } from '../../src/blocks.js';
import type { ContextState } from '../../src/contract.js';

/* ============================================================================
 * 一、会话构造 DSL
 * ========================================================================== */

export class HistoryBuilder {
  private readonly msgs: Message[] = [];
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(2, '0')}`;
  }

  system(text = '你是一个代码助手，遵守用户的全部约束。'): this {
    this.msgs.push({ id: this.nextId('sys'), role: 'system', content: text });
    return this;
  }

  user(text: string): this {
    this.msgs.push({ id: this.nextId('user'), role: 'user', content: text });
    return this;
  }

  /** assistant 消息；提供 calls 时同时登记 tool_calls。 */
  assistant(text: string, calls?: readonly ToolCall[]): this {
    this.msgs.push({ id: this.nextId('as'), role: 'assistant', content: text, ...(calls ? { toolCalls: calls } : {}) });
    return this;
  }

  /** tool result 消息。乱序到达时按实际到达顺序追加即可。 */
  tool(callId: string, text: string): this {
    this.msgs.push({ id: this.nextId('tool'), role: 'tool', content: text, toolCallId: callId });
    return this;
  }

  /** 便捷：一次工具调用 + 紧随的 result。 */
  toolRound(name: string, resultText: string, callId?: string): this {
    const id = callId ?? `call-${this.seq + 1}`;
    this.assistant(`调用 ${name}`, [{ id, name, args: {} }]);
    this.tool(id, resultText);
    return this;
  }

  build(): Message[] {
    return this.msgs;
  }
}

/** Background「包含系统提示、中部历史与尾部最近轮次的会话」的基准形态。 */
export function baseSession(): Message[] {
  return new HistoryBuilder()
    .system()
    .user('请帮我检查项目配置')
    .toolRound('read_file', 'config: { port: 3067 }')
    .user('继续检查依赖')
    .toolRound('list_deps', 'typescript, react')
    .user('总结一下发现')
    .assistant('配置与依赖检查完毕，无异常。')
    .build();
}

/* ============================================================================
 * 二、stub compressor 家族（确定性、无网络）
 * ========================================================================== */

function slotsFromText(text: string): SummarySlots {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return {
    constraints: lines.filter((l) => l.includes('必须') || l.includes('记住')),
    artifacts: lines.filter((l) => /[A-Za-z]:\\|\.\//.test(l)),
    todos: lines.filter((l) => l.includes('待办') || /\[\s\]/.test(l) || /\[[xX]\]/.test(l)),
    narrative: lines.slice(0, 2).join(' '),
  };
}

/** 理想 LLM：原文回显（实体全保留），L2+ 附带合法槽位。校验必然通过。 */
export function goodCompress(): NonNullable<CompressCallbacks['compress']> {
  return async (input: CompressInput): Promise<CompressOutput> => ({
    text: input.text,
    ...(input.level >= 2 ? { slots: slotsFromText(input.text) } : {}),
  });
}

/** 摘要但丢失全部硬实体（槽位结构合法）。用于触发校验失败处理链。 */
export function entityDroppingCompress(): NonNullable<CompressCallbacks['compress']> {
  return async (input: CompressInput): Promise<CompressOutput> => {
    const text = '叙述：本轮工作内容已经总结完毕，细节略。';
    return input.level >= 2
      ? { text, slots: { constraints: [], artifacts: [], todos: [], narrative: text } }
      : { text };
  };
}

/** 第一次输出丢实体、之后恢复原文回显。用于「重压一次后通过」。 */
export function firstBadThenGoodCompress(): NonNullable<CompressCallbacks['compress']> {
  let call = 0;
  const bad = entityDroppingCompress();
  const good = goodCompress();
  return async (input: CompressInput): Promise<CompressOutput> => {
    call += 1;
    return call === 1 ? bad(input, input.signal) : good(input, input.signal);
  };
}

/** 永不返回，仅响应 abort 信号。用于超时降级场景。 */
export function hangingCompress(): NonNullable<CompressCallbacks['compress']> {
  return (input: CompressInput) =>
    new Promise<CompressOutput>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
    });
}

/** L2+ 输出缺少 slots（不符合 schema）→ 触发重试一次再降级。 */
export function schemaInvalidCompress(): NonNullable<CompressCallbacks['compress']> {
  return async (input: CompressInput): Promise<CompressOutput> => ({ text: `纯文本摘要：${input.text.slice(0, 20)}` });
}

/** 始终抛异常。三级全失败 → NoCompressionPossible。 */
export function throwingCompress(): NonNullable<CompressCallbacks['compress']> {
  return async (): Promise<CompressOutput> => {
    throw new Error('llm unavailable');
  };
}

/* ============================================================================
 * 三、状态与段构造辅助
 * ========================================================================== */

/** 由消息序列构建 ContextState（与 world.buildState 相同逻辑的独立入口）。 */
export function makeState(
  msgs: readonly Message[],
  config: CompressConfig,
  opts: Partial<Pick<ContextState, 'epoch' | 'pins' | 'compressed' | 'capacity'>> = {},
): ContextState {
  const blocks = parseToolBlocks(msgs, config.countTokens);
  const tokens = totalTokens(msgs, config.countTokens);
  return {
    msgs: [...msgs],
    epoch: opts.epoch ?? 0,
    blocks,
    pins: opts.pins ?? [],
    compressed: opts.compressed ?? [],
    tokens,
    capacity: opts.capacity ?? tokens + 1,
  };
}

/** 把相邻 block 归并为段（每段一个 block），供预算分配的单元级测试。 */
export function segmentsFromBlocks(blocks: readonly ToolBlock[]): Segment[] {
  return blocks.map((block, i) => ({
    id: `seg-${i + 1}`,
    startId: block.startId,
    endId: block.endId,
    msgIds: [...block.msgIds],
    blockIds: [block.id],
    tokens: block.tokens,
  }));
}
