"""demo_pkg — 用于验证 generate_api_docs.py 的示例包。

刻意覆盖以下场景：
- 类（含构造方法、普通方法、property、类属性）
- 函数（含类型注解、默认值、枚举/字符串双兼容入参）
- 枚举（str-mixin Enum）
- 常量
- dataclass 字段提取
- 再导出与去重（__init__ 与 aliases 重复导出同一符号）
- 未声明 __all__ 的模块（internal，不应进入公开文档）
"""

from demo_pkg.core import (
    DEFAULT_BUCKET,
    ConsentStatus,
    MemoryStore,
    SessionContext,
    store_memory,
)
from demo_pkg.infra import MAX_RETRIES, RetryPolicy, TimeoutConfig, run_with_retry

__all__ = [
    "DEFAULT_BUCKET",
    "MAX_RETRIES",
    "ConsentStatus",
    "MemoryStore",
    "RetryPolicy",
    "SessionContext",
    "TimeoutConfig",
    "run_with_retry",
    "store_memory",
]
