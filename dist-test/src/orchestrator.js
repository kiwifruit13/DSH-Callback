/**
 * 一轮压缩的编排。
 *
 * 守护 §9.2 / §9.3 / §11（`atomicity-idempotency` 九个场景）：
 *
 * 执行顺序固定：触发 → pin 识别 → 切割 → 预算分配 → 逐段压缩（幂等缓存）→
 * 构造 next_msgs → 提交前三断言 → epoch CAS → 提交 → 观测。
 *
 * 原子性：`next_msgs` 全部构造完成并通过断言后才整体替换；
 * 中途任何失败都返回原 `state` 引用（逐字节不变），epoch 不递增。
 * 幂等：四元组 (startId, endId, level, epoch) 相同直接复用缓存，不调 compress；
 * 并发：同 epoch 的并发触发复用同一 in-flight promise，只压一次。
 */
import { idempotencyKeyOf } from './callbacks.js';
import { ArchiveCorrupted, CommitAssertFailed, CompressError, HookError, } from './contract.js';
import { createArchive } from './archive.js';
import { parseToolBlocks, segmentsAreSafe, selectSegment, totalTokens } from './blocks.js';
import { runFallbackChain, truncateToBudget } from './fallback.js';
import { assignBudget, createEmbedderSpace } from './gain.js';
import { l1Denoise } from './levels/l1.js';
import { l4PointerText } from './levels/l4.js';
import { resolvePins } from './pins.js';
import { ALL_ENTITY_CATEGORIES, createVectorSpace } from './signals.js';
import { shouldCompress, buildTopicShiftSpace } from './trigger.js';
import { verifySummary } from './verify.js';
/** 压缩块在消息流中的呈现：纯文本 user 消息。 */
const BLOCK_MSG_PREFIX = 'cb-';
function blockToMessage(block) {
    return {
        id: `${BLOCK_MSG_PREFIX}${block.id}`,
        role: 'user',
        content: block.text,
        vendor: 'generic',
    };
}
export function createOrchestrator(options) {
    const { config, callbacks } = options;
    const archive = createArchive(config.archive);
    const cache = new Map();
    const inFlight = new Map();
    const records = [];
    // 已提交的最新 epoch（CAS 基准）与最近一次提交（幂等重放锚点：同一状态对象重复请求直接返回缓存结果）
    let committedEpoch = -1;
    let lastCommit = null;
    /**
     * 距上次成功压缩经历的调用轮数（§7.1 频率下限 / 等待上限的真实依据）。
     * 初始为 MAX_SAFE_INTEGER 表示「从未压缩过、不受频率下限约束」；
     * maybeCompress 的每次新调用推进 +1（幂等重放与 in-flight 复用不计入），
     * 成功提交压缩后归零。justCompressed 即「上一轮调用刚完成压缩」（值为 1）。
     */
    let turnsSinceLastCompress = Number.MAX_SAFE_INTEGER;
    /**
     * 统一告警入口（R5-3）：onWarning 与本轮 ObservationRecord.warnings 双通道
     * 共用此函数，消除「onWarning 有、warnings 恒空」的断连。
     * activeCycleWarnings 由 runCycle 在本轮期间挂载（JS 单线程，runCycle 全程同步持有）。
     */
    let activeCycleWarnings = null;
    const warn = (warning, details) => {
        activeCycleWarnings?.push(warning);
        config.onWarning?.(warning, details);
    };
    const emitError = (error, phase, hook, state) => {
        try {
            callbacks.onError?.(error, { hook, phase, state });
        }
        catch {
            // onError 自身的异常被吞掉，不得影响主流程
        }
    };
    /** 相似度空间：embedding 开启且提供了 embed 时用之，否则 TF-IDF（无网络调用）。 */
    const buildSpace = () => {
        if (config.embeddingEnabled && config.embed !== null)
            return createEmbedderSpace(config.embed);
        return createVectorSpace();
    };
    /** 校验失败的空保留率表（各记 1.0：失败原因不是实体丢失，不能伪造 0）。 */
    const emptyRetain = () => {
        const retain = {};
        for (const category of ALL_ENTITY_CATEGORIES)
            retain[category] = 1.0;
        return retain;
    };
    /**
     * 执行实体校验（§3 失败语义）：用户 verify 钩子优先；
     * 钩子异常 → 视为**不通过**（hookError = true）并记 verify_hook_error 告警，走降级链不放行。
     */
    const runVerify = (original, summary, level, slots) => {
        if (callbacks.verify !== undefined) {
            try {
                // P0-3：VerifyInput 携带 slots，默认校验链才能执行硬槽位逐字定位
                return callbacks.verify({ original, summary, level: level, slots, config }, config);
            }
            catch (error) {
                warn('verify_hook_error', { error: String(error) });
                return { passed: false, entityRetain: emptyRetain(), missing: [], hookError: true, warnings: [] };
            }
        }
        return verifySummary(original, summary, slots, config);
    };
    /** 对单个段执行压缩（含校验失败处理链），返回实际生效级别、来源与归档指针。 */
    const compressSegment = async (segMsgs, budget, level, epoch, startId, endId, signal) => {
        const original = segMsgs.map((m) => m.content).join('\n');
        // 铁律二 + 归档前提：有损级别（L2+）必须先归档成功
        let archiveRef = null;
        if (level >= 2) {
            archiveRef = await archive.archive(segMsgs, segMsgs[0]?.vendor ?? 'generic');
            if (archiveRef === null) {
                // 归档不可用：禁止有损下沉，退化为 L1 无损裁剪（仍允许）
                warn('archive-unavailable', { startId, endId, level });
                const l1 = l1Denoise(segMsgs, config);
                return { text: l1.text, method: 'heuristic', degraded: true, slots: null, level: 1, archiveRef: null };
            }
        }
        if (level === 1) {
            const l1 = l1Denoise(segMsgs, config);
            return { text: l1.text, method: 'heuristic', degraded: false, slots: null, level: 1, archiveRef: null };
        }
        const input = {
            text: original,
            level: level,
            budget,
            key: { startId, endId, level: level, epoch },
            // R5-9：signal 由 maybeCompress 透传（不再是无源死信号），宿主据此取消网络调用；
            // 宿主未提供 signal 时为永不中止的空信号（向后兼容语义不变）
            signal: signal ?? new AbortController().signal,
            config,
        };
        /** 把校验报告的软实体处置记录转发到告警通道，不静默忽略（P1-3）。 */
        const reportVerifyWarnings = (report) => {
            for (const detail of report.warnings) {
                warn('verify_soft_warning', { startId, endId, detail });
            }
        };
        /**
         * 转发降级链告警（R5-4）：FallbackResult.warnings 不再被丢弃。
         * llm_hook_error 已由 fallback 内部携带详情直发 onWarning，跳过防止双报；
         * 其余（llm_invalid_schema_attempt_N / llm_aborted / heuristic_over_budget）经统一入口补发。
         */
        const FALLBACK_SELF_REPORTED = new Set(['llm_hook_error']);
        const reportFallbackWarnings = (r) => {
            for (const w of r.warnings) {
                if (!FALLBACK_SELF_REPORTED.has(w))
                    warn(w, { startId, endId });
            }
        };
        // 主路径：降级链（llm → heuristic → truncate）
        let result = await runFallbackChain(input, callbacks.compress ?? null, config);
        reportFallbackWarnings(result);
        // §8.2 校验失败处理链：重压一次 → 抽取式 → 硬截断保尾
        const verify = runVerify(original, result.output.text, level, result.output.slots ?? null);
        reportVerifyWarnings(verify);
        if (!verify.passed) {
            warn('verify_failed_retry', { startId, endId, missing: verify.missing.length });
            const retry = await runFallbackChain(input, callbacks.compress ?? null, config);
            reportFallbackWarnings(retry);
            const retryVerify = runVerify(original, retry.output.text, level, retry.output.slots ?? null);
            reportVerifyWarnings(retryVerify);
            if (retryVerify.passed) {
                result = retry;
            }
            else {
                // 降级为 L1 抽取式（输出 ⊆ 输入，硬实体天然保留）。
                // 级别单调不回退：level 仍记目标级别，可信度由 degraded 标记。
                const l1 = l1Denoise(segMsgs, config);
                let text = l1.text;
                let method = 'heuristic';
                // 抽取式仍超预算 → 硬截断保尾（truncateToBudget 与降级链第三级同一实现，R5-6）
                if (config.countTokens(text) > budget) {
                    text = truncateToBudget(text, budget, config);
                    method = 'truncate';
                }
                // 截断后对保留部分重跑一次校验（`entity-verify`：截断后仍对保留部分重跑一次实体校验）。
                // 这不是门禁而是性质断言：截断输出 ⊆ l1 输出 ⊆ 原文行子集，硬实体保留率恒 1.0；
                // 结果必须被消费 —— 软实体处置记录经此上报，不静默丢弃（P1-3，原 P3-2 死赋值的正确形态）。
                const truncatedVerify = runVerify(original, text, level, null);
                reportVerifyWarnings(truncatedVerify);
                if (!truncatedVerify.passed) {
                    warn('verify_failed_after_truncate', { startId, endId, missing: truncatedVerify.missing.length });
                }
                return { text, method, degraded: true, slots: null, level, archiveRef };
            }
        }
        return {
            text: result.output.text,
            method: result.method,
            degraded: result.degraded,
            slots: result.output.slots ?? null,
            level,
            archiveRef,
        };
    };
    const runCycle = async (state, signal) => {
        // R5-3：挂载本轮告警收集器，finally 卸载（全部 return 路径不泄漏、不串轮）
        const warnings = [];
        activeCycleWarnings = warnings;
        try {
            return await runCycleInner(state, signal, warnings);
        }
        finally {
            activeCycleWarnings = null;
        }
    };
    const runCycleInner = async (state, signal, warnings) => {
        const start = Date.now();
        const casEpoch = state.epoch;
        const countTokens = config.countTokens;
        /** 整体取消检查（R5-9）：提交发生前放弃本轮，状态逐字节原样（§9.2）。 */
        const aborted = () => signal?.aborted ?? false;
        // ---- 触发 ----
        const currentTokens = totalTokens(state.msgs, countTokens);
        const evaluated = { ...state, tokens: currentTokens };
        let decision = { compress: false, reason: 'below-trigger', forced: false, epoch: casEpoch };
        try {
            if (callbacks.shouldCompress !== undefined) {
                const d = callbacks.shouldCompress(evaluated, config);
                // R5-8：布尔返回无边界语义，如实标注 host-decision，不伪造 task-boundary（其要求携带 cutPointId）
                decision = typeof d === 'boolean' ? { compress: d, reason: d ? 'host-decision' : 'below-trigger', forced: false, epoch: casEpoch } : d;
            }
            else {
                // 默认触发路径（宿主未注入 shouldCompress 时的唯一路径）：
                // 轮次状态由本实例真实维护（P0-1/P0-2），topic-shift 边界基于当前用户消息语料计算（P1-4，
                // 语料构建与 defaultShouldCompress 共用 buildTopicShiftSpace，防止两处漂移）。
                decision = shouldCompress({
                    state: evaluated,
                    config,
                    turnsSinceLastCompress,
                    justCompressed: turnsSinceLastCompress === 1,
                }, buildTopicShiftSpace(evaluated));
            }
        }
        catch (error) {
            // shouldCompress 异常 → 保守地不压缩
            warn('should_compress_hook_error', { error: String(error) });
            emitError(new HookError('shouldCompress', error), 'trigger', 'shouldCompress', state);
            return state;
        }
        if (!decision.compress)
            return state;
        if (aborted())
            return state; // R5-9：触发后、pin 识别前的取消检查点
        // ---- pin 识别（先于切割：pin 决定 head 边界）----
        let pins;
        try {
            const resolved = resolvePins(evaluated, config, callbacks.onPreCompress);
            pins = resolved.pins;
            if (resolved.degraded)
                warnings.push('pin_hook_degraded');
        }
        catch (error) {
            emitError(new HookError('onPreCompress', error), 'pin', 'onPreCompress', state);
            return state;
        }
        const pinnedState = { ...evaluated, pins };
        // ---- 切点消费（P1-1）：触发层产出的 cutPointId 在此进入链路 ----
        // 校验其不落入任何 block 内部（铁律三的前哨信号）；切点是参考信号，
        // 不中止本轮——真正的切割安全由 selectSegment 与提交断言保障。
        if (decision.cutPointId !== undefined) {
            const msgIndexForCut = new Map(state.msgs.map((m, i) => [m.id, i]));
            const cutIdx = msgIndexForCut.get(decision.cutPointId);
            if (cutIdx === undefined) {
                warn('cutpoint-not-found', { cutPointId: decision.cutPointId, reason: decision.reason });
            }
            else {
                const insideBlock = pinnedState.blocks.some((b) => b.msgIds.indexOf(decision.cutPointId) > 0 && b.msgIds.indexOf(decision.cutPointId) < b.msgIds.length - 1);
                if (insideBlock) {
                    warn('cutpoint_inside_block', {
                        cutPointId: decision.cutPointId,
                        blockId: pinnedState.blocks.find((b) => b.msgIds.includes(decision.cutPointId))?.id,
                    });
                }
            }
        }
        // ---- 切割 ----
        let segments;
        try {
            segments = callbacks.selectSegment !== undefined ? callbacks.selectSegment(pinnedState, config) : selectSegment(pinnedState, config);
        }
        catch (error) {
            // selectSegment 异常 → 中止本轮，不回退默认切割（边界错则全盘错）
            warn('select_hook_error', { error: String(error) });
            emitError(new HookError('selectSegment', error), 'select', 'selectSegment', state);
            return state;
        }
        if (segments === null) {
            warn('select_abort', { reason: 'no-safe-cut' });
            return state;
        }
        if (segments.length > 0 && !segmentsAreSafe(segments, pinnedState.blocks)) {
            warn('select_abort', { reason: 'no-safe-cut' });
            return state;
        }
        // ---- 已下沉块的再下沉（铁律一「永远从原文压缩」的渐进式主循环）----
        // 候选：level ≥ 1、未达 maxLevel、有归档指针的既有压缩块。
        // 已达 sinkLimit 的块也在列：直接落 L4 指针，不再调用摘要钩子（铁律二「达上限即停」）。
        const resinkOld = new Map();
        const resinkTexts = new Map();
        const resinkOriginalMsgs = new Map();
        const resinkSegments = [];
        for (const block of evaluated.compressed) {
            if (block.level < 1 || block.level >= config.maxLevel)
                continue;
            if (block.archiveRef === null)
                continue;
            let originalMsgs;
            try {
                originalMsgs = await archive.rehydrate(block.archiveRef);
            }
            catch (error) {
                if (error instanceof ArchiveCorrupted) {
                    // 归档损坏：拒绝基于可疑原文的任何再下沉，保持当前级别
                    warn('archive_corrupted_reject_resink', { blockId: block.id });
                }
                else {
                    // 归档不可用：禁止有损下沉，保持当前级别
                    warn('archive-unavailable', { blockId: block.id, phase: 'resink' });
                }
                continue;
            }
            const segId = `rs-${block.id}`;
            resinkOld.set(segId, block);
            resinkTexts.set(segId, originalMsgs.map((m) => m.content).join('\n'));
            resinkOriginalMsgs.set(segId, originalMsgs);
            resinkSegments.push({
                id: segId,
                startId: block.sourceSpan.startId,
                endId: block.sourceSpan.endId,
                msgIds: originalMsgs.map((m) => m.id),
                blockIds: [],
                tokens: originalMsgs.reduce((sum, m) => sum + countTokens(m.content), 0),
            });
        }
        const allSegments = [...segments, ...resinkSegments];
        if (allSegments.length === 0) {
            warn('select_abort', { reason: 'no-safe-cut' });
            return state;
        }
        // ---- 预算分配（anchor = pin 约束集；增益基于 L0 原文）----
        const pinTexts = pins.map((p) => p.text);
        const anchorText = pinTexts.join('\n');
        const msgById = new Map(state.msgs.map((m) => [m.id, m]));
        const segmentTexts = new Map();
        for (const seg of allSegments) {
            // 再下沉段的文本 = rehydrate 取回的 L0 原文；普通段 = 消息原文拼接
            const preset = resinkTexts.get(seg.id);
            if (preset !== undefined) {
                segmentTexts.set(seg.id, preset);
                continue;
            }
            const segMsgs = seg.msgIds.map((id) => msgById.get(id)).filter((m) => m !== undefined);
            segmentTexts.set(seg.id, segMsgs.map((m) => m.content).join('\n'));
        }
        const space = buildSpace();
        space.addDocument?.(anchorText);
        for (const text of segmentTexts.values())
            space.addDocument?.(text);
        const assignments = assignBudget({ segments: allSegments, anchorText, segmentTexts, retainedTexts: pinTexts, space }, config);
        // ---- 逐段压缩 ----
        const blocks = [];
        const producedBySeg = new Map();
        const msgIndex = new Map(state.msgs.map((m, i) => [m.id, i]));
        for (const assignment of assignments) {
            if (aborted())
                return state; // R5-9：逐段压缩间的取消检查点（丢弃未提交的部分产物）
            const seg = allSegments.find((s) => s.id === assignment.segmentId);
            if (seg === undefined)
                continue;
            const oldBlock = resinkOld.get(seg.id);
            // 再下沉语义：级别单调不回退（铁律二）；达 sinkLimit 直接落 L4 且不再调摘要钩子
            // targetLevel 收敛到 maxLevel 内（P3-9：assignBudget 不知道 maxLevel，可能给出更深的级别）
            let targetLevel = Math.min(assignment.targetLevel, config.maxLevel);
            if (oldBlock !== undefined) {
                targetLevel = Math.max(oldBlock.level, targetLevel);
                if (oldBlock.compressCount >= config.sinkLimit) {
                    targetLevel = config.maxLevel;
                }
            }
            const key = idempotencyKeyOf({ startId: seg.startId, endId: seg.endId, level: targetLevel, epoch: casEpoch });
            // 幂等缓存：相同四元组直接复用，不再调用 compress
            const cached = cache.get(key);
            if (cached !== undefined) {
                blocks.push(cached.block);
                // 缓存命中同样要登记替换关系，否则 next_msgs 会保留原始消息，
                // 与 token 断言的预估基准（已按替换计算）脱节
                producedBySeg.set(seg.id, cached.block);
                continue;
            }
            const resinkMsgs = resinkOriginalMsgs.get(seg.id);
            const segMsgs = resinkMsgs ?? seg.msgIds.map((id) => msgById.get(id)).filter((m) => m !== undefined);
            let produced;
            try {
                if (targetLevel === 4) {
                    // L4 指针：必须可回溯。再下沉时重归档会按 hash 去重，复用同一份原文
                    const ref = await archive.archive(segMsgs, segMsgs[0]?.vendor ?? 'generic');
                    if (ref === null) {
                        if (oldBlock !== undefined) {
                            // 再下沉遇归档不可用：保持旧块当前级别，不产出替换块
                            warn('archive-unavailable', { startId: seg.startId, endId: seg.endId, phase: 'resink-l4' });
                            continue;
                        }
                        // 新段遇归档不可用：禁止有损下沉，退化为 L1 无损裁剪
                        warn('archive-unavailable', { startId: seg.startId, endId: seg.endId, phase: 'l4' });
                        const l1 = l1Denoise(segMsgs, config);
                        produced = {
                            id: `cb-${seg.startId}-${seg.endId}`,
                            level: 1,
                            method: 'heuristic',
                            text: l1.text,
                            sourceSpan: { startId: seg.startId, endId: seg.endId, msgCount: seg.msgIds.length },
                            archiveRef: null,
                            epoch: casEpoch + 1,
                            compressCount: 1,
                            tokens: countTokens(l1.text),
                            degraded: true,
                        };
                    }
                    else {
                        const pointerText = l4PointerText(seg.startId, seg.endId, segMsgs.length, ref.ref);
                        // 达 sinkLimit 的块：compress_count 保持原值不再递增（铁律二「达上限即停」）
                        const nextCount = oldBlock === undefined
                            ? 0
                            : oldBlock.compressCount >= config.sinkLimit
                                ? oldBlock.compressCount
                                : oldBlock.compressCount + 1;
                        produced = {
                            id: `cb-${seg.startId}-${seg.endId}`,
                            level: 4,
                            method: 'none',
                            text: pointerText,
                            sourceSpan: { startId: seg.startId, endId: seg.endId, msgCount: segMsgs.length },
                            archiveRef: ref,
                            epoch: casEpoch + 1,
                            compressCount: nextCount,
                            tokens: countTokens(pointerText),
                            degraded: false,
                        };
                    }
                }
                else {
                    const { text, method, degraded, slots, level: effectiveLevel, archiveRef: segArchiveRef } = await compressSegment(segMsgs, assignment.budget, targetLevel, casEpoch, seg.startId, seg.endId, signal);
                    // P1-2：compressSegment 内部已完成 L2+ 的唯一一次归档，直接复用其指针与实际级别
                    produced = {
                        id: `cb-${seg.startId}-${seg.endId}`,
                        level: effectiveLevel,
                        method,
                        text,
                        sourceSpan: { startId: seg.startId, endId: seg.endId, msgCount: seg.msgIds.length },
                        archiveRef: segArchiveRef,
                        epoch: casEpoch + 1,
                        compressCount: oldBlock === undefined ? 1 : oldBlock.compressCount + 1,
                        tokens: countTokens(text),
                        degraded,
                    };
                }
            }
            catch (error) {
                if (error instanceof CompressError && error.code === 'no-compression-possible') {
                    throw error; // 三级全失败：向上抛，上下文保持原样
                }
                warn('segment_compress_error', { segmentId: seg.id, error: String(error) });
                emitError(error, 'compress', 'compress', state);
                return state;
            }
            blocks.push(produced);
            producedBySeg.set(seg.id, produced);
            cache.set(key, { block: produced });
        }
        // ---- 构造 next_msgs：head 逐字节保留 + 压缩块替换被压段 + tail ----
        const skipIds = new Set();
        const anchorToBlock = new Map();
        for (const seg of allSegments) {
            const block = producedBySeg.get(seg.id);
            if (block === undefined)
                continue;
            const old = resinkOld.get(seg.id);
            if (old !== undefined) {
                // 再下沉：旧压缩块消息被新块原位替换
                const anchor = `cb-${old.id}`;
                skipIds.add(anchor);
                anchorToBlock.set(anchor, block);
            }
            else {
                for (const id of seg.msgIds)
                    skipIds.add(id);
                anchorToBlock.set(seg.startId, block);
            }
        }
        const nextMsgs = [];
        for (const msg of state.msgs) {
            const block = anchorToBlock.get(msg.id);
            if (block !== undefined) {
                nextMsgs.push(blockToMessage(block));
                continue;
            }
            if (skipIds.has(msg.id))
                continue;
            nextMsgs.push(msg);
        }
        // ---- 提交前三断言 ----
        if (aborted())
            return state; // R5-9：提交前的最终取消检查点（此后进入不可逆提交）
        let replacedTokens = 0;
        for (const [segId] of producedBySeg) {
            const old = resinkOld.get(segId);
            if (old !== undefined) {
                replacedTokens += old.tokens; // 再下沉：被替换的是旧压缩块消息
            }
            else {
                replacedTokens += allSegments.find((s) => s.id === segId)?.tokens ?? 0;
            }
        }
        try {
            assertCommit(nextMsgs, pins, countTokens, currentTokens, config, replacedTokens, blocks.reduce((sum, b) => sum + b.tokens, 0));
        }
        catch (error) {
            if (error instanceof CommitAssertFailed) {
                warn('commit_assert_failed', { assertion: error.assertion, message: error.message });
                emitError(error, 'commit', null, state);
                return state; // 整体回滚
            }
            throw error;
        }
        // ---- epoch CAS：过期状态（epoch 已被更新的提交推进）禁止二次写入 ----
        if (state.epoch < committedEpoch) {
            warn('epoch_cas_conflict', { expected: casEpoch, latest: committedEpoch });
            return state;
        }
        // ---- 提交 ----
        const nextTokens = totalTokens(nextMsgs, countTokens);
        const nextBlocks = parseToolBlocks(nextMsgs, countTokens);
        const committed = {
            msgs: nextMsgs,
            epoch: casEpoch + 1,
            blocks: nextBlocks,
            pins,
            compressed: [...state.compressed, ...blocks],
            tokens: nextTokens,
            capacity: state.capacity,
        };
        committedEpoch = casEpoch + 1;
        lastCommit = { input: state, result: committed };
        turnsSinceLastCompress = 0; // 本轮刚完成压缩：频率下限与 justCompressed 的基准（P0-1）
        // ---- 观测 ----
        // P1-5：cacheImpact 不再硬编码，改为真实比对——
        // prefixStable：从头逐引用比对，第一处差异必须恰好是压缩块呈现消息（cb- 前缀）；
        // 消息不可变设计下引用相同即逐字节相同。
        let firstDiff = 0;
        const commonLen = Math.min(state.msgs.length, nextMsgs.length);
        while (firstDiff < commonLen && state.msgs[firstDiff] === nextMsgs[firstDiff])
            firstDiff++;
        // R5-8：稳定前缀要求至少保留一条原始消息 —— 首条消息即被压缩块替换时
        // 不存在任何稳定前缀，不得报 true（head 被清空却称前缀稳定）。
        const prefixStable = firstDiff > 0 && (firstDiff >= nextMsgs.length || nextMsgs[firstDiff].id.startsWith(BLOCK_MSG_PREFIX));
        // breakpointAfterHead：库不管理 cache_control 断点位置，能验证的是
        // 「首个压缩块之前存在头部消息」，即断点可置于头部之后、首个压缩块之前。
        const firstBlockIdx = nextMsgs.findIndex((m) => m.id.startsWith(BLOCK_MSG_PREFIX));
        const breakpointAfterHead = firstBlockIdx > 0;
        // 观测的 level / method 描述本轮的主要压缩来源：取第一个实体压缩块
        // （method !== 'none'）；纯 L4 指针轮次才回退到 blocks[0]
        const mainBlock = blocks.find((b) => b.method !== 'none') ?? blocks[0];
        const record = {
            epoch: casEpoch + 1,
            beforeTokens: currentTokens,
            afterTokens: nextTokens,
            ratio: currentTokens > 0 ? nextTokens / currentTokens : 1,
            durationMs: Date.now() - start,
            level: mainBlock?.level ?? 0,
            method: mainBlock?.method ?? 'none',
            degraded: blocks.some((b) => b.degraded),
            pinCount: pins.length,
            cacheImpact: {
                prefixStable,
                breakpointAfterHead,
            },
            triggerReason: decision.reason,
            warnings,
        };
        records.push(record);
        config.onObservation?.(record);
        return committed;
    };
    return {
        archive,
        maybeCompress(state, signal) {
            // R5-9：入口已取消 → 直接跳过本轮，不推进轮次、不跑任何钩子
            if (signal?.aborted)
                return Promise.resolve(state);
            // 幂等重放：同一状态对象重复请求 → 直接返回上次提交结果，不重跑任何钩子（§9.3），也不推进轮次
            if (lastCommit !== null && state === lastCommit.input) {
                return Promise.resolve(lastCommit.result);
            }
            const existing = inFlight.get(state.epoch);
            if (existing !== undefined)
                return existing; // 并发触发复用同一 promise，不推进轮次
            // 新一轮调用：轮次推进（P0-1）。首次压缩前保持「无历史」（不限制频率下限），
            // 避免与 MIN_SAFE 语义混淆；成功提交后归零，此后逐轮 +1。
            if (turnsSinceLastCompress !== Number.MAX_SAFE_INTEGER)
                turnsSinceLastCompress += 1;
            const promise = runCycle(state, signal)
                .catch((error) => {
                emitError(error, 'compress', null, state);
                return state; // 任何未预期异常：上下文逐字节原样
            })
                .finally(() => {
                inFlight.delete(state.epoch);
            });
            inFlight.set(state.epoch, promise);
            return promise;
        },
        observations() {
            return [...records];
        },
    };
}
/**
 * 提交前三断言（§9.2）：
 * 1. tool-block-pairing：next_msgs 重解析后不存在不完整块（新压缩块是纯文本 user 消息，不参与配对）；
 * 2. pin-in-place：每条 pin 的受保护文本仍逐字在位；
 * 3. token-consistency：实际 token 与「压缩前预估的压缩后 token」偏差不超容差。
 *
 * 预估公式：estimated = beforeTokens − 被替换内容 token + 新压缩块 token。
 * 偏差只可能来自 token 估算器本身的漂移，这正是该断言要捕获的对象。
 */
