/**
 * 公共契约层：本文件只声明类型、枚举与错误，**不包含任何实现、不产生任何副作用**。
 *
 * 设计约束（来自 Gherkin 契约）：
 * - 全部阈值走 {@link CompressConfig} 注入，本文件不出现任何待标定数字；
 * - 唯一硬编码常量是 {@link HARD_ENTITY_RETAIN_REQUIRED} = 1.0，它是契约本身而非阈值；
 * - 所有集合默认 `readonly`，消息序列以不可变数组持有（§9.2 原子性前提）。
 */

/* ============================================================================
 * 一、消息模型
 * ========================================================================== */

/** 消息角色。与主流 Chat Completions / Messages API 对齐。 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 消息来源厂商标记。
 * 归档时需要保存它，rehydrate 才能把原文还原成首次进入会话时的 API 格式。
 */
export type Vendor = 'anthropic' | 'openai' | 'generic';

/** assistant 发起的一次工具调用。 */
export interface ToolCall {
  /** 工具调用唯一标识，与后续 tool result 的 `toolCallId` 配对。 */
  readonly id: string;
  /** 工具名。 */
  readonly name: string;
  /** 调用参数（保留原始结构，不做序列化假设）。 */
  readonly args?: unknown;
}

/** 会话中的一条消息。 */
export interface Message {
  /** 消息唯一标识。切点、source_span、归档指针全部以它为锚。 */
  readonly id: string;
  readonly role: Role;
  /** 文本内容。tool 消息为 result 的文本载荷。 */
  readonly content: string;
  /** assistant 消息发起的工具调用（可并行多个）。 */
  readonly toolCalls?: readonly ToolCall[];
  /** tool 消息所回应的 {@link ToolCall.id}。 */
  readonly toolCallId?: string;
  /**
   * 原始载荷。归档保存它，rehydrate 才能无损还原为首次进入会话时的 API 格式，
   * 不因展平为 text 字段而丢失结构化内容。
   */
  readonly raw?: unknown;
  /** 来源厂商标记，缺省视为 `generic`。 */
  readonly vendor?: Vendor;
  /** 已知 token 数；缺省由计数钩子估算。 */
  readonly tokens?: number;
}

/* ============================================================================
 * 二、结构模型
 * ========================================================================== */

/**
 * 一个 tool block：一条发起工具调用的 assistant 消息 + 其全部 tool result。
 *
 * 铁律三：block 内的 assistant 与全部 result 必须位于切割的同一侧。
 * 拆散会直接触发 Anthropic / OpenAI API 400（§6）。
 */
export interface ToolBlock {
  readonly id: string;
  readonly startId: string;
  readonly endId: string;
  /** 组成该 block 的全部消息 ID，保持原始到达顺序，不重排。 */
  readonly msgIds: readonly string[];
  /** 全部 tool_use 都已收到对应 result。 */
  readonly complete: boolean;
  /** 未收到 result 的 tool_use 标识列表。 */
  readonly missing: readonly string[];
  /** 畸形块：孤儿 result、被下一条 assistant 工具调用截断、或其他无法配对的形态。 */
  readonly malformed: boolean;
  readonly tokens: number;
}

/** 待压缩的一个中部段。由完整 tool block 组成，切点只落在 block 之间。 */
export interface Segment {
  readonly id: string;
  readonly startId: string;
  readonly endId: string;
  readonly msgIds: readonly string[];
  /** 该段包含的 tool block ID。 */
  readonly blockIds: readonly string[];
  readonly tokens: number;
}

/**
 * 指向原始消息区间的指针。
 * 铁律一要求它永远指向 L0 原文的消息 ID，而非某个摘要块。
 */
export interface SourceSpan {
  readonly startId: string;
  readonly endId: string;
  readonly msgCount: number;
}

/** 归档指针。凭它可经 rehydrate 取回逐字原文。 */
export interface ArchiveRef {
  /** 归档记录标识。 */
  readonly ref: string;
  /** JSONL 文件中的字节偏移，用于索引重建。 */
  readonly offset: number;
  /** 原文内容哈希，用于一致性校验；不一致时抛 {@link ArchiveCorrupted}。 */
  readonly hash: string;
}

/* ============================================================================
 * 三、保护模型
 * ========================================================================== */

/**
 * pin 理由枚举。
 *
 * 说明：README §1 表述为「七种」，但 `tool-block-integrity` 场景强制要求
 * `pin_reason = tool-block-incomplete`，与另外七种并列生效，故实现按 **八值** 处理。
 * 记为待确认项 Q1（见 todo.md §3）。
 */
