# 守护：§8.1 正则实体校验 + §8.2 校验失败处理链 + §8.3 进阶校验（默认关闭）｜对应：src/verify.ts
# 依据 §12.1 纪律：硬实体要求 100% 保留（这是契约不是阈值），软实体阈值由配置注入
@verify @entity
Feature: 压缩后实体校验

  作为 Agent 运行时的上下文管理者
  我需要每次有损压缩后立即校验关键实体是否仍在摘要中
  否则路径、ID、命令错一个字符，Agent 就会对错误目标执行破坏性操作

  Background:
    Given 软实体保留率阈值由配置注入
    And 硬实体保留率要求恒为 1.0

  Scenario Outline: 任一类硬实体保留率不足即校验不通过
    Given 原文含若干 <实体类别>
    And 压缩摘要中缺失了其中至少一个
    When 执行实体校验
    Then verify_passed 为 false
    And entity_retain 中 <实体类别> 的保留率小于 1.0
    And 报告标记缺失的具体实体值以便定位

    Examples:
      | 实体类别                |
      | Windows 绝对路径        |
      | POSIX 路径              |
      | URL                     |
      | UUID 或 commit hash     |
      | 反引号包裹的命令与符号  |

  Scenario: 校验不通过先触发一次重压
    Given 一次 L2 摘要的硬实体保留率不足 1.0
    When 校验失败处理链启动
    Then 以更换 temperature 或更强调摘抄的 prompt 重压一次
    And 重压结果的 method 仍记为 llm
    And 重压最多执行一次，不进入无限重试

  Scenario: 重压仍不通过则降级到抽取式
    Given 重压后的摘要硬实体保留率仍不足 1.0
    When 校验失败处理链继续
    Then 降级为 L1 抽取式压缩
    And 抽取结果的每个实体保留率为 1.0（因输出是原文子集）
    And 该块的 method 记为 heuristic

  Scenario: 抽取式仍超预算则硬截断保尾部
    Given 降级为抽取式后其 token 数仍超出该段预算
    When 校验失败处理链继续
    Then 执行硬截断并保留尾部内容
    And 该块的 method 记为 truncate
    And 截断后仍对保留部分重跑一次实体校验

  Scenario Outline: 软实体低于阈值时按配置处置
    Given 原文含若干 <软实体类别>
    And 其保留率低于配置注入的阈值
    When 执行实体校验
    Then 按配置执行 <处置动作>
    And 处置结果写入报告，不静默忽略

    Examples:
      | 软实体类别        | 处置动作            |
      | 数值与百分比      | 告警但允许通过      |
      | 人名与专名        | 告警但允许通过      |

  Scenario: 校验通过时报告逐类可查
    Given 一次压缩的硬实体与软实体均达标
    When 执行实体校验
    Then verify_passed 为 true
    And entity_retain 字段包含每一类实体的独立保留率数值
    And 报告可供事后审计而非只给出总体布尔值

  # 以下三个场景超出规划 §12.5 的五个，补全校验器自身的失效路径与 §8.3。
  # 理由：校验器抛异常、原文本身无实体、进阶问答校验这三条路径若不在契约中锁定，
  # 实现容易把"校验失败"和"校验器崩了"混为一谈——后者必须视为不通过而非放行。
  Scenario: 校验器自身抛异常时视为不通过
    Given 已注入的 verify 钩子会抛出异常
    When 执行实体校验
    Then 本轮判定为校验不通过，不放行该摘要
    And 走 §8.2 的降级链而非直接采用可疑结果
    And 记录一条 verify_hook_error 告警以区分"未达标"与"校验器崩溃"

  Scenario: 原文不含任何受检实体时校验直接通过
    Given 待压缩段为纯自然语言叙述，不含路径、ID、命令、数值或专名
    When 执行实体校验
    Then verify_passed 为 true
    And entity_retain 中各类别保留率记为 1.0 而非 0 或空值
    And 不因"未匹配到实体"被误判为信息丢失

  Scenario: 进阶事实问答校验默认关闭
    Given 配置中进阶校验开关为关闭
    When 执行实体校验
    Then 不生成任何事实问题且不调用额外模型
    And 仅正则实体校验生效
    When 将进阶校验开关置为开启并重新校验
    Then 针对 constraints、artifacts、todos 三个槽位各生成一题
    And 每题答案均可在原文中逐字定位，不出现开放式问题
    And 任一题答错即判定关键信息丢失并走降级链
