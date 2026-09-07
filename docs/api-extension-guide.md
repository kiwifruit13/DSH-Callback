# API 扩展使用教程：以代码为唯一真相源的契约扩展流程

> 适用范围：本仓库（dsh-callback）全部公共 API 的新增、修改、删除。
> 方案源头：`api-plus/`（Python 参考实现）→ 本仓库 TS 移植（`scripts/generate-api-docs.ts` + `scripts/check-api-contract.ts`）。
> 核心铁律：**文档不手写、不背书。代码动了，重跑生成器即可；门禁不通过，就不算完成。**

---

## 一、为什么是这条路径

传统做法是「先写文档 → 再改代码」，两份独立维护的产物必然漂移。本项目的替代方案只有一条规则：

```
代码契约（类型 + TSDoc）→ 重新生成 Manifest → 门禁验证
```

- **代码是唯一真相源**：`docs/` 下四份产物全部由生成器产出，**禁止手改**；
- **Manifest 是唯一中间表示**：纯 JSON（`docs/api_manifest.json`），契约测试与文档渲染消费同一份，结构上保证互不矛盾；
- **门禁机器裁决**：`api:check`（漂移）与 `api:contract`（五类契约）退出码非 0 即失败，不依赖人工记忆。

## 二、扩展前决策：向后兼容 or 破坏性变更

动手前先归类。**只有向后兼容的扩展可以直接走本教程标准流程**；破坏性变更必须先在 `bugs_todo.md` / 设计讨论中登记裁决。

| 变更类型 | 兼容性 | 处理方式 |
|---|---|---|
| 函数/方法新增**可选**参数 | ✅ 兼容 | 标准流程（本教程） |
| interface 新增**可选**字段 | ✅ 兼容 | 标准流程 |
| 字符串字面量联合类型**新增取值** | ✅ 兼容 | 标准流程（消费方 switch 需自查 default 分支） |
| 新增导出符号 | ✅ 兼容 | 标准流程 |
| 必填参数/字段改成可选 | ✅ 兼容（放宽） | 标准流程 |
| 参数/字段改名或删除 | ❌ 破坏 | 先登记裁决，走弃用期（旧名保留 + TSDoc `@deprecated`） |
| 必填项加严、类型收窄 | ❌ 破坏 | 先登记裁决 |
| 删除导出符号 | ❌ 破坏 | 先登记裁决，确认零引用后执行 |
| 枚举/联合类型删除取值 | ❌ 破坏 | 先登记裁决（集成方可能按旧值 switch） |

> 判定口诀：**「旧调用方代码一行不改、重新编译后行为不变」→ 兼容**。

## 三、标准流程五步

### Step 0 · 盘点影响面

先回答三个问题，写进改动说明（commit / todo 条目）：

1. **触及哪些公开符号**？从 `docs/api_reference.md` 或 `docs/api_manifest.json` 检索受影响类型；
2. **是否存在多接口同型**？本项目至少两处同名方法需同步（如 `Orchestrator.maybeCompress` 与门面 `ContextCompressor.maybeCompress`）——改一处漏一处是最常见的结构脱节；
3. **消费方有哪些**？`grep -rn "<符号名>" src/ features/` 全量过一遍，含测试接线。

### Step 1 · 改代码契约（类型 + TSDoc）

在**定义处**（不只是别名处）修改类型签名，并同步补齐 TSDoc。TSDoc 是门禁的一部分（覆盖率下限 70%，`api:contract` 强制），必写项：

```ts
/**
 * 一句话职责。
 *
 * @param state 被评估的状态。语义约定写这里（谁拥有、是否可变、复用规则）。
 * @param signal 可选整体取消通道。语义四要素：
 *   ① 入口已中止时的行为；② 过程中中止的行为（是否透传到钩子）；
 *   ③ 提交后中止是否追溯；④ 并发/重入时的归属规则。
 * 返回值二元性：新状态（已提交）或原状态引用逐字节不变（未触发/中止/回滚）。
 */
maybeCompress(state: ContextState, signal?: AbortSignal): Promise<ContextState>;
```