export type PinReason =
  /** 系统提示消息。 */
  | 'system-prompt'
  /** 用户最新一轮的原始需求文本。 */
  | 'latest-user-intent'
  /**
   * 用户提出的硬约束（「必须在原文件上原地修改，不要生成新版本」这类）。
   * 契约 `pin-protection` 场景一要求这类内容被 pin 且逐字节不变，
   * 但原枚举无对应取值，补此值以免出现「被 pin 但 reason 不属于枚举」的自相矛盾。
   * 记为待确认项 Q6（见 todo.md §3）。
   */
  | 'user-constraint'
  /** 用户消息含「记住」「以后都要」等持久性要求。 */
  | 'user-remember'
  /** 尚未被后续成功输出取代的关键报错行。 */
  | 'error-critical'
  /** 交付物绝对路径。 */
  | 'deliverable-path'
  /** 用户对高风险操作的批准记录。 */
  | 'permission-grant'
  /** 未完成的待办。 */
  | 'open-todo'
  /** tool block 配对不完整，铁律三强制 pin，任何级别都不参与压缩。 */
  | 'tool-block-incomplete';

/**
 * pin 理由优先级（由高到低）。
 * 同一内容命中多个识别信号时，只产生一条 pin 记录，reason 取优先级更高的那一种。
 */
export const PIN_REASON_PRIORITY: readonly PinReason[] = [
  'tool-block-incomplete',
  'system-prompt',
  'user-constraint',
  'permission-grant',
  'deliverable-path',
  'user-remember',
  'latest-user-intent',
  'error-critical',
  'open-todo',
] as const;

/** 一条不可压缩区记录。 */
export interface PinRecord {
  /** 被保护的消息 ID。 */
  readonly msgId: string;
  /**
   * 受保护的字符区间 `[start, end)`。
   * 局部 pin 时必填：只保护含关键信息的片段，span 之外的内容仍可下沉。
   */
  readonly span?: readonly [number, number];
  readonly reason: PinReason;
  /** 被保护的文本内容，提交前断言会比对它是否逐字节在位。 */
  readonly text: string;
}

/* ============================================================================
 * 四、产物模型
 * ========================================================================== */

/**
 * 压缩级别。
 * - L0 原文
 * - L1 抽取式去噪（唯一被强制「输出 ⊆ 输入」的级别）
 * - L2 分槽位结构化摘要
 * - L3 更粗粒度摘要
 * - L4 指针（仅说明存在过什么与如何取回）
 *
 * 铁律二：级别单调不回退，且下沉次数有上限。
 */
export type CompressLevel = 0 | 1 | 2 | 3 | 4;

/**
 * 压缩产出的实际方法。
 * 该标记必须随报告落盘，用于事后判定该段上下文的可信度（§9.1）。
 */
export type CompressMethod =
  /** LLM 摘要成功。 */
  | 'llm'
  /** 降级为规则抽取式。 */
  | 'heuristic'
  /** 降级为硬截断。 */
  | 'truncate'
  /** 未压缩（纯保留或 pin 段）。 */
  | 'none';

/** 压缩产物。 */
export interface CompressedBlock {
  readonly id: string;
  readonly level: CompressLevel;
  readonly method: CompressMethod;
  /** 进入上下文的文本。 */
  readonly text: string;
  /** 永远指向 L0 原文的消息 ID，不指向另一个摘要块。 */
  readonly sourceSpan: SourceSpan;
  /** L4 与全部有损级别必须非空，否则禁止下沉。 */
  readonly archiveRef: ArchiveRef | null;
  /** 产出时的 epoch。 */
  readonly epoch: number;
  /** 已下沉次数，达配置上限后停止有损重压。 */
  readonly compressCount: number;
  readonly tokens: number;
  /** 本块是否走了降级链。 */
  readonly degraded: boolean;
}

/* ============================================================================
 * 五、决策模型
 * ========================================================================== */

/** 触发决策原因。 */
export type TriggerReason =
  /** 占用低于触发线。 */
  | 'below-trigger'
  /** 落在迟滞带内，防抖动。 */
  | 'hysteresis-band'
  /** 命中任务边界。 */
  | 'task-boundary'
  /** 无边界但超过等待上限，强制压缩。 */
  | 'forced'
  /** 距上次压缩的轮数小于频率下限。 */
  | 'rate-limit'
  /** 压缩后占用已落到目标线以下。 */
  | 'post-compress-settled'
  /** 找不到安全切点，放弃本轮。 */
  | 'no-safe-cut'
  /** 触发钩子抛异常，保守地不压缩。 */
  | 'hook-error'
  /** 占用超线但仍在等待任务边界，且未超等待上限。 */
  | 'waiting-boundary'
  /**
   * 宿主以布尔形式返回 shouldCompress（R5-8）：库无法得知真实原因，
   * 如实标注为宿主决策，不伪造 task-boundary（该原因要求携带 cutPointId）。
   */
  | 'host-decision';

