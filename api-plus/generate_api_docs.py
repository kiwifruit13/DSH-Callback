#!/usr/bin/env python3
"""
generate_api_docs.py — 从源码自动生成 API 文档（代码是唯一真相源）

用法：
    python generate_api_docs.py <包名> <输出目录> [选项]

示例：
    python generate_api_docs.py demo_pkg docs
    python generate_api_docs.py demo_pkg docs --check
    python generate_api_docs.py demo_pkg docs --strict --manifest docs/api_manifest.json
    python generate_api_docs.py demo_pkg docs --exclude demo_pkg.internal

流水线（三个显式阶段，中间产物为 API Manifest）：
    源码包
      │ 阶段一：扫描 —— 递归导入全部子模块，收集导入错误（不静默吞掉）
      ▼
    模块表 {模块名: 模块对象}
      │ 阶段二：提取 —— 遍历各模块 __all__，按符号种类反射提取元信息，
      │                处理再导出去重、常量、property、dataclass、Pydantic
      ▼
    API Manifest（纯 JSON 可序列化的中间表示）
      │ 阶段三：渲染 —— 三个渲染器消费同一份 Manifest，保证产物互不矛盾
      ▼
    docs/api_reference.md          完整 API 参考（按定义模块分组）
    docs/api_class_reference.md    符号速查表（符号 → 定义模块 → 导出来源）
    docs/api_enums.md              枚举类型汇总

设计约束：
    - 输出必须字节级确定：不含时间戳，所有迭代显式排序，保证
      `git diff --exit-code` 门禁在不同机器上结果一致。
    - 不静默失败：导入错误、__all__ 声明不可访问、缺失 __all__ 都会
      记录到 Manifest 并打印；--strict 模式下导致非零退出码。
    - 依赖最小化：仅标准库；Pydantic 支持为可选（未安装时自动跳过该分支）。
"""

from __future__ import annotations

import argparse
import dataclasses
import enum
import importlib
import inspect
import json
import pkgutil
import sys
import typing
from pathlib import Path
from typing import Any

GENERATOR_NAME = "generate_api_docs.py"
GENERATOR_VERSION = "1.0.0"

# 渲染进注解前缀剥离列表的额外前缀（标准库常见出处）
_EXTRA_STRIP_PREFIXES = ["collections.abc"]

KIND_LABELS = {
    "enum": "枚举",
    "class": "类",
    "dataclass": "数据类",
    "pydantic_model": "Pydantic 模型",
    "function": "函数",
    "constant": "常量",
}


# ---------------------------------------------------------------------------
# 阶段零：通用格式化工具
# ---------------------------------------------------------------------------

def _pydantic_base() -> type | None:
    """返回 pydantic.BaseModel；未安装 pydantic 时返回 None（不视为错误）。"""
    try:
        from pydantic import BaseModel
        return BaseModel
    except ImportError:
        return None


def _format_annotation(ann: Any, strip_prefixes: list[str]) -> str:
    """把类型注解对象格式化为可读字符串；空注解返回空串。

    注意：get_type_hints 会把字符串注解解析为真实类对象，
    此时 str(cls) 会得到 "<class 'str'>" 这类原始形式，
    因此类对象必须改用 __qualname__ 展示。
    """
    if ann is inspect.Parameter.empty or ann is None:
        return ""
    if isinstance(ann, str):
        # 未能求值的字符串注解，原样展示
        return ann
    if isinstance(ann, type):
        s = ann.__qualname__
    else:
        s = str(ann)
    for prefix in strip_prefixes:
        s = s.replace(prefix + ".", "")
    return s.replace("typing.", "")


def _format_default(value: Any) -> str:
    """格式化参数默认值；无默认值返回空串。枚举成员展示为 类名.成员名。"""
    if value is inspect.Parameter.empty:
        return ""
    if isinstance(value, enum.Enum):
        return f" = {type(value).__name__}.{value.name}"
    r = repr(value)
    if len(r) > 60:
        r = r[:57] + "..."
    return f" = {r}"


