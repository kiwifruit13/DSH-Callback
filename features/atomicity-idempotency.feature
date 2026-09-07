# 守护：§9.2 原子性 + §9.3 幂等与并发｜对应：src/orchestrator.ts
# 标签：@invariant 属于提交前必跑集
@invariant @atomicity @idempotency
Feature: 原子提交与幂等

  作为 Agent 运行时的上下文管理者
  我需要压缩要么整段成功提交要么上下文完全不变，且重复或并发触发不会把同一段压两遍
  否则"半压缩"状态比不压缩更糟——它既丢了信息又无法回溯

  Background:
    Given 一个已配置归档与幂等缓存的会话
    And 消息序列以不可变数组持有

  Scenario: compress 中途抛异常时上下文完全不变
    Given 注入的 compress 钩子在处理第二个段时抛出异常
    And 第一个段已成功产出压缩结果
    When 执行完整压缩流程
    Then 已产出的第一个段结果被丢弃不提交
    And ContextState 引用与 msgs 内容逐字节保持压缩前的状态
    And epoch 不递增
    And 不存在任何部分写入的 CompressedBlock

  Scenario: 提交前断言失败则整体回滚
    Given 待提交的 next_msgs 中某个 tool block 的配对不完整
    When 执行提交前完整性断言
    Then 断言失败并触发整体回滚
    And 上下文保持原样
    And 记录一条 commit_assert_failed 告警并指明失败的断言项

  Scenario: 相同幂等键重复调用复用缓存结果
    Given 幂等键 (startId, endId, level, epoch) 已存在对应压缩结果
    When 以同一幂等键再次请求压缩
    Then 直接返回缓存结果
    And 不再调用 compress 钩子
    And 返回块与首次产出的块逐字节相同

  Scenario: 成功提交后 epoch 递增
    Given 一轮压缩已成功提交
    When 检查提交后的 ContextState
    Then epoch 相对提交前恰好递增 1
    And 该轮产出的全部 CompressedBlock 的 epoch 字段等于新值

  Scenario: 并发触发时仅执行一次压缩
    Given 两个请求在同一 epoch 下几乎同时触发压缩
    When 二者并发进入压缩流程
    Then 仅一次实际压缩被执行，另一方复用同一 in-flight promise
    And 最终只产出一套 CompressedBlock
    And epoch 只递增 1

  Scenario: epoch CAS 冲突时后者放弃本轮
    Given 一个请求已完成提交使 epoch 递增
    And 另一个请求仍持有递增前的旧 epoch 值
    When 后者尝试以旧 epoch 提交
    Then CAS 比较失败，后者放弃本轮提交
    And 不产生基于过期状态的第二次写入
    And 后者可选择在新 epoch 上重新评估是否仍需压缩

  # 以下三个场景超出规划 §12.5 的六个，补全提交阶段断言项与观测接口。
  # 理由：§9.2 列了三项提交前断言（配对完整、pin 在位、token 一致），原清单只覆盖了第一项；
  # 另两项失败若不约定行为，实现可能只校验配对就提交，导致 pin 内容被悄悄换掉。
  Scenario: 提交前断言 pin 内容全部在位
    Given 本轮识别出的全部 pin 中有一条在 next_msgs 里缺失或文本被改动
    When 执行提交前完整性断言
    Then 断言失败并触发整体回滚
    And 告警指明缺失或被改动的 pin 及其 pin_reason

  Scenario: 提交前断言 token 计数与预估一致
    Given next_msgs 的实际 token 总数与压缩前预估值的偏差超出容许范围
    When 执行提交前完整性断言
    Then 断言失败并触发整体回滚
    And 记录预估偏差值以便修正 token 估算器

  Scenario: 每轮压缩产出可接入外部监控的观测记录
    Given 一轮压缩已成功提交
    When 检查其观测记录
    Then 记录包含前后 token、压缩比、耗时、级别、method、pin 条数与 cache 影响字段
    And 观测接口以回调或事件形式暴露，不绑定任何特定监控实现
    And 记录中的 method 与 degraded 字段可区分本轮是否走了降级