/** 任务边界类型。切点优先落在这类边界上。 */
export type BoundaryType =
  /** 一条待办状态由 pending 翻转为 completed。 */
  | 'todo-transition'
  /** 一段连续工具调用序列终止且后续为纯文本。 */
  | 'tool-seq-end'
  /** 助手输出了交付总结且用户随后发起新话题。 */
  | 'delivery-summary'
  /** 用户新消息与前一话题的增益相关性低于阈值。 */
  | 'topic-shift';

/** 触发判定结果。 */
export interface TriggerDecision {
  /** 是否执行压缩。 */
  readonly compress: boolean;
  readonly reason: TriggerReason;
  /** 命中任务边界时的切点消息 ID。 */
  readonly cutPointId?: string;
  /** 命中任务边界时的边界类型。 */
  readonly boundaryType?: BoundaryType;
  /** 是否为强制压缩（无边界且超等待上限）。 */
  readonly forced: boolean;
  /** 本轮 epoch 快照。 */
  readonly epoch: number;
}

/** 单个段的预算分配结果。 */
export interface BudgetAssignment {
  readonly segmentId: string;
  /** 与 anchor 的相关性，取值区间 [0, 1]。 */
  readonly relevance: number;
  /** 与已保留内容的最大冗余度，取值区间 [0, 1]。 */
  readonly redundancy: number;
  /** 增益 = 相关性 − λ × 冗余度。 */
  readonly gain: number;
  /** 分配到的 token 预算。 */
  readonly budget: number;
  /** 目标下沉级别。语义反转要求最低增益也只到 L4，绝不删除。 */
  readonly targetLevel: CompressLevel;
}

/* ============================================================================
 * 六、报告与观测模型
 * ========================================================================== */

/** 受校验的实体类别。 */
export type EntityCategory =
  /** 硬实体：Windows 绝对路径。 */
  | 'windows-path'
  /** 硬实体：POSIX 路径。 */
  | 'posix-path'
  /** 硬实体：URL。 */
  | 'url'
  /** 硬实体：UUID 或 commit hash。 */
  | 'uuid-or-hash'
  /** 硬实体：反引号包裹的命令与符号。 */
  | 'command-symbol'
  /** 软实体：数值与百分比。 */
  | 'number-percent'
  /** 软实体：人名与专名。 */
  | 'person-name';

/** 硬实体类别集合。这些类别的保留率要求恒为 1.0。 */
export const HARD_ENTITY_CATEGORIES: readonly EntityCategory[] = [
  'windows-path',
  'posix-path',
  'url',
  'uuid-or-hash',
  'command-symbol',
] as const;

/**
 * 硬实体保留率要求。
 * 它不是阈值而是契约本身：路径、URL、UUID、命令符号错一个字符，
 * Agent 就会对错误目标执行破坏性操作，因此没有标定空间。
 */
export const HARD_ENTITY_RETAIN_REQUIRED = 1.0 as const;

/**
 * 进阶事实问答（§8.3）的一题。问题与答案由槽位确定性生成，不调用额外模型。
 */
export interface SlotQuestion {
  /** 所属槽位类别。 */
  readonly category: 'constraints' | 'artifacts' | 'todos';
  readonly question: string;
  /** 标准答案 = 槽位取值，必须可在原文中逐字定位。 */
  readonly answer: string;
}

/** 实体校验报告。 */
export interface VerifyReport {
  readonly passed: boolean;
  /** 每一类实体的独立保留率，供事后审计而非只给总体布尔值。 */
  readonly entityRetain: Readonly<Record<EntityCategory, number>>;
  /** 缺失的具体实体值，便于定位。 */
  readonly missing: readonly string[];
  /** 校验器自身抛异常时为 true —— 必须视为不通过而非放行。 */
  readonly hookError: boolean;
  /** 软实体未达阈值时的处置记录，不静默忽略。 */
  readonly warnings: readonly string[];
  /** §8.3 进阶问答的题目；仅 advancedVerifyEnabled 开启且有槽位时非空。 */
  readonly qa?: readonly SlotQuestion[];
}

/** prompt cache 影响。稳定前缀是避免 cache 全 miss 的关键（§7.2）。 */
export interface CacheImpact {
  /** 头部消息序列在压缩前后是否逐字节相同。 */
  readonly prefixStable: boolean;
  /** cache_control 断点位置是否仍位于头部之后、首个压缩块之前。 */
  readonly breakpointAfterHead: boolean;
}