TSDoc 规范要点：

- 可选参数**必须**写明「缺省时的行为」（等价于什么默认值/默认路径）；
- 新增枚举值/联合取值**必须**写明「与旧取值的语义边界」，特别是它纠正了什么失真（如 `'host-decision'`：不伪造 `task-boundary`）；
- 涉及原子性的行为必须写明「提交点在哪、中止是否追溯」；
- 别名再导出由生成器自动合并到定义处，**注释写在定义处**。

同时更新 README 中的最小接入示例（若签名出现在示例里）。

### Step 2 · 同步全部同型接口与门面

对 Step 0 盘点出的每个同型接口逐个修改。检查清单：

- [ ] 内部接口（如 `Orchestrator`）已改；
- [ ] 公共门面（如 `ContextCompressor`）已改，且**参数原样透传**，不做二次包装丢参；
- [ ] 实现体已消费新参数（**禁止只改签名不接线**——那是死参数，比没有更糟）；
- [ ] 相关 README / `docs/CLAUDE.md` 约定同步。

### Step 3 · 重新生成 Manifest

```bash
npm run api:docs        # 重新生成 4 份产物到 docs/
```

- 产物：`api_reference.md`、`api_class_reference.md`、`api_enums.md`、`api_manifest.json`；
- 生成器**输出字节级确定**（无时间戳、无绝对路径、迭代显式排序），因此 `git diff --exit-code docs/` 可稳定用作 CI 门禁；
- 生成后用 `git diff docs/` **人工复核一遍**：确认变更面与 Step 0 的盘点一致，出现计划外的符号变化即说明有遗漏接线。

### Step 4 · 四层验证（顺序固定，全部通过才算完成）

```bash
npm run typecheck      # ① 编译层：源码 + 消费方类型全过
npm run api:check      # ② 漂移门禁：docs/ 与实时代码零漂移
npm run api:contract   # ③ 契约门禁：五类契约 + TSDoc 覆盖率 ≥ 70%
npm test               # ④ 行为层：全量契约场景（含为新行为新增的 Gherkin 场景）
```

**行为层不可省略**：类型与文档只证明「签名存在」，不证明「语义正确」。按项目契约先行约定，为新行为补 Gherkin 场景（正常 / 异常 / 边界 / 权限四类中至少覆盖受影响的类别），走门面级接线而非占位夹具。

---

## 四、实战案例回放：`maybeCompress` 增加 AbortSignal（R5-9）

> 完整改动见 `bugs_todo.md` R5-9 条目，此处提炼流程要点。

**Step 0 盘点**：触及 `Orchestrator`、`ContextCompressor` 两个接口（同型方法）；消费方为 `createContextCompressor`（api.ts）与全部测试接线；`CompressInput.signal` 已存在（死信号 `new AbortController().signal`），本次是「激活」而非新增概念。

**Step 1 类型与 TSDoc**：`Orchestrator.maybeCompress` 与 `ContextCompressor.maybeCompress` 同步加 `signal?: AbortSignal`，TSDoc 写明四要素（入口已中止 → 跳过且不推进轮次；过程中中止 → 信号透传给 compress 钩子、提交前放弃、状态逐字节原样；提交完成后中止不追溯；并发同 epoch 复用首个调用的 signal）。

**Step 2 接线（防死参数）**：`maybeCompress` → `runCycle(state, signal)` → `compressSegment(..., signal)` → `input.signal: signal ?? new AbortController().signal`（缺省语义与旧行为完全一致，兼容）；并在触发后 / 逐段间 / 提交前设三个取消检查点。门面 `createContextCompressor` 原样透传。