def _format_signature(func: Any, strip_prefixes: list[str]) -> str:
    """格式化可调用对象签名。优先用 get_type_hints 解析字符串注解。

    传入类对象时，签名取自 __init__，但类型提示必须从 __init__
    而非类体解析（类体注解描述的是类属性，不是构造参数）。
    """
    hints_target = func.__init__ if inspect.isclass(func) else func
    try:
        sig = inspect.signature(func)
    except (ValueError, TypeError):
        return "(...)"
    try:
        hints = typing.get_type_hints(hints_target)
    except Exception:
        hints = {}

    parts: list[str] = []
    for name, param in sig.parameters.items():
        if name in ("self", "cls"):
            continue
        prefix = ""
        if param.kind is inspect.Parameter.VAR_POSITIONAL:
            prefix = "*"
        elif param.kind is inspect.Parameter.VAR_KEYWORD:
            prefix = "**"
        ann = hints.get(name, param.annotation)
        ann_s = _format_annotation(ann, strip_prefixes)
        annotation = f": {ann_s}" if ann_s else ""
        default = _format_default(param.default)
        parts.append(f"{prefix}{name}{annotation}{default}")

    ret = hints.get("return", sig.return_annotation)
    ret_s = _format_annotation(ret, strip_prefixes)
    return_annotation = f" -> {ret_s}" if ret_s else ""
    return f"({', '.join(parts)}){return_annotation}"


def _first_line(doc: str | None) -> str:
    if not doc:
        return ""
    return doc.strip().split("\n")[0].strip()


def _classify(obj: Any) -> str:
    """判定符号种类。判定顺序有讲究：枚举 ⊂ 类，dataclass/Pydantic ⊂ 类。"""
    base = _pydantic_base()
    if isinstance(obj, type) and issubclass(obj, enum.Enum):
        return "enum"
    if isinstance(obj, type) and dataclasses.is_dataclass(obj):
        return "dataclass"
    if base is not None and isinstance(obj, type) and issubclass(obj, base):
        return "pydantic_model"
    if isinstance(obj, type):
        return "class"
    if callable(obj):
        return "function"
    return "constant"


def _truncate(text: str, limit: int = 60) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


# ---------------------------------------------------------------------------
# 阶段一：扫描（递归收集模块，记录而非吞掉错误）
# ---------------------------------------------------------------------------

def _scan_modules(pkg: Any, excludes: set[str]) -> tuple[dict[str, Any], list[str]]:
    """递归导入包及其全部子模块。

    返回 (模块表, 导入错误列表)。导入错误格式为
    "模块名: 异常类型: 异常信息"，由调用方决定上报还是致命化。
    """
    modules: dict[str, Any] = {pkg.__name__: pkg}
    errors: list[str] = []
    for info in pkgutil.walk_packages(pkg.__path__, prefix=pkg.__name__ + "."):
        if info.name in excludes:
            continue
        try:
            modules[info.name] = importlib.import_module(info.name)
        except Exception as exc:  # noqa: BLE001 —— 需要记录任意导入异常
            errors.append(f"{info.name}: {type(exc).__name__}: {exc}")
    return modules, errors


# ---------------------------------------------------------------------------
# 阶段二：提取（符号 → Manifest 条目）
# ---------------------------------------------------------------------------

def _extract_enum(name: str, obj: type) -> dict[str, Any]:
    return {
        "name": name,
        "kind": "enum",
        "doc": inspect.getdoc(obj) or "",
        "members": [{"name": m.name, "value": repr(m.value)} for m in obj],
    }


def _extract_dataclass_fields(obj: type, strip_prefixes: list[str]) -> list[dict[str, str]]:
    try:
        hints = typing.get_type_hints(obj)
    except Exception:
        hints = {}
    fields: list[dict[str, str]] = []
    for f in dataclasses.fields(obj):
        ann_s = _format_annotation(hints.get(f.name, f.type), strip_prefixes)
        if f.default is not dataclasses.MISSING:
            default = repr(f.default)
        elif f.default_factory is not dataclasses.MISSING:
            default = "<factory>"
        else:
            default = "（必填）"
        fields.append({"name": f.name, "type": ann_s or "-", "default": default})
    return fields