export function assertCommit(nextMsgs, pins, countTokens, beforeTokens, config, replacedTokens, newBlockTokens) {
    // 1. 配对完整性
    const nextBlocks = parseToolBlocks(nextMsgs, countTokens);
    const broken = nextBlocks.find((b) => !b.complete || b.malformed);
    if (broken !== undefined) {
        throw new CommitAssertFailed('tool-block-pairing', `提交后存在不完整块 ${broken.id}`, { missing: broken.missing });
    }
    // 2. pin 在位
    const allText = nextMsgs.map((m) => m.content).join('\n\u0000\n');
    for (const pin of pins) {
        if (!nextMsgs.some((m) => m.id === pin.msgId) && !allText.includes(pin.text)) {
            throw new CommitAssertFailed('pin-in-place', `pin 内容缺失：${pin.msgId} (${pin.reason})`, { msgId: pin.msgId, reason: pin.reason });
        }
    }
    // 3. token 一致
    const actual = nextMsgs.reduce((sum, m) => sum + countTokens(m.content), 0);
    const estimated = beforeTokens - replacedTokens + newBlockTokens;
    const tolerance = Math.max(1, Math.ceil(estimated * config.tokenEstimateTolerance));
    if (Math.abs(actual - estimated) > tolerance) {
        throw new CommitAssertFailed('token-consistency', `token 偏差超容差：实际 ${actual}，预估 ${estimated}`, { actual, estimated });
    }
}
//# sourceMappingURL=orchestrator.js.map