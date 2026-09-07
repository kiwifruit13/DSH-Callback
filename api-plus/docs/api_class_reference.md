# demo_pkg 符号速查表（自动生成）

> **本文档由 `generate_api_docs.py` 自动生成，以代码为唯一真相源**，人工修改会被下次生成覆盖。
> 若需更新 API 描述，请修改代码 docstring 后重新生成。

> 列出全部公开符号及其定义模块与导出来源；再导出符号已去重。

| 符号 | 类型 | 定义模块 | 导出来源 | 说明 |
|------|------|----------|----------|------|
| `ConsentStatus` | 枚举 | `demo_pkg.core` | `demo_pkg`、`demo_pkg.aliases`、`demo_pkg.core` | 用户授权状态，只有 GRANTED 才允许写入记忆。 |
| `DEFAULT_BUCKET` | 常量 | `demo_pkg` | `demo_pkg`、`demo_pkg.core` | - |
| `MAX_RETRIES` | 常量 | `demo_pkg` | `demo_pkg`、`demo_pkg.infra` | - |
| `MemoryStore` | 类 | `demo_pkg.core` | `demo_pkg`、`demo_pkg.core` | 记忆存储器，按桶隔离不同类型的内容。 |
| `RetryPolicy` | 枚举 | `demo_pkg.infra` | `demo_pkg`、`demo_pkg.infra` | 重试策略。 |
| `SessionContext` | 数据类 | `demo_pkg.core` | `demo_pkg`、`demo_pkg.core` | 一次会话的上下文，贯穿整个处理流程。 |
| `TimeoutConfig` | 数据类 | `demo_pkg.infra` | `demo_pkg`、`demo_pkg.infra` | 超时与重试配置。 |
| `run_with_retry` | 函数 | `demo_pkg.infra` | `demo_pkg`、`demo_pkg.infra` | 按指定策略执行 func，重试耗尽后返回 None。 |
| `store_memory` | 函数 | `demo_pkg.core` | `demo_pkg`、`demo_pkg.core` | 记忆存储的顶层便捷入口。 |
