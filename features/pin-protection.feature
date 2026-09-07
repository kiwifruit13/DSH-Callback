# 守护：§3 onPreCompress 钩子 + §5 分槽位摘要｜对应：src/pins.ts
# 标签：@invariant 属于提交前必跑集
@invariant @pin @priority-critical
Feature: 不可压缩区保护

  作为 Agent 运行时的上下文管理者
  我需要保证用户硬约束、交付物路径、权限确认与未完成待办在任何压缩级别下都不失真
  否则 Agent 会在压缩后违背用户明确要求，或对错误目标执行破坏性操作

  Background:
    Given 一个已解析出头部、中部与尾部的会话
    And pin 白名单识别器已启用

  Scenario: 用户硬约束逐字节不变
    Given 会话早期用户消息含文本 "必须在原文件上原地修改，不要生成新版本"
    When 执行任意级别的压缩
    Then 该消息被 pin
    And 压缩后其文本与原消息逐字节相同

  Scenario: 交付物绝对路径完整保留
    Given 一条消息含 Windows 绝对路径 "D:\Documents\out\报告.docx"
    When 执行任意级别的压缩
    Then 该路径在压缩结果中逐字符存在
    And 路径类实体保留率为 1.0

  Scenario: 权限确认记录可被追溯
    Given 会话中存在用户对高风险操作的批准记录
    When 执行压缩
    Then 该记录被 pin 且 pin_reason 为 permission-grant
    And 依据压缩后的上下文仍能判定该操作已获批准

  Scenario: 未完成待办 pin，已完成待办可下沉
    Given 存在一条状态为 pending 的待办与一条状态为 completed 的待办
    When 执行压缩
    Then pending 待办被 pin 且 pin_reason 为 open-todo
    And completed 待办允许下沉至 L2 的 todos 槽位

  Scenario: 每条 pin 携带可审计理由
    When 完成一轮压缩
    Then 每个 pin 的 pin_reason 字段均非空
    And 全部 pin_reason 取值属于既定枚举集合

  Scenario: pin 豁免于增益计算
    Given 某段内容已被 pin
    When 执行预算分配
    Then 该段不参与增益评分
    And 该段不占用中部预算且 target_level 恒为 0（逐字保留）

  # 以下四个场景超出规划 §12.4 的六个，补全 §4 Pin 类型中已定义但未覆盖的 reason 枚举。
  # 理由：枚举里有七种 reason，原清单只覆盖三种；未覆盖的四种若不在契约中锁定，
  # 实现时极易漏识别，而它们保护的恰是"用户明确要求记住"和"关键报错"这类不可再生信息。
  Scenario Outline: 各类受保护内容被识别为对应 pin 理由
    Given 会话中存在一条 <内容形态>
    When 执行 on_pre_compress
    Then 该内容被 pin 且 pin_reason 为 <预期理由>

    Examples:
      | 内容形态                              | 预期理由                 |
      | 系统提示消息                          | system-prompt            |
      | 用户最新一轮的原始需求文本            | latest-user-intent       |
      | 用户消息含 "记住" 或 "以后都要" 字样  | user-remember            |
      | 尚未被后续成功输出取代的关键报错行    | error-critical           |

  Scenario: 仅 pin 消息内的关键片段而非整条长消息
    Given 一条超长用户消息，其中仅有一句包含交付物绝对路径
    When 执行 on_pre_compress
    Then 该消息产生的 pin 携带 span 字段指向含路径的字符区间
    And 该消息中 span 之外的内容仍可下沉至 L2 或更低级别

  Scenario: on_pre_compress 抛异常时退回静态白名单
    Given 已注入的 on_pre_compress 钩子会抛出异常
    When 执行完整压缩流程
    Then 压缩不中断且使用静态 pin 白名单继续
    And 本轮指标记录一条 pin_hook_degraded 告警

  Scenario: 重复识别同一内容不产生重复 pin
    Given 同一条消息同时命中 deliverable-path 与 latest-user-intent 两种识别信号
    When 执行 on_pre_compress
    Then 该消息仅产生一条 pin 记录
    And 其 pin_reason 取优先级更高的那一种
