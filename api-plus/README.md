# API 文档自动生成：以代码为唯一真相源（实现版）

本目录是《API 文档自动生成》技术方案的**完整落地实现**，包括生成器、契约门禁测试、示例包和生成产物，所有环节均已实际运行验证。

## 目录结构

```
api/
├── generate_api_docs.py        # 主生成器（仅标准库，Pydantic 可选）
├── test_api_contract.py        # 契约门禁测试（内置运行器，也可用 pytest）
├── demo_pkg/                   # 示例包：覆盖全部符号类型与边界场景
│   ├── __init__.py             #   根包：再导出 + __all__
│   ├── core.py                 #   类/枚举/常量/dataclass/双兼容入参
│   ├── infra.py                #   函数/枚举/常量/可选参数
│   ├── aliases.py              #   再导出同名符号（验证去重）
│   └── internal.py             #   无 __all__ 模块（验证提示逻辑）
├── docs/                       # 生成产物（禁止手改）
│   ├── api_reference.md        #   完整 API 参考
│   ├── api_class_reference.md  #   符号速查表（已去重）
│   ├── api_enums.md            #   枚举汇总
│   └── api_manifest.json       #   API Manifest（机器可读中间表示）
└── README.md
```

## 核心设计：三阶段流水线 + Manifest 中间层

生成不是"一步到位拼字符串"，而是三个显式阶段，中间产物为 **API Manifest**（纯 JSON，可序列化）：

```
源码包
  │ 阶段一 扫描：pkgutil.walk_packages 递归导入全部子模块
  │        导入错误不静默吞掉，逐条记录（--strict 下致命化）
  ▼
模块表
  │ 阶段二 提取：遍历各模块 __all__，按种类反射提取
  │        类/函数 → __module__+__qualname__ 定位定义处，再导出自动合并
  │        常量 → 无定义位置，按 (名称, 值) 合并
  │        类成员 → 只取 vars(cls)（排除继承噪音），含 property 与类属性
  │        dataclass/Pydantic → 提取字段表（类型/默认值/描述）
  ▼
API Manifest（唯一中间表示）
  │ 阶段三 渲染：三个渲染器消费同一份 Manifest
  ▼
api_reference.md + api_class_reference.md + api_enums.md
```

三份文档来自同一份 Manifest，结构上保证互不矛盾。Manifest 同时落盘为 `api_manifest.json`，供契约测试与未来的"API 变更日志"工具消费。

## 支持的符号类型

| 种类 | 提取内容 |
|------|----------|
| 枚举（Enum） | 全部成员名与值 |
| 普通类 | docstring、构造签名、本类定义的 property/方法/类属性 |
| dataclass | docstring + 字段表（类型、默认值、`<factory>`） |
| Pydantic 模型 | docstring + 字段表（类型、默认值、Field description）；未安装 pydantic 时自动跳过该分支 |
| 函数 | docstring + 完整签名（支持 `from __future__ import annotations`，经 `typing.get_type_hints` 求值） |
| 常量 | 值、类型 |

**刻意不支持**（已知局限，见文末）：动态构造的符号、条件性 `__all__`、monkey-patch 导出、私有成员。

## 用法

```bash
# 生成文档（输出目录自动创建）
python generate_api_docs.py demo_pkg docs --exclude demo_pkg.internal

# 同时输出 Manifest
python generate_api_docs.py demo_pkg docs --exclude demo_pkg.internal --manifest docs/api_manifest.json

# 只比对不写入（漂移检测，不一致时退出码 1）
python generate_api_docs.py demo_pkg docs --exclude demo_pkg.internal --check

# CI 门禁：存在导入错误或警告时退出码 2
python generate_api_docs.py demo_pkg docs --strict --exclude demo_pkg.internal
```

参数说明：

| 参数 | 说明 |
|------|------|
| `package` | 要生成文档的包名（当前位置：第 1 个参数） |
| `output_dir` | 文档输出目录 |
| `--check` | 只比对不写入，用于检测"改了代码没重跑生成器" |
| `--strict` | 有导入错误或警告时以退出码 2 失败 |
| `--manifest PATH` | 额外输出 API Manifest JSON |
| `--exclude MODULE` | 跳过模块，可多次传入（如无 `__all__` 的内部模块） |

## 输出确定性

