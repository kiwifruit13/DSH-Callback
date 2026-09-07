/**
 * 六个钩子的默认实现。
 *
 * 契约（`fallback-chain` 末场景）：宿主**只提供 compress** 也必须能跑通全流程，
 * 其余钩子由内置默认路径承担（触发在编排器内部，其余在 DEFAULT_CALLBACKS）。
 * 导出它们是为了让宿主可以「包装默认行为再增强」，而不是从零重写。
 */

import type { CompressCallbacks, VerifyInput } from './callbacks.js';
import type { CompressConfig } from './config.js';
import type { ContextState, PinRecord, Segment, TriggerDecision, VerifyReport } from './contract.js';
import { selectSegment as defaultCut } from './blocks.js';
import { identifyIncompleteBlockPins, identifyStaticPins, dedupePins } from './pins.js';
import { shouldCompress, buildTopicShiftSpace, type TriggerContext } from './trigger.js';
import { verifySummary } from './verify.js';

/**
 * 默认触发判定：双水位 + 迟滞 + 任务边界 + 频率下限。
 * 供宿主**显式**包装使用；编排器内置路径不经过它（见 DEFAULT_CALLBACKS 注释）。
 * ctx 的 turnsSinceLastCompress / justCompressed 必须由调用方真实维护，
 * 传占位值会复现 minGapTurns 永久抑制 / 迟滞带失效的问题。
 *
 * topic-shift 语料空间由 ctx.state 的用户消息构建（P1-4 收口：与编排器内置路径
 * 共用 buildTopicShiftSpace）—— 此前此处传入空空间，cosine 恒 0 会导致
 * topic-shift 对每一对相邻用户消息假阳性，一旦宿主按文档包装本函数即触发。
 */
export function defaultShouldCompress(ctx: TriggerContext): TriggerDecision {
  return shouldCompress(ctx, buildTopicShiftSpace(ctx.state));
}

/** 默认切割：按 block 边界切中部，无安全切点返回空数组。 */
export function defaultSelectSegment(state: ContextState, config: CompressConfig): Segment[] {
  return defaultCut(state, config);
}

/** 默认 pin 识别：静态白名单 + 铁律三强制 pin，按优先级去重。 */
export function defaultOnPreCompress(state: ContextState, config: CompressConfig): readonly PinRecord[] {
  return dedupePins([...identifyStaticPins(state), ...identifyIncompleteBlockPins(state)]);
}

/** 默认实体校验：正则硬/软实体 + 硬槽位逐字定位（slots 由编排层经 VerifyInput 传入，P0-3）。 */
export function defaultVerify(input: VerifyInput, config: CompressConfig): VerifyReport {
  return verifySummary(input.original, input.summary, input.slots ?? null, config);
}

/** 默认错误出口：什么都不做。宿主应提供自己的实现以接入日志/监控。 */
export function defaultOnError(): void {
  // 故意留空
}

/**
 * 默认回调集。**compress 不在其中** —— 它是宿主唯一必须提供的钩子。
 *
 * 注意：`shouldCompress` 也不在其中（P0-1/P0-2）——编排器内置的默认触发路径
 * 是唯一默认实现（真实维护轮次状态 turnsSinceLastCompress / justCompressed，
 * 并为 topic-shift 边界构建语料空间）。若在此处注册 shouldCompress，
 * 会以占位轮次屏蔽内置路径，导致频率下限/迟滞带/强制压缩全部失真。
 * 宿主需要自定义触发时，应基于真实轮次状态实现，或包装 `defaultShouldCompress`。
 */
export const DEFAULT_CALLBACKS: Omit<CompressCallbacks, 'compress' | 'shouldCompress'> = {
  selectSegment: defaultSelectSegment,
  onPreCompress: defaultOnPreCompress,
  verify: defaultVerify,
  onError: defaultOnError,
};