def _extract_pydantic_fields(obj: type, strip_prefixes: list[str]) -> list[dict[str, str]]:
    fields: list[dict[str, str]] = []
    for fname, finfo in obj.model_fields.items():
        ann_s = _format_annotation(finfo.annotation, strip_prefixes)
        default = repr(finfo.default) if not callable(finfo.default) else "<factory>"
        fields.append({
            "name": fname,
            "type": ann_s or "-",
            "default": default,
            "description": getattr(finfo, "description", "") or "",
        })
    return fields


def _extract_class(name: str, obj: type, kind: str, strip_prefixes: list[str]) -> dict[str, Any]:
    info: dict[str, Any] = {
        "name": name,
        "kind": kind,
        "doc": inspect.getdoc(obj) or "",
        "constructor": "",
        "fields": [],
        "properties": [],
        "methods": [],
        "attributes": [],
    }

    # 构造签名：dataclass / Pydantic 的构造参数与字段表重复，只展示字段表
    if kind == "dataclass":
        info["fields"] = _extract_dataclass_fields(obj, strip_prefixes)
    elif kind == "pydantic_model":
        info["fields"] = _extract_pydantic_fields(obj, strip_prefixes)
    else:
        info["constructor"] = f"{name}{_format_signature(obj, strip_prefixes)}"

    # 只提取本类定义的成员（vars），避免继承噪音；按名称排序保证确定性
    for attr_name in sorted(vars(obj)):
        if attr_name.startswith("_"):
            continue
        attr = vars(obj)[attr_name]
        if isinstance(attr, property):
            ret_s = ""
            if attr.fget is not None:
                try:
                    hints = typing.get_type_hints(attr.fget)
                except Exception:
                    hints = {}
                ret_s = _format_annotation(
                    hints.get("return", inspect.signature(attr.fget).return_annotation),
                    strip_prefixes,
                )
            info["properties"].append({
                "name": attr_name,
                "type": ret_s or "-",
                "doc": _first_line(inspect.getdoc(attr)),
            })
        elif callable(attr):
            info["methods"].append({
                "name": attr_name,
                "signature": f"{attr_name}{_format_signature(attr, strip_prefixes)}",
                "doc": _first_line(inspect.getdoc(attr)),
            })
        else:
            info["attributes"].append({
                "name": attr_name,
                "value": _truncate(repr(attr)),
            })
    return info


def _extract_function(name: str, obj: Any, strip_prefixes: list[str]) -> dict[str, Any]:
    return {
        "name": name,
        "kind": "function",
        "doc": inspect.getdoc(obj) or "",
        "signature": f"{name}{_format_signature(obj, strip_prefixes)}",
    }


def _extract_constant(name: str, obj: Any) -> dict[str, Any]:
    return {
        "name": name,
        "kind": "constant",
        "doc": "",
        "value": _truncate(repr(obj)),
        "type": type(obj).__name__,
    }


