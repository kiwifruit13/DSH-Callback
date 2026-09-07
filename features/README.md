# Gherkin 规范层说明

本目录是渐进式压缩系统的**行为契约层**，不是实现。当前状态：**契约先行，实现未开始**。九个 `.feature` 文件定义了系统必须永远成立的行为约束，`src/` 下对应模块尚未编写。

设计依据见规划文件 §12。本文承载 §12.1 分工纪律、§12.2 确定性前提、§12.3 可追溯映射，以及实现启动前必须补齐的 step definition 清单。

---

## 1. 分工纪律：什么该写进 Gherkin，什么不该

| 关注点 | 载体 | 原因 |
|---|---|---|
| 系统必须永远成立的行为约束（三铁律、tool 配对、pin、原子性、硬实体 100%） | **本目录的 `.feature`** | 是人能读的合同，改代码前先改合同 |
| 「任意输入下 L1 输出 ⊆ 输入」这类全称命题 | **fast-check 属性测试** | Gherkin 只能举例，举不出无穷。`level-sinking` 里的子集场景只是示例，真正的保证在 `test/subset.property.test.ts` |
| 数值边界、正则模式穷举、token 计数精度 | **vitest 单元测试** | 写成场景会让 feature 膨胀成流水账 |
| 阈值取值（λ、软实体保留率、水位比例、下沉上限、超时时长） | **都不写** | 属规划 §13 待实测标定项，写死进场景会变成假约束 |

**一条硬纪律：本目录内不出现任何待标定的具体数字。**

水位比例、λ、下沉上限、超时时长等一律通过 `Given …由配置注入` 表达，具体值在 `support/world.ts` 的钩子里注入。这样标定后调参数不需要改契约。

例外只有一处：**硬实体保留率 1.0**。这不是阈值而是契约本身——路径、URL、UUID、命令符号错一个字符，Agent 就会对错误目标执行破坏性操作，所以它必须是 100%，没有标定空间。

### 与规划原文的两处偏离

1. **`level-sinking` 的下沉上限**：规划 §12.4 原文写「compress_count 已达上限 2」。此处改为「已等于配置注入的下沉次数上限」，断言从「值等于 2」改为「达上限即停、不再递增」。理由是遵守上述纪律，且改后能覆盖任意上限取值。
2. **`trigger-watermark` 的配置注入**：规划原文的 Background 写死了「触发线 0.7 目标线 0.5」。此处改为占位符 + 注入说明，同样为了不把待标定值固化进契约。`tool-block-integrity` 保留了原文的 0.7/0.5，因为该特性的断言与水位数值无关，水位只影响是否触发、不影响配对正确性——但若后续标定改动水位，这个 Background 需要同步更新，属已知技术债。

---

## 2. 确定性前提：所有场景禁调真实 LLM

Callback 架构在这里显出价值：`compress` 是钩子，测试期换成确定性 stub，于是压缩结果可预测、断言可精确。

`support/world.ts` 负责三件事：

1. 构造 `ContextState` fixture（含 head/middle/tail 三段与预解析的 `blocks`）
2. 注入 stub compressor —— 建议两种：
   - **截断式**：取每句首 8 字拼接。天然满足「输出 ⊆ 输入」，用于 L1 与降级链场景
   - **固定槽位式**：返回写死的 `SummarySlots` JSON。用于 L2 与实体校验场景
3. 提供归档的临时目录隔离，每个场景独立目录，跑完即弃

真实 LLM 的行为差异不进 Gherkin，进规划 §13 的标定流程。

**注意**：`fallback-chain` 里的「LLM 超时」场景需要 stub 支持可控挂起（返回一个永不 resolve 的 promise），由 `AbortController` 在配置注入的超时后中断。不要为此调用真实网络。

---

## 3. 可追溯映射表

