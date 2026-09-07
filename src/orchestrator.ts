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

import type { CompressCallbacks, CompressInput } from './callbacks.js';
import { idempotencyKeyOf } from './callbacks.js';
import type { ArchiveSink, CompressConfig } from './config.js';
import type {
  CompressedBlock,
  CompressLevel,
  ContextState,
  EntityCategory,
  Message,
  ObservationRecord,
  PinRecord,
  Segment,
  TriggerDecision,
  VerifyReport,
} from './contract.js';
import {
  ArchiveCorrupted,
  ArchiveUnavailable,
  CommitAssertFailed,
  CompressError,
  HookError,
} from './contract.js';
import { createArchive, type Archive } from './archive.js';
import { parseToolBlocks, segmentsAreSafe, selectSegment, totalTokens } from './blocks.js';
import { runFallbackChain } from './fallback.js';
import { assignBudget, createEmbedderSpace, type SimilaritySpace } from './gain.js';
import { l1Denoise } from './levels/l1.js';
import { l4PointerText } from './levels/l4.js';
import { resolvePins } from './pins.js';
import { ALL_ENTITY_CATEGORIES, createVectorSpace } from './signals.js';
import { shouldCompress } from './trigger.js';
import { verifySummary } from './verify.js';

/** 编排器。 */
export interface Orchestrator {
  /** 对当前状态评估并（在触发条件满足时）执行一轮压缩。 */
  maybeCompress(state: ContextState): Promise<ContextState>;
  /** 全部观测记录（按提交顺序）。 */
  observations(): readonly ObservationRecord[];
}

export interface OrchestratorOptions {
  readonly config: CompressConfig;
  readonly callbacks: CompressCallbacks;
}