def build_manifest(package_name: str, excludes: set[str]) -> dict[str, Any]:
    """阶段一 + 阶段二：从包构建完整 Manifest（可 JSON 序列化）。"""
    pkg = importlib.import_module(package_name)
    modules, import_errors = _scan_modules(pkg, excludes)
    # 剥离前缀按长度降序，避免短前缀误伤长模块名
    strip_prefixes = sorted(modules.keys(), key=len, reverse=True) + _EXTRA_STRIP_PREFIXES

    warnings: list[str] = []
    errors: list[str] = list(import_errors)
    # key 含种类标记，保证跨模块再导出的同一符号只保留一条
    symbols: dict[tuple, dict[str, Any]] = {}

    for mod_name in sorted(modules):
        mod = modules[mod_name]
        all_names = getattr(mod, "__all__", None)
        if all_names is None:
            if mod is not pkg:
                warnings.append(f"模块 `{mod_name}` 未声明 __all__，其符号不进入公开文档")
            continue
        for name in all_names:
            obj = getattr(mod, name, None)
            if obj is None:
                errors.append(f"`{mod_name}.__all__` 声明了 `{name}`，但该符号不存在或无法访问")
                continue

            # 定位真实定义处：类/函数据 __module__+__qualname__（跨模块稳定）；
            # 常量（str/int 等）没有定义位置，按 (名称, 值) 合并再导出。
            if hasattr(obj, "__module__") and hasattr(obj, "__qualname__"):
                key = ("code", obj.__module__, obj.__qualname__)
                definition_module = obj.__module__
            else:
                key = ("constant", name, _truncate(repr(obj)))
                definition_module = mod_name

            entry = symbols.get(key)
            if entry is None:
                kind = _classify(obj)
                if kind == "enum":
                    entry = _extract_enum(name, obj)
                elif kind in ("class", "dataclass", "pydantic_model"):
                    entry = _extract_class(name, obj, kind, strip_prefixes)
                elif kind == "function":
                    entry = _extract_function(name, obj, strip_prefixes)
                else:
                    entry = _extract_constant(name, obj)
                entry["module"] = definition_module
                entry["exported_by"] = []
                symbols[key] = entry
            entry["exported_by"].append(mod_name)

    symbol_list = sorted(symbols.values(), key=lambda s: (s["module"], s["name"]))
    for s in symbol_list:
        s["exported_by"] = sorted(set(s["exported_by"]))

    total = len(symbol_list)
    with_doc = sum(1 for s in symbol_list if s["doc"].strip())
    by_kind: dict[str, int] = {}
    for s in symbol_list:
        by_kind[s["kind"]] = by_kind.get(s["kind"], 0) + 1

    return {
        "generator": f"{GENERATOR_NAME} v{GENERATOR_VERSION}",
        "package": package_name,
        "modules_scanned": sorted(modules.keys()),
        "stats": {
            "total_symbols": total,
            "by_kind": {k: by_kind[k] for k in sorted(by_kind)},
            "with_docstring": with_doc,
            "docstring_coverage_pct": round(100.0 * with_doc / total, 1) if total else 100.0,
        },
        "warnings": sorted(warnings),
        "errors": sorted(errors),
        "symbols": symbol_list,
    }


# ---------------------------------------------------------------------------
# 阶段三：渲染（三个渲染器消费同一份 Manifest）
# ---------------------------------------------------------------------------

_DOC_HEADER_NOTE = (
    "> **本文档由 `{gen}` 自动生成，以代码为唯一真相源**，人工修改会被下次生成覆盖。\n"
    "> 若需更新 API 描述，请修改代码 docstring 后重新生成。\n"
)


def _render_symbol_block(s: dict[str, Any]) -> list[str]:
    """渲染单个符号的完整区块。"""
    lines = [f"### `{s['name']}`（{KIND_LABELS[s['kind']]}）", ""]
    if s["doc"]:
        lines.append(s["doc"])
        lines.append("")
    exported = "、".join(f"`{m}`" for m in s["exported_by"])

    if s["kind"] == "enum":
        lines.append("| 成员 | 值 |")
        lines.append("|------|-----|")
        for m in s["members"]:
            lines.append(f"| `{m['name']}` | `{m['value']}` |")
        lines.append("")
    elif s["kind"] in ("dataclass", "pydantic_model"):
        lines.append("构造参数与字段一致：")
        lines.append("")
        if s["kind"] == "pydantic_model":
            lines.append("| 字段 | 类型 | 默认值 | 说明 |")
            lines.append("|------|------|--------|------|")
            for f in s["fields"]:
                lines.append(f"| `{f['name']}` | `{f['type']}` | `{f['default']}` | {f['description'] or '-'} |")
        else:
            lines.append("| 字段 | 类型 | 默认值 |")
            lines.append("|------|------|--------|")
            for f in s["fields"]:
                lines.append(f"| `{f['name']}` | `{f['type']}` | `{f['default']}` |")
        lines.append("")
    elif s["kind"] == "class":
        lines.append(f"- 构造：`{s['constructor']}`")
        if s["properties"]:
            lines.append("- 属性：")
            for p in s["properties"]:
                doc = f" — {p['doc']}" if p["doc"] else ""
                lines.append(f"  - `{p['name']}: {p['type']}`{doc}")
        if s["methods"]:
            lines.append("- 方法（本类定义）：")
            for m in s["methods"]:
                doc = f" — {m['doc']}" if m["doc"] else ""
                lines.append(f"  - `{m['signature']}`{doc}")
        if s["attributes"]:
            lines.append("- 类属性：")
            for a in s["attributes"]:
                lines.append(f"  - `{a['name']} = {a['value']}`")
        lines.append("")
    elif s["kind"] == "function":
        lines.append(f"- 签名：`{s['signature']}`")
        lines.append("")
    elif s["kind"] == "constant":
        lines.append(f"- 值：`{s['value']}`（类型 `{s['type']}`）")
        lines.append("")

    lines.append(f"导出来源：{exported}")
    lines.append("")
    return lines


