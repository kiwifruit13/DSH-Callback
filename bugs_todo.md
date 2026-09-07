# bugs_todo.md —— 隐匿 Bug 修复清单

> 来源：`docs/bug-audit-report-2026-09-07.md`
> 纪律：进度优先，执行过程中跳过所有测试环节，测试放在结尾统一验收（见文末「收尾验收」）。
> 每一项修复都给出完整实现路径，不留"从需求直接跳到结果"的断层。

## 使用说明

- 勾选框：`[ ]` 待修 / `[x]` 已修（含代码改动完成，未含测试执行）。
- 「验收风险」：该修复可能导致既有 Gherkin 场景行为变化，收尾验收时须重点复核的场景。

---

## P0 —— 默认链路核心失效

### [x] P0-1 / P0-2 触发接线统一 + 真实轮次状态
- **位置**：`src/defaults.ts`（DEFAULT_CALLBACKS.shouldCompress）、`src/orchestrator.ts`（内置触发路径、turnsSince/lastEpochOf 占位）
- **修复**：
  1. 从 `DEFAULT_CALLBACKS` 中**删除 `shouldCompress` 字段**（保留 `defaultShouldCompress` 导出供宿主显式使用）——orchestrator 内置路径成为唯一默认路径；
  2. orchestrator 实例维护真实轮次状态 `turnsSinceLastCompress`：初始 `MAX_SAFE_INTEGER`（从未压缩、不受频率下限约束）；`maybeCompress` 每次新调用（幂等重放与 in-flight 并发复用**不**计入）推进 +1；成功提交后归零；
  3. `justCompressed = turnsSinceLastCompress === 1`（上一轮调用刚完成压缩）；
  4. 删除占位函数 `turnsSince` / `lastEpochOf`（后者原判断 `lastEpochOf(state) === casEpoch - 1` 恒 false，本身即错）；
  5. 内置触发路径为 topic-shift 构建真实语料空间（把 state.msgs 中的 user 消息 addDocument 后传入 `shouldCompress`）——同时修复 P1-4。
- **验收风险**：默认链路第二次压缩将受 `minGapTurns(3)` 抑制（这是契约语义的正确恢复）；依赖"连续两次调用都压缩"的既有场景需复核。

### [x] P0-3 VerifyInput 增加 slots
- **位置**：`src/callbacks.ts`（VerifyInput）、`src/defaults.ts`（defaultVerify）、`src/orchestrator.ts`（runVerify）
- **修复**：`VerifyInput` 增加可选 `slots?: SummarySlots | null`；`runVerify` 调钩子时传入 slots；`defaultVerify` 透传 `input.slots ?? null` 给 `verifySummary`。向后兼容（可选字段）。
- **验收风险**：L2 槽位伪造拒绝场景现在会在默认链路生效，此前"放行"的场景预期要复核。

---

## P1 —— 契约违约与数据失真

### [x] P1-1 消费 TriggerDecision.cutPointId
- **位置**：`src/orchestrator.ts`（runCycle 触发判定之后）
- **修复**：decision.compress 且带 cutPointId 时：查不到消息 → 告警 `cutpoint-not-found`；切点消息是某 block 的**中间成员**（非首非尾）→ 告警 `cutpoint_inside_block`（违反铁律三风险的切点信号）。不中止本轮（切点是参考信号，安全仍由 selectSegment 保障）。原 L336 死代码 `msgIndex` 移至此处复用（顺带清理 P3-1）。

### [x] P1-2 compressSegment 返回实际级别与 archiveRef（消除双归档）
- **位置**：`src/orchestrator.ts`（compressSegment / runCycle）
- **修复**：compressSegment 返回值增加 `level`（实际生效级别）与 `archiveRef`（内部已完成的那次归档）：
  - 归档失败退化 L1 → `level: 1, archiveRef: null`；
  - level===1 → `level: 1, archiveRef: null`；
  - L2+ 正常 → `level: 目标级别, archiveRef: 已归档指针`（verify 失败降级抽取式时级别不回退、degraded 标记可信度）；
  - runCycle 删除 L423-426 的**第二次归档**，直接使用返回的 archiveRef。产物 level 恒与实际一致，`level>=2 → archiveRef 非空` 的契约恒成立。

