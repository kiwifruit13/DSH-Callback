# demo_pkg 枚举类型汇总（自动生成）

> **本文档由 `generate_api_docs.py` 自动生成，以代码为唯一真相源**，人工修改会被下次生成覆盖。
> 若需更新 API 描述，请修改代码 docstring 后重新生成。

共 2 个枚举类型。枚举成员属于 API 契约，改动需评审。

## `demo_pkg.core.ConsentStatus`

用户授权状态，只有 GRANTED 才允许写入记忆。

| 成员 | 值 |
|------|-----|
| `GRANTED` | `'granted'` |
| `DENIED` | `'denied'` |
| `PENDING` | `'pending'` |

导出来源：`demo_pkg`、`demo_pkg.aliases`、`demo_pkg.core`

## `demo_pkg.infra.RetryPolicy`

重试策略。

| 成员 | 值 |
|------|-----|
| `FIXED` | `'fixed'` |
| `EXPONENTIAL` | `'exponential'` |

导出来源：`demo_pkg`、`demo_pkg.infra`