def render_reference(manifest: dict[str, Any]) -> str:
    """渲染完整 API 参考，按符号的定义模块分组。"""
    pkg = manifest["package"]
    stats = manifest["stats"]
    lines = [
        f"# {pkg} API 参考文档（自动生成）",
        "",
        _DOC_HEADER_NOTE.format(gen=GENERATOR_NAME),
        f"> 符号总数：{stats['total_symbols']} ｜ docstring 覆盖率："
        f"{stats['docstring_coverage_pct']}%",
        "",
        "---",
        "",
    ]
    grouped: dict[str, list[dict[str, Any]]] = {}
    for s in manifest["symbols"]:
        grouped.setdefault(s["module"], []).append(s)
    for module_name in sorted(grouped):
        lines.append(f"## `{module_name}`")
        lines.append("")
        for s in sorted(grouped[module_name], key=lambda x: x["name"]):
            lines.extend(_render_symbol_block(s))
        lines.append("---")
        lines.append("")

    # 质量报告区块：让漂移与缺失在文档自身可见
    lines.append("## 生成质量报告")
    lines.append("")
    by_kind = "、".join(
        f"{KIND_LABELS[k]} ×{v}" for k, v in stats["by_kind"].items()
    ) or "（无）"
    lines.append(f"- 符号构成：{by_kind}")
    lines.append(f"- 扫描模块数：{len(manifest['modules_scanned'])}")
    if manifest["warnings"]:
        lines.append("- 提示：")
        for w in manifest["warnings"]:
            lines.append(f"  - {w}")
    if manifest["errors"]:
        lines.append("- **错误（必须修复）**：")
        for e in manifest["errors"]:
            lines.append(f"  - {e}")
    if not manifest["warnings"] and not manifest["errors"]:
        lines.append("- 无提示、无错误。")
    lines.append("")
    return "\n".join(lines)


def render_class_index(manifest: dict[str, Any]) -> str:
    """渲染符号速查表：一个符号一行（再导出已去重）。"""
    pkg = manifest["package"]
    lines = [
        f"# {pkg} 符号速查表（自动生成）",
        "",
        _DOC_HEADER_NOTE.format(gen=GENERATOR_NAME),
        "> 列出全部公开符号及其定义模块与导出来源；再导出符号已去重。",
        "",
        "| 符号 | 类型 | 定义模块 | 导出来源 | 说明 |",
        "|------|------|----------|----------|------|",
    ]
    for s in sorted(manifest["symbols"], key=lambda x: (x["name"], x["module"])):
        doc = _truncate(_first_line(s["doc"])) or "-"
        doc = doc.replace("|", "\\|")
        exported = "、".join(f"`{m}`" for m in s["exported_by"])
        lines.append(
            f"| `{s['name']}` | {KIND_LABELS[s['kind']]} | `{s['module']}` | {exported} | {doc} |"
        )
    lines.append("")
    return "\n".join(lines)