### [x] P1-3 verify.warnings 上报
- **位置**：`src/orchestrator.ts`（compressSegment）
- **修复**：runVerify 返回后，把 `verify.warnings` 逐条以 `verify_soft_warning` 告警转发到 `config.onWarning`（主路径与 retry 路径都覆盖）。

### [x] P1-5 cacheImpact 真实比对
- **位置**：`src/orchestrator.ts`（观测段）
- **修复**：`prefixStable` 改为真实计算——从头逐引用比对 `state.msgs` 与 `nextMsgs`，第一处差异必须是 `cb-` 前缀的压缩块呈现消息，否则 false；`breakpointAfterHead` 推导为「首个压缩块不位于消息流首位」（头部至少存在一条消息，断点可置于其前），并注释推导语义；删除 `headTokens`/`void headTokens` 死代码。

### [x] P1-6 ErrorContext.phase 按阶段传参
- **位置**：`src/orchestrator.ts`（emitError 及全部调用点）
- **修复**：emitError 直接接收 phase 字面量（'trigger' / 'pin' / 'select' / 'compress' / 'commit'），删除恒返回 'compress' 的 `phaseToName`；各阶段调用点显式传参；未捕获异常兜底 'compress'。

### [x] P1-7 契约幽灵指标 compress_deferred_count
- **位置**：`features/trigger-watermark.feature:68`
- **修复**：删除 `And 指标 compress_deferred_count 增加 1` 行（rate-limit 抑制由「决策原因记为 rate-limit」断言承载，不引入无实现的指标）。

### [x] P1-8 归档门面公共入口 + README 修正
- **位置**：`src/orchestrator.ts`（Orchestrator 接口）、`src/api.ts`（ContextCompressor）、`README.md`
- **修复**：Orchestrator 增加 `readonly archive: Archive`；ContextCompressor 透传（宿主由此获得与内部压缩**共享同一实例与索引**的 rehydrate / rebuildIndex 入口）；README rehydrate 段示例改为经 `compressor.archive` 调用，删除对 `JsonlArchiveSink.rebuildIndex()` 的错误调用；「六钩子」表述同步为「shouldCompress 走内置默认路径」。

---

## P2 —— 边界缺陷与健壮性

### [x] P2-1 dedupePins 支持同一消息多个局部 pin
- **位置**：`src/pins.ts`
- **修复**：去重键从 `msgId` 改为 `msgId + span`（整条 pin 键为 `msgId|whole`）；同键同优先级保留先到；同 msgId 同时存在 span pin 与整条 pin 时保留 span（整条保护由「block 整体退出」兜底）。多行待办/多路径不再丢保护。

### [x] P2-2 cosine 统一实现并修复维度不等 NaN
- **位置**：`src/signals.ts`、`src/gain.ts`
- **修复**：signals.ts 导出共享 `cosineSimilarity(a, b)`（点积循环用 `min(a.length, b.length)` 界限），gain.ts 的 `createEmbedderSpace` 与 signals 的 VectorSpace 都复用它；删除两份重复实现。

### [x] P2-3 fallback abort 分支补 break
- **位置**：`src/fallback.ts`
- **修复**：catch 中 `controller.signal.aborted` 分支在记录告警后 `break`（立即降级，不再对已取消的输入重试）。

### [x] P2-4 isValidSchema 槽位形状校验
- **位置**：`src/fallback.ts`
- **修复**：新增 `isValidSlots`：constraints/artifacts/todos 必须为数组、narrative 必须为字符串；level>=2 时 schema 校验从 `slots !== undefined` 升级为形状校验。

### [x] P2-5 heuristic 级空文本防护
- **位置**：`src/fallback.ts`
- **修复**：heuristic 级产出 `trim().length === 0` 时抛出（与 truncate 级对称），落入 truncate 级兜底，杜绝空 content 压缩块。

