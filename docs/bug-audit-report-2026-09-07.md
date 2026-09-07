# DSH-Callback 全链路隐匿 Bug 与结构脱节排查报告

> 排查日期：2026-09-07
> 排查范围：`src/` 全部 17 个模块 + `features/` 契约 + `README.md` + 测试接线（`features/support/world.ts`）
> 排查方法：静态逐文件走读 + 数据流追踪 + 契约-实现交叉比对（按项目规则，本轮不做测试执行，统一验收测试放在收尾阶段）
> 分级：P0 = 默认链路核心功能失效；P1 = 契约违约 / 数据失真；P2 = 边界缺陷 / 健壮性；P3 = 死代码 / 纪律问题

---

## 一、总体结论

项目单元级契约（features/ 94 场景）设计完备，但**门面接线层（`api.ts` → `defaults.ts` → `orchestrator.ts`）存在系统性断裂**：
多处"编排器内置正确路径"被 `DEFAULT_CALLBACKS` 的占位实现永久屏蔽，导致**默认接入方式下（宿主只提供 compress），
三铁律之外的多项触发/校验语义在真实链路中失效，而单元测试因绕过接线层全部绿灯**。
这是典型的"逻辑跳跃"：单元正确 + 集成断线 = 全链路失效。

---

## 二、P0 —— 默认链路核心失效（3 项）

### P0-1 默认配置下压缩最多发生一次，之后永久 rate-limit 卡死

- **位置**：`src/defaults.ts:55`、`src/orchestrator.ts:588-590`、`src/config.ts:147`（`minGapTurns: 3`）
- **链路**：`api.ts:43` 合并 `{ ...DEFAULT_CALLBACKS, ...options.callbacks }` 后，`DEFAULT_CALLBACKS.shouldCompress` 恒存在 →
  `orchestrator.ts:221` 的内置触发路径（带 `turnsSince(state)` / `justCompressed` 正确计算的那份）**成为死代码**，恒走 defaults 版本。
- **缺陷**：`turnsSinceLastCompress` 占位实现为 `state.epoch === 0 ? MAX_SAFE_INTEGER : 1`。首次压缩成功后 `epoch >= 1`，
  该值恒为 `1 < minGapTurns(3)` → `trigger.ts:128` 判定 rate-limit，**任务边界检测（L133）永远到不了**（判定顺序在 rate-limit 之后）。
- **后果**：默认接入方式下，第一次压缩后再也不会压缩，上下文持续膨胀直至溢出。
- **契约违约**：`trigger-watermark.feature` 的"识别到任务边界则在边界处压缩""无边界且超过等待上限时强制压缩"（`turnsSince=1 >= maxWaitTurns(12)` 恒假，forced 分支死路径）在默认链路全部不可达。
- **为何测试没拦住**：`world.ts:66-68` 中触发场景手工构造 `TriggerContext` 直调 `shouldCompress()` 单元函数，完全绕过门面接线。

### P0-2 `justCompressed` 硬编码 false —— 迟滞带与"压缩后落定"双机制失效

- **位置**：`src/defaults.ts:56`（`justCompressed: false`）
- **链路**：同 P0-1，defaults 版 shouldCompress 恒在场，orchestrator 内置计算 `lastEpochOf(state) === casEpoch - 1` 的路径（`orchestrator.ts:225`）死代码。
- **后果**：
  - `trigger.ts:114` post-compress-settled 分支永不触发 → 压缩后若仍超线，下一轮立即再判；
  - `trigger.ts:121` hysteresis-band 防抖分支永不触发 → 迟滞带失效，临界点抖动风险回归。
- **契约违约**：`trigger-watermark.feature` 场景"占用落在迟滞带内不压缩以防抖动""压缩后占用落到目标线以下则本轮结束"在默认链路不可复现。

### P0-3 默认 verify 丢失槽位参数 —— L2 硬槽位逐字校验整体失效

- **位置**：`src/defaults.ts:35`（`verifySummary(input.original, input.summary, null, config)` 硬编码 `slots: null`）、
  `src/callbacks.ts:86-94`（`VerifyInput` 接口**没有 slots 字段**）、`src/orchestrator.ts:118-127`