/** 一轮压缩的观测记录。以回调或事件形式暴露，不绑定任何特定监控实现。 */
export interface ObservationRecord {
  readonly epoch: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** 压缩比 afterTokens / beforeTokens。 */
  readonly ratio: number;
  readonly durationMs: number;
  readonly level: CompressLevel;
  readonly method: CompressMethod;
  /** 本轮是否走了降级。 */
  readonly degraded: boolean;
  readonly pinCount: number;
  readonly cacheImpact: CacheImpact;
  /**
   * 本轮触发原因（R5-8 可观测性扩展，可选以保持向后兼容）。
   * 宿主布尔返回的 shouldCompress 如实标注为 'host-decision'，不伪造 task-boundary。
   */
  readonly triggerReason?: TriggerReason;
  /** 本轮告警。 */
  readonly warnings: readonly string[];
}

/* ============================================================================
 * 七、上下文状态
 * ========================================================================== */

/**
 * 上下文状态。
 * `msgs` 以不可变数组持有，压缩采用「构造 next_msgs → 断言 → 整体替换」的提交方式，
 * 中途失败则引用与内容逐字节保持原样（§9.2 原子性）。
 */
export interface ContextState {
  readonly msgs: readonly Message[];
  /** 单调递增值，每次成功提交 +1，用于 CAS 冲突检测。 */
  readonly epoch: number;
  readonly blocks: readonly ToolBlock[];
  readonly pins: readonly PinRecord[];
  readonly compressed: readonly CompressedBlock[];
  readonly tokens: number;
  /** 上下文窗口容量。 */
  readonly capacity: number;
}

/* ============================================================================
 * 八、错误模型
 * ========================================================================== */

/** 压缩错误码。 */
export type CompressErrorCode =
  /** 三级降级全部失败，压缩不可能完成。 */
  | 'no-compression-possible'
  /** 归档内容哈希不一致。 */
  | 'archive-corrupted'
  /** 归档不可用，禁止有损下沉。 */
  | 'archive-unavailable'
  /** 用户钩子抛异常。 */
  | 'hook-error'
  /** 提交前断言失败，整体回滚。 */
  | 'commit-assert-failed'
  /** 提交前断言失败的具体项。 */
  | 'verify-failed';

/** 压缩错误基类。 */
export class CompressError extends Error {
  readonly code: CompressErrorCode;
  /** 结构化上下文，便于宿主环境记录与上报。 */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CompressErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CompressError';
    this.code = code;
    this.details = details;
  }
}

/** 三级降级链全部失败。上下文必须保持逐字节原样。 */
export class NoCompressionPossible extends CompressError {
  constructor(message = 'llm、heuristic、truncate 三级均无法产出合法结果', details: Record<string, unknown> = {}) {
    super('no-compression-possible', message, details);
    this.name = 'NoCompressionPossible';
  }
}

/** 归档内容哈希与实际内容不一致，拒绝回溯、拒绝基于它的下沉。 */
export class ArchiveCorrupted extends CompressError {
  constructor(message = '归档内容与 source_hash 不一致', details: Record<string, unknown> = {}) {
    super('archive-corrupted', message, details);
    this.name = 'ArchiveCorrupted';
  }
}

/** 归档不可用。禁止有损下沉，但仍允许无归档需求的 L1 无损裁剪。 */
export class ArchiveUnavailable extends CompressError {
  constructor(message = '归档存储不可用', details: Record<string, unknown> = {}) {
    super('archive-unavailable', message, details);
    this.name = 'ArchiveUnavailable';
  }
}

/** 用户钩子抛异常。携带钩子名，便于区分 shouldCompress / onPreCompress / selectSegment 等不同处置方向。 */
export class HookError extends CompressError {
  readonly hook: string;

  constructor(hook: string, cause: unknown) {
    super('hook-error', `钩子 ${hook} 抛出异常`, { hook, cause });
    this.name = 'HookError';
    this.hook = hook;
  }
}

/** 提交前断言失败。整体回滚，告警必须指明失败的断言项。 */
export class CommitAssertFailed extends CompressError {
  /** 失败的断言项：配对完整 / pin 在位 / token 一致。 */
  readonly assertion: 'tool-block-pairing' | 'pin-in-place' | 'token-consistency';

  constructor(assertion: 'tool-block-pairing' | 'pin-in-place' | 'token-consistency', message: string, details: Record<string, unknown> = {}) {
    super('commit-assert-failed', message, { assertion, ...details });
    this.name = 'CommitAssertFailed';
    this.assertion = assertion;
  }
}