### [x] P2-6 归档惰性初始化竞态
- **位置**：`src/archive.ts`
- **修复**：`ensureInit` 改为 promise 缓存（并发首调共享同一次重建；失败时重置可重试）。**复查修正**：`JsonlArchiveSink.append` 内部 statSync→appendFileSync 之间无 await 点，进程内单线程下天然原子，无需加锁（多进程互斥以注释说明，属宿主责任）。

### [x] P2-7 L1 去噪语义修复
- **位置**：`src/levels/l1.ts`
- **修复**：
  1. duplicate-read 升为**消息级**去重：同一指纹的行按消息分组，仅跨消息去重（保留最新消息的全部行），同一条消息内多行不再互删；
  2. `referenced-later` 反向保护覆盖全部四条裁剪规则（superseded-result / repeated-failure 删除前同样检查后续引用）。

### [x] P2-8 advancedVerify 逐值定位
- **位置**：`src/verify.ts`
- **修复**：不再校验 `join(' ')` 后的整串，改为对每个槽位取值独立 `original.includes` 逐值定位；qa.answer 保留 join 形式仅作展示。

### [x] P2-9 defaultTokenCounter 覆盖中文标点
- **位置**：`src/config.ts`
- **修复**：CJK 字符类扩展全角标点区（U+3000-303F、U+FF01-FF60），中文标点按字符计数；latin 分词前的 replace 同步剔除。signals 的 bigram 相似度切分保持不变（用途不同）。

---

## P3 —— 死代码、冗余与纪律

### [x] P3-1 orchestrator.msgIndex 死代码 → 由 P1-1 复用转正
### [x] P3-2 截断后 verify 死赋值 → 删除（截断保尾输出 ⊆ l1 输出 ⊆ 原文行子集，硬实体天然保留，注释说明）
### [x] P3-3 删除 FallbackLevel 死接口（callbacks.ts + index.ts 导出）
### [x] P3-4 l2.ts 接线说明修正：verify.ts:11 注释指向实际实现（verifySummary 自身的槽位校验）；l2.ts 注明 extractSlots/verifyHardSlots 为公共兜底工具、主链路当前未接线
### [x] P3-5 l2 narrative 硬编码 6 → CompressConfig 新增 `l2NarrativeMaxLines`（默认 6，resolveConfig 校验区间），extractSlots 增加可选 config 参数（向后兼容）
### [x] P3-6 cosine 重复实现 → 由 P2-2 统一
### [x] P3-7 parseToolBlocks O(n²) → finish 改用预建 byId Map
### [x] P3-8 pins 命令/URL 复用 'deliverable-path' reason → 枚举不动（破坏性变更待契约确认），注释说明
### [x] P3-9 maxLevel 未校验 → resolveConfig 增加 1-4 枚举校验；orchestrator 对 assignment.targetLevel 做 `Math.min(target, maxLevel)` 收敛（防 assignBudget 产出超 maxLevel 的级别）

---

## 收尾验收（本轮不执行，全部修复完成后统一进行）

> 进度：P0-1 ~ P3-9 全部落地；**收尾验收已全部通过（2026-09-07）**——
> `typecheck` ✅ · `test:invariant`（42 场景）✅ · `test`（94 场景 662 步）✅ · `api:check`（118 符号无漂移）✅。
> 验收期间修复的夹具适配（P2-7 消息级去重语义）：`entity-verify.steps.ts` 的 twoBlockSession 改为
> 并行工具调用形态（一个 assistant 声明 3 个 call，3 条 result 同属一个 block）——
> 原因：①单 call 多 result 会因 pending 收口成孤儿消息；②l1Denoise 以段为单位，跨 block 无法进入同一次去噪。
> 「重压降级」场景预算标定为 20（segA 整段 27 token、L1 降级输出 11 token，区间 [14,27) 取 20）。
> 本轮额外修的两处（接续时发现）：
> 1. `orchestrator.ts` 上次改动残留的孤儿代码块（旧 compressSegment 体，无归属、引用未定义变量）已删除；
> 2. 类型层新增 `HardSlots`（`callbacks.ts`），`VerifyInput.slots` 与 `verifySummary` 收参形状统一 ——
>    原来 `SummarySlots` 与「仅三硬槽位」的内联形状不兼容，`tsc` 直接报错。

