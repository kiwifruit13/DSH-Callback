#!/usr/bin/env python3
"""
test_api_contract.py — API 契约门禁测试

职责：不信任文档，直接校验"代码行为 + 文档产物 ↔ 代码真相"的一致性。
覆盖五类契约：

1. 扫描完整性     —— 所有子模块可导入，__all__ 声明的符号全部可访问
2. 文档同步       —— docs/ 下三份文档与当前代码重新生成的结果逐字节一致
3. 产物有效性     —— 已提交的 Manifest 中每个符号在活代码中真实存在，
                     枚举成员、类方法逐一核对（防"文档写了 prepare() 代码却是
                     prepare_context()"这类漂移）
4. 去重正确性     —— 速查表中每个符号只出现一次
5. 历史缺陷回归   —— store_memory 同时接受枚举与字符串入参（防 .value 崩溃）

运行方式（任选其一）：
    python test_api_contract.py          # 内置运行器，无第三方依赖
    python -m pytest test_api_contract.py  # 如已安装 pytest
"""

from __future__ import annotations

import importlib
import inspect
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import generate_api_docs as gen  # noqa: E402

PACKAGE = "demo_pkg"
DOCS_DIR = ROOT / "docs"
EXCLUDES = {"demo_pkg.internal"}
MANIFEST_PATH = DOCS_DIR / "api_manifest.json"
# docstring 覆盖率下限（百分比）。低于此值说明公开 API 描述不足，门禁失败。
DOCSTRING_COVERAGE_MIN = 70.0


def _load_committed_manifest() -> dict:
    assert MANIFEST_PATH.exists(), f"缺少已提交的 Manifest：{MANIFEST_PATH}，请先运行生成器"
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _resolve(symbol: dict):
    """按 Manifest 记录的定义模块取回活代码对象。"""
    mod = importlib.import_module(symbol["module"])
    return getattr(mod, symbol["name"])


# ---------------------------------------------------------------------------
# 契约一：扫描完整性
# ---------------------------------------------------------------------------

def test_scan_has_no_errors():
    """所有子模块可导入，且 __all__ 声明的符号全部可访问。"""
    manifest = gen.build_manifest(PACKAGE, EXCLUDES)
    assert manifest["errors"] == [], f"存在扫描错误：{manifest['errors']}"
    assert manifest["warnings"] == [], f"存在未预期警告：{manifest['warnings']}"


def test_all_exports_accessible():
    """逐模块验证：__all__ 中每个名字都能取到非 None 对象。"""
    pkg = importlib.import_module(PACKAGE)
    import pkgutil
    modules = [pkg]
    for info in pkgutil.walk_packages(pkg.__path__, prefix=PACKAGE + "."):
        if info.name in EXCLUDES:
            continue
        modules.append(importlib.import_module(info.name))
    for mod in modules:
        for name in getattr(mod, "__all__", []):
            obj = getattr(mod, name, None)
            assert obj is not None, f"`{mod.__name__}.__all__` 声明了不可访问的 `{name}`"


# ---------------------------------------------------------------------------
# 契约二：文档同步（漂移门禁）
# ---------------------------------------------------------------------------

def test_docs_are_in_sync_with_code():
    """docs/ 下三份文档必须与当前代码重新生成的结果完全一致。

    这是"代码改了但没重跑生成器"的直接拦截：任一文件不一致即失败。
    """
    _, fresh_docs = gen.generate_all(PACKAGE, EXCLUDES)
    drifted = []
    for filename, content in fresh_docs.items():
        path = DOCS_DIR / filename
        if not path.exists():
            drifted.append(f"{filename}: 文件缺失")
            continue
        if path.read_text(encoding="utf-8") != content:
            drifted.append(f"{filename}: 内容不一致")
    assert not drifted, (
        "文档与代码已漂移，请重新运行 `python generate_api_docs.py demo_pkg docs"
        f" --exclude demo_pkg.internal`：{drifted}"
    )


# ---------------------------------------------------------------------------
# 契约三：产物有效性（Manifest ↔ 活代码逐一核对）
# ---------------------------------------------------------------------------

def test_manifest_symbols_exist_in_live_code():
    """已提交 Manifest 中的每个符号必须在活代码中真实存在且种类一致。"""
    manifest = _load_committed_manifest()
    for symbol in manifest["symbols"]:
        obj = _resolve(symbol)
        assert gen._classify(obj) == symbol["kind"], (
            f"符号 `{symbol['name']}` 种类漂移：文档记录 {symbol['kind']}，"
            f"代码实际 {gen._classify(obj)}"
        )


