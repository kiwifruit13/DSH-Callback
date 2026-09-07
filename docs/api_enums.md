# dsh-callback 枚举与字面量联合汇总

> 本文档由 `scripts/generate-api-docs.ts` 自动生成，以代码为唯一真相源。
> 人工修改会被下次生成覆盖。若需更新 API 描述，请修改源码 TSDoc 后重新生成。

## `BoundaryType`

**定义模块**：`src/contract.ts`

任务边界类型。切点优先落在这类边界上。

| 取值 | 说明 |
|---|---|
| `"todo-transition"` | 一条待办状态由 pending 翻转为 completed。 |
| `"tool-seq-end"` | 一段连续工具调用序列终止且后续为纯文本。 |
| `"delivery-summary"` | 助手输出了交付总结且用户随后发起新话题。 |
| `"topic-shift"` | 用户新消息与前一话题的增益相关性低于阈值。 |

## `CompressErrorCode`

**定义模块**：`src/contract.ts`

压缩错误码。

| 取值 | 说明 |
|---|---|
| `"no-compression-possible"` | 三级降级全部失败，压缩不可能完成。 |
| `"archive-corrupted"` | 归档内容哈希不一致。 |
| `"archive-unavailable"` | 归档不可用，禁止有损下沉。 |
| `"hook-error"` | 用户钩子抛异常。 |
| `"commit-assert-failed"` | 提交前断言失败，整体回滚。 |
| `"verify-failed"` | 提交前断言失败的具体项。 |

## `CompressMethod`

**定义模块**：`src/contract.ts`

压缩产出的实际方法。 该标记必须随报告落盘，用于事后判定该段上下文的可信度（§9.1）。

| 取值 | 说明 |
|---|---|
| `"llm"` | LLM 摘要成功。 |
| `"heuristic"` | 降级为规则抽取式。 |
| `"truncate"` | 降级为硬截断。 |
| `"none"` | 未压缩（纯保留或 pin 段）。 |

## `EntityCategory`

**定义模块**：`src/contract.ts`

受校验的实体类别。

| 取值 | 说明 |
|---|---|
| `"windows-path"` | 硬实体：Windows 绝对路径。 |
| `"posix-path"` | 硬实体：POSIX 路径。 |
| `"url"` | 硬实体：URL。 |
| `"uuid-or-hash"` | 硬实体：UUID 或 commit hash。 |
| `"command-symbol"` | 硬实体：反引号包裹的命令与符号。 |
| `"number-percent"` | 软实体：数值与百分比。 |
| `"person-name"` | 软实体：人名与专名。 |

## `PinReason`

**定义模块**：`src/contract.ts`

pin 理由枚举。

| 取值 | 说明 |
|---|---|
| `"system-prompt"` | 系统提示消息。 |
| `"latest-user-intent"` | 用户最新一轮的原始需求文本。 |
| `"user-constraint"` | 用户提出的硬约束（「必须在原文件上原地修改，不要生成新版本」这类）。 契约 `pin-protection` 场景一要求这类内容被 pin 且逐字节不变， 但原枚举无对应取值，补此值以免出现「被 pin 但 reason 不属于枚举」的自相矛盾。 记为待确认项 Q6（见 todo.md §3）。 |
| `"user-remember"` | 用户消息含「记住」「以后都要」等持久性要求。 |
| `"error-critical"` | 尚未被后续成功输出取代的关键报错行。 |
| `"deliverable-path"` | 交付物绝对路径。 |
| `"permission-grant"` | 用户对高风险操作的批准记录。 |
| `"open-todo"` | 未完成的待办。 |
| `"tool-block-incomplete"` | tool block 配对不完整，铁律三强制 pin，任何级别都不参与压缩。 |

## `Role`

**定义模块**：`src/contract.ts`

消息角色。与主流 Chat Completions / Messages API 对齐。

| 取值 | 说明 |
|---|---|
| `"system"` |  |
| `"user"` |  |
| `"assistant"` |  |
| `"tool"` |  |

## `TriggerReason`

**定义模块**：`src/contract.ts`

触发决策原因。

| 取值 | 说明 |
|---|---|
| `"below-trigger"` | 占用低于触发线。 |
| `"hysteresis-band"` | 落在迟滞带内，防抖动。 |
| `"task-boundary"` | 命中任务边界。 |
| `"forced"` | 无边界但超过等待上限，强制压缩。 |
| `"rate-limit"` | 距上次压缩的轮数小于频率下限。 |
| `"post-compress-settled"` | 压缩后占用已落到目标线以下。 |
| `"no-safe-cut"` | 找不到安全切点，放弃本轮。 |
| `"hook-error"` | 触发钩子抛异常，保守地不压缩。 |
| `"waiting-boundary"` | 占用超线但仍在等待任务边界，且未超等待上限。 |

## `Vendor`

**定义模块**：`src/contract.ts`

消息来源厂商标记。 归档时需要保存它，rehydrate 才能把原文还原成首次进入会话时的 API 格式。

| 取值 | 说明 |
|---|---|
| `"anthropic"` |  |
| `"openai"` |  |
| `"generic"` |  |
