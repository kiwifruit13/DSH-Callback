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
 * 宿主只需实现 `compress` 即可跑通全流程，其余五个由默认实现承担。
 */
/** 把幂等键序列化为稳定字符串，用作缓存键。 */
export function idempotencyKeyOf(key) {
    return `${key.startId}|${key.endId}|${key.level}|${key.epoch}`;
}
//# sourceMappingURL=callbacks.js.map