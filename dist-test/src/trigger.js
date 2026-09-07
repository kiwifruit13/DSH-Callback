/**
 * 触发策略：双水位 + 迟滞带 + 任务边界 + 频率下限。
 *
 * 守护 §7.1（`trigger-watermark` 九个场景）：
 * - 压缩只在「占用超线且遇到任务边界」时发生，否则 prompt cache 全 miss；
 * - 迟滞带防抖动：高于目标线但低于触发线时不压缩；
 * - 频率下限：距上次成功压缩不足 minGapTurns 轮时抑制，单轮多次穿越只压一次；
 * - 无边界但超过等待上限时强制压缩，切点仍受 tool block 门禁约束；
 * - 判定顺序固定，保证同输入同输出。
 */
import { createVectorSpace } from './signals.js';
import { matchAll, RE_TODO_DONE, RE_TODO_PENDING } from './patterns.js';
/** 等待任务边界（超线但未超等待上限，也未命中边界）已作为 `waiting-boundary` 并入 TriggerReason。 */
/** 执行触发判定。 */
/**
 * 为 topic-shift 边界判定构建语料空间（P1-4 收口）：
 * 把 state 中全部 user 角色消息登记进 TF-IDF 空间参与 IDF 统计。
 *
 * 空语料空间下任意文本的向量都是零向量，`cosine` 恒返回 0 —— 低于
 * relevanceThreshold 就会对每一对相邻用户消息误报 topic-shift（P1-4 路径 A 的原始缺陷）。
 * 编排器内置触发路径与 `defaultShouldCompress` **必须共用本 helper**，
 * 杜绝「一处补了语料、另一处传空空间」的接线漂移再次发生。
 */
export function buildTopicShiftSpace(state) {
    const space = createVectorSpace();
    for (const msg of state.msgs) {
        if (msg.role === 'user')
            space.addDocument(msg.content);
    }
    return space;
}
const DELIVERY_KEYWORDS = ['总结', '交付', '完成情况', 'summary', 'delivered', 'done with'];
/**
 * 识别任务边界。四类信号的实现都是**确定性**的文本规则：
 * - todo-transition：待办由 pending 翻转为 completed 的那条消息；
 * - tool-seq-end：工具调用序列终止后第一条纯文本消息；
 * - delivery-summary：助手输出交付总结后的下一条用户消息；
 * - topic-shift：相邻两条用户消息相关性低于阈值（需要 space，缺省跳过该类）。
 */
export function detectBoundaries(state, config, space) {
    const hits = [];
    const { msgs } = state;
    // todo-transition：出现过 pending 行之后，首次出现 done 行的消息
    let seenPending = false;
    for (const msg of msgs) {
        const hasPending = matchAll(msg.content, RE_TODO_PENDING).length > 0;
        const hasDone = matchAll(msg.content, RE_TODO_DONE).length > 0;
        if (hasPending)
            seenPending = true;
        if (seenPending && hasDone) {
            hits.push({ messageId: msg.id, type: 'todo-transition' });
            break;
        }
    }
    // tool-seq-end：最后一个 block 之后的第一条纯文本消息
    const lastBlock = state.blocks[state.blocks.length - 1];
    if (lastBlock !== undefined) {
        const endIndex = msgs.findIndex((m) => m.id === lastBlock.endId);
        if (endIndex >= 0) {
            for (let i = endIndex + 1; i < msgs.length; i++) {
                const msg = msgs[i];
                if (msg.role === 'user' || msg.role === 'assistant') {
                    hits.push({ messageId: msg.id, type: 'tool-seq-end' });
                    break;
                }
            }
        }
    }
    // delivery-summary：助手输出总结后，紧随的用户消息即新话题起点
    for (let i = 0; i < msgs.length - 1; i++) {
        const msg = msgs[i];
        if (msg.role !== 'assistant')
            continue;
        if (!DELIVERY_KEYWORDS.some((kw) => msg.content.toLowerCase().includes(kw)))
            continue;
        const next = msgs[i + 1];
        if (next.role === 'user') {
            hits.push({ messageId: next.id, type: 'delivery-summary' });
            break;
        }
    }
    // topic-shift：相邻用户消息相关性低于阈值
    if (space !== undefined && config.relevanceThreshold > 0) {
        const userMsgs = msgs.filter((m) => m.role === 'user');
        for (let i = 1; i < userMsgs.length; i++) {
            const prev = space.vectorize(userMsgs[i - 1].content);
            const curr = space.vectorize(userMsgs[i].content);
            if (space.cosine(prev, curr) < config.relevanceThreshold) {
                hits.push({ messageId: userMsgs[i].id, type: 'topic-shift' });
                break;
            }
        }
    }
    return hits;
}
/**
 * 触发判定。顺序即优先级，全部阈值来自配置注入。
 */
export function shouldCompress(ctx, space) {
    const { state, config, turnsSinceLastCompress, justCompressed } = ctx;
    const ratio = state.capacity > 0 ? state.tokens / state.capacity : 0;
    const epoch = state.epoch;
    // 1. 压缩后已回落到目标线以下：本轮结束
    if (justCompressed && ratio < config.targetRatio) {
        return { compress: false, reason: 'post-compress-settled', forced: false, epoch };
    }
    // 2. 低于触发线
    if (ratio < config.triggerRatio) {
        // 迟滞带细化：高于目标线且刚压缩过，防抖动
        if (justCompressed && ratio >= config.targetRatio) {
            return { compress: false, reason: 'hysteresis-band', forced: false, epoch };
        }
        return { compress: false, reason: 'below-trigger', forced: false, epoch };
    }
    // 3. 频率下限：单轮内反复穿越只压一次
    if (turnsSinceLastCompress < config.minGapTurns) {
        return { compress: false, reason: 'rate-limit', forced: false, epoch };
    }
    // 4. 任务边界优先
    const hits = detectBoundaries(state, config, space);
    if (hits.length > 0) {
        const hit = hits[0];
        return {
            compress: true,
            reason: 'task-boundary',
            cutPointId: hit.messageId,
            boundaryType: hit.type,
            forced: false,
            epoch,
        };
    }
    // 5. 无边界但超过等待上限 → 强制（切点由切割层保证落在 block 之间）
    if (turnsSinceLastCompress >= config.maxWaitTurns) {
        return { compress: true, reason: 'forced', forced: true, epoch };
    }
    // 6. 超线但仍在等待边界
    return { compress: false, reason: 'waiting-boundary', forced: false, epoch };
}
//# sourceMappingURL=trigger.js.map