- **链路断点**：orchestrator 的 `runVerify` 明明持有 `slots`（`compressSegment` 产出的分槽位结果），但
  `callbacks.verify !== undefined` 恒成立（DEFAULT 提供）→ 走钩子路径 → `VerifyInput` 类型上无法携带 slots →
  `defaultVerify` 传 null → `verifySummary` 的硬槽位逐字定位校验（`verify.ts:146-148`）**恒被跳过**。
- **后果**：LLM 摘要伪造槽位取值（不在原文中）时默认校验放行；`callbacks.ts:48` "每条取值必须逐字定位"的硬契约在默认链路无执行者。
  orchestrator 直调 `verifySummary(..., slots)` 的路径（`orchestrator.ts:126`）同为死代码。
- **修复方向**：`VerifyInput` 增加 `slots` 字段（或 defaults 侧不再注册 verify，交由 orchestrator 内置路径）。

---

## 三、P1 —— 契约违约与数据失真（8 项）

### P1-1 `TriggerDecision.cutPointId / boundaryType` 全链路无人消费

- **位置**：`src/contract.ts:269-271`（声明）、`src/trigger.ts:139-140`（产出）；orchestrator 全文 0 次读取。
- **脱节**：用户钩子返回的切点被丢弃；默认触发的切点也未传递给切割层——"触发切点 → selectSegment 尊重边界"这条数据流**根本不存在**，
  切割完全独立按 block 边界执行。契约场景"返回压缩决策且切点落在该边界信号处"只在单元层面对象字段成立，编排层无对应物。

### P1-2 有损降级后 `CompressedBlock.level` 字段失真、且可能 `level>=2` 而 `archiveRef=null`

- **位置**：`src/orchestrator.ts:147-149`（compressSegment 内归档失败退化为 L1，但只返回文本，不返回实际级别）与
  `src/orchestrator.ts:423-433`（runCycle 仍按原 `targetLevel` 记录 level；`archive.archive()` 二次失败时 `archiveRef=null`）。
- **后果**：产出块声明为 L2/L3，实际文本是 L1 无损裁剪结果，违反 `contract.ts:216-217`"L4 与全部有损级别 archiveRef 必须非空"的自述契约；
  且这类块因 `archiveRef===null` 被 `orchestrator.ts:276` 的再下沉候选排除，**永久停留在失真的级别标注上**；观测数据（level/method）失真。
- **同类**：verify 失败降级为抽取式（`orchestrator.ts:180-189`）后 level 仍记原 targetLevel——语义上可辩护（级别单调），但与"降级为 L1"的注释相矛盾，需统一口径。

### P1-3 `verify` 返回的 `warnings`（软实体处置记录）被静默丢弃

- **位置**：`src/orchestrator.ts:170-193`：`runVerify` 结果只用 `passed/missing`，`VerifyReport.warnings` 从未读取；
  `src/contract.ts:350` 明确承诺"软实体未达阈值时的处置记录，**不静默忽略**"。
- **后果**：`softEntityAction: 'warn'` 的全部告警无处落地，观测层对软实体丢失零感知。

### P1-4 `topic-shift` 边界在两条路径上方向相反的失真

- **路径 A（DEFAULT_CALLBACKS）**：`defaults.ts:48` 每次新建 `createVectorSpace()` 却**从不 `addDocument`** → 空语料空间
  `vectorize` 返回空向量 → `cosine` 恒 0 < `relevanceThreshold(0.15)` → 只要有 ≥2 条用户消息**恒命中 topic-shift**（假阳性）。
- **路径 B（orchestrator 内置，当前为死代码）**：`orchestrator.ts:225` 调用 `shouldCompress(...)` 不传 `space` →
  `trigger.ts:90` 判 `space === undefined` 跳过 → topic-shift **恒不检测**（假阴性）。
- **契约违约**：`trigger-watermark.feature` Outline 行"用户新消息与前一话题的增益相关性低于阈值"在两条路径上都无法正确工作。

### P1-5 `ObservationRecord.cacheImpact` 硬编码 true，未经验证

- **位置**：`src/orchestrator.ts:548-551`：`prefixStable: true` / `breakpointAfterHead: true` 直接写死，
  注释声称"head 消息保持原引用"但代码未做任何比对验证；同函数 L534 的 `headTokens` 计算后 `void` 丢弃（L556）。
- **后果**：观测字段失真——若 head 定义与实际替换锚点出现偏差（如自定义 selectSegment 返回的段锚点极靠前），
  报告仍宣称 prefix 稳定，事后审计被误导。契约场景"稳定前缀在压缩前后逐字节不变"依赖该字段，断言对象自身未被实现验证。

