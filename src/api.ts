/**
 * 公共门面：宿主环境接入压缩器的唯一入口。
 *
 * 最小接入：
 * ```ts
 * const compressor = createContextCompressor({
 *   callbacks: { compress: async ({ text }) => ({ text: await llm.summarize(text) }) },
 * });
 * const nextState = await compressor.maybeCompress(state);
 * ```
 */

import type { CompressCallbacks } from './callbacks.js';
import type { Archive } from './archive.js';
import { resolveConfig, type CompressConfig } from './config.js';
import type { ContextState, ObservationRecord } from './contract.js';
import { DEFAULT_CALLBACKS } from './defaults.js';
import { createOrchestrator, type Orchestrator } from './orchestrator.js';

/** 压缩器实例。 */
export interface ContextCompressor {
  /**
   * 对当前状态评估并执行（或跳过）一轮压缩。
   * 返回值要么是全新的 ContextState（已提交，epoch+1），
   * 要么是原状态引用逐字节不变（未触发 / 中止 / 回滚）。
   *
   * @param signal 可选的整体取消通道（R5-9）。语义：
   * - 调用时已 aborted → 本轮直接跳过，返回原状态引用；
   * - 压缩过程中 abort → 信号同时透传给 compress 钩子（宿主网络调用可自行清理），
   *   且本轮在任何提交发生前放弃，状态逐字节原样（§9.2 原子性）；
   * - 提交完成后 abort 不追溯已落盘的压缩。
   * - 并发同 epoch 触发复用首个调用的 signal。
   */
  maybeCompress(state: ContextState, signal?: AbortSignal): Promise<ContextState>;
  /** 全部观测记录。 */
  observations(): readonly ObservationRecord[];
  /** 生效配置（合并默认值后）。 */
  readonly config: CompressConfig;
  /**
   * 归档门面（P1-8）：rehydrate / rebuildIndex 的公共入口。
   * 与内部压缩共享同一实例与索引——凭压缩块的 archiveRef 随时取回 L0 原文，
   * 进程重启后可 rebuildIndex() 从 JSONL 重建。
   */
  readonly archive: Archive;
}

export interface CreateCompressorOptions {
  /** 配置覆盖。未提供的项取 DEFAULT_CONFIG 占位值，建议按 §13 标定后显式传入。 */
  readonly config?: Partial<CompressConfig>;
  /** 宿主回调。compress 为必填语义，shouldCompress 缺省走编排器内置路径，其余钩子缺省走 DEFAULT_CALLBACKS。 */
  readonly callbacks: CompressCallbacks;
}

/** 创建压缩器。非法配置在此即刻失败，不带入压缩流程。 */
export function createContextCompressor(options: CreateCompressorOptions): ContextCompressor {
  const config = resolveConfig(options.config ?? {});
  const callbacks: CompressCallbacks = { ...DEFAULT_CALLBACKS, ...options.callbacks };
  const orchestrator: Orchestrator = createOrchestrator({ config, callbacks });

  return {
    maybeCompress(state: ContextState, signal?: AbortSignal): Promise<ContextState> {
      return orchestrator.maybeCompress(state, signal);
    },
    observations(): readonly ObservationRecord[] {
      return orchestrator.observations();
    },
    config,
    archive: orchestrator.archive,
  };
}