/** 压缩块在消息流中的呈现：纯文本 user 消息。 */
function blockToMessage(block: CompressedBlock): Message {
  return {
    id: `cb-${block.id}`,
    role: 'user',
    content: block.text,
    vendor: 'generic',
  };
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const { config, callbacks } = options;
  const archive: Archive = createArchive(config.archive);
  const cache = new Map<string, { block: CompressedBlock }>();
  const inFlight = new Map<number, Promise<ContextState>>();
  const records: ObservationRecord[] = [];
  // 已提交的最新 epoch（CAS 基准）与最近一次提交（幂等重放锚点：同一状态对象重复请求直接返回缓存结果）
  let committedEpoch = -1;
  let lastCommit: { input: ContextState; result: ContextState } | null = null;

  const warn = (warning: string, details?: Record<string, unknown>): void => {
    config.onWarning?.(warning, details);
  };

  const emitError = (error: unknown, phase: ObservationRecord | null, hook: string | null, state: ContextState): void => {
    try {
      callbacks.onError?.(error, { hook, phase: phaseToName(phase), state });
    } catch {
      // onError 自身的异常被吞掉，不得影响主流程
    }
  };

  const phaseToName = (record: ObservationRecord | null): 'trigger' | 'select' | 'pin' | 'compress' | 'verify' | 'commit' => 'compress';

  /** 相似度空间：embedding 开启且提供了 embed 时用之，否则 TF-IDF（无网络调用）。 */
  const buildSpace = (): SimilaritySpace => {
    if (config.embeddingEnabled && config.embed !== null) return createEmbedderSpace(config.embed);
    return createVectorSpace();
  };

  /** 校验失败的空保留率表（各记 1.0：失败原因不是实体丢失，不能伪造 0）。 */
  const emptyRetain = (): Record<EntityCategory, number> => {
    const retain = {} as Record<EntityCategory, number>;
    for (const category of ALL_ENTITY_CATEGORIES) retain[category] = 1.0;
    return retain;
  };

  /**
   * 执行实体校验（§3 失败语义）：用户 verify 钩子优先；
   * 钩子异常 → 视为**不通过**（hookError = true）并记 verify_hook_error 告警，走降级链不放行。
   */
  const runVerify = (
    original: string,
    summary: string,
    level: number,
    slots: Parameters<typeof verifySummary>[2],
  ): VerifyReport => {
    if (callbacks.verify !== undefined) {
      try {
        return callbacks.verify({ original, summary, level: level as CompressLevel, config }, config);
      } catch (error) {
        warn('verify_hook_error', { error: String(error) });
        return { passed: false, entityRetain: emptyRetain(), missing: [], hookError: true, warnings: [] };
      }
    }
    return verifySummary(original, summary, slots, config);
  };

  /** 对单个段执行压缩（含校验失败处理链），返回最终文本与来源。 */
  const compressSegment = async (
    segMsgs: readonly Message[],
    budget: number,
    level: number,
    epoch: number,
    startId: string,
    endId: string,
  ): Promise<{ text: string; method: CompressedBlock['method']; degraded: boolean; slots: Parameters<typeof verifySummary>[2] }> => {
    const original = segMsgs.map((m) => m.content).join('\n');

    // 铁律二 + 归档前提：有损级别（L2+）必须先归档成功
    let archiveRef = null;
    if (level >= 2) {
      archiveRef = await archive.archive(segMsgs, segMsgs[0]?.vendor ?? 'generic');
      if (archiveRef === null) {
        // 归档不可用：禁止有损下沉，退化为 L1 无损裁剪（仍允许）
        warn('archive-unavailable', { startId, endId, level });
        const l1 = l1Denoise(segMsgs, config);
        return { text: l1.text, method: 'heuristic', degraded: true, slots: null };
      }
    }

    if (level === 1) {
      const l1 = l1Denoise(segMsgs, config);
      return { text: l1.text, method: 'heuristic', degraded: false, slots: null };
    }

    const input: CompressInput = {
      text: original,
      level: level as 2 | 3,
      budget,
      key: { startId, endId, level: level as 2 | 3, epoch },
      signal: new AbortController().signal,
      config,
    };

    // 主路径：降级链（llm → heuristic → truncate）
    let result = await runFallbackChain(input, callbacks.compress ?? null, config);

    // §8.2 校验失败处理链：重压一次 → 抽取式 → 硬截断保尾
    let verify = runVerify(original, result.output.text, level, result.output.slots ?? null);
    if (!verify.passed) {
      warn('verify_failed_retry', { startId, endId, missing: verify.missing.length });
      const retry = await runFallbackChain(input, callbacks.compress ?? null, config);
      const retryVerify = runVerify(original, retry.output.text, level, retry.output.slots ?? null);
      if (retryVerify.passed) {
        result = retry;
        verify = retryVerify;
      } else {
        // 降级为 L1 抽取式（输出 ⊆ 输入，硬实体天然保留）
        const l1 = l1Denoise(segMsgs, config);
        let text = l1.text;
        let method: CompressedBlock['method'] = 'heuristic';
        // 抽取式仍超预算 → 硬截断保尾部，截断后重跑一次校验
        if (config.countTokens(text) > budget) {
          text = truncateTail(text, budget, config);
          method = 'truncate';
        }
        verify = runVerify(original, text, level, null);
        return { text, method, degraded: true, slots: null };
      }
    }

    return { text: result.output.text, method: result.method, degraded: result.degraded, slots: result.output.slots ?? null };
  };

  /** 硬截断保尾部。 */
  const truncateTail = (text: string, budget: number, cfg: CompressConfig): string => {
    const lines = text.split('\n');
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = cfg.countTokens(lines[i]!);
      if (kept.length > 0 && used + cost > budget) break;
      kept.unshift(lines[i]!);
      used += cost;
    }
    return kept.join('\n');
  };

  const runCycle = async (state: ContextState): Promise<ContextState> => {
    const start = Date.now();
    const casEpoch = state.epoch;
    const warnings: string[] = [];
    const countTokens = config.countTokens;

    // ---- 触发 ----
    const currentTokens = totalTokens(state.msgs, countTokens);
    const evaluated: ContextState = { ...state, tokens: currentTokens };
    let decision: TriggerDecision = { compress: false, reason: 'below-trigger', forced: false, epoch: casEpoch };
    try {
      if (callbacks.shouldCompress !== undefined) {
        const d = callbacks.shouldCompress(evaluated, config);
        decision = typeof d === 'boolean' ? { compress: d, reason: d ? 'task-boundary' : 'below-trigger', forced: false, epoch: casEpoch } : d;
      } else {
        decision = shouldCompress({ state: evaluated, config, turnsSinceLastCompress: turnsSince(state), justCompressed: lastEpochOf(state) === casEpoch - 1 });
      }
    } catch (error) {
      // shouldCompress 异常 → 保守地不压缩
      warn('should_compress_hook_error', { error: String(error) });
      emitError(new HookError('shouldCompress', error), null, 'shouldCompress', state);
      return state;
    }
    if (!decision.compress) return state;

    // ---- pin 识别（先于切割：pin 决定 head 边界）----
    let pins: readonly PinRecord[];
    try {
      const resolved = resolvePins(evaluated, config, callbacks.onPreCompress);
      pins = resolved.pins;
      if (resolved.degraded) warnings.push('pin_hook_degraded');
    } catch (error) {
      emitError(new HookError('onPreCompress', error), null, 'onPreCompress', state);
      return state;
    }

    const pinnedState: ContextState = { ...evaluated, pins };

    // ---- 切割 ----
    let segments;
    try {
      segments = callbacks.selectSegment !== undefined ? callbacks.selectSegment(pinnedState, config) : selectSegment(pinnedState, config);
    } catch (error) {
      // selectSegment 异常 → 中止本轮，不回退默认切割（边界错则全盘错）
      warn('select_hook_error', { error: String(error) });
      emitError(new HookError('selectSegment', error), null, 'selectSegment', state);
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
    const resinkOld = new Map<string, CompressedBlock>();
    const resinkTexts = new Map<string, string>();
    const resinkOriginalMsgs = new Map<string, readonly Message[]>();
    const resinkSegments: Segment[] = [];
    for (const block of evaluated.compressed) {
      if (block.level < 1 || block.level >= config.maxLevel) continue;
      if (block.archiveRef === null) continue;
      let originalMsgs: readonly Message[];
      try {
        originalMsgs = await archive.rehydrate(block.archiveRef);
      } catch (error) {
        if (error instanceof ArchiveCorrupted) {
          // 归档损坏：拒绝基于可疑原文的任何再下沉，保持当前级别
          warn('archive_corrupted_reject_resink', { blockId: block.id });
        } else {
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
    const segmentTexts = new Map<string, string>();
    for (const seg of allSegments) {
      // 再下沉段的文本 = rehydrate 取回的 L0 原文；普通段 = 消息原文拼接
      const preset = resinkTexts.get(seg.id);
      if (preset !== undefined) {
        segmentTexts.set(seg.id, preset);
        continue;
      }
      const segMsgs = seg.msgIds.map((id) => msgById.get(id)).filter((m): m is Message => m !== undefined);
      segmentTexts.set(seg.id, segMsgs.map((m) => m.content).join('\n'));
    }
    const space = buildSpace();
    space.addDocument?.(anchorText);
    for (const text of segmentTexts.values()) space.addDocument?.(text);
    const assignments = assignBudget(
      { segments: allSegments, anchorText, segmentTexts, retainedTexts: pinTexts, space },
      config,
    );

    // ---- 逐段压缩 ----
    const blocks: CompressedBlock[] = [];
    const producedBySeg = new Map<string, CompressedBlock>();
    const msgIndex = new Map(state.msgs.map((m, i) => [m.id, i]));
    for (const assignment of assignments) {
      const seg = allSegments.find((s) => s.id === assignment.segmentId);
      if (seg === undefined) continue;
      const oldBlock = resinkOld.get(seg.id);

      // 再下沉语义：级别单调不回退（铁律二）；达 sinkLimit 直接落 L4 且不再调摘要钩子
      let targetLevel = assignment.targetLevel;
      if (oldBlock !== undefined) {
        targetLevel = Math.max(oldBlock.level, targetLevel) as CompressLevel;
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
      const segMsgs = resinkMsgs ?? seg.msgIds.map((id) => msgById.get(id)).filter((m): m is Message => m !== undefined);
      let produced: CompressedBlock;

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
          } else {
            const pointerText = l4PointerText(seg.startId, seg.endId, segMsgs.length, ref.ref);
            // 达 sinkLimit 的块：compress_count 保持原值不再递增（铁律二「达上限即停」）
            const nextCount =
              oldBlock === undefined
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
        } else {
          const { text, method, degraded, slots } = await compressSegment(
            segMsgs,
            assignment.budget,
            targetLevel,
            casEpoch,
            seg.startId,
            seg.endId,
          );
          let archiveRef = null;
          if (targetLevel >= 2) {
            archiveRef = await archive.archive(segMsgs, segMsgs[0]?.vendor ?? 'generic');
          }
          produced = {
            id: `cb-${seg.startId}-${seg.endId}`,
            level: targetLevel,
            method,
            text,
            sourceSpan: { startId: seg.startId, endId: seg.endId, msgCount: seg.msgIds.length },
            archiveRef,
            epoch: casEpoch + 1,
            compressCount: oldBlock === undefined ? 1 : oldBlock.compressCount + 1,
            tokens: countTokens(text),
            degraded,
          };
        }
      } catch (error) {
        if (error instanceof CompressError && error.code === 'no-compression-possible') {
          throw error; // 三级全失败：向上抛，上下文保持原样
        }
        warn('segment_compress_error', { segmentId: seg.id, error: String(error) });
        emitError(error, null, 'compress', state);
        return state;
      }

      blocks.push(produced);
      producedBySeg.set(seg.id, produced);
      cache.set(key, { block: produced });
    }

    // ---- 构造 next_msgs：head 逐字节保留 + 压缩块替换被压段 + tail ----
    const skipIds = new Set<string>();
    const anchorToBlock = new Map<string, CompressedBlock>();
    for (const seg of allSegments) {
      const block = producedBySeg.get(seg.id);
      if (block === undefined) continue;
      const old = resinkOld.get(seg.id);
      if (old !== undefined) {
        // 再下沉：旧压缩块消息被新块原位替换
        const anchor = `cb-${old.id}`;
        skipIds.add(anchor);
        anchorToBlock.set(anchor, block);
      } else {
        for (const id of seg.msgIds) skipIds.add(id);
        anchorToBlock.set(seg.startId, block);
      }
    }

    const nextMsgs: Message[] = [];
    for (const msg of state.msgs) {
      const block = anchorToBlock.get(msg.id);
      if (block !== undefined) {
        nextMsgs.push(blockToMessage(block));
        continue;
      }
      if (skipIds.has(msg.id)) continue;
      nextMsgs.push(msg);
    }

    // ---- 提交前三断言 ----
    let replacedTokens = 0;
    for (const [segId] of producedBySeg) {
      const old = resinkOld.get(segId);
      if (old !== undefined) {
        replacedTokens += old.tokens; // 再下沉：被替换的是旧压缩块消息
      } else {
        replacedTokens += allSegments.find((s) => s.id === segId)?.tokens ?? 0;
      }
    }
    try {
      assertCommit(
        nextMsgs,
        pins,
        countTokens,
        currentTokens,
        config,
        replacedTokens,
        blocks.reduce((sum, b) => sum + b.tokens, 0),
      );
    } catch (error) {
      if (error instanceof CommitAssertFailed) {
                warn('commit_assert_failed', { assertion: error.assertion, message: error.message });
        emitError(error, null, null, state);
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
    const committed: ContextState = {
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

    // ---- 观测 ----
    const headTokens = nextTokens - blocks.reduce((s, b) => s + b.tokens, 0);
    // 观测的 level / method 描述本轮的主要压缩来源：取第一个实体压缩块
    // （method !== 'none'）；纯 L4 指针轮次才回退到 blocks[0]
    const mainBlock = blocks.find((b) => b.method !== 'none') ?? blocks[0];
    const record: ObservationRecord = {
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
        prefixStable: true, // head 消息保持原引用，逐字节不变
        breakpointAfterHead: true,
      },
      warnings,
    };
    records.push(record);
    config.onObservation?.(record);
    void headTokens;

    return committed;
  };

  return {
    maybeCompress(state: ContextState): Promise<ContextState> {
      // 幂等重放：同一状态对象重复请求 → 直接返回上次提交结果，不重跑任何钩子（§9.3）
      if (lastCommit !== null && state === lastCommit.input) {
        return Promise.resolve(lastCommit.result);
      }
      const existing = inFlight.get(state.epoch);
      if (existing !== undefined) return existing; // 并发触发复用同一 promise
      const promise = runCycle(state)
        .catch((error) => {
          emitError(error, null, null, state);
          return state; // 任何未预期异常：上下文逐字节原样
        })
        .finally(() => {
          inFlight.delete(state.epoch);
        });
      inFlight.set(state.epoch, promise);
      return promise;
    },

    observations(): readonly ObservationRecord[] {
      return [...records];
    },
  };
}

/** 距上次压缩的轮数占位：由 host 通过状态外信息维护时覆盖此默认（当前以 epoch 差近似）。 */
function turnsSince(state: ContextState): number {
  return state.epoch === 0 ? Number.MAX_SAFE_INTEGER : 1;
}

function lastEpochOf(state: ContextState): number {
  return state.compressed.length > 0 ? state.compressed[state.compressed.length - 1]!.epoch : -1;
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
export function assertCommit(
  nextMsgs: readonly Message[],
  pins: readonly PinRecord[],
  countTokens: (text: string) => number,
  beforeTokens: number,
  config: CompressConfig,
  replacedTokens: number,
  newBlockTokens: number,
): void {
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
