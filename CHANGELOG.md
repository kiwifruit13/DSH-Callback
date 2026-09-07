# 更新日志

本项目的所有显著变更记录于此。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-07

自 0.1.0 基线导入以来的第 1~6 轮隐藏 bug 审计修复与 API 兼容扩展。
全部变更经全量验收：`test:invariant` 42 场景、契约测试 **102 场景 739 步**、
`api:check` / `api:contract`（TSDoc 覆盖率 94.1%）全部门禁通过。

### 新增（均为向后兼容扩展）

- `maybeCompress(state, signal?)` 整体取消通道：入口已中止直接跳过；触发后 / 逐段间 /
  提交前三个检查点放弃本轮（状态逐字节原样）；信号透传 `compress` 钩子；门面同步扩展。（R5-9）
- `TriggerDecision.reason` 新枚举值 `'host-decision'`：布尔返回的宿主 `shouldCompress`
  如实标注，不再伪造成 `task-boundary`。（R5-8）
- `ObservationRecord.triggerReason?` 可选字段：触发原因可观测。
- 导出类型 `HardSlots`（`SummarySlots` 的三硬槽位子集），校验链统一收口。
- 导出 `buildTopicShiftSpace`（编排器内置路径与 `defaultShouldCompress` 共用的
  topic-shift 语料构建 helper）、`truncateToBudget`（唯一硬截断实现）。
- 契约 `features/default-facade.feature`：门面级 P0 回归场景（默认触发路径连续两轮压缩 /
  settled·迟滞 / 伪造槽位拒绝走降级链 / 整体取消 / 告警双通道），首次真实覆盖默认链路。
- `docs/api-extension-guide.md`：API 扩展标准流程教程（代码契约 → Manifest 再生成 → 门禁验证）。

### 修复

- **触发链路（P1-4 / R5-1）**：topic-shift 判定的语料空间为空集导致任意相邻用户消息
  cosine 恒 0 假阳性触发压缩；编排器内置路径与公共导出 `defaultShouldCompress` 共用
  `buildTopicShiftSpace`，并有直接单测锁定（相似消息不误报、无关消息如实检出）。
- **轮次状态（P0-1 / P0-2）**：`turnsSinceLastCompress` / `justCompressed` 由实例真实维护，
  频率下限与迟滞带在默认链路真实生效；压缩后 settled 状态引用逐字节不变。
- **校验链（P0-3）**：`compress` 输出槽位经 `VerifyInput` 透传给 `verifySummary`，
  伪造槽位（取值不在原文）被默认校验链拒绝并走 §8.2 降级链。
- **级别分配（P1-2）**：压缩降级不回退级别口径（level 仍记目标级别，可信度由 `degraded` 标记）。
- **观测（R5-3 / R5-4 / P1-3）**：`warn()` 统一入口，`ObservationRecord.warnings` 双通道
  同步记录；fallback 链告警（`llm_invalid_schema_attempt_N` / `heuristic_over_budget` 等）
  不再被丢弃；校验软实体处置转发告警通道。
- **观测语义（R5-8）**：首条消息即压缩块时 `prefixStable` 不再误报 `true`（增加
  `firstDiff > 0` 前提）。
- **L1 去噪（P2-7）**：duplicate-read 收敛为消息级语义（同一条消息内的多行是同一次输出，
  互不为重复）；referenced-later 全覆盖。
- **性能（P3-7）**：`blocks.ts` 块扫描 O(n²) → O(n)。
- **一致性（P3-2 / P3-5 / R5-6 / R5-7）**：清理死赋值与孤儿代码；`l2` 配置注入；
  硬截断收敛为 `fallback.truncateToBudget` 单一实现；`RE_HASH` 补大写十六进制 `[0-9a-fA-F]`。

### 变更

- 回调口径（P1-8）：「六钩子」更正为「五钩子 + 编排器内置触发路径」——`shouldCompress`
  移出 `DEFAULT_CALLBACKS`（占位轮次会使频率下限 / 迟滞带 / 强制压缩失真），README 与
  TSDoc 同步；`extractSlots` / `rehydrate` 等 README 示例与实际签名对齐。
- 契约文件清理（P1-7）：移除幽灵指标 `compress_deferred_count` 及对应孤儿步骤。
- `gain.ts` / `callbacks.ts` 等 TSDoc 与实现对齐（R5-5 / R5-2）。

### 文档

- API 参考文档由 `npm run api:docs` 再生成（118 符号），以代码为唯一真相源；
  `api:check` / `api:contract` 门禁随 CI 验证。

## [0.1.0] - 2026-09-06

阶段性开发成果基线导入 develop 节点。
