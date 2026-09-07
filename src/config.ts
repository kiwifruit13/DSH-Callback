/**
 * 配置层。
 *
 * 契约纪律：Gherkin 场景内不出现任何待标定数字，全部走本文件的 {@link CompressConfig} 注入。
 * 标定后调参数不需要改契约，也不需要改业务代码。
 *
 * 注意：本文件给出的默认值是**保守占位值**，需在规划 §13 实测标定后替换；
 * 它们不是契约的一部分。
 */

import type { CompressLevel, EntityCategory, Message } from './contract.js';

/**
 * 归档记录。JSONL 追加文件的一行。
 * 保存 raw 与 vendor 是为了 rehydrate 能无损还原为首次进入会话时的 API 格式。
 */
export interface ArchiveRecord {
  /** 归档记录标识，与 {@link import('./contract.js').ArchiveRef.ref} 对应。 */
  readonly ref: string;
  /** JSONL 文件中的字节偏移。 */
  readonly offset: number;
  /** 原文内容哈希，即 source_hash。 */
  readonly hash: string;
  /** 被归档的原始消息序列。 */
  readonly msgs: readonly Message[];
  /** 来源厂商标记。 */
  readonly vendor: string;
}

/**
 * 归档存储抽象。
 *
 * 契约只规定「JSONL 追加文件 + 内存索引」，未规定落盘位置（待确认项 Q4），
 * 因此抽象为可注入的 sink：宿主环境可换成任意存储后端。
 *
 * 语义要求：
 * - `append` 只追加不覆盖，既有行的字节偏移不变；
 * - 重复 `hash` 不产生冗余行；
 * - `available()` 返回 false 时，禁止执行有损下沉，但仍允许 L1 无损裁剪。
 */
export interface ArchiveSink {
  /** 追加一条归档记录，返回其字节偏移。 */
  append(record: Omit<ArchiveRecord, 'offset'>): Promise<number>;
  /** 按 ref 读取一条记录。 */
  read(ref: string): Promise<ArchiveRecord | null>;
  /** 全量遍历，用于索引丢失后重建。 */
  readAll(): AsyncIterable<ArchiveRecord>;
  /** 存储是否可用。写入失败或不可用时返回 false。 */
  available(): boolean | Promise<boolean>;
}

/** 观测回调。以回调形式暴露，不绑定任何特定监控实现。 */
export type ObservationHook = (record: import('./contract.js').ObservationRecord) => void;

/** 告警回调。用于 pin_hook_degraded、archive-unavailable 等可观测降级信号。 */
export type WarningHook = (warning: string, details?: Record<string, unknown>) => void;

/** token 计数钩子。宿主环境可提供真实 tokenizer；缺省走内置估算。 */
export type TokenCounter = (text: string) => number;

/** 文本向量化钩子。开启 embedding 时由宿主提供；缺省走内置 TF-IDF。 */
export type Embedder = (text: string) => readonly number[];

/** 压缩配置。全部阈值集中于此，源码其余位置不得出现待标定数字。 */
export interface CompressConfig {
  /* ---- 触发（§7.1 双水位 + 迟滞 + 频率下限） ---- */

  /** 触发线：占用率高于此值才考虑压缩。 */
  readonly triggerRatio: number;
  /** 目标线：压缩后应回落到此值以下。必须小于 triggerRatio。 */
  readonly targetRatio: number;
  /** 频率下限轮数：距上次成功压缩小于此轮数则抑制，避免临界点反复压缩。 */
  readonly minGapTurns: number;
  /** 等待上限轮数：始终无任务边界且超过此轮数则强制压缩。 */
  readonly maxWaitTurns: number;
  /** topic-shift 边界判定用的增益相关性阈值。 */
  readonly relevanceThreshold: number;
  /** 尾部保留的消息条数。这些消息永不压缩，保证最近上下文始终完整在场。 */
  readonly tailTurns: number;

  /* ---- 下沉（铁律一、铁律二） ---- */

  /** 下沉次数上限：compress_count 达此值即停止有损重压，直接落 L4。 */
  readonly sinkLimit: number;
  /** 允许的最深级别。 */
  readonly maxLevel: CompressLevel;

  /* ---- 预算与增益（§1.3 语义反转、§1.4 预算分配） ---- */

  /** 冗余度权重 λ。增益 = 相关性 − λ × 冗余度。 */
  readonly lambda: number;
  /** 中部段的目标 token 预算。各段 budget 之和不得超过它。 */
  readonly targetBudgetTokens: number;
  /** 是否启用 embedding。关闭时退化为纯 TF-IDF 字符二元组，无任何网络调用。 */
  readonly embeddingEnabled: boolean;

  /* ---- 校验（§8.1 / §8.2 / §8.3） ---- */

  /** 软实体保留率阈值，低于则按配置处置（告警但允许通过）。 */
  readonly softEntityRetainThreshold: number;
  /** 各类软实体的处置动作。 */
  readonly softEntityAction: Readonly<Partial<Record<EntityCategory, 'warn' | 'reject'>>>;
  /** 进阶事实问答校验开关，默认关闭（会调用额外模型）。 */
  readonly advancedVerifyEnabled: boolean;

  /* ---- 降级链（§9.1） ---- */

  /** LLM 摘要级超时（毫秒），由 AbortController 控制。 */
  readonly llmTimeoutMs: number;
  /** 规则抽取级超时（毫秒）。 */
  readonly heuristicTimeoutMs: number;
  /** 硬截断级超时（毫秒）。 */
  readonly truncateTimeoutMs: number;
  /** LLM 返回非法 JSON 时的重试次数。契约要求最多一次。 */
  readonly llmRetryCount: number;

