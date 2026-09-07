# demo_pkg API 参考文档（自动生成）

> **本文档由 `generate_api_docs.py` 自动生成，以代码为唯一真相源**，人工修改会被下次生成覆盖。
> 若需更新 API 描述，请修改代码 docstring 后重新生成。

> 符号总数：9 ｜ docstring 覆盖率：77.8%

---

## `demo_pkg`

### `DEFAULT_BUCKET`（常量）

- 值：`'default'`（类型 `str`）

导出来源：`demo_pkg`、`demo_pkg.core`

### `MAX_RETRIES`（常量）

- 值：`10`（类型 `int`）

导出来源：`demo_pkg`、`demo_pkg.infra`

---

## `demo_pkg.core`

### `ConsentStatus`（枚举）

用户授权状态，只有 GRANTED 才允许写入记忆。

| 成员 | 值 |
|------|-----|
| `GRANTED` | `'granted'` |
| `DENIED` | `'denied'` |
| `PENDING` | `'pending'` |

导出来源：`demo_pkg`、`demo_pkg.aliases`、`demo_pkg.core`

### `MemoryStore`（类）

记忆存储器，按桶隔离不同类型的内容。

- 构造：`MemoryStore(bucket: str = 'default')`
- 属性：
  - `bucket: str` — 当前桶名（只读）。
- 方法（本类定义）：
  - `recall(key: str) -> str | None` — 按键读取一条记忆，不存在时返回 None。
  - `store(key: str, value: str, status: ConsentStatus = ConsentStatus.GRANTED) -> bool` — 写入一条记忆；授权状态非 GRANTED 时拒绝写入并返回 False。
- 类属性：
  - `bucket_limit = 64`

导出来源：`demo_pkg`、`demo_pkg.core`

### `SessionContext`（数据类）

一次会话的上下文，贯穿整个处理流程。

构造参数与字段一致：

| 字段 | 类型 | 默认值 |
|------|------|--------|
| `session_id` | `str` | `（必填）` |
| `user_id` | `str` | `''` |
| `tags` | `list[str]` | `<factory>` |

导出来源：`demo_pkg`、`demo_pkg.core`

### `store_memory`（函数）

记忆存储的顶层便捷入口。

status 同时接受 ConsentStatus 枚举或其字符串值（如 "granted"），
字符串会被自动转换为枚举，避免调用方因类型不匹配而崩溃。

- 签名：`store_memory(store: MemoryStore, key: str, value: str, status: ConsentStatus | str = ConsentStatus.GRANTED) -> bool`

导出来源：`demo_pkg`、`demo_pkg.core`

---

## `demo_pkg.infra`

### `RetryPolicy`（枚举）

重试策略。

| 成员 | 值 |
|------|-----|
| `FIXED` | `'fixed'` |
| `EXPONENTIAL` | `'exponential'` |

导出来源：`demo_pkg`、`demo_pkg.infra`

### `TimeoutConfig`（数据类）

超时与重试配置。

构造参数与字段一致：

| 字段 | 类型 | 默认值 |
|------|------|--------|
| `timeout` | `float` | `5.0` |
| `retries` | `int` | `3` |

导出来源：`demo_pkg`、`demo_pkg.infra`

### `run_with_retry`（函数）

按指定策略执行 func，重试耗尽后返回 None。

FIXED 策略每次等待固定 10ms；EXPONENTIAL 策略按 2 的幂次递增等待。

- 签名：`run_with_retry(func: Callable[[], object], config: TimeoutConfig | None = None, policy: RetryPolicy = RetryPolicy.FIXED) -> object`

导出来源：`demo_pkg`、`demo_pkg.infra`

---

## 生成质量报告

- 符号构成：类 ×1、常量 ×2、数据类 ×2、枚举 ×2、函数 ×2
- 扫描模块数：4
- 无提示、无错误。
