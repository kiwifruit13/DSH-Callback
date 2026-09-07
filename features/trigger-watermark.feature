# 守护：§7.1 双水位 + 迟滞 + 任务边界优先｜对应：src/trigger.ts
# 依据 §12.1 纪律：水位比例等阈值一律由配置注入，场景内不硬编码
@trigger @watermark
Feature: 触发策略与 prompt cache 友好性

  作为 Agent 运行时的上下文管理者
  我需要压缩在"占用超线且遇到任务边界"时才发生，且两次压缩之间有迟滞带与频率下限
  否则会在临界点反复压缩，每次都让 prompt cache 全 miss，成本与首字延迟双重跳升

  Background:
    Given 压缩配置注入为 触发线 <trigger> 目标线 <target> 频率下限轮数 <minGap>
    And 上下文窗口大小已知
    # 说明：上述尖括号值由 support/world.ts 在钩子中注入具体数值，
    # 本文件不假设任何默认值，便于标定后无需改动契约。

  Scenario: 占用低于触发线不压缩
    Given 当前 token 占用率低于触发线
    When 调用 should_compress
    Then 返回不压缩决策
    And epoch 保持不变
    And 不调用任何压缩钩子

  Scenario: 占用落在迟滞带内不压缩以防抖动
    Given 当前 token 占用率高于目标线但低于触发线
    And 上一轮压缩刚刚完成
    When 调用 should_compress
    Then 返回不压缩决策
    And 决策原因记为 hysteresis-band
    And 本轮不产生新的 CompressedBlock

  Scenario Outline: 识别到任务边界则在边界处压缩
    Given 当前 token 占用率高于触发线
    And 会话中存在 <边界信号> 标记的位置
    When 调用 should_compress
    Then 返回压缩决策且切点落在该边界信号处
    And 决策原因记为 task-boundary
    And 边界类型记为 <边界类型>

    Examples:
      | 边界信号                                 | 边界类型          |
      | 一条待办状态由 pending 翻转为 completed  | todo-transition   |
      | 一段连续工具调用序列终止且后续为纯文本   | tool-seq-end      |
      | 助手输出了交付总结且用户随后发起新话题   | delivery-summary  |
      | 用户新消息与前一话题的增益相关性低于阈值 | topic-shift       |

  Scenario: 无边界且超过等待上限时强制压缩
    Given 当前 token 占用率高于触发线
    And 自上次压缩以来始终未出现任何任务边界信号
    And 等待轮数已超过配置的等待上限
    When 调用 should_compress
    Then 返回压缩决策
    And 决策标记 forced 为 true
    And 切点仍受 tool block 边界门禁约束，不落在任何 block 内部

  Scenario: 压缩后占用落到目标线以下则本轮结束
    Given 一轮压缩已提交且压缩后占用率低于目标线
    When 紧接着再次调用 should_compress
    Then 返回不压缩决策
    And 本轮不追加第二次压缩
    And epoch 相对压缩前仅递增 1

  Scenario: 频率下限内抑制压缩即使占用已超线
    Given 当前 token 占用率高于触发线
    And 距上次成功压缩的轮数小于配置的频率下限轮数
    When 调用 should_compress
    Then 返回不压缩决策
    And 决策原因记为 rate-limit

  # 以下三个场景超出规划 §12.5 的五个，补全 §7.2 prompt cache 对策的可验证部分。
  # 理由：§7.2 提出了三条对策但原清单一条都没覆盖，而 cache miss 是本方案最主要的成本来源；
  # 不写进契约，实现时极可能把压缩块插到系统提示之前，导致头部缓存永久失效。
  Scenario: 稳定前缀在压缩前后逐字节不变
    Given 会话头部含系统提示与已 pin 的内容
    When 完成一轮压缩并提交
    Then 头部消息序列在压缩前后逐字节相同
    And cache_control 断点仍位于头部之后、首个压缩块之前
    And 报告字段 cache_impact.prefix_stable 为 true

  Scenario: 相同幂等键重试复用压缩结果不重新生成
    Given 一段内容已按幂等键 (startId, endId, level, epoch) 生成过压缩结果
    When 以完全相同的幂等键再次请求压缩
    Then 返回缓存的既有结果
    And 不再调用 LLM 摘要钩子
    And 压缩块文本与首次生成时逐字节相同以避免缓存抖动

  Scenario: 单轮内占用反复穿越触发线只压缩一次
    Given 一轮对话中 token 占用率先超触发线、压缩后回落、随后再次超线
    When 该轮内连续多次调用 should_compress
    Then 仅首次超线触发压缩
    And 后续调用因频率下限被抑制
    And 全轮 epoch 递增次数为 1

  # R5-1 回归：defaultShouldCompress 是公共导出（README 推荐宿主包装使用），
  # 其 topic-shift 语料空间必须由会话用户消息真实构建。空语料空间下任意文本
  # 向量恒为零，cosine 恒 0 低于阈值，会对每对相邻用户消息假阳性触发
  # topic-shift（原缺陷：P1-4 只修了编排器内置路径，公共导出残留）。
  Scenario: 默认触发判定对相邻相似消息不误报 topic-shift
    Given 当前 token 占用率高于触发线
    And 相邻两条用户消息围绕同一主题高度相关
    When 直接调用公共导出的 defaultShouldCompress
    Then 不得因 topic-shift 假阳性触发压缩

  Scenario: 默认触发判定对真实的相邻话题切换如实检出
    Given 当前 token 占用率高于触发线
    And 相邻两条用户消息分属完全无关的话题
    When 直接调用公共导出的 defaultShouldCompress
    Then 返回压缩决策且切点落在该边界信号处
    And 决策原因记为 task-boundary
    And 边界类型记为 topic-shift
