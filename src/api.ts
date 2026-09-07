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
   */
  maybeCompress(state: ContextState): Promise<ContextState>;
  /** 全部观测记录。 */
  observations(): readonly ObservationRecord[];
  /** 生效配置（合并默认值后）。 */
  readonly config: CompressConfig;
}

export interface CreateCompressorOptions {
  /** 配置覆盖。未提供的项取 DEFAULT_CONFIG 占位值，建议按 §13 标定后显式传入。 */
  readonly config?: Partial<CompressConfig>;
  /** 宿主回调。compress 为必填语义，其余钩子缺省走默认实现。 */
  readonly callbacks: CompressCallbacks;
}

/** 创建压缩器。非法配置在此即刻失败，不带入压缩流程。 */
export function createContextCompressor(options: CreateCompressorOptions): ContextCompressor {
  const config = resolveConfig(options.config ?? {});
  const callbacks: CompressCallbacks = { ...DEFAULT_CALLBACKS, ...options.callbacks };
  const orchestrator: Orchestrator = createOrchestrator({ config, callbacks });

  return {
    maybeCompress(state: ContextState): Promise<ContextState> {
      return orchestrator.maybeCompress(state);
    },
    observations(): readonly ObservationRecord[] {
      return orchestrator.observations();
    },
    config,
  };
}
