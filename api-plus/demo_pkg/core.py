"""核心业务层：用户授权状态、会话上下文与记忆存储。"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field

__all__ = ["ConsentStatus", "DEFAULT_BUCKET", "MemoryStore", "SessionContext", "store_memory"]


class ConsentStatus(str, enum.Enum):
    """用户授权状态，只有 GRANTED 才允许写入记忆。"""

    GRANTED = "granted"
    DENIED = "denied"
    PENDING = "pending"


DEFAULT_BUCKET: str = "default"
"""默认记忆桶名。"""


@dataclass
class SessionContext:
    """一次会话的上下文，贯穿整个处理流程。"""

    session_id: str
    user_id: str = ""
    tags: list[str] = field(default_factory=list)


class MemoryStore:
    """记忆存储器，按桶隔离不同类型的内容。"""

    bucket_limit: int = 64

    def __init__(self, bucket: str = DEFAULT_BUCKET):
        """初始化存储器。

        Args:
            bucket: 目标桶名，默认使用 DEFAULT_BUCKET。
        """
        self._bucket = bucket
        self._items: dict[str, str] = {}

    @property
    def bucket(self) -> str:
        """当前桶名（只读）。"""
        return self._bucket

    def store(self, key: str, value: str, status: ConsentStatus = ConsentStatus.GRANTED) -> bool:
        """写入一条记忆；授权状态非 GRANTED 时拒绝写入并返回 False。"""
        if status is not ConsentStatus.GRANTED:
            return False
        self._items[key] = value
        return True

    def recall(self, key: str) -> str | None:
        """按键读取一条记忆，不存在时返回 None。"""
        return self._items.get(key)


def store_memory(
    store: MemoryStore,
    key: str,
    value: str,
    status: ConsentStatus | str = ConsentStatus.GRANTED,
) -> bool:
    """记忆存储的顶层便捷入口。

    status 同时接受 ConsentStatus 枚举或其字符串值（如 "granted"），
    字符串会被自动转换为枚举，避免调用方因类型不匹配而崩溃。
    """
    if isinstance(status, str):
        status = ConsentStatus(status)
    return store.store(key, value, status)
