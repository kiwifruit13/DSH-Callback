# dsh-callback 符号速查表

> 本文档由 `scripts/generate-api-docs.ts` 自动生成，以代码为唯一真相源。
> 人工修改会被下次生成覆盖。若需更新 API 描述，请修改源码 TSDoc 后重新生成。

| 符号 | 种类 | 定义模块 | 说明 |
|---|---|---|---|
| `Archive` | 接口 | `src/archive.ts` | 归档存储门面。 |
| `ArchiveCorrupted` | 类 | `src/contract.ts` | 归档内容哈希与实际内容不一致，拒绝回溯、拒绝基于它的下沉。 |
| `ArchiveRecord` | 接口 | `src/config.ts` | 归档记录。JSONL 追加文件的一行。 保存 raw 与 vendor 是为了 rehydrate 能无损还原为首次进入会话时的 API 格式。 |
| `ArchiveRef` | 接口 | `src/contract.ts` | 归档指针。凭它可经 rehydrate 取回逐字原文。 |
| `ArchiveSink` | 接口 | `src/config.ts` | 归档存储抽象。 |
| `ArchiveUnavailable` | 类 | `src/contract.ts` | 归档不可用。禁止有损下沉，但仍允许无归档需求的 L1 无损裁剪。 |
| `assignBudget` | 函数 | `src/gain.ts` | 执行预算分配。 |
| `AssignBudgetInput` | 接口 | `src/gain.ts` |  |
| `BoundaryHit` | 接口 | `src/trigger.ts` | 任务边界命中。 |
| `BoundaryType` | 类型别名 | `src/contract.ts` | 任务边界类型。切点优先落在这类边界上。 |
| `BudgetAssignment` | 接口 | `src/contract.ts` | 单个段的预算分配结果。 |
| `CacheImpact` | 接口 | `src/contract.ts` | prompt cache 影响。稳定前缀是避免 cache 全 miss 的关键（§7.2）。 |
| `CommitAssertFailed` | 类 | `src/contract.ts` | 提交前断言失败。整体回滚，告警必须指明失败的断言项。 |
| `CompressCallbacks` | 接口 | `src/callbacks.ts` | 六个可注入钩子。全部可选，缺省走默认实现。 |
| `CompressConfig` | 接口 | `src/config.ts` | 压缩配置。全部阈值集中于此，源码其余位置不得出现待标定数字。 |
| `CompressedBlock` | 接口 | `src/contract.ts` | 压缩产物。 |
| `CompressError` | 类 | `src/contract.ts` | 压缩错误基类。 |
| `CompressErrorCode` | 类型别名 | `src/contract.ts` | 压缩错误码。 |
| `CompressInput` | 接口 | `src/callbacks.ts` | compress 钩子的入参。 |
| `CompressLevel` | 类型别名 | `src/contract.ts` | 压缩级别。 - L0 原文 - L1 抽取式去噪（唯一被强制「输出 ⊆ 输入」的级别） - L2 分槽位结构化摘要 - L3 更粗粒度摘要 - L4 指针（仅说明存在过什么与如何取回） |
| `CompressMethod` | 类型别名 | `src/contract.ts` | 压缩产出的实际方法。 该标记必须随报告落盘，用于事后判定该段上下文的可信度（§9.1）。 |
| `CompressOutput` | 接口 | `src/callbacks.ts` | compress 钩子的出参。 |
| `ConfigError` | 类 | `src/config.ts` | 配置校验错误。 |
| `ContextCompressor` | 接口 | `src/api.ts` | 压缩器实例。 |
| `ContextState` | 接口 | `src/contract.ts` | 上下文状态。 `msgs` 以不可变数组持有，压缩采用「构造 next_msgs → 断言 → 整体替换」的提交方式， 中途失败则引用与内容逐字节保持原样（§9.2 原子性）。 |
| `createArchive` | 函数 | `src/archive.ts` | 创建归档门面。 `sink` 为 null 表示无归档能力：此时 `archive()` 恒返回 null、`isAvailable()` 恒为 false。 |
| `CreateCompressorOptions` | 接口 | `src/api.ts` |  |
| `createContextCompressor` | 函数 | `src/api.ts` | 创建压缩器。非法配置在此即刻失败，不带入压缩流程。 |
| `createEmbedderSpace` | 函数 | `src/gain.ts` | embedding 模式的相似度空间：向量化由宿主提供，余弦本地计算。 |
| `createOrchestrator` | 函数 | `src/orchestrator.ts` |  |
| `createVectorSpace` | 函数 | `src/signals.ts` |  |
| `dedupePins` | 函数 | `src/pins.ts` | 合并去重：同一条消息只保留一条 pin，reason 取优先级最高者。 局部 pin（带 span）优先于整条 pin，避免为图省事把整条长消息锁死。 |
| `DEFAULT_CALLBACKS` | 常量 | `src/defaults.ts` | 默认回调集。**compress 不在其中** —— 它是宿主唯一必须提供的钩子。 |
| `DEFAULT_CONFIG` | 常量 | `src/config.ts` | 保守占位默认值。规划 §13 实测标定后替换。 |
| `defaultHash` | 常量 | `src/archive.ts` | 默认哈希：SHA-256 十六进制。 |
| `defaultOnError` | 函数 | `src/defaults.ts` | 默认错误出口：什么都不做。宿主应提供自己的实现以接入日志/监控。 |
| `defaultOnPreCompress` | 函数 | `src/defaults.ts` | 默认 pin 识别：静态白名单 + 铁律三强制 pin，按优先级去重。 |
| `defaultSelectSegment` | 函数 | `src/defaults.ts` | 默认切割：按 block 边界切中部，无安全切点返回空数组。 |
| `defaultShouldCompress` | 函数 | `src/defaults.ts` | 默认触发判定：双水位 + 迟滞 + 任务边界 + 频率下限。 |
| `defaultTokenCounter` | 函数 | `src/config.ts` | 内置 token 估算：中英文混排的保守近似。 中文按字符计，拉丁按空白与标点切分计，另加每条约 4 token 的消息开销。 宿主环境应提供真实 tokenizer 替换它。 |
| `defaultVerify` | 函数 | `src/defaults.ts` | 默认实体校验：正则硬/软实体 + 硬槽位逐字定位。 |
| `detectBoundaries` | 函数 | `src/trigger.ts` | 识别任务边界。四类信号的实现都是**确定性**的文本规则： - todo-transition：待办由 pending 翻转为 completed 的那条消息； - tool-seq-end：工具调用序列终止后第一条纯文本消息； - delivery-summary：助手输出交付总结后的下一条用户消息； - topic-shift：相邻两条用户消息相关性低于阈值（需要 space，缺省跳过该类）。 |
| `Embedder` | 类型别名 | `src/config.ts` | 文本向量化钩子。开启 embedding 时由宿主提供；缺省走内置 TF-IDF。 |
| `EntityCategory` | 类型别名 | `src/contract.ts` | 受校验的实体类别。 |
| `ErrorContext` | 接口 | `src/callbacks.ts` | 错误上下文。 |
| `extractHardEntities` | 函数 | `src/patterns.ts` | 提取文本中某一类硬实体。uuid-or-hash 同时匹配 UUID 与十六进制串。 |
| `extractSlots` | 函数 | `src/levels/l2.ts` | 从原文抽取分槽位摘要。 全部硬槽位取值都是原文的逐字行，narrative 也取原文行（兜底路径不引入改写）。 |
| `FallbackLevel` | 接口 | `src/callbacks.ts` | 降级链每一级的实现签名，供 {@link CompressCallbacks.compress} 之外的兜底级复用。 |
| `FallbackResult` | 接口 | `src/fallback.ts` |  |
| `HARD_ENTITY_CATEGORIES` | 常量 | `src/contract.ts` | 硬实体类别集合。这些类别的保留率要求恒为 1.0。 |
| `HARD_ENTITY_PATTERNS` | 常量 | `src/patterns.ts` | 硬实体类别 → 正则。 |
| `HARD_ENTITY_RETAIN_REQUIRED` | 常量 | `src/contract.ts` | 硬实体保留率要求。 它不是阈值而是契约本身：路径、URL、UUID、命令符号错一个字符， Agent 就会对错误目标执行破坏性操作，因此没有标定空间。 |
| `HashFn` | 类型别名 | `src/archive.ts` | 哈希函数。宿主可注入（例如浏览器环境替换 node:crypto）。 |
| `hashMessages` | 函数 | `src/archive.ts` | 一批原文的 source_hash。 |
| `HookError` | 类 | `src/contract.ts` | 用户钩子抛异常。携带钩子名，便于区分 shouldCompress / onPreCompress / selectSegment 等不同处置方向。 |
| `IdempotencyKey` | 接口 | `src/callbacks.ts` | 幂等键。四元组 (startId, endId, level, epoch)。 相同幂等键重复请求必须复用缓存结果，避免重复消耗 LLM 调用与缓存抖动。 |
| `idempotencyKeyOf` | 函数 | `src/callbacks.ts` | 把幂等键序列化为稳定字符串，用作缓存键。 |
| `identifyIncompleteBlockPins` | 函数 | `src/pins.ts` | 铁律三强制 pin：不完整或畸形的 tool block 在任何级别都不参与压缩。 这些 pin 是强制项，优先级最高，不随用户钩子的返回值变化。 |
| `identifyStaticPins` | 函数 | `src/pins.ts` | 静态白名单识别。覆盖八种 reason 中除 `tool-block-incomplete` 之外的全部情形。 顺序无关，最终由 {@link dedupePins} 按优先级收敛。 |
| `isBlockCompressible` | 函数 | `src/blocks.ts` | 该块是否可参与压缩。不完整或畸形的块被强制 pin，任何级别都不参与。 |
| `isPinned` | 函数 | `src/pins.ts` | 该消息是否被 pin。 |
| `JsonlArchiveSink` | 类 | `src/archive.ts` | JSONL 追加文件归档 sink。 |
| `l1Denoise` | 函数 | `src/levels/l1.ts` | 对一个段的原始消息序列执行 L1 去噪。 输出的每一行都可在输入中逐字定位；规则命中记录仅供报告与契约断言使用。 |
| `L1Result` | 接口 | `src/levels/l1.ts` |  |
| `l3Coarsen` | 函数 | `src/levels/l3.ts` | L3 粗化：保留首尾各 `l1EdgeKeepLines` 行 + 全部显著行，其余删除。 输出仍是原文行子集（method 记 heuristic 时依赖这一性质）。 |
| `l4PointerText` | 函数 | `src/levels/l4.ts` | L4 指针文本。 |
| `Match` | 接口 | `src/patterns.ts` | 一次正则匹配结果，带字符区间，供 span pin 使用。 |
| `matchAll` | 函数 | `src/patterns.ts` | 在文本中找出全部匹配，返回带区间的列表。 |
| `MemoryArchiveSink` | 类 | `src/archive.ts` | 内存归档 sink。 无文件系统权限或不想落盘时的等价实现，语义与 JSONL 版一致（只追加、偏移单调）。 |
| `Message` | 接口 | `src/contract.ts` | 会话中的一条消息。 |
| `msgTokens` | 函数 | `src/blocks.ts` | 单条消息的 token 数。消息自带计数优先，否则用配置的计数器估算。 |
| `NoCompressionPossible` | 类 | `src/contract.ts` | 三级降级链全部失败。上下文必须保持逐字节原样。 |
| `ObservationHook` | 类型别名 | `src/config.ts` | 观测回调。以回调形式暴露，不绑定任何特定监控实现。 |
| `ObservationRecord` | 接口 | `src/contract.ts` | 一轮压缩的观测记录。以回调或事件形式暴露，不绑定任何特定监控实现。 |
| `Orchestrator` | 接口 | `src/orchestrator.ts` | 编排器。 |
| `OrchestratorOptions` | 接口 | `src/orchestrator.ts` |  |
| `parseToolBlocks` | 函数 | `src/blocks.ts` | 解析会话中的全部 tool block。 |
| `PIN_REASON_PRIORITY` | 常量 | `src/contract.ts` | pin 理由优先级（由高到低）。 同一内容命中多个识别信号时，只产生一条 pin 记录，reason 取优先级更高的那一种。 |
| `PinReason` | 类型别名 | `src/contract.ts` | pin 理由枚举。 |
| `PinRecord` | 接口 | `src/contract.ts` | 一条不可压缩区记录。 |
| `PinResolveResult` | 接口 | `src/pins.ts` | pin 解析结果。 |
| `RE_COMMAND` | 常量 | `src/patterns.ts` | 反引号包裹的命令与符号。 |
| `RE_HASH` | 常量 | `src/patterns.ts` | commit hash 一类十六进制串（7–40 位）。 |
| `RE_POSIX_PATH` | 常量 | `src/patterns.ts` | POSIX 路径：至少两级，避免把单个 `/usr` 或除法算式误判为路径。 |
| `RE_TODO_DONE` | 常量 | `src/patterns.ts` | 已完成待办：`- [x]`、`DONE:`、`已完成`。 |
| `RE_TODO_PENDING` | 常量 | `src/patterns.ts` | 未完成待办：`- [ ]`、`TODO:`、`待办：`。 |
| `RE_URL` | 常量 | `src/patterns.ts` | URL。 |
| `RE_UUID` | 常量 | `src/patterns.ts` | UUID。 |
| `RE_WINDOWS_PATH` | 常量 | `src/patterns.ts` | Windows 绝对路径：`D:\Documents\out\报告.docx`。 |
| `resolveConfig` | 函数 | `src/config.ts` | 合并用户配置与默认值，并做区间校验。 非法配置在进入压缩流程前就失败，避免带着错误阈值静默运行。 |
| `resolvePins` | 函数 | `src/pins.ts` | 生成本轮全部 pin。 |
| `Role` | 类型别名 | `src/contract.ts` | 消息角色。与主流 Chat Completions / Messages API 对齐。 |
| `runFallbackChain` | 函数 | `src/fallback.ts` | 执行降级链。 |
| `Segment` | 接口 | `src/contract.ts` | 待压缩的一个中部段。由完整 tool block 组成，切点只落在 block 之间。 |
| `segmentsAreSafe` | 函数 | `src/blocks.ts` | 校验切割结果：任一段的首尾都必须是完整 block。提交前断言会用到。 |
| `selectSegment` | 函数 | `src/blocks.ts` | 默认中部段切割。 |
| `shouldCompress` | 函数 | `src/trigger.ts` | 触发判定。顺序即优先级，全部阈值来自配置注入。 |
| `SimilaritySpace` | 接口 | `src/gain.ts` | 向量化能力的最小接口。TF-IDF 与 embedding 两种实现都满足它。 |
| `SOFT_ENTITY_PATTERNS` | 常量 | `src/patterns.ts` | 软实体类别 → 正则。 |
| `SourceSpan` | 接口 | `src/contract.ts` | 指向原始消息区间的指针。 铁律一要求它永远指向 L0 原文的消息 ID，而非某个摘要块。 |
| `splitTokens` | 函数 | `src/signals.ts` | 分词。路径、URL、UUID、命令、哈希作为整体 token； 其余文本按 CJK bigram + 拉丁词切分。确定性输出。 |
| `SummarySlots` | 接口 | `src/callbacks.ts` | L2 分槽位摘要（§5）。 |
| `TokenCounter` | 类型别名 | `src/config.ts` | token 计数钩子。宿主环境可提供真实 tokenizer；缺省走内置估算。 |
| `ToolBlock` | 接口 | `src/contract.ts` | 一个 tool block：一条发起工具调用的 assistant 消息 + 其全部 tool result。 |
| `ToolCall` | 接口 | `src/contract.ts` | assistant 发起的一次工具调用。 |
| `totalTokens` | 函数 | `src/blocks.ts` | 一批消息的总 token 数。 |
| `TriggerContext` | 接口 | `src/trigger.ts` | 判定上下文。上次压缩的状态由调用方（编排层）维护。 |
| `TriggerDecision` | 接口 | `src/contract.ts` | 触发判定结果。 |
| `TriggerReason` | 类型别名 | `src/contract.ts` | 触发决策原因。 |
| `VectorSpace` | 接口 | `src/signals.ts` | 向量空间：收集语料后按 TF-IDF 计算文本向量。 |
| `Vendor` | 类型别名 | `src/contract.ts` | 消息来源厂商标记。 归档时需要保存它，rehydrate 才能把原文还原成首次进入会话时的 API 格式。 |
| `verifyEntities` | 函数 | `src/verify.ts` | 正则实体校验。 |
| `verifyHardSlots` | 函数 | `src/levels/l2.ts` | 硬槽位逐字校验：constraints、artifacts、todos 的每条取值都必须能在原文中逐字定位。 返回无法定位的取值列表；为空即通过。 |
| `VerifyInput` | 接口 | `src/callbacks.ts` | verify 钩子的入参。 |
| `VerifyReport` | 接口 | `src/contract.ts` | 实体校验报告。 |
| `verifySummary` | 函数 | `src/verify.ts` | 完整校验入口：先跑硬槽位逐字定位（有槽位时），再跑正则实体校验； 进阶问答开关开启时追加 §8.3 问答校验。 三者任一不通过即整体不通过。 |
| `WarningHook` | 类型别名 | `src/config.ts` | 告警回调。用于 pin_hook_degraded、archive-unavailable 等可观测降级信号。 |
