/**
 * tool block 解析与边界切割。
 *
 * 守护铁律三：block 内的 assistant 工具调用与其全部 result 必须位于切割的同一侧。
 * 拆散会直接触发 Anthropic / OpenAI API 400，压缩收益归零且会话中断（§6）。
 *
 * 覆盖的畸形形态（`tool-block-integrity` 八个场景）：
 * 1. 完整块：assistant + 全部 result 同侧
 * 2. 并行调用：一条 assistant 的 N 个 tool_calls + N 条 result 构成**一个**不可分割块
 * 3. result 乱序到达：仍归入所属 block，块内保持原始到达顺序，不重排
 * 4. result 缺失：complete=false，missing 记录未返回的 tool_use id
 * 5. 孤儿 result：找不到对应 tool_calls，单独成块且标记畸形，流程继续不抛异常
 * 6. 被下一条 assistant 工具调用截断：在截断处结束，complete=false，后续块独立解析
 */
/** 单条消息的 token 数。消息自带计数优先，否则用配置的计数器估算。 */
export function msgTokens(msg, countTokens) {
    return msg.tokens ?? countTokens(msg.content);
}
/** 一批消息的总 token 数。 */
export function totalTokens(msgs, countTokens) {
    let sum = 0;
    for (const msg of msgs)
        sum += msgTokens(msg, countTokens);
    return sum;
}
/** 该消息是否为发起工具调用的 assistant 消息。 */
function isToolCallMessage(msg) {
    return msg.role === 'assistant' && msg.toolCalls !== undefined && msg.toolCalls.length > 0;
}
/** 该消息是否为工具结果消息。 */
function isToolResultMessage(msg) {
    return msg.role === 'tool' && msg.toolCallId !== undefined;
}
/**
 * 解析会话中的全部 tool block。
 *
 * 采用单趟状态机：遇到发起调用的 assistant 开块，沿途收集 result，
 * 遇到「下一条 assistant 工具调用」或「不属于本块的 tool result」即收口。
 */
export function parseToolBlocks(msgs, countTokens) {
    const blocks = [];
    /** 当前正在累积的块。 */
    let currentIds = [];
    let pending = new Set();
    let firstId = '';
    let currentId = '';
    const finish = (complete, malformed) => {
        if (currentIds.length === 0)
            return;
        const blockMsgs = currentIds.map((id) => msgs.find((m) => m.id === id)).filter((m) => m !== undefined);
        blocks.push({
            id: currentId,
            startId: firstId,
            endId: currentIds[currentIds.length - 1],
            msgIds: currentIds,
            complete,
            missing: [...pending],
            malformed,
            tokens: totalTokens(blockMsgs, countTokens),
        });
        currentIds = [];
        pending = new Set();
        firstId = '';
        currentId = '';
    };
    for (const msg of msgs) {
        if (isToolCallMessage(msg)) {
            // 已有未收口的块 → 被下一条 assistant 工具调用截断，判为畸形
            if (currentIds.length > 0)
                finish(false, true);
            currentId = `blk-${msg.id}`;
            firstId = msg.id;
            currentIds = [msg.id];
            pending = new Set(msg.toolCalls.map((c) => c.id));
            continue;
        }
        if (isToolResultMessage(msg)) {
            const callId = msg.toolCallId;
            if (currentIds.length > 0 && pending.has(callId)) {
                // 归属当前块（乱序同样成立：只看 id 是否在本块的 pending 集合里）
                pending.delete(callId);
                currentIds.push(msg.id);
                if (pending.size === 0)
                    finish(true, false);
                continue;
            }
            // 孤儿 result：先收口当前块，再让它单独成块
            if (currentIds.length > 0)
                finish(false, false);
            blocks.push({
                id: `blk-${msg.id}`,
                startId: msg.id,
                endId: msg.id,
                msgIds: [msg.id],
                complete: false,
                missing: [],
                malformed: true,
                tokens: msgTokens(msg, countTokens),
            });
            continue;
        }
        // 普通消息：若处于块内，说明 result 未收齐即被打断
        if (currentIds.length > 0)
            finish(false, true);
    }
    // 收尾：仍有未返回的 result
    if (currentIds.length > 0)
        finish(false, pending.size > 0);
    return blocks;
}
/** 该块是否可参与压缩。不完整或畸形的块被强制 pin，任何级别都不参与。 */
export function isBlockCompressible(block) {
    return block.complete && !block.malformed;
}
/** 建立「消息 ID → block ID」映射，供切割与 pin 定位使用。 */
export function buildMsgBlockIndex(blocks) {
    const index = new Map();
    for (const block of blocks) {
        for (const id of block.msgIds)
            index.set(id, block.id);
    }
    return index;
}
/**
 * 默认中部段切割。
 *
 * 规则：
 * - head = 消息流起点**连续 system 消息区**的末端（系统提示永不压缩）；
 * - pin 消息的保护不依赖扩大 head：被 pin 的普通消息不参与任何 block，天然不进段；
 *   pin 落在某 block 内时，整块退出压缩候选（保守：pin 的 span 行必须逐字保留）；
 * - tail = 尾部最近 `tailTurns` 条消息，永不压缩；
 * - 中部 = head 与 tail 之间，按 block 边界切成若干段，
 *   **任一段的首尾元素都必须是完整 block**；
 * - 中部内若不存在任何完整 block，返回空数组（无安全切点，本轮放弃）。
 */