1. `npm run typecheck`
2. `npm run test:invariant` —— 三铁律 + API 400 防线
3. `npm run test` —— 全量 94 场景；重点复核 P0 修复的验收风险项
4. `npm run api:check` / 必要时 `npm run api:docs`（VerifyInput.slots、HardSlots、ContextCompressor.archive、l2NarrativeMaxLines 属导出面变化）
5. 新增建议场景：默认门面连续两轮压缩（P0-1 回归）、压缩后 settled/迟滞（P0-2 回归）、全链路槽位伪造拒绝（P0-3 回归）
   —— **已落地（2026-09-07）**：`features/default-facade.feature`（3 场景 12 步）+
   `features/support/steps/default-facade.steps.ts`。场景经 `createContextCompressor` 门面、
   不注入 shouldCompress，P0 修复成果首次在默认链路被真实执行。

---

## 第 5 轮审计（2026-09-07，验收后全量走读）

> 范围：src/ 全部 21 模块最新状态 + 全链路数据流追踪 + 契约-实现-接线三方交叉比对。

### [x] R5-1 / P1 defaultShouldCompress 空语料空间 → topic-shift 恒假阳性（已复现已修）
- **位置**：`src/defaults.ts`（defaultShouldCompress）
- **问题**：P1-4 只修了编排器内置路径；公共导出的 `defaultShouldCompress` 仍向
  `shouldCompress` 传**空** VectorSpace → 任意文本向量恒为零向量 → cosine 恒 0 <
  relevanceThreshold → 每一对相邻用户消息都误报 topic-shift。README 明确推荐宿主包装
  本函数，一用即踩；且触发类场景零覆盖，测试不可能发现。
- **修复**：trigger.ts 新增共享 `buildTopicShiftSpace(state)`（登记全部 user 消息入语料），
  编排器内置路径与 defaultShouldCompress 共用，消除两处接线漂移的土壤。
- **回归**：default-facade.feature 场景 1/2 走内置路径（同 helper）；
  defaultShouldCompress 的直接单测建议后续补入 trigger-watermark。

### [x] R5-2 / P3 callbacks.ts 头注释漂移（已修）
- 「其余五个由默认实现承担」「全部可选」与 shouldCompress 移出 DEFAULT_CALLBACKS、
  compress 必填的当前事实不符（P1-8 修 README 时此处漏改）。已同步。

### [x] R5-3 / P2 观测记录 warnings 双通道断连（已修）
- runCycle 内大量告警（verify_failed_retry、cutpoint-not-found、archive-unavailable、
  segment_compress_error 等）只走 `config.onWarning`，不进 `ObservationRecord.warnings`
  （后者几乎恒空，仅 pin_hook_degraded 入内）。观测记录「本轮告警」的承诺失真。
- **修复方向**：runCycle 用统一收集器把 warn() 同步写入本轮 warnings 数组。

### [x] R5-4 / P3 fallback 链 warnings 被丢弃（已修）
- `FallbackResult.warnings`（heuristic_over_budget、llm_aborted 等）在 compressSegment
  中被忽略；llm_invalid_schema / llm_hook_error 已走 onWarning，其余静默。

### [x] R5-5 / P3 gain 文档与实现的冗余度对照物不一致（已修）
- gain.ts 注释承诺 redundancy 对照「head 与 pin 内容」，orchestrator 只传
  `retainedTexts: pinTexts`（不含 head system prompt）。择一：补 head 或改注释。

### [x] R5-6 / P3 硬截断双实现（已修）
- `fallback.truncateToBudget` 与 `orchestrator.truncateTail` 逻辑完全相同（保尾累积行），
  收敛为一处导出复用。

### [x] R5-7 / P3 RE_HASH 不含大写十六进制（已修）
- `[0-9a-f]{7,40}` 漏大写 A-F commit hash：L1 指纹 / L3 显著行 / uuid-or-hash 校验均漏检
  （保守方向，仅信息量损失；上轮审计「另」注，一直未入清单）。加 `A-F` 或 `i` 标志。

