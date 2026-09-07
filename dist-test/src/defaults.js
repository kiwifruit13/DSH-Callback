/**
 * 六个钩子的默认实现。
 *
 * 契约（`fallback-chain` 末场景）：宿主**只提供 compress** 也必须能跑通全流程，
 * 其余五个钩子由这里的默认实现承担。
 * 导出它们是为了让宿主可以「包装默认行为再增强」，而不是从零重写。
 */
import { selectSegment as defaultCut } from './blocks.js';
import { identifyIncompleteBlockPins, identifyStaticPins, dedupePins } from './pins.js';
import { createVectorSpace } from './signals.js';
import { shouldCompress } from './trigger.js';
import { verifySummary } from './verify.js';
/** 默认触发判定：双水位 + 迟滞 + 任务边界 + 频率下限。 */
export function defaultShouldCompress(ctx) {
    return shouldCompress(ctx, createVectorSpace());
}
/** 默认切割：按 block 边界切中部，无安全切点返回空数组。 */
export function defaultSelectSegment(state, config) {
    return defaultCut(state, config);
}
/** 默认 pin 识别：静态白名单 + 铁律三强制 pin，按优先级去重。 */
export function defaultOnPreCompress(state, config) {
    return dedupePins([...identifyStaticPins(state), ...identifyIncompleteBlockPins(state)]);
}
/** 默认实体校验：正则硬/软实体 + 硬槽位逐字定位。 */
export function defaultVerify(input, config) {
    return verifySummary(input.original, input.summary, null, config);
}
/** 默认错误出口：什么都不做。宿主应提供自己的实现以接入日志/监控。 */
export function defaultOnError() {
    // 故意留空
}
/**
 * 默认回调集。**compress 不在其中** —— 它是宿主唯一必须提供的钩子。
 */
export const DEFAULT_CALLBACKS = {
    shouldCompress: (state, config) => {
        const space = createVectorSpace();
        // 门面不持有轮次历史：epoch 0（从未压缩过）视为不受频率下限约束，
        // 否则默认实现会因 minGapTurns 永远给出 rate-limit 而无法完成首次压缩
        return shouldCompress({
            state,
            config,
            turnsSinceLastCompress: state.epoch === 0 ? Number.MAX_SAFE_INTEGER : 1,
            justCompressed: false,
        }, space);
    },
    selectSegment: defaultSelectSegment,
    onPreCompress: defaultOnPreCompress,
    verify: defaultVerify,
    onError: defaultOnError,
};
//# sourceMappingURL=defaults.js.map