### P1-6 `ErrorContext.phase` 恒为 `'compress'`

- **位置**：`src/orchestrator.ts:93`：`phaseToName` 签名声明六种阶段返回值，实现无条件返回 `'compress'`。
- **后果**：`onError` 钩子的 phase 维度失真，宿主无法区分错误发生在 trigger/select/pin/verify/commit 哪一阶段。

### P1-7 契约引用了不存在的指标 `compress_deferred_count`

- **位置**：`features/trigger-watermark.feature:68`（`And 指标 compress_deferred_count 增加 1`）。
- **现状**：全代码库无此指标的定义与维护；world.ts 的 `metrics` 表按告警名计数，亦无此键。
  契约场景引用幽灵指标——该场景的真实断言大概率未生效或被绕过。

### P1-8 README 示例调用不存在的 API：`archive.rebuildIndex()`

- **位置**：`README.md:125-127`：示例对 `JsonlArchiveSink` 实例调用 `rebuildIndex()`；该类（`archive.ts:85-134`）**没有此方法**。
  `rebuildIndex` 只在 `createArchive` 门面上（`archive.ts:242`），且 `ContextCompressor` 门面（`api.ts`）不暴露 archive 实例——
  宿主按 README 操作必然 TypeError；即使自行包一层门面，也与 orchestrator 内部持有的 Archive 实例**不共享索引**，
  "进程重启后索引重建"在公共 API 层实际不可达。

---

## 四、P2 —— 边界缺陷与健壮性问题（9 项）

### P2-1 `dedupePins` 同一消息的多个局部 pin 只保留一个

- **位置**：`src/pins.ts:178-192`：按 `msgId` 单键去重，第二条同 msgId 的 span pin 因 `existing.span !== undefined` 判 not-better 被丢弃。
  `identifyStaticPins` 对同一消息的多条 pending 待办逐行 push（`pins.ts:132-134`），去重后只剩第一行。
- **影响范围有限的原因**：pin 的实际保护力是"消息所在 block 整体退出候选"（`blocks.ts:161-162`），span 仅用于提交断言，
  故多数场景被架构兜底；但作为公共导出 API（`index.ts:114`）供宿主使用时，丢 span 是真实缺陷——被丢 span 的文本不进入 pin-in-place 断言。

### P2-2 `createEmbedderSpace.cosine` 维度不等时产生 NaN

- **位置**：`src/gain.ts:23-31`：`len = Math.min(a.length, b.length)` 但点积循环用 `i < a.length`；`b[i]` 越界为 undefined → dot=NaN → gain=NaN。
- **触发条件**：宿主 embed 模型维度不一致（模型切换、截断配置）。
- **连锁**：NaN 参与排序时 `b.gain - a.gain` 为 NaN（falsy）→ 回退 order 排序，预算分配静默失真，无告警。
- **注**：`signals.ts:126-136` 的 VectorSpace.cosine 是同款实现的复制品（同隐患同模式），两处重复实现本身违反复用原则。

### P2-3 fallback 的 abort 分支缺少 break —— 外部取消后仍重试

- **位置**：`src/fallback.ts:114-123`：`controller.signal.aborted` 分支 push warning 后**未 break**，循环继续下一次 attempt。
  外部 signal 已 abort 时会再跑一轮注定失败的 compress；超时场景（15s）×重试次数叠加最长等待。
- **关联缺口**：orchestrator 传入的 `input.signal` 是 `new AbortController().signal`（`orchestrator.ts:162`）——永不中止的死信号；
  `maybeCompress` 公共 API 不接受 AbortSignal。`config.llmTimeoutMs` 等超时配置在 fallback 内部生效，但"整体取消"通道在公共 API 层缺失。

### P2-4 `isValidSchema` 槽位校验过弱

- **位置**：`src/fallback.ts:48-52`：仅检查 `output.slots !== undefined`，不校验 `constraints/artifacts/todos` 是否为数组、元素是否字符串。
  宿主返回 `slots: 42` 也能通过 schema 检查进入后续流程（类型层 `SummarySlots` 的形状在运行时未被验证）。

### P2-5 fallback heuristic 级与 L1 去噪产出空文本无防护