### [x] R5-8 / P3 观测语义两处小失真（已修）
- 布尔返回的 shouldCompress 被编排器伪造成 `reason: 'task-boundary'`（无 cutPointId）；
- 首条消息即压缩块时 prefixStable 仍报 true（head 被清空却称前缀稳定，
  breakpointAfterHead=false 可部分暴露）。

### [x] R5-9 / P2 maybeCompress 无整体取消通道（已实施，api-plus 契约流程确认）
- P2-3 修复了 fallback 内部 abort 分支，但公共 API 层 `maybeCompress` 不接受
  AbortSignal，`input.signal` 是永不中止的死信号（orchestrator.ts:181）。
  属破坏性 API 变更，待契约裁决后再实施。

### 本轮验证结果
`typecheck` ✅ · `test:invariant`（42 场景）✅ · `test`（97 场景 696 步，含 3 个新门面级场景）✅（本轮数据；R5-3~R5-9 修复后的最终数据见下方修复记录：100 场景 725 步） ·
`api:docs` 再生成（118 符号，新增 buildTopicShiftSpace）✅ · `api:check` 无漂移 ✅

### R5-3 ~ R5-9 修复记录（第 6 轮，api-plus 契约流程）
- **R5-3**：orchestrator 增加统一告警入口 `warn()`（onWarning 与本轮 warnings 数组双通道共用，
  `activeCycleWarnings` 由 runCycle 挂载、finally 卸载，全部 return 路径不泄漏）。
- **R5-4**：compressSegment 转发 `FallbackResult.warnings`（llm_invalid_schema_attempt_N /
  llm_aborted / heuristic_over_budget），`llm_hook_error` 已由 fallback 携带详情直发故跳过防双报。
- **R5-5**：择「注释对齐实现」——`retainedTexts` TSDoc 改为「当前实现为 pin 约束集文本」，
  含 head 的冗余度对照留作后续增强（会改变增益排序，需契约评估）。
- **R5-6**：`truncateToBudget` 从 fallback.ts 导出（唯一实现），orchestrator 删除本地 truncateTail 复用之。
- **R5-7**：RE_HASH 改 `[0-9a-fA-F]{7,40}`（保守方向无损，仅扩大检出）。
- **R5-8**：①布尔返回的 shouldCompress 如实标注新枚举值 `'host-decision'`（TriggerReason 扩展），
  并给 ObservationRecord 增加可选 `triggerReason` 字段使触发原因可观测（向后兼容）；
  ②prefixStable 增加 `firstDiff > 0` 前提——首条消息即压缩块时不得报 true。
- **R5-9**（api-plus 契约确认结论：**可选参数属向后兼容扩展，代码为唯一真相源先行落地**）：
  `maybeCompress(state, signal?)` —— 入口已中止直接跳过（不推进轮次）；触发后 / 逐段间 / 提交前
  三个检查点放弃本轮（状态逐字节原样）；信号透传 compress 钩子（宿主网络调用自行清理）；
  并发同 epoch 复用首个调用的 signal；门面 ContextCompressor 同步扩展；双接口 TSDoc 齐全。
- **新增回归场景**（default-facade.feature，共 100 场景 725 步全绿）：
  整体取消（入口中止 + 中途取消不提交不产生观测 + 钩子收到已中止信号）、
  布尔触发如实标注（triggerReason = host-decision + prefixStable/breakpointAfterHead）、
  降级链告警入观测记录（llm_invalid_schema_attempt_N，R5-4 锁定）、
  P0-3 场景扩展观测告警双通道断言（verify_failed_retry，R5-3 锁定）。
- **最终门禁**：`test:invariant` 42 场景 ✅ · `test` **100 场景 725 步** ✅ ·
  `api:docs` 118 符号 ✅ · `api:check` 无漂移 ✅ · `api:contract` 五类契约 + TSDoc 覆盖率 94.1% ✅。
- **未做**：R5-1 附注的 defaultShouldCompress 直接单测（建议后续补入 trigger-watermark）。