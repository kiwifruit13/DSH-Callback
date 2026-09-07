"""别名模块：演示同一符号被多个模块再导出。

生成器必须对此去重：ConsentStatus 在文档中只出现一次，
同时标注出它被哪些模块导出。
"""

from demo_pkg.core import ConsentStatus

__all__ = ["ConsentStatus"]
