# DSH-Callback 实施清单

> 目标：把「渐进式上下文压缩」从 Gherkin 契约推进为**可被第三方环境集成的库**。
> 两条主线并行：**接口暴露面设计**（供集成）+ **实现落地**（供契约通过）。
> 状态图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[!]` 阻塞/待确认

---

## 0. 已确定的架构决策（不需要再讨论）

| 决策 | 取值 | 依据 |
|---|---|---|
| 语言 | TypeScript（ESM） | `cucumber.json` 的 `import: features/support/**/*.ts` |
| 运行时 | Node 18+，零运行时依赖（不绑定任何 LLM SDK） | 「集成到别的环境」要求 |
| 测试 | cucumber-js + tsx loader | README §5 |
| 导出面 | `src/index.ts` **唯一公共入口**，内部模块一律不导出 | api-plus 的 `__all__` 等价物 |
| 阈值 | 全部走 `CompressConfig` 注入，源码内不出现待标定数字 | 契约纪律 README §1 |
| 文档 | 由 `scripts/generate-api-docs.ts` 从源码生成，禁止手改 | api-plus 单一真相源 |

### 分层与依赖方向（严格单向，不可回指）

```
src/index.ts            公共导出面（唯一入口，含 TSDoc）
   ↑
src/api.ts              门面：createContextCompressor()
   ↑
src/orchestrator.ts     一轮压缩的编排：触发 → 切割 → pin → 压缩 → 校验 → 提交
   ↑
