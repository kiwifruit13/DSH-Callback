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
import { resolveConfig } from './config.js';
import { DEFAULT_CALLBACKS } from './defaults.js';
import { createOrchestrator } from './orchestrator.js';
/** 创建压缩器。非法配置在此即刻失败，不带入压缩流程。 */
export function createContextCompressor(options) {
    const config = resolveConfig(options.config ?? {});
    const callbacks = { ...DEFAULT_CALLBACKS, ...options.callbacks };
    const orchestrator = createOrchestrator({ config, callbacks });
    return {
        maybeCompress(state) {
            return orchestrator.maybeCompress(state);
        },
        observations() {
            return orchestrator.observations();
        },
        config,
    };
}
//# sourceMappingURL=api.js.map