export function selectSegment(state, config) {
    const { msgs, blocks, pins } = state;
    if (blocks.length === 0)
        return [];
    const msgIndex = new Map(msgs.map((m, i) => [m.id, i]));
    // head 末端：起点连续 system 区
    let headEnd = -1;
    for (const msg of msgs) {
        if (msg.role !== 'system')
            break;
        headEnd = msgIndex.get(msg.id) ?? headEnd;
    }
    // 任何 pin 所在的 block 整体退出压缩候选（span 行逐字保留优先于压缩收益）
    const pinnedMsgIds = new Set(pins.map((p) => p.msgId));
    const blockHasPin = (block) => block.msgIds.some((id) => pinnedMsgIds.has(id));
    // tail 起点
    const tailStart = Math.max(headEnd + 1, msgs.length - config.tailTurns);
    if (tailStart <= headEnd + 1)
        return [];
    const segments = [];
    let current = [];
    const flush = () => {
        if (current.length === 0)
            return;
        const msgIds = [];
        for (const block of current)
            msgIds.push(...block.msgIds);
        segments.push({
            id: `seg-${current[0].startId}-${current[current.length - 1].endId}`,
            startId: current[0].startId,
            endId: current[current.length - 1].endId,
            msgIds,
            blockIds: current.map((b) => b.id),
            tokens: current.reduce((sum, b) => sum + b.tokens, 0),
        });
        current = [];
    };
    for (const block of blocks) {
        const startIdx = msgIndex.get(block.startId);
        const endIdx = msgIndex.get(block.endId);
        if (startIdx === undefined || endIdx === undefined)
            continue;
        // 完全落在中部区间内、可压缩、且不含 pin → 独立成段（每 block 一段，
        // 预算可按增益逐段分配，也避免「唯一段恒为最低增益」退化）；否则断开
        if (startIdx > headEnd && endIdx < tailStart && isBlockCompressible(block) && !blockHasPin(block)) {
            flush();
            current.push(block);
            flush();
        }
        else {
            flush();
        }
    }
    flush();
    return segments;
}
/** 校验切割结果：任一段的首尾都必须是完整 block。提交前断言会用到。 */
export function segmentsAreSafe(segments, blocks) {
    const blockById = new Map(blocks.map((b) => [b.id, b]));
    for (const seg of segments) {
        const first = blockById.get(seg.blockIds[0] ?? '');
        const last = blockById.get(seg.blockIds[seg.blockIds.length - 1] ?? '');
        if (first === undefined || last === undefined)
            return false;
        if (!isBlockCompressible(first) || !isBlockCompressible(last))
            return false;
    }
    return true;
}
//# sourceMappingURL=blocks.js.map