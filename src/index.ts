/**
 * `dsh-callback` 公共导出面。
 *
 * 这是**唯一**的公共入口，内部模块一律不对外暴露。
 * 导出清单是集成契约的一部分：新增/删除/改名均属破坏性变更，需要评审。
 *
 * 最小接入示例：
 *
 * ```ts
 * import { createContextCompressor } from 'dsh-callback';
 *
 * const compressor = createContextCompressor({
 *   config: { triggerRatio: 0.75 },
 *   callbacks: { compress: async ({ text }) => ({ text: await mySummarizer(text) }) },
 * });
 * const next = await compressor.maybeCompress(state);
 * ```
 */

/* ---- 契约：类型 ---- */
export type {
  Role,
  Vendor,
  ToolCall,
  Message,
  ToolBlock,
  Segment,
  SourceSpan,
  ArchiveRef,
  PinReason,
  PinRecord,
  CompressLevel,
  CompressMethod,
  CompressedBlock,
  TriggerReason,
  TriggerDecision,
  BoundaryType,
  BudgetAssignment,
  EntityCategory,
  VerifyReport,
  CacheImpact,
  ObservationRecord,
  ContextState,
  CompressErrorCode,
} from './contract.js';

/* ---- 契约：常量与错误类 ---- */
export {
  PIN_REASON_PRIORITY,
  HARD_ENTITY_CATEGORIES,
  HARD_ENTITY_RETAIN_REQUIRED,
  CompressError,
  NoCompressionPossible,
  ArchiveCorrupted,
  ArchiveUnavailable,
  HookError,
  CommitAssertFailed,
} from './contract.js';

/* ---- 配置 ---- */
export type { ArchiveRecord, ArchiveSink, ObservationHook, WarningHook, TokenCounter, Embedder, CompressConfig } from './config.js';
export { DEFAULT_CONFIG, defaultTokenCounter, resolveConfig, ConfigError } from './config.js';

/* ---- 回调 ---- */
export type {
  IdempotencyKey,
  SummarySlots,
  HardSlots,
  CompressInput,
  CompressOutput,
  VerifyInput,
  ErrorContext,
  CompressCallbacks,
} from './callbacks.js';
export { idempotencyKeyOf } from './callbacks.js';

/* ---- 门面 ---- */
export { createContextCompressor } from './api.js';
export type { ContextCompressor, CreateCompressorOptions } from './api.js';

/* ---- 编排 ---- */
export { createOrchestrator } from './orchestrator.js';
export type { Orchestrator, OrchestratorOptions } from './orchestrator.js';

/* ---- 默认实现（宿主只提供 compress 也能跑通全流程） ---- */
export {
  DEFAULT_CALLBACKS,
  defaultShouldCompress,
  defaultSelectSegment,
  defaultOnPreCompress,
  defaultVerify,
  defaultOnError,
} from './defaults.js';

/* ---- 触发 ---- */
export { shouldCompress, detectBoundaries } from './trigger.js';
export type { TriggerContext, BoundaryHit } from './trigger.js';

/* ---- 结构：tool block 与切割 ---- */
export {
  parseToolBlocks,
  selectSegment,
  segmentsAreSafe,
  isBlockCompressible,
  msgTokens,
  totalTokens,
} from './blocks.js';

/* ---- 保护：pin ---- */
export {
  resolvePins,
  identifyStaticPins,
  identifyIncompleteBlockPins,
  dedupePins,
  isPinned,
} from './pins.js';
export type { PinResolveResult } from './pins.js';

/* ---- 归档与回溯 ---- */
export {
  createArchive,
  hashMessages,
  defaultHash,
  MemoryArchiveSink,
  JsonlArchiveSink,
} from './archive.js';
export type { Archive, HashFn } from './archive.js';

/* ---- 向量与增益 ---- */
export { splitTokens, createVectorSpace, cosineSimilarity } from './signals.js';
export type { VectorSpace } from './signals.js';
export { assignBudget, createEmbedderSpace } from './gain.js';
export type { SimilaritySpace, AssignBudgetInput } from './gain.js';

/* ---- 校验 ---- */
export { verifyEntities, verifySummary } from './verify.js';

/* ---- 降级链 ---- */
export { runFallbackChain } from './fallback.js';
export type { FallbackResult } from './fallback.js';

/* ---- 级别实现 ---- */
export { l1Denoise, extractSlots, verifyHardSlots, l3Coarsen, l4PointerText } from './levels/index.js';
export type { L1Result } from './levels/index.js';

/* ---- 实体正则（宿主自定义钩子时可复用同一套规则） ---- */
export {
  matchAll,
  extractHardEntities,
  RE_WINDOWS_PATH,
  RE_POSIX_PATH,
  RE_URL,
  RE_UUID,
  RE_HASH,
  RE_COMMAND,
  RE_TODO_PENDING,
  RE_TODO_DONE,
  HARD_ENTITY_PATTERNS,
  SOFT_ENTITY_PATTERNS,
} from './patterns.js';
export type { Match } from './patterns.js';