  /* ---- 提交断言（§9.2） ---- */

  /** 提交断言：next_msgs 实际 token 数与预估值的容许偏差比例，超出则回滚。 */
  readonly tokenEstimateTolerance: number;

  /* ---- L1 去噪（铁律一：输出 ⊆ 输入） ---- */

  /** 单条工具 stdout 超过该行数视为超长，只保留首尾。 */
  readonly l1OversizeLines: number;
  /** 超长 stdout 保留的首部与尾部行数。 */
  readonly l1EdgeKeepLines: number;

  /* ---- 集成点 ---- */

  /** 归档存储。为 null 表示无归档能力，此时禁止有损下沉。 */
  readonly archive: ArchiveSink | null;
  /** token 计数器。 */
  readonly countTokens: TokenCounter;
  /** 文本向量化器。embeddingEnabled 为 true 时必须提供。 */
  readonly embed: Embedder | null;
  /** 观测回调。 */
  readonly onObservation: ObservationHook | null;
  /** 告警回调。 */
  readonly onWarning: WarningHook | null;
}

/** 保守占位默认值。规划 §13 实测标定后替换。 */
export const DEFAULT_CONFIG: CompressConfig = {
  triggerRatio: 0.7,
  targetRatio: 0.5,
  minGapTurns: 3,
  maxWaitTurns: 12,
  relevanceThreshold: 0.15,
  tailTurns: 6,

  sinkLimit: 2,
  maxLevel: 4,

  lambda: 0.5,
  targetBudgetTokens: 2000,
  embeddingEnabled: false,

  softEntityRetainThreshold: 0.8,
  softEntityAction: {
    'number-percent': 'warn',
    'person-name': 'warn',
  },
  advancedVerifyEnabled: false,

  llmTimeoutMs: 15_000,
  heuristicTimeoutMs: 2_000,
  truncateTimeoutMs: 1_000,
  llmRetryCount: 1,

  tokenEstimateTolerance: 0.05,

  l1OversizeLines: 40,
  l1EdgeKeepLines: 5,

  archive: null,
  countTokens: defaultTokenCounter,
  embed: null,
  onObservation: null,
  onWarning: null,
};

/**
 * 内置 token 估算：中英文混排的保守近似。
 * 中文按字符计，拉丁按空白与标点切分计，另加每条约 4 token 的消息开销。
 * 宿主环境应提供真实 tokenizer 替换它。
 */
export function defaultTokenCounter(text: string): number {
  if (text.length === 0) return 0;
  const cjk = (text.match(/[㐀-䶿一-鿿぀-ヿ]/g) ?? []).length;
  const latin = text
    .replace(/[㐀-䶿一-鿿぀-ヿ]/g, ' ')
    .split(/[\s,.;:!?()[\]{}"'`\/\\|<>+\-*=~@#$%^&_]+/)
    .filter((t) => t.length > 0).length;
  return cjk + latin;
}

/** 配置校验错误。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 合并用户配置与默认值，并做区间校验。
 * 非法配置在进入压缩流程前就失败，避免带着错误阈值静默运行。
 */
export function resolveConfig(overrides: Partial<CompressConfig> = {}): CompressConfig {
  const cfg: CompressConfig = { ...DEFAULT_CONFIG, ...overrides };

  assertRange('triggerRatio', cfg.triggerRatio, 0, 1);
  assertRange('targetRatio', cfg.targetRatio, 0, 1);
  if (cfg.targetRatio >= cfg.triggerRatio) {
    throw new ConfigError(`targetRatio(${cfg.targetRatio}) 必须小于 triggerRatio(${cfg.triggerRatio})`);
  }
  assertRange('minGapTurns', cfg.minGapTurns, 0, Number.MAX_SAFE_INTEGER);
  assertRange('maxWaitTurns', cfg.maxWaitTurns, 1, Number.MAX_SAFE_INTEGER);
  assertRange('tailTurns', cfg.tailTurns, 1, Number.MAX_SAFE_INTEGER);
  if (cfg.maxWaitTurns < cfg.minGapTurns) {
    throw new ConfigError(`maxWaitTurns(${cfg.maxWaitTurns}) 不得小于 minGapTurns(${cfg.minGapTurns})`);
  }
  assertRange('lambda', cfg.lambda, 0, 1);
  assertRange('targetBudgetTokens', cfg.targetBudgetTokens, 1, Number.MAX_SAFE_INTEGER);
  assertRange('sinkLimit', cfg.sinkLimit, 0, Number.MAX_SAFE_INTEGER);
  assertRange('softEntityRetainThreshold', cfg.softEntityRetainThreshold, 0, 1);
  assertRange('tokenEstimateTolerance', cfg.tokenEstimateTolerance, 0, 1);
  assertRange('l1OversizeLines', cfg.l1OversizeLines, 2, Number.MAX_SAFE_INTEGER);
  assertRange('l1EdgeKeepLines', cfg.l1EdgeKeepLines, 1, cfg.l1OversizeLines);
  assertRange('relevanceThreshold', cfg.relevanceThreshold, 0, 1);

  if (cfg.embeddingEnabled && cfg.embed === null) {
    throw new ConfigError('embeddingEnabled 为 true 时必须提供 embed 向量化器');
  }

  return cfg;
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} 取值 ${value} 超出合法区间 [${min}, ${max}]`);
  }
}