def test_manifest_enum_members_match_code():
    """枚举成员逐一核对：名字集合与值必须与活代码一致。"""
    manifest = _load_committed_manifest()
    for symbol in manifest["symbols"]:
        if symbol["kind"] != "enum":
            continue
        live = _resolve(symbol)
        doc_members = {m["name"]: m["value"] for m in symbol["members"]}
        live_members = {m.name: repr(m.value) for m in live}
        assert doc_members == live_members, (
            f"枚举 `{symbol['name']}` 成员漂移：文档 {doc_members}，代码 {live_members}"
        )


def test_manifest_class_methods_exist():
    """类文档里列出的每个方法必须在活类上真实可调用。

    直接拦截历史缺陷：文档写了 prepare()，代码里其实是 prepare_context()。
    """
    manifest = _load_committed_manifest()
    for symbol in manifest["symbols"]:
        if symbol["kind"] != "class":
            continue
        cls = _resolve(symbol)
        for method in symbol["methods"]:
            attr = getattr(cls, method["name"], None)
            assert attr is not None, (
                f"类 `{cls.__name__}` 的文档方法 `{method['name']}` 在代码中不存在"
            )
            assert callable(attr), f"类 `{cls.__name__}` 的 `{method['name']}` 不可调用"


def test_manifest_function_signatures_resolvable():
    """函数的记录签名必须能对应到一个可求值的真实签名。"""
    manifest = _load_committed_manifest()
    for symbol in manifest["symbols"]:
        if symbol["kind"] != "function":
            continue
        func = _resolve(symbol)
        sig = inspect.signature(func)  # 求值失败会抛异常 → 测试失败
        assert len(sig.parameters) >= 0


# ---------------------------------------------------------------------------
# 契约四：去重正确性
# ---------------------------------------------------------------------------

def test_class_index_has_no_duplicate_symbols():
    """速查表中每个符号名只允许出现一次（再导出已合并到导出来源列）。"""
    index_path = DOCS_DIR / "api_class_reference.md"
    names = []
    for line in index_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("| `"):
            names.append(line.split("`")[1])
    duplicates = {n for n in names if names.count(n) > 1}
    assert not duplicates, f"速查表存在重复符号：{sorted(duplicates)}"


# ---------------------------------------------------------------------------
# 契约五：历史缺陷回归（行为级）
# ---------------------------------------------------------------------------

def test_store_memory_accepts_string_status():
    """store_memory 必须同时接受枚举与其字符串值。

    历史缺陷：只接受 Enum 对象时，调用方传字符串会在 `.value` 处崩溃。
    """
    from demo_pkg.core import ConsentStatus, MemoryStore, store_memory

    store = MemoryStore()
    assert store_memory(store, "k1", "v1", ConsentStatus.GRANTED) is True
    assert store_memory(store, "k2", "v2", "granted") is True
    assert store_memory(store, "k3", "v3", "pending") is False
    assert store.recall("k1") == "v1"
    assert store.recall("k3") is None


def test_consent_status_single_source():
    """ConsentStatus 全项目只能有一个定义（防双定义遮蔽）。"""
    from demo_pkg import ConsentStatus as via_root
    from demo_pkg.aliases import ConsentStatus as via_aliases
    from demo_pkg.core import ConsentStatus as via_core

    assert via_root is via_core is via_aliases, "同一枚举存在多个不同定义，导入将产生遮蔽"


# ---------------------------------------------------------------------------
# 附加门禁：docstring 覆盖率
# ---------------------------------------------------------------------------

def test_docstring_coverage_above_threshold():
    manifest = gen.build_manifest(PACKAGE, EXCLUDES)
    coverage = manifest["stats"]["docstring_coverage_pct"]
    assert coverage >= DOCSTRING_COVERAGE_MIN, (
        f"公开符号 docstring 覆盖率 {coverage}% 低于阈值 {DOCSTRING_COVERAGE_MIN}%"
    )


# ---------------------------------------------------------------------------
# 内置运行器（无 pytest 也能跑）
# ---------------------------------------------------------------------------

def _main() -> int:
    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"[通过] {name}")
        except AssertionError as exc:
            failed += 1
            print(f"[失败] {name}: {exc}")
        except Exception as exc:  # noqa: BLE001 —— 非断言异常也记为失败
            failed += 1
            print(f"[错误] {name}: {type(exc).__name__}: {exc}")
    total = len(tests)
    print(f"\n共 {total} 项，通过 {total - failed} 项，失败 {failed} 项。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main())
