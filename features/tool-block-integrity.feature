# 守护：铁律三 + §6 tool_use/tool_result 完整性保护｜对应：src/blocks.ts, src/pins.ts
# 优先级最高：违反即触发 Anthropic / OpenAI API 400
# 标签：@invariant 属于提交前必跑集
@invariant @tool-block @priority-critical
Feature: tool block 配对完整性

  作为 Agent 运行时的上下文管理者
  我需要保证任何一次压缩都不会把 assistant 的工具调用与其返回结果拆散
  否则云端 API 会直接拒绝整个请求，压缩收益归零且会话中断

  Background:
    Given 一个包含系统提示、中部历史与尾部最近轮次的会话
    And 压缩配置注入为 触发线 0.7 目标线 0.5

  Scenario: 切点只落在 tool block 之间
    Given 中部包含一个完整 tool block，其 assistant 消息发起 1 次工具调用且 result 齐全
    When 执行边界切割
    Then 该 block 的 assistant 消息与其全部 result 位于切割的同一侧
    And 中部段的首元素与尾元素都必须是完整 block

  Scenario: 并行工具调用构成单一不可分割块
    Given 一条 assistant 消息含 3 个 tool_calls
    And 3 条对应 tool result 消息紧随其后
    When 解析 tool block
    Then 这 4 条消息构成 1 个 block
    And 该 block 的 token 数等于 4 条消息 token 之和

  Scenario: 缺失 result 的畸形块被强制 pin
    Given 一个 tool block 的 assistant 消息发起了 2 次工具调用
    And 仅 1 条 tool result 到达，另一次调用超时未返回
    When 执行 on_pre_compress
    Then 该 block 标记为 complete 等于 false
    And missing 列表含未返回的 tool_use 标识
    And 该 block 被强制 pin 且 pin_reason 为 tool-block-incomplete
    And 该 block 在任何级别都不参与压缩

  Scenario: 孤儿 result 单独成块且不中断流程
    Given 一条 tool result 消息找不到对应的 assistant tool_calls
    When 解析 tool block
    Then 该 result 单独成块并被标记为畸形
    And 压缩流程正常继续不抛异常

  Scenario: 无安全切点时放弃本轮压缩
    Given 中部起点到尾部起点之间的全部消息同属一个 tool block
    When 执行边界切割
    Then select_segment 返回空的中部段集合
    And 本轮压缩被放弃且上下文逐字节不变
    And 指标 select_abort_count 增加 1

  Scenario: 中部为空时不产生空压缩块
    Given 会话仅有系统提示与尾部消息，中部无任何 block
    When 执行完整压缩流程
    Then 不生成任何 CompressedBlock
    And epoch 不递增

  # 以下两个场景超出规划 §12.4 的六个，补全真实会话中常见的畸形形态。
  # 理由：result 乱序与跨轮次悬挂都会让"pending 集合"判定失效，
  # 若不显式约定行为，实现者会各自做出不同假设。
  Scenario: 乱序到达的 result 仍归入其所属 block
    Given 一条 assistant 消息按顺序发起 tool_calls 标识为 call-1、call-2、call-3
    And 三条 tool result 以 call-2、call-3、call-1 的乱序到达
    When 解析 tool block
    Then 这 4 条消息仍构成 1 个 complete 的 block
    And block 内消息保持原始到达顺序不被重排

  Scenario: 被下一条 assistant 工具调用截断的 block 判为畸形
    Given 一条 assistant 消息发起 2 次工具调用但仅有 1 条 result 到达
    And 紧随其后是另一条发起工具调用的 assistant 消息
    When 解析 tool block
    Then 第一个 block 在该 assistant 消息处结束且 complete 等于 false
    And 第一个 block 被强制 pin 且 pin_reason 为 tool-block-incomplete
    And 第二个 block 独立解析不受前一个畸形块影响
