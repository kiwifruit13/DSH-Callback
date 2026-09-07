# dsh-callback API 参考

> 本文档由 `scripts/generate-api-docs.ts` 自动生成，以代码为唯一真相源。
> 人工修改会被下次生成覆盖。若需更新 API 描述，请修改源码 TSDoc 后重新生成。

共 117 个公开符号，入口 `src/index.ts`。

## src/api.ts

### `ContextCompressor`

**种类**：接口 · **定义模块**：`src/api.ts`

压缩器实例。

```ts
export interface ContextCompressor {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `maybeCompress` | `(state: ContextState) => Promise<ContextState>` | 否 | 对当前状态评估并执行（或跳过）一轮压缩。 返回值要么是全新的 ContextState（已提交，epoch+1）， 要么是原状态引用逐字节不变（未触发 / 中止 / 回滚）。 |
| `observations` | `() => readonly ObservationRecord[]` | 否 | 全部观测记录。 |
| `config` | `CompressConfig` | 否 | 生效配置（合并默认值后）。 |

### `CreateCompressorOptions`

**种类**：接口 · **定义模块**：`src/api.ts`

```ts
export interface CreateCompressorOptions {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `config` | `Partial<CompressConfig> \| undefined` | 是 | 配置覆盖。未提供的项取 DEFAULT_CONFIG 占位值，建议按 §13 标定后显式传入。 |
| `callbacks` | `CompressCallbacks` | 否 | 宿主回调。compress 为必填语义，其余钩子缺省走默认实现。 |

### `createContextCompressor`

**种类**：函数 · **定义模块**：`src/api.ts`

创建压缩器。非法配置在此即刻失败，不带入压缩流程。

```ts
(options: CreateCompressorOptions): ContextCompressor
```

## src/archive.ts

### `Archive`

**种类**：接口 · **定义模块**：`src/archive.ts`

归档存储门面。

```ts
export interface Archive {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `isAvailable` | `() => Promise<boolean>` | 否 | 存储是否可用。不可用时应禁止有损下沉。 |
| `archive` | `(msgs: readonly Message[], vendor?: string \| undefined) => Promise<ArchiveRef \| null>` | 否 | 归档一段原文。相同内容只存一次，返回既有或新建的指针。 归档不可用时返回 null，由调用方决定是否拒绝下沉。 |
| `rehydrate` | `(ref: ArchiveRef) => Promise<readonly Message[]>` | 否 | 凭指针取回原文。哈希不一致抛 {@link ArchiveCorrupted}。 |
| `rebuildIndex` | `() => Promise<number>` | 否 | 重建索引，返回条目数。用于进程重启后索引丢失的场景。 |
| `size` | `() => number` | 否 | 当前归档条目数。 |

### `createArchive`

**种类**：函数 · **定义模块**：`src/archive.ts`

创建归档门面。 `sink` 为 null 表示无归档能力：此时 `archive()` 恒返回 null、`isAvailable()` 恒为 false。

```ts
(sink: ArchiveSink | null, hash?: HashFn): Archive
```

### `defaultHash`

**种类**：常量 · **定义模块**：`src/archive.ts`

默认哈希：SHA-256 十六进制。

```ts
HashFn
```

**值**：`(text) => createHash('sha256').update(text, 'utf8').digest('hex')`

### `HashFn`

**种类**：类型别名 · **定义模块**：`src/archive.ts`

哈希函数。宿主可注入（例如浏览器环境替换 node:crypto）。

```ts
(text: string) => string
```

### `hashMessages`

**种类**：函数 · **定义模块**：`src/archive.ts`

一批原文的 source_hash。

```ts
(msgs: readonly Message[], hash?: HashFn): string
```

### `JsonlArchiveSink`

**种类**：类 · **定义模块**：`src/archive.ts`

JSONL 追加文件归档 sink。

```ts
new (filePath: string): JsonlArchiveSink
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `filePath` | `string` | 否 |  |
| `append` | `(record: Omit<ArchiveRecord, "offset">) => Promise<number>` | 否 | 追加一条归档记录，返回其字节偏移。 |
| `read` | `(ref: string) => Promise<ArchiveRecord \| null>` | 否 | 按 ref 读取一条记录。 |
| `readAll` | `() => AsyncIterable<ArchiveRecord>` | 否 | 全量遍历，用于索引丢失后重建。 |
| `available` | `() => boolean` | 否 | 存储是否可用。写入失败或不可用时返回 false。 |
| `ensureDir` | `() => void` | 否 |  |

### `MemoryArchiveSink`

**种类**：类 · **定义模块**：`src/archive.ts`

内存归档 sink。 无文件系统权限或不想落盘时的等价实现，语义与 JSONL 版一致（只追加、偏移单调）。

```ts
class MemoryArchiveSink
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `records` | `ArchiveRecord[]` | 否 |  |
| `cursor` | `number` | 否 |  |
| `append` | `(record: Omit<ArchiveRecord, "offset">) => Promise<number>` | 否 | 追加一条归档记录，返回其字节偏移。 |
| `read` | `(ref: string) => Promise<ArchiveRecord \| null>` | 否 | 按 ref 读取一条记录。 |
| `readAll` | `() => AsyncIterable<ArchiveRecord>` | 否 | 全量遍历，用于索引丢失后重建。 |
| `available` | `() => boolean` | 否 | 存储是否可用。写入失败或不可用时返回 false。 |

## src/blocks.ts

### `isBlockCompressible`

**种类**：函数 · **定义模块**：`src/blocks.ts`

该块是否可参与压缩。不完整或畸形的块被强制 pin，任何级别都不参与。

```ts
(block: ToolBlock): boolean
```

### `msgTokens`

**种类**：函数 · **定义模块**：`src/blocks.ts`

单条消息的 token 数。消息自带计数优先，否则用配置的计数器估算。

```ts
(msg: Message, countTokens: TokenCounter): number
```

### `parseToolBlocks`

**种类**：函数 · **定义模块**：`src/blocks.ts`

解析会话中的全部 tool block。

```ts
(msgs: readonly Message[], countTokens: TokenCounter): ToolBlock[]
```

### `segmentsAreSafe`

**种类**：函数 · **定义模块**：`src/blocks.ts`

校验切割结果：任一段的首尾都必须是完整 block。提交前断言会用到。

```ts
(segments: readonly Segment[], blocks: readonly ToolBlock[]): boolean
```

### `selectSegment`

**种类**：函数 · **定义模块**：`src/blocks.ts`

默认中部段切割。

```ts
(state: ContextState, config: CompressConfig): Segment[]
```

### `totalTokens`

**种类**：函数 · **定义模块**：`src/blocks.ts`

一批消息的总 token 数。

```ts
(msgs: readonly Message[], countTokens: TokenCounter): number
```

## src/callbacks.ts

### `CompressCallbacks`

**种类**：接口 · **定义模块**：`src/callbacks.ts`

六个可注入钩子。全部可选，缺省走默认实现。

```ts
export interface CompressCallbacks {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `shouldCompress` | `((state: ContextState, config: CompressConfig) => boolean \| TriggerDecision) \| undefined` | 是 | 触发判定。返回 boolean 或完整决策。 抛异常时视为**不压缩**。 |
| `selectSegment` | `((state: ContextState, config: CompressConfig) => readonly Segment[] \| null) \| undefined` | 是 | 中部段切割。返回空数组表示无安全切点，本轮放弃。 抛异常时**中止本轮压缩**且不回退到任何默认切割实现。 |
| `onPreCompress` | `((state: ContextState, config: CompressConfig) => readonly PinRecord[]) \| undefined` | 是 | pin 识别。返回本轮识别到的全部保护记录。 抛异常时**继续**，退回静态 pin 白名单，并记一条 pin_hook_degraded 告警。 |
| `compress` | `(input: CompressInput, signal: AbortSignal) => CompressOutput \| Promise<CompressOutput>` | 否 | 压缩执行。这是唯一必须提供的钩子。 超时由 {@link CompressInput.signal} 控制，失败走降级链。 |
| `verify` | `((input: VerifyInput, config: CompressConfig) => VerifyReport) \| undefined` | 是 | 实体校验。 抛异常时**视为不通过**，走 §8.2 降级链，并记 verify_hook_error 告警。 |
| `onError` | `((error: unknown, context: ErrorContext) => void) \| undefined` | 是 | 错误出口。自身抛出的异常会被静默吞掉，不得影响主流程。 |

### `CompressInput`

**种类**：接口 · **定义模块**：`src/callbacks.ts`

compress 钩子的入参。

```ts
export interface CompressInput {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `text` | `string` | 否 | 待压缩的**原文**文本。铁律一：永远从 L0 原文压缩，绝不传摘要。 |
| `level` | `CompressLevel` | 否 | 目标级别。 |
| `budget` | `number` | 否 | 该段的 token 预算。 |
| `key` | `IdempotencyKey` | 否 | 幂等键，宿主可据此自行缓存。 |
| `signal` | `AbortSignal` | 否 | 超时中断信号。宿主必须响应它，否则超时后仍会残留未取消的网络调用。 |
| `config` | `CompressConfig` | 否 |  |

### `CompressOutput`

**种类**：接口 · **定义模块**：`src/callbacks.ts`

compress 钩子的出参。

```ts
export interface CompressOutput {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `text` | `string` | 否 | 压缩后的文本。L1 级别下它必须是 input.text 的子集。 |
| `slots` | `SummarySlots \| undefined` | 是 | L2 及以上的分槽位结果。省略时框架按纯文本处理。 |

### `ErrorContext`

**种类**：接口 · **定义模块**：`src/callbacks.ts`

错误上下文。

```ts
export interface ErrorContext {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `hook` | `string \| null` | 否 | 出错的钩子名，未命中钩子时为 null。 |
| `phase` | `"trigger" \| "select" \| "pin" \| "compress" \| "verify" \| "commit"` | 否 | 所处阶段。 |
| `state` | `ContextState` | 否 | 出错时的上下文快照引用。 |

### `FallbackLevel`

**种类**：接口 · **定义模块**：`src/callbacks.ts`

降级链每一级的实现签名，供 {@link CompressCallbacks.compress} 之外的兜底级复用。

```ts
export interface FallbackLevel {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `method` | `CompressMethod` | 否 |  |
| `run` | `(input: CompressInput, signal: AbortSignal) => CompressOutput \| Promise<CompressOutput>` | 否 |  |

### `IdempotencyKey`

**种类**：接口 · **定义模块**：`src/callbacks.ts`

幂等键。四元组 (startId, endId, level, epoch)。 相同幂等键重复请求必须复用缓存结果，避免重复消耗 LLM 调用与缓存抖动。

```ts
export interface IdempotencyKey {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `startId` | `string` | 否 |  |
| `endId` | `string` | 否 |  |
| `level` | `CompressLevel` | 否 |  |
| `epoch` | `number` | 否 |  |

### `idempotencyKeyOf`

**种类**：函数 · **定义模块**：`src/callbacks.ts`

把幂等键序列化为稳定字符串，用作缓存键。

```ts
(key: IdempotencyKey): string
```

### `SummarySlots`

**种类**：接口 · **定义模块**：`src/callbacks.ts`

L2 分槽位摘要（§5）。

```ts
export interface SummarySlots {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `constraints` | `readonly string[]` | 否 | 用户硬约束，逐字摘抄。 |
| `artifacts` | `readonly string[]` | 否 | 交付物路径与标识，逐字摘抄。 |
| `todos` | `readonly string[]` | 否 | 待办项，逐字摘抄。 |
| `narrative` | `string` | 否 | 叙述性摘要，允许改写。 |

### `VerifyInput`

**种类**：接口 · **定义模块**：`src/callbacks.ts`

verify 钩子的入参。

```ts
export interface VerifyInput {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `original` | `string` | 否 | 原文文本。 |
| `summary` | `string` | 否 | 待校验的摘要文本。 |
| `level` | `CompressLevel` | 否 | 摘要所属级别。 |
| `config` | `CompressConfig` | 否 |  |

## src/config.ts

### `ArchiveRecord`

**种类**：接口 · **定义模块**：`src/config.ts`

归档记录。JSONL 追加文件的一行。 保存 raw 与 vendor 是为了 rehydrate 能无损还原为首次进入会话时的 API 格式。

```ts
export interface ArchiveRecord {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `ref` | `string` | 否 | 归档记录标识，与 {@link import ('./contract.js').ArchiveRef.ref} 对应。 |
| `offset` | `number` | 否 | JSONL 文件中的字节偏移。 |
| `hash` | `string` | 否 | 原文内容哈希，即 source_hash。 |
| `msgs` | `readonly Message[]` | 否 | 被归档的原始消息序列。 |
| `vendor` | `string` | 否 | 来源厂商标记。 |

### `ArchiveSink`

**种类**：接口 · **定义模块**：`src/config.ts`

归档存储抽象。

```ts
export interface ArchiveSink {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `append` | `(record: Omit<ArchiveRecord, "offset">) => Promise<number>` | 否 | 追加一条归档记录，返回其字节偏移。 |
| `read` | `(ref: string) => Promise<ArchiveRecord \| null>` | 否 | 按 ref 读取一条记录。 |
| `readAll` | `() => AsyncIterable<ArchiveRecord>` | 否 | 全量遍历，用于索引丢失后重建。 |
| `available` | `() => boolean \| Promise<boolean>` | 否 | 存储是否可用。写入失败或不可用时返回 false。 |

### `CompressConfig`

**种类**：接口 · **定义模块**：`src/config.ts`

压缩配置。全部阈值集中于此，源码其余位置不得出现待标定数字。

```ts
export interface CompressConfig {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `triggerRatio` | `number` | 否 | 触发线：占用率高于此值才考虑压缩。 |
| `targetRatio` | `number` | 否 | 目标线：压缩后应回落到此值以下。必须小于 triggerRatio。 |
| `minGapTurns` | `number` | 否 | 频率下限轮数：距上次成功压缩小于此轮数则抑制，避免临界点反复压缩。 |
| `maxWaitTurns` | `number` | 否 | 等待上限轮数：始终无任务边界且超过此轮数则强制压缩。 |
| `relevanceThreshold` | `number` | 否 | topic-shift 边界判定用的增益相关性阈值。 |
| `tailTurns` | `number` | 否 | 尾部保留的消息条数。这些消息永不压缩，保证最近上下文始终完整在场。 |
| `sinkLimit` | `number` | 否 | 下沉次数上限：compress_count 达此值即停止有损重压，直接落 L4。 |
| `maxLevel` | `CompressLevel` | 否 | 允许的最深级别。 |
| `lambda` | `number` | 否 | 冗余度权重 λ。增益 = 相关性 − λ × 冗余度。 |
| `targetBudgetTokens` | `number` | 否 | 中部段的目标 token 预算。各段 budget 之和不得超过它。 |
| `embeddingEnabled` | `boolean` | 否 | 是否启用 embedding。关闭时退化为纯 TF-IDF 字符二元组，无任何网络调用。 |
| `softEntityRetainThreshold` | `number` | 否 | 软实体保留率阈值，低于则按配置处置（告警但允许通过）。 |
| `softEntityAction` | `Readonly<Partial<Record<EntityCategory, "warn" \| "reject">>>` | 否 | 各类软实体的处置动作。 |
| `advancedVerifyEnabled` | `boolean` | 否 | 进阶事实问答校验开关，默认关闭（会调用额外模型）。 |
| `llmTimeoutMs` | `number` | 否 | LLM 摘要级超时（毫秒），由 AbortController 控制。 |
| `heuristicTimeoutMs` | `number` | 否 | 规则抽取级超时（毫秒）。 |
| `truncateTimeoutMs` | `number` | 否 | 硬截断级超时（毫秒）。 |
| `llmRetryCount` | `number` | 否 | LLM 返回非法 JSON 时的重试次数。契约要求最多一次。 |
| `tokenEstimateTolerance` | `number` | 否 | 提交断言：next_msgs 实际 token 数与预估值的容许偏差比例，超出则回滚。 |
| `l1OversizeLines` | `number` | 否 | 单条工具 stdout 超过该行数视为超长，只保留首尾。 |
| `l1EdgeKeepLines` | `number` | 否 | 超长 stdout 保留的首部与尾部行数。 |
| `archive` | `ArchiveSink \| null` | 否 | 归档存储。为 null 表示无归档能力，此时禁止有损下沉。 |
| `countTokens` | `TokenCounter` | 否 | token 计数器。 |
| `embed` | `Embedder \| null` | 否 | 文本向量化器。embeddingEnabled 为 true 时必须提供。 |
| `onObservation` | `ObservationHook \| null` | 否 | 观测回调。 |
| `onWarning` | `WarningHook \| null` | 否 | 告警回调。 |

### `ConfigError`

**种类**：类 · **定义模块**：`src/config.ts`

配置校验错误。

```ts
new (message: string): ConfigError
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `name` | `string` | 否 |  |
| `message` | `string` | 否 |  |
| `stack` | `string \| undefined` | 是 |  |
| `cause` | `unknown` | 是 |  |

### `DEFAULT_CONFIG`

**种类**：常量 · **定义模块**：`src/config.ts`

保守占位默认值。规划 §13 实测标定后替换。

```ts
CompressConfig
```

**值**：`{ triggerRatio: 0.7, targetRatio: 0.5, minGapTurns: 3, maxWaitTurns: 12, relevanceThreshold: 0.15, tailTurns: 6, sinkLim…`

### `defaultTokenCounter`

**种类**：函数 · **定义模块**：`src/config.ts`

内置 token 估算：中英文混排的保守近似。 中文按字符计，拉丁按空白与标点切分计，另加每条约 4 token 的消息开销。 宿主环境应提供真实 tokenizer 替换它。

```ts
(text: string): number
```

### `Embedder`

**种类**：类型别名 · **定义模块**：`src/config.ts`

文本向量化钩子。开启 embedding 时由宿主提供；缺省走内置 TF-IDF。

```ts
(text: string) => readonly number[]
```

### `ObservationHook`

**种类**：类型别名 · **定义模块**：`src/config.ts`

观测回调。以回调形式暴露，不绑定任何特定监控实现。

```ts
(record: import('./contract.js').ObservationRecord) => void
```

### `resolveConfig`

**种类**：函数 · **定义模块**：`src/config.ts`

合并用户配置与默认值，并做区间校验。 非法配置在进入压缩流程前就失败，避免带着错误阈值静默运行。

```ts
(overrides?: Partial<CompressConfig>): CompressConfig
```

### `TokenCounter`

**种类**：类型别名 · **定义模块**：`src/config.ts`

token 计数钩子。宿主环境可提供真实 tokenizer；缺省走内置估算。

```ts
(text: string) => number
```

### `WarningHook`

**种类**：类型别名 · **定义模块**：`src/config.ts`

告警回调。用于 pin_hook_degraded、archive-unavailable 等可观测降级信号。

```ts
(warning: string, details?: Record<string, unknown>) => void
```

## src/contract.ts

### `ArchiveCorrupted`

**种类**：类 · **定义模块**：`src/contract.ts`

归档内容哈希与实际内容不一致，拒绝回溯、拒绝基于它的下沉。

```ts
new (message?: string, details?: Record<string, unknown>): ArchiveCorrupted
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `code` | `CompressErrorCode` | 否 |  |
| `details` | `Readonly<Record<string, unknown>>` | 否 | 结构化上下文，便于宿主环境记录与上报。 |
| `name` | `string` | 否 |  |
| `message` | `string` | 否 |  |
| `stack` | `string \| undefined` | 是 |  |
| `cause` | `unknown` | 是 |  |

### `ArchiveRef`

**种类**：接口 · **定义模块**：`src/contract.ts`

归档指针。凭它可经 rehydrate 取回逐字原文。

```ts
export interface ArchiveRef {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `ref` | `string` | 否 | 归档记录标识。 |
| `offset` | `number` | 否 | JSONL 文件中的字节偏移，用于索引重建。 |
| `hash` | `string` | 否 | 原文内容哈希，用于一致性校验；不一致时抛 {@link ArchiveCorrupted}。 |

### `ArchiveUnavailable`

**种类**：类 · **定义模块**：`src/contract.ts`

归档不可用。禁止有损下沉，但仍允许无归档需求的 L1 无损裁剪。

```ts
new (message?: string, details?: Record<string, unknown>): ArchiveUnavailable
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `code` | `CompressErrorCode` | 否 |  |
| `details` | `Readonly<Record<string, unknown>>` | 否 | 结构化上下文，便于宿主环境记录与上报。 |
| `name` | `string` | 否 |  |
| `message` | `string` | 否 |  |
| `stack` | `string \| undefined` | 是 |  |
| `cause` | `unknown` | 是 |  |

### `BoundaryType`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

任务边界类型。切点优先落在这类边界上。

```ts
| 'todo-transition'
  /** 一段连续工具调用序列终止且后续为纯文本。 */
  | 'tool-seq-end'
  /** 助手输出了交付总结且用户随后发起新话题。 */
  | 'delivery-summary'
  /** 用户新消息与前一话题的增益相关性低于阈值。 */
  | 'topic-shift'
```

**取值**：

- `"todo-transition"` — 一条待办状态由 pending 翻转为 completed。
- `"tool-seq-end"` — 一段连续工具调用序列终止且后续为纯文本。
- `"delivery-summary"` — 助手输出了交付总结且用户随后发起新话题。
- `"topic-shift"` — 用户新消息与前一话题的增益相关性低于阈值。

### `BudgetAssignment`

**种类**：接口 · **定义模块**：`src/contract.ts`

单个段的预算分配结果。

```ts
export interface BudgetAssignment {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `segmentId` | `string` | 否 |  |
| `relevance` | `number` | 否 | 与 anchor 的相关性，取值区间 [0, 1]。 |
| `redundancy` | `number` | 否 | 与已保留内容的最大冗余度，取值区间 [0, 1]。 |
| `gain` | `number` | 否 | 增益 = 相关性 − λ × 冗余度。 |
| `budget` | `number` | 否 | 分配到的 token 预算。 |
| `targetLevel` | `CompressLevel` | 否 | 目标下沉级别。语义反转要求最低增益也只到 L4，绝不删除。 |

### `CacheImpact`

**种类**：接口 · **定义模块**：`src/contract.ts`

prompt cache 影响。稳定前缀是避免 cache 全 miss 的关键（§7.2）。

```ts
export interface CacheImpact {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `prefixStable` | `boolean` | 否 | 头部消息序列在压缩前后是否逐字节相同。 |
| `breakpointAfterHead` | `boolean` | 否 | cache_control 断点位置是否仍位于头部之后、首个压缩块之前。 |

### `CommitAssertFailed`

**种类**：类 · **定义模块**：`src/contract.ts`

提交前断言失败。整体回滚，告警必须指明失败的断言项。

```ts
new (assertion: "tool-block-pairing" | "pin-in-place" | "token-consistency", message: string, details?: Record<string, unknown>): CommitAssertFailed
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `assertion` | `"tool-block-pairing" \| "pin-in-place" \| "token-consistency"` | 否 | 失败的断言项：配对完整 / pin 在位 / token 一致。 |
| `code` | `CompressErrorCode` | 否 |  |
| `details` | `Readonly<Record<string, unknown>>` | 否 | 结构化上下文，便于宿主环境记录与上报。 |
| `name` | `string` | 否 |  |
| `message` | `string` | 否 |  |
| `stack` | `string \| undefined` | 是 |  |
| `cause` | `unknown` | 是 |  |

### `CompressedBlock`

**种类**：接口 · **定义模块**：`src/contract.ts`

压缩产物。

```ts
export interface CompressedBlock {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `id` | `string` | 否 |  |
| `level` | `CompressLevel` | 否 |  |
| `method` | `CompressMethod` | 否 |  |
| `text` | `string` | 否 | 进入上下文的文本。 |
| `sourceSpan` | `SourceSpan` | 否 | 永远指向 L0 原文的消息 ID，不指向另一个摘要块。 |
| `archiveRef` | `ArchiveRef \| null` | 否 | L4 与全部有损级别必须非空，否则禁止下沉。 |
| `epoch` | `number` | 否 | 产出时的 epoch。 |
| `compressCount` | `number` | 否 | 已下沉次数，达配置上限后停止有损重压。 |
| `tokens` | `number` | 否 |  |
| `degraded` | `boolean` | 否 | 本块是否走了降级链。 |

### `CompressError`

**种类**：类 · **定义模块**：`src/contract.ts`

压缩错误基类。

```ts
new (code: CompressErrorCode, message: string, details?: Record<string, unknown>): CompressError
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `code` | `CompressErrorCode` | 否 |  |
| `details` | `Readonly<Record<string, unknown>>` | 否 | 结构化上下文，便于宿主环境记录与上报。 |
| `name` | `string` | 否 |  |
| `message` | `string` | 否 |  |
| `stack` | `string \| undefined` | 是 |  |
| `cause` | `unknown` | 是 |  |

### `CompressErrorCode`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

压缩错误码。

```ts
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
  | 'verify-failed'
```

**取值**：

- `"no-compression-possible"` — 三级降级全部失败，压缩不可能完成。
- `"archive-corrupted"` — 归档内容哈希不一致。
- `"archive-unavailable"` — 归档不可用，禁止有损下沉。
- `"hook-error"` — 用户钩子抛异常。
- `"commit-assert-failed"` — 提交前断言失败，整体回滚。
- `"verify-failed"` — 提交前断言失败的具体项。

### `CompressLevel`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

压缩级别。 - L0 原文 - L1 抽取式去噪（唯一被强制「输出 ⊆ 输入」的级别） - L2 分槽位结构化摘要 - L3 更粗粒度摘要 - L4 指针（仅说明存在过什么与如何取回）

```ts
0 | 1 | 2 | 3 | 4
```

### `CompressMethod`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

压缩产出的实际方法。 该标记必须随报告落盘，用于事后判定该段上下文的可信度（§9.1）。

```ts
| 'llm'
  /** 降级为规则抽取式。 */
  | 'heuristic'
  /** 降级为硬截断。 */
  | 'truncate'
  /** 未压缩（纯保留或 pin 段）。 */
  | 'none'
```

**取值**：

- `"llm"` — LLM 摘要成功。
- `"heuristic"` — 降级为规则抽取式。
- `"truncate"` — 降级为硬截断。
- `"none"` — 未压缩（纯保留或 pin 段）。

### `ContextState`

**种类**：接口 · **定义模块**：`src/contract.ts`

上下文状态。 `msgs` 以不可变数组持有，压缩采用「构造 next_msgs → 断言 → 整体替换」的提交方式， 中途失败则引用与内容逐字节保持原样（§9.2 原子性）。

```ts
export interface ContextState {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `msgs` | `readonly Message[]` | 否 |  |
| `epoch` | `number` | 否 | 单调递增值，每次成功提交 +1，用于 CAS 冲突检测。 |
| `blocks` | `readonly ToolBlock[]` | 否 |  |
| `pins` | `readonly PinRecord[]` | 否 |  |
| `compressed` | `readonly CompressedBlock[]` | 否 |  |
| `tokens` | `number` | 否 |  |
| `capacity` | `number` | 否 | 上下文窗口容量。 |

### `EntityCategory`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

受校验的实体类别。

```ts
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
  | 'person-name'
```

**取值**：

- `"windows-path"` — 硬实体：Windows 绝对路径。
- `"posix-path"` — 硬实体：POSIX 路径。
- `"url"` — 硬实体：URL。
- `"uuid-or-hash"` — 硬实体：UUID 或 commit hash。
- `"command-symbol"` — 硬实体：反引号包裹的命令与符号。
- `"number-percent"` — 软实体：数值与百分比。
- `"person-name"` — 软实体：人名与专名。

### `HARD_ENTITY_CATEGORIES`

**种类**：常量 · **定义模块**：`src/contract.ts`

硬实体类别集合。这些类别的保留率要求恒为 1.0。

```ts
readonly EntityCategory[]
```

**值**：`[ 'windows-path', 'posix-path', 'url', 'uuid-or-hash', 'command-symbol', ] as const`

### `HARD_ENTITY_RETAIN_REQUIRED`

**种类**：常量 · **定义模块**：`src/contract.ts`

硬实体保留率要求。 它不是阈值而是契约本身：路径、URL、UUID、命令符号错一个字符， Agent 就会对错误目标执行破坏性操作，因此没有标定空间。

```ts
1
```

**值**：`1.0 as const`

### `HookError`

**种类**：类 · **定义模块**：`src/contract.ts`

用户钩子抛异常。携带钩子名，便于区分 shouldCompress / onPreCompress / selectSegment 等不同处置方向。

```ts
new (hook: string, cause: unknown): HookError
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `hook` | `string` | 否 |  |
| `code` | `CompressErrorCode` | 否 |  |
| `details` | `Readonly<Record<string, unknown>>` | 否 | 结构化上下文，便于宿主环境记录与上报。 |
| `name` | `string` | 否 |  |
| `message` | `string` | 否 |  |
| `stack` | `string \| undefined` | 是 |  |
| `cause` | `unknown` | 是 |  |

### `Message`

**种类**：接口 · **定义模块**：`src/contract.ts`

会话中的一条消息。

```ts
export interface Message {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `id` | `string` | 否 | 消息唯一标识。切点、source_span、归档指针全部以它为锚。 |
| `role` | `Role` | 否 |  |
| `content` | `string` | 否 | 文本内容。tool 消息为 result 的文本载荷。 |
| `toolCalls` | `readonly ToolCall[] \| undefined` | 是 | assistant 消息发起的工具调用（可并行多个）。 |
| `toolCallId` | `string \| undefined` | 是 | tool 消息所回应的 {@link ToolCall.id}。 |
| `raw` | `unknown` | 是 | 原始载荷。归档保存它，rehydrate 才能无损还原为首次进入会话时的 API 格式， 不因展平为 text 字段而丢失结构化内容。 |
| `vendor` | `Vendor \| undefined` | 是 | 来源厂商标记，缺省视为 `generic`。 |
| `tokens` | `number \| undefined` | 是 | 已知 token 数；缺省由计数钩子估算。 |

### `NoCompressionPossible`

**种类**：类 · **定义模块**：`src/contract.ts`

三级降级链全部失败。上下文必须保持逐字节原样。

```ts
new (message?: string, details?: Record<string, unknown>): NoCompressionPossible
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `code` | `CompressErrorCode` | 否 |  |
| `details` | `Readonly<Record<string, unknown>>` | 否 | 结构化上下文，便于宿主环境记录与上报。 |
| `name` | `string` | 否 |  |
| `message` | `string` | 否 |  |
| `stack` | `string \| undefined` | 是 |  |
| `cause` | `unknown` | 是 |  |

### `ObservationRecord`

**种类**：接口 · **定义模块**：`src/contract.ts`

一轮压缩的观测记录。以回调或事件形式暴露，不绑定任何特定监控实现。

```ts
export interface ObservationRecord {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `epoch` | `number` | 否 |  |
| `beforeTokens` | `number` | 否 |  |
| `afterTokens` | `number` | 否 |  |
| `ratio` | `number` | 否 | 压缩比 afterTokens / beforeTokens。 |
| `durationMs` | `number` | 否 |  |
| `level` | `CompressLevel` | 否 |  |
| `method` | `CompressMethod` | 否 |  |
| `degraded` | `boolean` | 否 | 本轮是否走了降级。 |
| `pinCount` | `number` | 否 |  |
| `cacheImpact` | `CacheImpact` | 否 |  |
| `warnings` | `readonly string[]` | 否 | 本轮告警。 |

### `PIN_REASON_PRIORITY`

**种类**：常量 · **定义模块**：`src/contract.ts`

pin 理由优先级（由高到低）。 同一内容命中多个识别信号时，只产生一条 pin 记录，reason 取优先级更高的那一种。

```ts
readonly PinReason[]
```

**值**：`[ 'tool-block-incomplete', 'system-prompt', 'user-constraint', 'permission-grant', 'deliverable-path', 'user-remember', …`

### `PinReason`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

pin 理由枚举。

```ts
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
  | 'tool-block-incomplete'
```

**取值**：

- `"system-prompt"` — 系统提示消息。
- `"latest-user-intent"` — 用户最新一轮的原始需求文本。
- `"user-constraint"` — 用户提出的硬约束（「必须在原文件上原地修改，不要生成新版本」这类）。 契约 `pin-protection` 场景一要求这类内容被 pin 且逐字节不变， 但原枚举无对应取值，补此值以免出现「被 pin 但 reason 不属于枚举」的自相矛盾。 记为待确认项 Q6（见 todo.md §3）。
- `"user-remember"` — 用户消息含「记住」「以后都要」等持久性要求。
- `"error-critical"` — 尚未被后续成功输出取代的关键报错行。
- `"deliverable-path"` — 交付物绝对路径。
- `"permission-grant"` — 用户对高风险操作的批准记录。
- `"open-todo"` — 未完成的待办。
- `"tool-block-incomplete"` — tool block 配对不完整，铁律三强制 pin，任何级别都不参与压缩。

### `PinRecord`

**种类**：接口 · **定义模块**：`src/contract.ts`

一条不可压缩区记录。

```ts
export interface PinRecord {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `msgId` | `string` | 否 | 被保护的消息 ID。 |
| `span` | `readonly [number, number] \| undefined` | 是 | 受保护的字符区间 `[start, end)`。 局部 pin 时必填：只保护含关键信息的片段，span 之外的内容仍可下沉。 |
| `reason` | `PinReason` | 否 |  |
| `text` | `string` | 否 | 被保护的文本内容，提交前断言会比对它是否逐字节在位。 |

### `Role`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

消息角色。与主流 Chat Completions / Messages API 对齐。

```ts
'system' | 'user' | 'assistant' | 'tool'
```

**取值**：

- `"system"`
- `"user"`
- `"assistant"`
- `"tool"`

### `Segment`

**种类**：接口 · **定义模块**：`src/contract.ts`

待压缩的一个中部段。由完整 tool block 组成，切点只落在 block 之间。

```ts
export interface Segment {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `id` | `string` | 否 |  |
| `startId` | `string` | 否 |  |
| `endId` | `string` | 否 |  |
| `msgIds` | `readonly string[]` | 否 |  |
| `blockIds` | `readonly string[]` | 否 | 该段包含的 tool block ID。 |
| `tokens` | `number` | 否 |  |

### `SourceSpan`

**种类**：接口 · **定义模块**：`src/contract.ts`

指向原始消息区间的指针。 铁律一要求它永远指向 L0 原文的消息 ID，而非某个摘要块。

```ts
export interface SourceSpan {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `startId` | `string` | 否 |  |
| `endId` | `string` | 否 |  |
| `msgCount` | `number` | 否 |  |

### `ToolBlock`

**种类**：接口 · **定义模块**：`src/contract.ts`

一个 tool block：一条发起工具调用的 assistant 消息 + 其全部 tool result。

```ts
export interface ToolBlock {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `id` | `string` | 否 |  |
| `startId` | `string` | 否 |  |
| `endId` | `string` | 否 |  |
| `msgIds` | `readonly string[]` | 否 | 组成该 block 的全部消息 ID，保持原始到达顺序，不重排。 |
| `complete` | `boolean` | 否 | 全部 tool_use 都已收到对应 result。 |
| `missing` | `readonly string[]` | 否 | 未收到 result 的 tool_use 标识列表。 |
| `malformed` | `boolean` | 否 | 畸形块：孤儿 result、被下一条 assistant 工具调用截断、或其他无法配对的形态。 |
| `tokens` | `number` | 否 |  |

### `ToolCall`

**种类**：接口 · **定义模块**：`src/contract.ts`

assistant 发起的一次工具调用。

```ts
export interface ToolCall {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `id` | `string` | 否 | 工具调用唯一标识，与后续 tool result 的 `toolCallId` 配对。 |
| `name` | `string` | 否 | 工具名。 |
| `args` | `unknown` | 是 | 调用参数（保留原始结构，不做序列化假设）。 |

### `TriggerDecision`

**种类**：接口 · **定义模块**：`src/contract.ts`

触发判定结果。

```ts
export interface TriggerDecision {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `compress` | `boolean` | 否 | 是否执行压缩。 |
| `reason` | `TriggerReason` | 否 |  |
| `cutPointId` | `string \| undefined` | 是 | 命中任务边界时的切点消息 ID。 |
| `boundaryType` | `BoundaryType \| undefined` | 是 | 命中任务边界时的边界类型。 |
| `forced` | `boolean` | 否 | 是否为强制压缩（无边界且超等待上限）。 |
| `epoch` | `number` | 否 | 本轮 epoch 快照。 |

### `TriggerReason`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

触发决策原因。

```ts
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
```

**取值**：

- `"below-trigger"` — 占用低于触发线。
- `"hysteresis-band"` — 落在迟滞带内，防抖动。
- `"task-boundary"` — 命中任务边界。
- `"forced"` — 无边界但超过等待上限，强制压缩。
- `"rate-limit"` — 距上次压缩的轮数小于频率下限。
- `"post-compress-settled"` — 压缩后占用已落到目标线以下。
- `"no-safe-cut"` — 找不到安全切点，放弃本轮。
- `"hook-error"` — 触发钩子抛异常，保守地不压缩。
- `"waiting-boundary"` — 占用超线但仍在等待任务边界，且未超等待上限。

### `Vendor`

**种类**：类型别名 · **定义模块**：`src/contract.ts`

消息来源厂商标记。 归档时需要保存它，rehydrate 才能把原文还原成首次进入会话时的 API 格式。

```ts
'anthropic' | 'openai' | 'generic'
```

**取值**：

- `"anthropic"`
- `"openai"`
- `"generic"`

### `VerifyReport`

**种类**：接口 · **定义模块**：`src/contract.ts`

实体校验报告。

```ts
export interface VerifyReport {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `passed` | `boolean` | 否 |  |
| `entityRetain` | `Readonly<Record<EntityCategory, number>>` | 否 | 每一类实体的独立保留率，供事后审计而非只给总体布尔值。 |
| `missing` | `readonly string[]` | 否 | 缺失的具体实体值，便于定位。 |
| `hookError` | `boolean` | 否 | 校验器自身抛异常时为 true —— 必须视为不通过而非放行。 |
| `warnings` | `readonly string[]` | 否 | 软实体未达阈值时的处置记录，不静默忽略。 |
| `qa` | `readonly SlotQuestion[] \| undefined` | 是 | §8.3 进阶问答的题目；仅 advancedVerifyEnabled 开启且有槽位时非空。 |

## src/defaults.ts

### `DEFAULT_CALLBACKS`

**种类**：常量 · **定义模块**：`src/defaults.ts`

默认回调集。**compress 不在其中** —— 它是宿主唯一必须提供的钩子。

```ts
Omit<CompressCallbacks, 'compress'>
```

**值**：`{ shouldCompress: (state, config) => { const space = createVectorSpace(); // 门面不持有轮次历史：epoch 0（从未压缩过）视为不受频率下限约束， // 否则默认…`

### `defaultOnError`

**种类**：函数 · **定义模块**：`src/defaults.ts`

默认错误出口：什么都不做。宿主应提供自己的实现以接入日志/监控。

```ts
(): void
```

### `defaultOnPreCompress`

**种类**：函数 · **定义模块**：`src/defaults.ts`

默认 pin 识别：静态白名单 + 铁律三强制 pin，按优先级去重。

```ts
(state: ContextState, config: CompressConfig): readonly PinRecord[]
```

### `defaultSelectSegment`

**种类**：函数 · **定义模块**：`src/defaults.ts`

默认切割：按 block 边界切中部，无安全切点返回空数组。

```ts
(state: ContextState, config: CompressConfig): Segment[]
```

### `defaultShouldCompress`

**种类**：函数 · **定义模块**：`src/defaults.ts`

默认触发判定：双水位 + 迟滞 + 任务边界 + 频率下限。

```ts
(ctx: TriggerContext): TriggerDecision
```

### `defaultVerify`

**种类**：函数 · **定义模块**：`src/defaults.ts`

默认实体校验：正则硬/软实体 + 硬槽位逐字定位。

```ts
(input: VerifyInput, config: CompressConfig): VerifyReport
```

## src/fallback.ts

### `FallbackResult`

**种类**：接口 · **定义模块**：`src/fallback.ts`

```ts
export interface FallbackResult {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `output` | `CompressOutput` | 否 |  |
| `method` | `CompressMethod` | 否 | 实际执行的级别。 |
| `degraded` | `boolean` | 否 | 走了降级链即 true。 |
| `warnings` | `readonly string[]` | 否 | 各级降级原因，写入观测报告。 |

### `runFallbackChain`

**种类**：函数 · **定义模块**：`src/fallback.ts`

执行降级链。

```ts
(input: CompressInput, compress: ((input: CompressInput, signal: AbortSignal) => CompressOutput | Promise<CompressOutput>) | null, config: CompressConfig): Promise<...>
```

## src/gain.ts

### `assignBudget`

**种类**：函数 · **定义模块**：`src/gain.ts`

执行预算分配。

```ts
(input: AssignBudgetInput, config: CompressConfig): BudgetAssignment[]
```

### `AssignBudgetInput`

**种类**：接口 · **定义模块**：`src/gain.ts`

```ts
export interface AssignBudgetInput {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `segments` | `readonly Segment[]` | 否 | 待分配的中部段。 |
| `anchorText` | `string` | 否 | anchor 文本：pin 约束集的拼接。 |
| `segmentTexts` | `ReadonlyMap<string, string>` | 否 | segmentId → 该段的 **L0 原文**。铁律一：绝不传摘要。 |
| `retainedTexts` | `readonly string[]` | 否 | 已保留内容的文本（head 与 pin 内容），冗余度对照物。 |
| `space` | `SimilaritySpace` | 否 | 相似度空间。embedding 关闭时为 TF-IDF 实现，不产生任何网络调用。 |

### `createEmbedderSpace`

**种类**：函数 · **定义模块**：`src/gain.ts`

embedding 模式的相似度空间：向量化由宿主提供，余弦本地计算。

```ts
(embed: Embedder): SimilaritySpace
```

### `SimilaritySpace`

**种类**：接口 · **定义模块**：`src/gain.ts`

向量化能力的最小接口。TF-IDF 与 embedding 两种实现都满足它。

```ts
export interface SimilaritySpace {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `vectorize` | `(text: string) => readonly number[]` | 否 |  |
| `cosine` | `(a: readonly number[], b: readonly number[]) => number` | 否 |  |
| `addDocument` | `((text: string) => void) \| undefined` | 是 | 登记语料参与 IDF 统计。embedding 实现无需此步。 |

## src/levels/l1.ts

### `l1Denoise`

**种类**：函数 · **定义模块**：`src/levels/l1.ts`

对一个段的原始消息序列执行 L1 去噪。 输出的每一行都可在输入中逐字定位；规则命中记录仅供报告与契约断言使用。

```ts
(msgs: readonly Message[], config: CompressConfig): L1Result
```

### `L1Result`

**种类**：接口 · **定义模块**：`src/levels/l1.ts`

```ts
export interface L1Result {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `text` | `string` | 否 | 去噪后的文本（原文行的子集，保持原始顺序）。 |
| `appliedRules` | `readonly string[]` | 否 | 命中的规则名，按处理顺序去重排列。 |

## src/levels/l2.ts

### `extractSlots`

**种类**：函数 · **定义模块**：`src/levels/l2.ts`

从原文抽取分槽位摘要。 全部硬槽位取值都是原文的逐字行，narrative 也取原文行（兜底路径不引入改写）。

```ts
(msgs: readonly Message[]): SummarySlots
```

### `verifyHardSlots`

**种类**：函数 · **定义模块**：`src/levels/l2.ts`

硬槽位逐字校验：constraints、artifacts、todos 的每条取值都必须能在原文中逐字定位。 返回无法定位的取值列表；为空即通过。

```ts
(slots: SummarySlots, original: string): readonly string[]
```

## src/levels/l3.ts

### `l3Coarsen`

**种类**：函数 · **定义模块**：`src/levels/l3.ts`

L3 粗化：保留首尾各 `l1EdgeKeepLines` 行 + 全部显著行，其余删除。 输出仍是原文行子集（method 记 heuristic 时依赖这一性质）。

```ts
(text: string, config: CompressConfig): string
```

## src/levels/l4.ts

### `l4PointerText`

**种类**：函数 · **定义模块**：`src/levels/l4.ts`

L4 指针文本。

```ts
(startId: string, endId: string, msgCount: number, archiveRef: string): string
```

## src/orchestrator.ts

### `createOrchestrator`

**种类**：函数 · **定义模块**：`src/orchestrator.ts`

```ts
(options: OrchestratorOptions): Orchestrator
```

### `Orchestrator`

**种类**：接口 · **定义模块**：`src/orchestrator.ts`

编排器。

```ts
export interface Orchestrator {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `maybeCompress` | `(state: ContextState) => Promise<ContextState>` | 否 | 对当前状态评估并（在触发条件满足时）执行一轮压缩。 |
| `observations` | `() => readonly ObservationRecord[]` | 否 | 全部观测记录（按提交顺序）。 |

### `OrchestratorOptions`

**种类**：接口 · **定义模块**：`src/orchestrator.ts`

```ts
export interface OrchestratorOptions {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `config` | `CompressConfig` | 否 |  |
| `callbacks` | `CompressCallbacks` | 否 |  |

## src/patterns.ts

### `extractHardEntities`

**种类**：函数 · **定义模块**：`src/patterns.ts`

提取文本中某一类硬实体。uuid-or-hash 同时匹配 UUID 与十六进制串。

```ts
(text: string, category: EntityCategory): string[]
```

### `HARD_ENTITY_PATTERNS`

**种类**：常量 · **定义模块**：`src/patterns.ts`

硬实体类别 → 正则。

```ts
Readonly<Record<'windows-path' | 'posix-path' | 'url' | 'uuid-or-hash' | 'command-symbol', RegExp>>
```

**值**：`{ 'windows-path': RE_WINDOWS_PATH, 'posix-path': RE_POSIX_PATH, 'url': RE_URL, 'uuid-or-hash': RE_UUID, 'command-symbol'…`

### `Match`

**种类**：接口 · **定义模块**：`src/patterns.ts`

一次正则匹配结果，带字符区间，供 span pin 使用。

```ts
export interface Match {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `value` | `string` | 否 |  |
| `start` | `number` | 否 |  |
| `end` | `number` | 否 |  |

### `matchAll`

**种类**：函数 · **定义模块**：`src/patterns.ts`

在文本中找出全部匹配，返回带区间的列表。

```ts
(text: string, re: RegExp): Match[]
```

### `RE_COMMAND`

**种类**：常量 · **定义模块**：`src/patterns.ts`

反引号包裹的命令与符号。

```ts
RegExp
```

**值**：`/`[^`\n]+`/`

### `RE_HASH`

**种类**：常量 · **定义模块**：`src/patterns.ts`

commit hash 一类十六进制串（7–40 位）。

```ts
RegExp
```

**值**：`/\b[0-9a-f]{7,40}\b/`

### `RE_POSIX_PATH`

**种类**：常量 · **定义模块**：`src/patterns.ts`

POSIX 路径：至少两级，避免把单个 `/usr` 或除法算式误判为路径。

```ts
RegExp
```

**值**：`/(?:\/[\w.@-]+){2,}/`

### `RE_TODO_DONE`

**种类**：常量 · **定义模块**：`src/patterns.ts`

已完成待办：`- [x]`、`DONE:`、`已完成`。

```ts
RegExp
```

**值**：`/(?:^|\n)\s*(?:[-*]\s*\[[xX]\]|DONE\s*:|已完成\s*[:：])[^\n]*/`

### `RE_TODO_PENDING`

**种类**：常量 · **定义模块**：`src/patterns.ts`

未完成待办：`- [ ]`、`TODO:`、`待办：`。

```ts
RegExp
```

**值**：`/(?:^|\n)\s*(?:[-*]\s*\[\s\]|TODO\s*:|待办\s*[:：])[^\n]*/`

### `RE_URL`

**种类**：常量 · **定义模块**：`src/patterns.ts`

URL。

```ts
RegExp
```

**值**：`/https?:\/\/[^\s)"'<>]+/`

### `RE_UUID`

**种类**：常量 · **定义模块**：`src/patterns.ts`

UUID。

```ts
RegExp
```

**值**：`/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/`

### `RE_WINDOWS_PATH`

**种类**：常量 · **定义模块**：`src/patterns.ts`

Windows 绝对路径：`D:\Documents\out\报告.docx`。

```ts
RegExp
```

**值**：`/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/`

### `SOFT_ENTITY_PATTERNS`

**种类**：常量 · **定义模块**：`src/patterns.ts`

软实体类别 → 正则。

```ts
Readonly<Record<'number-percent' | 'person-name', RegExp>>
```

**值**：`{ 'number-percent': /-?\d+(?:\.\d+)?%/, 'person-name': /[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}/, }`

## src/pins.ts

### `dedupePins`

**种类**：函数 · **定义模块**：`src/pins.ts`

合并去重：同一条消息只保留一条 pin，reason 取优先级最高者。 局部 pin（带 span）优先于整条 pin，避免为图省事把整条长消息锁死。

```ts
(hits: readonly PinRecord[]): PinRecord[]
```

### `identifyIncompleteBlockPins`

**种类**：函数 · **定义模块**：`src/pins.ts`

铁律三强制 pin：不完整或畸形的 tool block 在任何级别都不参与压缩。 这些 pin 是强制项，优先级最高，不随用户钩子的返回值变化。

```ts
(state: ContextState): PinRecord[]
```

### `identifyStaticPins`

**种类**：函数 · **定义模块**：`src/pins.ts`

静态白名单识别。覆盖八种 reason 中除 `tool-block-incomplete` 之外的全部情形。 顺序无关，最终由 {@link dedupePins} 按优先级收敛。

```ts
(state: ContextState): PinRecord[]
```

### `isPinned`

**种类**：函数 · **定义模块**：`src/pins.ts`

该消息是否被 pin。

```ts
(pins: readonly PinRecord[], msgId: string): boolean
```

### `PinResolveResult`

**种类**：接口 · **定义模块**：`src/pins.ts`

pin 解析结果。

```ts
export interface PinResolveResult {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `pins` | `readonly PinRecord[]` | 否 |  |
| `degraded` | `boolean` | 否 | 是否因 onPreCompress 抛异常而退化为静态白名单。 |

### `resolvePins`

**种类**：函数 · **定义模块**：`src/pins.ts`

生成本轮全部 pin。

```ts
(state: ContextState, config: CompressConfig, hook?: ((state: ContextState, config: CompressConfig) => readonly PinRecord[]) | undefined): PinResolveResult
```

## src/signals.ts

### `createVectorSpace`

**种类**：函数 · **定义模块**：`src/signals.ts`

```ts
(): VectorSpace
```

### `splitTokens`

**种类**：函数 · **定义模块**：`src/signals.ts`

分词。路径、URL、UUID、命令、哈希作为整体 token； 其余文本按 CJK bigram + 拉丁词切分。确定性输出。

```ts
(text: string): string[]
```

### `VectorSpace`

**种类**：接口 · **定义模块**：`src/signals.ts`

向量空间：收集语料后按 TF-IDF 计算文本向量。

```ts
export interface VectorSpace {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `addDocument` | `(text: string) => void` | 否 | 登记一篇文档参与 IDF 统计。重复文本按多次文档计。 |
| `vectorize` | `(text: string) => readonly number[]` | 否 | 计算文本的 TF-IDF 向量（词表维度，稀疏为零）。 |
| `cosine` | `(a: readonly number[], b: readonly number[]) => number` | 否 | 余弦相似度，零向量返回 0。 |
| `vocabularySize` | `() => number` | 否 | 当前词表大小。 |
| `documentCount` | `() => number` | 否 | 已登记文档数。 |

## src/trigger.ts

### `BoundaryHit`

**种类**：接口 · **定义模块**：`src/trigger.ts`

任务边界命中。

```ts
export interface BoundaryHit {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `messageId` | `string` | 否 |  |
| `type` | `BoundaryType` | 否 |  |

### `detectBoundaries`

**种类**：函数 · **定义模块**：`src/trigger.ts`

识别任务边界。四类信号的实现都是**确定性**的文本规则： - todo-transition：待办由 pending 翻转为 completed 的那条消息； - tool-seq-end：工具调用序列终止后第一条纯文本消息； - delivery-summary：助手输出交付总结后的下一条用户消息； - topic-shift：相邻两条用户消息相关性低于阈值（需要 space，缺省跳过该类）。

```ts
(state: ContextState, config: CompressConfig, space?: SimilaritySpace | undefined): BoundaryHit[]
```

### `shouldCompress`

**种类**：函数 · **定义模块**：`src/trigger.ts`

触发判定。顺序即优先级，全部阈值来自配置注入。

```ts
(ctx: TriggerContext, space?: SimilaritySpace | undefined): TriggerDecision
```

### `TriggerContext`

**种类**：接口 · **定义模块**：`src/trigger.ts`

判定上下文。上次压缩的状态由调用方（编排层）维护。

```ts
export interface TriggerContext {
```

| 成员 | 类型 | 可选 | 说明 |
|---|---|---|---|
| `state` | `ContextState` | 否 |  |
| `config` | `CompressConfig` | 否 |  |
| `turnsSinceLastCompress` | `number` | 否 | 距上次成功压缩经历的对话轮数（无历史记 Infinity）。 |
| `justCompressed` | `boolean` | 否 | 上一轮是否刚完成压缩（迟滞带与「压缩后落定」判定用）。 |

## src/verify.ts

### `verifyEntities`

**种类**：函数 · **定义模块**：`src/verify.ts`

正则实体校验。

```ts
(original: string, summary: string, config: CompressConfig): VerifyReport
```

### `verifySummary`

**种类**：函数 · **定义模块**：`src/verify.ts`

完整校验入口：先跑硬槽位逐字定位（有槽位时），再跑正则实体校验； 进阶问答开关开启时追加 §8.3 问答校验。 三者任一不通过即整体不通过。

```ts
(original: string, summary: string, slots: { constraints: readonly string[]; artifacts: readonly string[]; todos: readonly string[]; } | null, config: CompressConfig): VerifyReport
```