产物**字节级确定**：不含时间戳，所有迭代显式排序。因此 `git diff --exit-code docs/` 可稳定用作门禁，不会因文件遍历顺序在不同机器上抖动。

## 契约门禁测试

`test_api_contract.py` 共 11 项测试，覆盖五类契约（对应历史缺陷）：

| 契约 | 测试 | 防什么 |
|------|------|--------|
| 扫描完整性 | `test_scan_has_no_errors`、`test_all_exports_accessible` | 模块导入失败被静默跳过；`__all__` 声明了不可访问的符号 |
| 文档同步 | `test_docs_are_in_sync_with_code` | 改了代码没重跑生成器（**已实测拦截**） |
| 产物有效性 | `test_manifest_symbols_exist_in_live_code`、`test_manifest_enum_members_match_code`、`test_manifest_class_methods_exist`、`test_manifest_function_signatures_resolvable` | 文档写了 `prepare()` 但代码里是 `prepare_context()`；枚举成员漂移 |
| 去重正确性 | `test_class_index_has_no_duplicate_symbols` | 再导出导致速查表重复行 |
| 历史缺陷回归 | `test_store_memory_accepts_string_status`、`test_consent_status_single_source` | 枚举入参只接受 Enum 对象、字符串入参在 `.value` 崩溃；同一枚举双定义遮蔽 |

附加门禁：`test_docstring_coverage_above_threshold`，公开符号 docstring 覆盖率低于 70%（`DOCSTRING_COVERAGE_MIN`）即失败。

```bash
python test_api_contract.py              # 内置运行器，无依赖
python -m pytest test_api_contract.py    # 如已安装 pytest
```

## CI 集成建议

```bash
# 1. 重新生成，有漂移则失败
python generate_api_docs.py demo_pkg docs --check --strict --exclude demo_pkg.internal

# 2. 契约测试
python test_api_contract.py

# 3.（可选）要求文档与代码同一提交
python generate_api_docs.py demo_pkg docs --exclude demo_pkg.internal
git diff --exit-code docs/
```

## 套用到自己的项目

前置条件与之前方案文档一致：类型注解 + `__all__` + docstring + Pydantic/dataclass（可选）。步骤：

1. 把 `generate_api_docs.py` 复制到仓库（零依赖，单文件）；
2. 确保 `__all__` 齐全；无 `__all__` 的内部模块用 `--exclude` 排除（否则会触发警告，`--strict` 下失败）；
3. 跑一次生成，把 `docs/` 提交进版本库；
4. 把 `test_api_contract.py` 复制到仓库，改三个常量（`PACKAGE`、`EXCLUDES`、`DOCSTRING_COVERAGE_MIN`），并把"产物有效性"一节里的符号断言按项目补充；
5. 接入 CI（上一节的三步）。

## 已知局限

- **运行即导入**：生成器通过 `import` 反射，模块导入期的副作用（建连接、读配置）会真实执行。有重副作用的项目应把副作用移到函数体内，或改用 AST 静态分析（见演进方向）。
- **动态符号盲区**：运行时动态构造、条件性 `__all__`、monkey-patch 出来的符号无法可靠提取。
- **常量去重按 (名称, 值)**：两个不同含义的同名同值常量会被合并为一条（实践中罕见）。
- **继承方法不展示**：类文档只列本类定义的方法（设计决策，排除继承噪音）；如需继承链信息，可扩展渲染器。

## 演进方向（未实现）

1. **API 变更日志**：发版时存档 Manifest，下次生成时 diff，自动产出"新增/删除/签名变更"清单并标记破坏性变更；
2. **静态分析替代反射**：用 `ast`/`griffe` 解析，消除导入副作用问题；
3. **docstring 段落解析**：解析 Google/NumPy 风格的 `Args:`/`Returns:` 段，把参数说明与签名合并展示；
4. **HTML 输出**：Manifest → HTML，符号间交叉引用超链接。

## 为什么自研而不用 pdoc / mkdocstrings

- 契约测试联动：门禁测试直接消费同一套提取逻辑，外部工具做不到；
- 定制产物：速查表（含定义模块 + 导出来源 + 去重）是本项目特有需求；
- 漂移门禁：`--check` 与 `git diff --exit-code` 组合的 CI 流程是一等公民；
- 零依赖单文件：复制即用，无构建环节。

纯展示型文档场景（无契约门禁需求）直接用 pdoc/mkdocstrings 更省力。