| feature 文件 | 守护对象 | 对应源码（待实现） | 场景块 | 含 Examples 展开 | 标签 |
|---|---|---|---|---|---|
| `tool-block-integrity` | 铁律三 + §6 | `src/blocks.ts`, `src/pins.ts` | 8 | 8 | `@invariant` `@priority-critical` |
| `pin-protection` | §3 `onPreCompress` + §5 + §4 `PinReason` 全枚举 | `src/pins.ts` | 10 | 13 | `@invariant` `@priority-critical` |
| `level-sinking` | 铁律一 + 铁律二 + L1 去噪规则 | `src/levels/*`, `src/orchestrator.ts`, `src/archive.ts` | 9 | 12 | `@invariant` `@priority-critical` |
| `atomicity-idempotency` | §9.2 + §9.3 + §11 观测 | `src/orchestrator.ts` | 9 | 9 | `@invariant` |
| `trigger-watermark` | §7.1 + §7.2 cache 对策 | `src/trigger.ts` | 9 | 12 | — |
| `gain-budget` | §1.4 + §1.3 语义反转 | `src/gain.ts`, `src/signals.ts` | 9 | 9 | — |
| `entity-verify` | §8.1 + §8.2 + §8.3 | `src/verify.ts` | 9 | 14 | — |
| `fallback-chain` | §9.1 + §3 五钩子失败语义 | `src/fallback.ts`, `src/defaults.ts` | 9 | 9 | — |
| `rehydrate` | §4.1 | `src/archive.ts` | 8 | 8 | — |
| **合计** | | | **80** | **94** | 4 个 `@invariant` |

带 `@invariant` 的四个文件是提交前必跑集，对应规划 §12.6 的 `invariant-only` profile。它们守护的是铁律与 API 400 防线——违反即生产事故。

每个 feature 文件首行注释标明「守护哪条铁律 / 哪个章节 / 对应哪个源文件」，形成双向可追溯：改代码时知道要跑哪些场景，改场景时知道动了哪条约束。

### 规划清单之外的补充场景

各文件在规划 §12.4/§12.5 定稿场景之外做了补充，每处补充都在文件内以注释说明理由。汇总：

| 文件 | 规划定稿 | 实际 | 补充动机 |
|---|---|---|---|
| `tool-block-integrity` | 6 | 8 | result 乱序到达、被下一条 assistant 调用截断——两种畸形形态会让 pending 集合判定失效 |
| `pin-protection` | 6 | 10 | 规划 §4 定义了七种 `PinReason`，原清单只覆盖三种；补 `Scenario Outline` 覆盖余下四种，另加 span 局部 pin、钩子异常、重复识别去重 |
| `level-sinking` | 6 | 9 | L1 是唯一被强制「输出 ⊆ 输入」的级别，但其去噪规则未锁定；补 `Scenario Outline` 固定四条规则名，另加 L2 硬槽位摘抄、无归档禁止下沉 |
| `trigger-watermark` | 5 | 9 | 规划 §7.2 提了三条 cache 对策但原清单一条未覆盖；补稳定前缀、幂等键缓存复用、单轮多次穿越。另把 §7.1 的频率下限单列为场景 |
| `gain-budget` | 5 | 9 | 原清单只从「低增益不删」单向验证语义反转；补 anchor 反向对照场景，证明 anchor 选择确实影响排序（否则实现可能仍悄悄用当前 query 而测试照样通过）。另加混排向量化、并列增益稳定排序、增益基于原文重算 |
| `entity-verify` | 5 | 9 | 补 §8.2 链条的硬截断级、校验器自身抛异常（必须视为不通过而非放行）、原文无实体时不误判、§8.3 进阶校验默认关闭 |
| `fallback-chain` | 5 | 9 | 规划 §3 声明了五个钩子各自的失败语义且处置方向完全不同（不压缩/继续/中止），原清单只覆盖 compress；补另三个，另加非法 JSON 重试、最小实现可跑通 |
| `atomicity-idempotency` | 6 | 9 | 规划 §9.2 列了三项提交前断言，原清单只覆盖配对完整性；补 pin 在位、token 一致两项，另加观测记录 |
| `rehydrate` | 4 | 8 | 补归档不可用禁止下沉（否则等于永久丢信息，最严重的静默故障）、索引重建、哈希不一致拒绝、多块共享原文 |