**Step 3 再生成**：`npm run api:docs` → diff 确认变更面恰为两个接口签名 +（同轮的）`ObservationRecord.triggerReason?` 与 `TriggerReason` 新取值。

**Step 4 验证**：新增 3 个门面级 Gherkin 场景锁定行为（整体取消 / 布尔触发如实标注 / 告警入观测记录），最终门禁：typecheck ✅ · api:check ✅ · api:contract（118 符号，TSDoc 94.1%）✅ · test 100 场景 725 步 ✅。

**经验教训**（测试接线层）：

- 门面在创建时**固化回调引用与配置**——测试中替换 `hookOverrides` / `configOverrides` 后必须重建 `createContextCompressor`，否则新钩子不生效（场景假失败的高发根因）；
- 默认预算下小会话的段全部落 L1（不调 compress 钩子），涉及钩子行为的场景必须显式压小 `targetBudgetTokens`。

---

## 五、门禁失败排查表

| 错误信息（`api:contract` 输出） | 根因 | 处置 |
|---|---|---|
| `无法加载入口模块 ../src/index.js` | 编译失败或循环依赖导致运行期 import 失败 | 先跑 `npm run typecheck`，修编译错误 |
| `找不到 Manifest，请先运行 npm run api:docs` | docs/api_manifest.json 不存在 | 重跑 `npm run api:docs` |
| `代码已导出 X，但 Manifest 未记录` | 新增导出后未再生成 | `npm run api:docs` |
| `Manifest 记录了 X，但代码中已不存在` | 删除/改名导出后未再生成 | `npm run api:docs`；若是破坏性变更，先走弃用流程 |
| `X 种类漂移：Manifest=... 实际=...` | 同名符号从 interface 改成 class 等 | 确认意图 → `api:docs` → 复核消费方 |
| `导出面声明了 X，但运行期取不到值` | 改名/循环依赖导致 import 得到 undefined | 修依赖方向，禁止 `export type` 与值导出混写 |
| `枚举 X 新增成员 M，Manifest 未同步`（联合类型同理） | 新增取值后未再生成 | `npm run api:docs`；并排查消费方 switch 是否有 default 兜底 |
| `公开符号 TSDoc 覆盖率 N% 低于下限 70%` | 新符号缺 TSDoc 或写成普通注释 | 按 Step 1 规范补齐（成员注释也计入） |
| `api:check` 报漂移 | docs/ 与代码不一致 | 永远以代码为准改完再生成，**不要手改 docs/** |

## 六、禁止事项（防逻辑跳跃）

1. **禁止只改签名不接线**：新增参数必须有真实消费点与行为差异，否则是死参数；
2. **禁止手改 `docs/` 下四份产物**：漂移门禁会以手改内容为基准，掩盖真相；
3. **禁止跳过 Step 0 盘点**：多接口同型漏改一处 = 结构脱节，`api:contract` 的符号级检查抓不到「语义同型但不同名」的方法；
4. **禁止用文档生成代替行为测试**：Manifest 正确 ≠ 行为正确，Gherkin 契约场景不可省；
5. **禁止在 TSDoc 里描述不存在的行为**：文档即承诺，门禁与集成方都会按它消费；
6. **禁止破坏性变更走「顺手改」**：一律先登记裁决（bugs_todo.md）再动手。

## 七、快速检查清单

```
[ ] Step 0：影响面符号清单 + 同型接口清单 + 消费方 grep 结果
[ ] Step 1：类型修改落在定义处；TSDoc 含可选参数缺省语义/边界/原子性
[ ] Step 2：全部同型接口同步；门面透传；实现体真实消费新参数
[ ] Step 3：npm run api:docs；git diff docs/ 复核变更面与盘点一致
[ ] Step 4：typecheck → api:check → api:contract → test 全绿
[ ] 行为：为新语义补 Gherkin 场景（走门面级接线）
[ ] 记录：bugs_todo.md / 工作日志登记本次扩展
```