- **位置**：`src/fallback.ts:143-148`：heuristic 级未检查 `heuristicText.trim().length === 0`（truncate 级 L156 有检查，不对称）。
  极端输入（全空白原文）经 l3Coarsen 可能产出空文本 → 生成空 content 的压缩块消息，主流 Chat API 对空文本消息会 400。

### P2-6 `JsonlArchiveSink` 同步 I/O + 并发追加竞态

- **位置**：`src/archive.ts:92-98`：`statSync().size` 与 `appendFileSync` 之间存在窗口，并发 append 双方取得相同 offset →
  索引偏移失真；`readAll` 全量 `readFileSync` 阻塞事件循环（库定位为"可嵌入任意 Agent 运行时"）。
  另 `ensureInit` 的 `initialized = true` 先置位后 await（`archive.ts:184-188`），并发首次调用会拿到未建完的索引，hash 去重失效产生冗余行。

### P2-7 L1 `duplicate-read` 行级实现与"输出级"契约语义偏差

- **位置**：`src/levels/l1.ts:110-134`：按"行"提取指纹去重，同一条 tool 消息内部多行含同一实体（如一次 ls 输出 20 行同前缀路径）
  会被互删到只剩最后一行。契约（`l1.ts:10` 注释自述）粒度是"同一文件的重复**读取输出**只保留最新一次"——输出=消息级。
- **同类**：`referenced-later` 反向保护只覆盖 duplicate-read 与 oversized-stdout 两条规则（`l1.ts:127,151`），
  superseded-result / repeated-failure 删除的行即使被后续显式引用也不受保护。

### P2-8 `advancedVerify` 的多值 join 答案定位必然误报

- **位置**：`src/verify.ts:82-89,116-119`：`answer = slots.xxx.join(' ')`，再 `original.includes(answer)`。
  槽位含多个取值时（如两个不同路径），原文中两值几乎不可能以 `' '` 相邻出现 → 恒判 missing → verify 恒不通过 → 触发无意义降级链。
  `advancedVerifyEnabled` 开启即劣化，属"开关打开即坏"型缺陷。

### P2-9 `defaultTokenCounter` 中文标点未计入

- **位置**：`src/config.ts:188-196`：CJK 区间未覆盖全角标点（`，。；：！？`等 U+FF01-FF60、U+3000-303F），
  且 latin 分词分隔符表无中文标点 → `完成，交付` 整体算 1 个 latin 词 + 4 个 CJK 字符，token 系统性偏低。
  影响触发水位提前量与 token-consistency 断言的容差基准。注释已声明为占位，但偏差方向一致（低估），值得在标定前修正。

---

## 五、P3 —— 死代码、冗余与纪律问题（7 项）

| # | 位置 | 问题 |
|---|---|---|
| P3-1 | `src/orchestrator.ts:336` | `msgIndex` 构建后全文无引用，死代码 |
| P3-2 | `src/orchestrator.ts:188` | 截断后 `verify = runVerify(...)` 的赋值结果从未使用（死赋值），截断后是否通过校验无人关心——若契约要求"截断后仍须校验"则此环节缺失 |
| P3-3 | `src/callbacks.ts:143-145` + `index.ts:73` | `FallbackLevel` 接口声明并导出，无任何实现与使用 |
| P3-4 | `src/levels/l2.ts` 全文件 | `extractSlots` / `verifyHardSlots` 仅导出、无内部调用方；`verify.ts:11` 注释声称"硬槽位逐字校验在 levels/l2.ts 的 verifyHardSlots"，实际 `verify.ts:146-148` 自行重写了一份——**L2 分槽位抽取兜底从未接入降级链**（fallback 的 heuristic 级走 `l3Coarsen` 且不产出 slots），l2.ts 的存在意图（"无 LLM 时的分槽位兜底"）与实际接线脱节 |
| P3-5 | `src/levels/l2.ts:60` | `narrative.length < 6` 硬编码数字，违反 `config.ts:64`"源码其余位置不得出现待标定数字"的自家纪律 |
| P3-6 | `src/gain.ts` 与 `src/signals.ts` | cosine 双份重复实现（含同款 NaN 隐患），违反复用原则 |
| P3-7 | `src/blocks.ts:58` | `parseToolBlocks.finish` 用 `msgs.find` 逐块线性查找，整体 O(n²)；长会话下解析成本显著 |