### 一处有意的交叉引用

`trigger-watermark` 的「相同幂等键重试复用压缩结果」与 `atomicity-idempotency` 的「相同幂等键重复调用复用缓存结果」针对同一机制，但断言角度不同、不重复：

- 前者断言**压缩块文本逐字节相同**，守护的是 §7.2 cache 对策（避免字节抖动破坏 prompt cache）
- 后者断言**不再调用 compress 钩子**，守护的是 §9.3 幂等（避免重复消耗 LLM 调用）

实现时二者由同一份缓存满足，但两个断言都必须通过。不要把其中一个删掉。

---

## 4. 实现启动前需补齐的支撑文件

规划 §11 已列出目录结构，此处给出必须新建的支撑文件与各自职责。

```
features/support/
├─ world.ts          # Custom World：ContextState fixture 构造、stub compressor 注入、
│                    #   归档临时目录隔离、配置注入（水位/λ/上限/超时/阈值）
├─ fixtures.ts       # 对话历史构造 DSL：链式生成 head/middle/tail，
│                    #   构造完整与畸形 tool block、乱序 result、并行 tool_calls
└─ steps/
   ├─ block-steps.ts    # tool-block-integrity
   ├─ pin-steps.ts      # pin-protection
   ├─ level-steps.ts    # level-sinking
   ├─ trigger-steps.ts  # trigger-watermark
   ├─ gain-steps.ts     # gain-budget
   ├─ verify-steps.ts   # entity-verify
   ├─ fallback-steps.ts # fallback-chain
   ├─ atomic-steps.ts   # atomicity-idempotency
   └─ archive-steps.ts  # rehydrate
```

规划 §11 的目录树里 `steps/` 只列了五个文件，此处按九个 feature 一比一补齐——一个 feature 对应一个 steps 文件，避免步骤定义散落难以定位。

`fixtures.ts` 的构造 DSL 建议形态（供实现参考，非契约）：

```
history()
  .system("…")
  .userTurn("…")
  .assistantToolCalls(["call-1", "call-2"])
  .toolResult("call-2")            // 故意乱序
  .toolResult("call-1")
  .incompleteToolCall("call-3")    // 只有调用没有 result
  .orphanToolResult("call-x")      // 只有 result 没有调用
  .tail(turns)
```

这套 DSL 是 `tool-block-integrity` 八个场景能否精确表达的关键，优先实现。

---

## 5. 运行方式

```
npx cucumber-js --profile default          # 全量
npx cucumber-js --profile invariant-only   # 铁律与 API 400 防线，改动核心模块时必跑
npx cucumber-js --profile wip              # 开发中场景
```

TypeScript step definition 需 loader，推荐 `tsx`：

```
NODE_OPTIONS="--import tsx" npx cucumber-js --profile invariant-only
```

若项目采用 CommonJS，把 `cucumber.json` 里的 `import` 字段换成 `require`。

场景全部确定性、无网络，可秒级跑完，适合直接作为 CI 门禁。`invariant-only` 建议设为提交前强制通过项，`default` 设为合并前强制通过项。

---

## 6. 契约的修改纪律

改行为之前先改契约，改完契约再改代码。具体：

- 新增行为 → 先在对应 feature 加场景，再实现
- 修改既有行为 → 先改场景断言，确认场景失败，再改实现让它通过
- 删除行为 → 先删场景并在提交信息里说明理由，不要留着失败的场景

三个 `@priority-critical` 文件的场景不得为了「让实现通过」而放宽断言。若确实需要放宽，先回规划文件改对应章节并说明理由——尤其不得放宽这两条：

- tool block 的 assistant 与全部 result 必须同侧
- 硬实体（路径/URL/UUID/命令符号）保留率必须 1.0

这两条一旦放宽，产出的是「测试通过但会触发 API 400 或误操作文件」的系统。
