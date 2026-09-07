/**
 * 回调层：宿主环境注入能力的唯一入口。
 *
 * 六个钩子的**失败语义各不相同**，这是契约 §3 的硬性要求，实现时必须逐一对齐：
 *
 * | 钩子 | 抛异常时的处置 | 依据 |
 * |---|---|---|
 * | {@link CompressCallbacks.shouldCompress} | 保守地**不压缩**，上下文原样 | 判定错了最多不省 token |
 * | {@link CompressCallbacks.selectSegment} | **中止本轮**，不回退默认切割 | 边界错则全盘错 |
 * | {@link CompressCallbacks.onPreCompress} | **继续**，退回静态 pin 白名单 | 记 pin_hook_degraded 告警 |
 * | {@link CompressCallbacks.compress} | 走降级链 llm → heuristic → truncate → 放弃 | §9.1 |
 * | {@link CompressCallbacks.verify} | **视为不通过**，走降级链 | 记 verify_hook_error，不得放行 |
 * | {@link CompressCallbacks.onError} | 自身不得再抛 | 兜底出口 |
 *
 * 宿主只需实现 `compress` 即可跑通全流程：`shouldCompress` 由编排器内置路径承担
 * （不在 DEFAULT_CALLBACKS 中，P0-1/P0-2），其余四个钩子由 DEFAULT_CALLBACKS 提供。
 */

import type { CompressConfig } from './config.js';
import type {
  CompressLevel,

  ContextState,
  PinRecord,
  Segment,
  TriggerDecision,
  VerifyReport,
} from './contract.js';

/**
 * 幂等键。四元组 (startId, endId, level, epoch)。
 * 相同幂等键重复请求必须复用缓存结果，避免重复消耗 LLM 调用与缓存抖动。
 */
export interface IdempotencyKey {
  readonly startId: string;
  readonly endId: string;
  readonly level: CompressLevel;
  readonly epoch: number;
}

/** 把幂等键序列化为稳定字符串，用作缓存键。 */
export function idempotencyKeyOf(key: IdempotencyKey): string {
  return `${key.startId}|${key.endId}|${key.level}|${key.epoch}`;
}

/**
 * L2 分槽位摘要（§5）。
 *
 * 硬槽位约束：`constraints`、`artifacts`、`todos` 每条取值必须可在原文中**逐字定位**；
 * 只有 `narrative` 允许出现原文中不存在的改写文本。
 */
export interface SummarySlots {
  /** 用户硬约束，逐字摘抄。 */
  readonly constraints: readonly string[];
  /** 交付物路径与标识，逐字摘抄。 */
  readonly artifacts: readonly string[];
  /** 待办项，逐字摘抄。 */
  readonly todos: readonly string[];
  /** 叙述性摘要，允许改写。 */
  readonly narrative: string;
}

/**
 * 参与逐字校验的**硬槽位**取值集合（P0-3 引入的校验入参形状）。
 *
 * 只有 constraints / artifacts / todos 需要逐字定位，narrative 允许改写、不参与校验；
 * 因此校验侧按此形状收参：`SummarySlots` 结构上是它的超集，可直接传入，
 * 宿主自行构造三个数组（无 narrative）也合法。
 */
export interface HardSlots {
  /** 用户硬约束，逐字摘抄。 */
  readonly constraints: readonly string[];
  /** 交付物路径与标识，逐字摘抄。 */
  readonly artifacts: readonly string[];
  /** 待办项，逐字摘抄。 */
  readonly todos: readonly string[];
}

/** compress 钩子的入参。 */
export interface CompressInput {
  /** 待压缩的**原文**文本。铁律一：永远从 L0 原文压缩，绝不传摘要。 */
  readonly text: string;
  /** 目标级别。 */
  readonly level: CompressLevel;
  /** 该段的 token 预算。 */
  readonly budget: number;
  /** 幂等键，宿主可据此自行缓存。 */
  readonly key: IdempotencyKey;
  /** 超时中断信号。宿主必须响应它，否则超时后仍会残留未取消的网络调用。 */
  readonly signal: AbortSignal;
  readonly config: CompressConfig;
}

/** compress 钩子的出参。 */
export interface CompressOutput {
  /** 压缩后的文本。L1 级别下它必须是 input.text 的子集。 */
  readonly text: string;
  /** L2 及以上的分槽位结果。省略时框架按纯文本处理。 */
  readonly slots?: SummarySlots;
}

/** verify 钩子的入参。 */
export interface VerifyInput {
  /** 原文文本。 */
  readonly original: string;
  /** 待校验的摘要文本。 */
  readonly summary: string;
  /** 摘要所属级别。 */
  readonly level: CompressLevel;
  /**
   * L2 及以上的分槽位结果（P0-3）。
   * 编排层把 compress 产出的槽位传到这里，默认校验链据此执行
   * 「constraints / artifacts / todos 逐字定位」的硬槽位校验；
   * 无槽位（L1 / 纯文本输出）时为 null 或缺省。
   */
  readonly slots?: HardSlots | null;
  readonly config: CompressConfig;
}

/** 错误上下文。 */
export interface ErrorContext {
  /** 出错的钩子名，未命中钩子时为 null。 */
  readonly hook: string | null;
  /** 所处阶段。 */
  readonly phase: 'trigger' | 'select' | 'pin' | 'compress' | 'verify' | 'commit';
  /** 出错时的上下文快照引用。 */
  readonly state: ContextState;
}

/** 六个可注入钩子。除 compress（必填）外全部可选：shouldCompress 缺省走编排器内置路径，其余缺省走 DEFAULT_CALLBACKS。 */
export interface CompressCallbacks {
  /**
   * 触发判定。返回 boolean 或完整决策。
   * 抛异常时视为**不压缩**。
   */
  shouldCompress?(state: ContextState, config: CompressConfig): TriggerDecision | boolean;

  /**
   * 中部段切割。返回空数组表示无安全切点，本轮放弃。
   * 抛异常时**中止本轮压缩**且不回退到任何默认切割实现。
   */
  selectSegment?(state: ContextState, config: CompressConfig): readonly Segment[] | null;

  /**
   * pin 识别。返回本轮识别到的全部保护记录。
   * 抛异常时**继续**，退回静态 pin 白名单，并记一条 pin_hook_degraded 告警。
   */
  onPreCompress?(state: ContextState, config: CompressConfig): readonly PinRecord[];

  /**
   * 压缩执行。这是唯一必须提供的钩子。
   * 超时由 {@link CompressInput.signal} 控制，失败走降级链。
   */
  compress(input: CompressInput, signal: AbortSignal): Promise<CompressOutput> | CompressOutput;

  /**
   * 实体校验。
   * 抛异常时**视为不通过**，走 §8.2 降级链，并记 verify_hook_error 告警。
   */
  verify?(input: VerifyInput, config: CompressConfig): VerifyReport;

  /** 错误出口。自身抛出的异常会被静默吞掉，不得影响主流程。 */
  onError?(error: unknown, context: ErrorContext): void;
}