另：`src/pins.ts:109,115` 命令符号与 URL 的 pin reason 复用 `'deliverable-path'`（枚举无对应值），语义失真；
`config.ts:210-238` 未校验 `maxLevel` 合法取值（0-4 枚举）；`RE_HASH`（`patterns.ts:46`）不含大写十六进制，
大写 hash 在指纹/L3 显著行判定中漏检（保守方向，仅信息量损失）。

---

## 六、"测试为何全绿"的根因分析

1. **触发类场景绕过接线层**：`world.ts:66-68` 手工构造 `TriggerContext` 直调 `shouldCompress()`，P0-1/P0-2 的断裂不在覆盖范围。
2. **校验类场景走 verifySummary 直调**：槽位校验场景直接构造 slots 调用 `verifySummary`，P0-3 的 VerifyInput 缺口不在覆盖范围。
3. **`makeConfig` 强制 `tailTurns: 1`**（`world.ts:132`）：默认值 `tailTurns: 6` 的行为从未被契约锁定——"tailTurns 按'条消息'而非'轮'计"的语义偏差（`blocks.ts:165` 直接用消息条数差）无测试约束。
4. **契约存在幽灵断言**：P1-7 的 `compress_deferred_count` 无实现，场景通过依赖的是其它宽松断言。
5. **观测字段自身即断言对象**：P1-5 的 cacheImpact 硬编码 true，"断言生产者"而非"断言行为"。

---

## 七、修复优先级建议

| 优先级 | 事项 | 预估改动面 |
|---|---|---|
| 立即 | P0-1/P0-2：删除 defaults 与 orchestrator 二选一的重复触发接线——orchestrator 保留唯一实现，`DEFAULT_CALLBACKS.shouldCompress` 移除，让宿主省略时走内置路径；轮次状态由 orchestrator 以实例字段真实维护 | `defaults.ts`、`orchestrator.ts` |
| 立即 | P0-3：`VerifyInput` 增加 `slots?: SummarySlots \| null`，`defaultVerify` 透传 | `callbacks.ts`、`defaults.ts` |
| 高 | P1-2：`compressSegment` 返回实际生效级别，runCycle 按实际级别落盘 | `orchestrator.ts` |
| 高 | P1-1：orchestrator 消费 `decision.cutPointId`（至少校验其落在切割边界附近，否则告警） | `orchestrator.ts` |
| 高 | P1-3/P1-5/P1-6：warnings 上报 onWarning；cacheImpact 真实比对；phaseToName 按 runCycle 阶段传参 | `orchestrator.ts` |
| 高 | P1-4：DEFAULT 触发路径传入真实语料空间或干脆禁用 topic-shift（返回保守不判定） | `defaults.ts` |
| 中 | P2-2（两处 cosine 收敛为一处 + `i < len`）、P2-3（aborted 分支补 break）、P2-5（heuristic 级空文本防护）、P2-8（advancedVerify 逐值定位） | 对应文件 |
| 中 | P1-8：README 修正为 `createArchive(sink).rebuildIndex()`，并在 ContextCompressor 暴露 archive 门面 | `README.md`、`api.ts` |
| 低 | P3 清单逐项清理；`features/trigger-watermark.feature:68` 幽灵指标改为可实现的 metrics 断言 | 多文件 |

---

## 八、统一验收测试建议（收尾阶段执行）

按项目规则，本轮未执行测试。修复完成后建议按以下顺序验收：

1. `npm run typecheck` —— 类型层先过；
2. **新增集成场景**（补齐当前缺口）：
   - 默认门面（只传 compress）连续触发两轮压缩的端到端场景（P0-1 回归）；
   - 压缩后紧接着再调 maybeCompress 的 settled/迟滞场景（P0-2 回归）；
   - 走 `createContextCompressor` 全链路的槽位伪造拒绝场景（P0-3 回归）；
3. `npm run test:invariant` —— 三铁律 + API 400 防线回归；
4. `npm run test` —— 全量契约回归；
5. `npm run api:check` —— 导出面与文档一致性门禁。

---

## 九、正交说明：本轮未覆盖项

- `dist-test/`、`api-plus/`、`scripts/check-api-contract.ts`、`scripts/generate-api-docs.ts` 未做深度走读；
- `cucumber.json` 与 CI 集成链路未审计；
- 并发场景（同 epoch in-flight 复用、CAS 冲突）仅做静态推演，未做压测复现。