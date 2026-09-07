"""基础设施层：重试策略、超时配置与重试执行器。"""

from __future__ import annotations

import enum
import time
from collections.abc import Callable
from dataclasses import dataclass

__all__ = ["MAX_RETRIES", "RetryPolicy", "TimeoutConfig", "run_with_retry"]

MAX_RETRIES: int = 10
"""允许的最大重试次数。"""


class RetryPolicy(str, enum.Enum):
    """重试策略。"""

    FIXED = "fixed"
    EXPONENTIAL = "exponential"


@dataclass
class TimeoutConfig:
    """超时与重试配置。"""

    timeout: float = 5.0
    retries: int = 3


def run_with_retry(
    func: Callable[[], object],
    config: TimeoutConfig | None = None,
    policy: RetryPolicy = RetryPolicy.FIXED,
) -> object:
    """按指定策略执行 func，重试耗尽后返回 None。

    FIXED 策略每次等待固定 10ms；EXPONENTIAL 策略按 2 的幂次递增等待。
    """
    cfg = config or TimeoutConfig()
    for attempt in range(cfg.retries + 1):
        try:
            return func()
        except Exception:
            if attempt >= cfg.retries:
                return None
            delay = (2 ** attempt) * 0.01 if policy is RetryPolicy.EXPONENTIAL else 0.01
            time.sleep(delay)
    return None