def render_enums(manifest: dict[str, Any]) -> str:
    """渲染枚举汇总文档。"""
    pkg = manifest["package"]
    enums = [s for s in manifest["symbols"] if s["kind"] == "enum"]
    lines = [
        f"# {pkg} 枚举类型汇总（自动生成）",
        "",
        _DOC_HEADER_NOTE.format(gen=GENERATOR_NAME),
        f"共 {len(enums)} 个枚举类型。枚举成员属于 API 契约，改动需评审。",
        "",
    ]
    for s in sorted(enums, key=lambda x: (x["module"], x["name"])):
        lines.append(f"## `{s['module']}.{s['name']}`")
        lines.append("")
        if s["doc"]:
            lines.append(s["doc"])
            lines.append("")
        lines.append("| 成员 | 值 |")
        lines.append("|------|-----|")
        for m in s["members"]:
            lines.append(f"| `{m['name']}` | `{m['value']}` |")
        lines.append("")
        exported = "、".join(f"`{m}`" for m in s["exported_by"])
        lines.append(f"导出来源：{exported}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

DOC_FILES = ("api_reference.md", "api_class_reference.md", "api_enums.md")


def generate_all(package_name: str, excludes: set[str]) -> tuple[dict[str, Any], dict[str, str]]:
    """构建 Manifest 并渲染全部文档，返回 (manifest, {文件名: 内容})。"""
    manifest = build_manifest(package_name, excludes)
    docs = {
        "api_reference.md": render_reference(manifest),
        "api_class_reference.md": render_class_index(manifest),
        "api_enums.md": render_enums(manifest),
    }
    return manifest, docs


def main() -> int:
    parser = argparse.ArgumentParser(
        description="从源码自动生成 API 文档（代码是唯一真相源）",
    )
    parser.add_argument("package", help="要生成文档的包名，如 demo_pkg")
    parser.add_argument("output_dir", help="文档输出目录")
    parser.add_argument(
        "--check", action="store_true",
        help="只比对不写入：现有文档与重新生成结果不一致时退出码为 1",
    )
    parser.add_argument(
        "--strict", action="store_true",
        help="存在导入错误或警告时退出码为 2（用于 CI 门禁）",
    )
    parser.add_argument(
        "--manifest", metavar="PATH", default=None,
        help="额外把 API Manifest 写入指定 JSON 路径",
    )
    parser.add_argument(
        "--exclude", metavar="MODULE", action="append", default=[],
        help="跳过指定模块（可多次传入）",
    )
    args = parser.parse_args()

    # 保证从当前目录可导入目标包
    cwd = Path.cwd()
    if str(cwd) not in sys.path:
        sys.path.insert(0, str(cwd))
    importlib.invalidate_caches()

    try:
        manifest, docs = generate_all(args.package, set(args.exclude))
    except ImportError as exc:
        print(f"[错误] 无法导入包 `{args.package}`：{exc}", file=sys.stderr)
        print(f"请确认当前目录下存在 {args.package} 包，且其依赖已安装。", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)

    if args.check:
        if not output_dir.is_dir():
            print(f"[不一致] 输出目录不存在：{output_dir}")
            return 1
        drifted = []
        for filename, content in docs.items():
            path = output_dir / filename
            if not path.exists():
                drifted.append((filename, "文件缺失"))
                continue
            existing = path.read_text(encoding="utf-8")
            if existing != content:
                drifted.append((filename, "内容不一致"))
        if drifted:
            print("[不一致] 文档与代码已漂移，请重新运行生成器：")
            for filename, reason in drifted:
                print(f"  - {filename}: {reason}")
            return 1
        print("[OK] 文档与代码一致，无漂移。")
    else:
        output_dir.mkdir(parents=True, exist_ok=True)
        for filename, content in docs.items():
            (output_dir / filename).write_text(content, encoding="utf-8")
            print(f"[OK] 已生成 {output_dir / filename}（{len(content)} 字符）")

    if args.manifest:
        manifest_path = Path(args.manifest)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"[OK] 已生成 Manifest：{manifest_path}")

    stats = manifest["stats"]
    print(
        f"[报告] 符号 {stats['total_symbols']} 个"
        f"（docstring 覆盖率 {stats['docstring_coverage_pct']}%），"
        f"警告 {len(manifest['warnings'])} 条，错误 {len(manifest['errors'])} 条"
    )
    for w in manifest["warnings"]:
        print(f"  [提示] {w}")
    for e in manifest["errors"]:
        print(f"  [错误] {e}")

    if args.strict and (manifest["errors"] or manifest["warnings"]):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