src/trigger.ts   src/blocks.ts   src/pins.ts   src/gain.ts   src/verify.ts
src/levels/*     src/fallback.ts  src/archive.ts  src/signals.ts
   ↑
src/contract.ts         全部类型 / 枚举 / 错误（无实现、无副作用）
src/defaults.ts         默认配置与默认钩子实现
```

---

## 1. 阶段划分

### 阶段 A — 工程骨架 `[x]`

- [x] A1 `package.json`（name `dsh-callback`、type module、脚本 `test` / `test:invariant` / `api:docs` / `api:check`）
- [x] A2 `tsconfig.json`（strict、`declaration`、ESM）+ `tsconfig.build.json`
- [x] A3 `.gitignore`
- [x] A4 安装 `@cucumber/cucumber` `tsx` `typescript`（152 包 / 13s，npmmirror）

**验收**：`npx tsc --noEmit` 通过；`npm run test` 能启动 cucumber（允许全部 pending）。

---

### 阶段 B — 公共契约层（本阶段是「接口清晰暴露」的核心）`[x]`

- [x] B1 `src/contract.ts`
  - 消息模型：`Message` / `ToolCall` / `Role` / `Vendor`
  - 结构模型：`ToolBlock` / `Segment` / `SourceSpan` / `ArchiveRef`
  - 保护模型：`PinRecord` / `PinReason`（八值，见 §3 待确认项）+ `PIN_REASON_PRIORITY` 优先级表
  - 产物模型：`CompressedBlock` / `CompressLevel` / `CompressMethod`
  - 决策模型：`TriggerDecision` / `TriggerReason` / `BoundaryType` / `BudgetAssignment`
  - 报告模型：`VerifyReport` / `CacheImpact` / `ObservationRecord`
  - 错误模型：`CompressError` + `NoCompressionPossible` / `ArchiveCorrupted` / `ArchiveUnavailable` / `HookError` / `CommitAssertFailed`
- [x] B2 `src/config.ts` — `CompressConfig` 全阈值 + `resolveConfig()`（默认值合并、区间校验）、`ArchiveSink` 抽象（Q4）、`defaultTokenCounter`
- [x] B3 `src/callbacks.ts` — 六钩子接口 + 失败语义表 + `IdempotencyKey` / `SummarySlots` / `CompressInput` / `CompressOutput`
- [x] B4 `src/index.ts` — 显式导出面（白名单，非 `export *`），每个导出带 TSDoc

**验收**：`src/` 下无任何 `any`；`import { ... } from 'dsh-callback'` 即可拿到全部集成所需符号。

---

### 阶段 C — API 文档生成与漂移门禁（api-plus 的 TS 等价物）`[x]`

- [x] C1 `scripts/generate-api-docs.ts` — 用 TypeScript 编译器 API 扫描 `src/index.ts` 的导出符号，产出：
  - `docs/api_manifest.json`（机器可读中间表示，供门禁与未来变更日志消费）
  - `docs/api_reference.md`（完整参考，含签名与 TSDoc）
  - `docs/api_class_reference.md`（符号速查表：符号 / 种类 / 定义模块 / 职责）
  - `docs/api_enums.md`（枚举汇总）
- [x] C2 输出确定性：无时间戳、迭代显式排序，保证 `git diff --exit-code docs/` 可当门禁
- [x] C3 `--check` 漂移检测：代码改了没重跑生成器则退出码 1
- [x] C4 `scripts/check-api-contract.ts` — 契约门禁：
  - 导出面每个符号在运行期真实可访问（防"声明了但 import 失败"）
  - manifest 中符号与实时代码一致（防文档写了 `prepare()` 代码里是 `prepareContext()`）
  - 枚举成员无漂移
  - 公开符号 TSDoc 覆盖率阈值

**验收**：`npm run api:docs` 产出四份文件；`npm run api:check` 在改动导出面后失败、重跑后通过。

---

### 阶段 D — 核心实现 `[x]`

按**依赖顺序**执行（原顺序已调整：`defaults.ts` 依赖其余模块，故后移至 D11）。

- [x] D1 `src/blocks.ts` — tool block 状态机解析（并行调用、乱序 result、孤儿 result、被截断块）、`selectSegment` 边界切割、`segmentsAreSafe` 门禁
- [x] D2 `src/patterns.ts` + `src/pins.ts` — 实体/关键词正则库（pins 与 verify 共用，防两套规则漂移）；pin 识别（九值 reason + 优先级去重）、span 局部 pin、静态白名单降级（pin_hook_degraded）
- [x] D3 `src/archive.ts` — `MemoryArchiveSink` / `JsonlArchiveSink`、source_hash 双道校验、共享原文去重、惰性索引重建、API 已统一为异步
- [x] D4 `src/signals.ts` — TF-IDF 字符二元组向量（中英混排、路径整体 token、无外部分词依赖）
- [x] D5 `src/levels/l1.ts`（抽取式，输出 ⊆ 输入，四条去噪规则）· `l2.ts`（分槽位）· `l3.ts` · `l4.ts`（指针）
- [x] D6 `src/gain.ts` — 增益评分、冗余度 λ 加权、预算分配、并列增益稳定排序
- [x] D7 `src/verify.ts` — 硬/软实体正则校验、硬槽位逐字定位校验
- [x] D8 `src/fallback.ts` — llm → heuristic → truncate → 放弃，`AbortController` 超时、非法 JSON 重试一次
- [x] D9 `src/trigger.ts` — 双水位 + 迟滞 + 任务边界识别 + 频率下限 + 强制压缩
- [x] D10 `src/orchestrator.ts` — 一轮编排 + 提交前三断言 + epoch CAS + 幂等缓存 + in-flight 去重 + 观测记录
- [x] D11 `src/defaults.ts` — 六个钩子的默认实现（契约：宿主只提供 `compress` 也要能跑通）
- [x] D12 `src/api.ts` — `createContextCompressor()` 门面

**验收**：`npx tsc --noEmit` 通过。

---

### 阶段 E — 契约支撑层 `[x]`

- [x] E1 `features/support/world.ts` — ContextState fixture、stub compressor（截断式 / 固定槽位式）、配置注入、临时归档目录隔离
- [x] E2 `features/support/fixtures.ts` — `history()` 链式 DSL（含乱序 / 孤儿 / 不完整 tool 构造）
- [x] E3 `features/support/steps/*.ts` — 九个文件，一比一对应九个 feature

**验收**：`npm run test` 不再全部 pending。

---

### 阶段 F — 结尾统一验收 `[x]`

按用户要求，测试集中在结尾执行，过程中不跑。

- [x] F1 `npm run api:check`（导出面与文档一致）— 无漂移；F4 期间改动 src 后已重新 `api:docs`（117 符号）
- [x] F2 `npm run test:invariant`（`@invariant` 四文件，提交前必过）— 42/42 全绿
- [x] F3 `npm run test`（全量 94 场景 / 663 步骤）— 94/94 全绿
- [x] F4 修复全部失败项，直到 F2 / F3 全绿（修复清单见下方「F4 修复记录」）
- [x] F5 补 `README.md`（集成示例：最小接入、六钩子替换、观测接入、归档回溯、契约测试命令）

#### F4 修复记录

**基础设施（阻塞项）**：
- Windows + npm(Git Bash) 下盘符大小写不一致（CLI CJS 链 `d:\` vs ESM 动态导入 `D:\`）导致 cucumber
  双实例，support 步骤落在未初始化实例上报 "isn't running (PENDING)"。修复：新增 `scripts/run-tests.mjs`
  （`fs.realpathSync` + 盘符大写规范化加载 Cli）、`tsconfig.test.json` 预编译到 `dist-test/`、
  `cucumber.json` 改用编译产物、`features/support/cucumber.ts` shim 统一经 createRequire 走 CJS 实例；
  package.json test 脚本改为 `tsc -p tsconfig.test.json && node scripts/run-tests.mjs`。
- 锁定 `@cucumber/cucumber` 11.2.0。

**实现层 src/**：
- `fallback.ts`：llm 级超时中断误判为宿主钩子崩溃。修复：以组合控制器是否 aborted 区分
  超时/外部取消（继续降级）与主动抛异常（立即 NoCompressionPossible）。
- `orchestrator.ts`：观测记录 level/method 取 blocks[0]，L4 指针块在前时误记为 none。
  修复：取第一个 method !== 'none' 的块。
- `defaults.ts`：门面默认 shouldCompress 固定 `turnsSinceLastCompress: 1` 触发频率下限，
  导致「只实现 compress」的宿主永远无法完成首次压缩。修复：epoch 0 视为无历史（不受频率下限约束）。

**契约步骤 / 夹具**：
- 路径/URL 实体触发 deliverable-path pin 把整个 block 锁死 → 无段可压（entity-verify / fallback-chain /
  rehydrate 三个夹具族）。修复：夹具实体改用 hash（不触发 pin）或纯文本，路径仅保留在 tool_calls.args。
- `shared.steps.ts`：method 断言取最后一个块，L4 指针块在后时误判。修复：新增 `lastRealBlock`
  （最后一个非 none 块）。
- entity-verify：重压/抽取式/截断三场景共用夹具但预算需求互斥。修复：重压场景预算 1（L3）、
  抽取式场景预算 20（L1 输出装得下→heuristic）、截断场景预算 1（L1 输出超预算→truncate），
  并用同指纹三行文本让 L1 duplicate-read 把输出压缩到远小于整段。
- verify / compress 钩子未传入 orchestrator（verifyCallCount 恒 0、verify 抛异常场景走了默认校验）。
- gain-budget：L4 场景缺内存归档（archiveRef 恒 null）；anchor 反例 segB 文本与查询零重叠。
- trigger-watermark：topic-shift 场景被 tool-seq-end 抢先命中（去掉 toolRound）；forced 场景夹具
  含 toolRound 必然产生边界（改为纯文本双消息）。
- rehydrate：归档不可用 sink 的 `readAll` 立即调用 bug；「损坏指针拒绝再下沉」场景状态构造改为
  真实已提交形态（原始块已被 cb 消息替换）。

---

## 2. 执行纪律

1. **改行为先改契约**：feature 文件优先于代码。
2. **不得为让实现通过而放宽断言**，尤其两条：tool block 配对完整性、硬实体保留率 1.0（README §6）。
3. **不出现待标定数字**：水位、λ、下沉上限、超时、阈值一律 `CompressConfig` 注入；唯一例外是硬实体保留率恒为 `1.0`。
4. **逻辑不跳跃**：每个模块的实现必须落在上述清单的对应条目上，禁止跳过某条直接宣称完成。
5. **禁止在过程中跑测试**，全部留到阶段 F。

---

## 3. 待确认项（实现前需你拍板）

| # | 问题 | 现状 | 影响 |
|---|---|---|---|
| Q1 | `PinReason` 实际是 **9 个值** 还是 7 个 | README §1 声明"七种"，但契约场景实际要求 `tool-block-incomplete`（铁律三）与 `user-constraint`（硬约束场景）两种额外取值，否则会出现「被 pin 但 reason 不属于枚举」的自相矛盾 | `pin-protection` 的「取值属于既定枚举集合」断言 |
| Q2 | `tool-block-integrity` 的 Background 写死 `触发线 0.7 目标线 0.5` | 违反"零硬编码阈值"纪律，README 已自认为技术债 | 是否现在改为配置注入 |
| Q3 | 规划文件（§1–§13）不在本仓库 | README 大量引用，无法做双向追溯校验 | 需提供路径 |
| Q4 | 归档默认落盘位置 | 契约只说"JSONL 追加文件"，未指定 | 需一个可注入的 `ArchiveSink` 接口 |
| Q5 | 是否需要同时提供 CJS 产物 | 若集成目标是 CommonJS 环境 | 构建配置 |
| Q6 | 硬约束（「必须在原文件上原地修改」）应归哪个 reason | 契约场景要求 pin，但原枚举无对应值 | 现补为 `user-constraint`，如应归入 `user-remember` 请指出 |

> Q1 / Q2 / Q4 的实现按**当前契约文本**执行（8 值、0.7/0.5 保留、抽象成可注入 sink），待你确认后再改，避免阻塞。

---

## 4. 进度记录

| 日期 | 完成项 | 备注 |
|---|---|---|
| 2026-09-06 | 项目全貌梳理 | 9 feature / 80 场景 / 94 展开，三铁律已识别 |
| 2026-09-06 | 阶段 A 工程骨架 | package.json / tsconfig / 依赖（152 包） |
| 2026-09-06 | 阶段 B 公共契约层 | contract.ts + config.ts + callbacks.ts + index.ts，52 个公开符号 |
| 2026-09-06 | 阶段 C API 文档与门禁 | 四份产物 + 漂移检测 + 契约门禁（实测可拦截未登记导出） |
| 2026-09-06 | 阶段 D1–D3 | blocks.ts / patterns.ts / pins.ts / archive.ts |
| 2026-09-06 | 阶段 D4–D12 全部完成 | signals / levels(4) / gain / verify / fallback / trigger / orchestrator / defaults / api，117 个公开符号，TSDoc 覆盖 94% |
| 2026-09-06 | 实现层缺口修复 | ① callbacks.verify 接线（异常→verify_hook_error→不通过）② §8.3 进阶问答校验（VerifyReport.qa）③ 再下沉路径（resink：单调/上限/compressCount）④ CAS 真实化（committedEpoch）+ 幂等重放 + token 断言公式修正 + assertCommit 导出 |
| 2026-09-06 | 阶段 E 支撑层完成 | world.ts（配置注入/双归档/stub 注入）+ fixtures.ts（HistoryBuilder DSL + 6 个确定性 stub）+ steps×10（shared + 9 feature 一比一）；363 个定义零重复、feature 步骤全覆盖（静态核对） |
| 2026-09-06 | API 文档同步复检 | contract.ts 新增 SlotQuestion / VerifyReport.qa 后 api:docs + api:contract + api:check 全通过（117 符号 / TSDoc 94%） |
| 2026-09-06 | F1–F2 | api:check 无漂移；invariant 42/42 全绿（修复 20 failed + 2 undefined：pin 误捕 cb 消息、selectSegment head 语义、幂等缓存未登记 producedBySeg、L1 四规则顺序、verify 槽位、open-todo 逐行 pin 等，详见 F4 修复记录） |
| 2026-09-06 | 测试基础设施修复 | Windows 盘符大小写导致 cucumber 双实例（PENDING）：新增 scripts/run-tests.mjs（realpath + 盘符规范化）+ tsconfig.test.json 预编译 dist-test + cucumber.ts shim（createRequire 走 CJS 实例）；cucumber.json / package.json 脚本切换；锁定 cucumber 11.2.0 |
| 2026-09-06 | F3–F4 | 全量 94/94 场景 / 663 步骤全绿：修复 fallback 超时误判（组合信号 aborted 区分）、defaults 门面频率下限、观测 method 取主压缩块、三族夹具路径 pin、lastRealBlock 断言、gain L4 归档缺失、topic-shift/forced 夹具、rehydrate readAll 与损坏指针状态构造 |
| 2026-09-06 | F5 + 收尾 | README.md（最小接入 / 六钩子 / 观测 / 归档回溯）；api:docs 重新生成（117 符号）+ api:check 无漂移；阶段 A–F 全部 `[x]`，项目验收完成 |
