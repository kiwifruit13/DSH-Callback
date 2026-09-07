# 守护：铁律一（永远从原文压缩）+ 铁律二（级别单调、下沉有上限）｜对应：src/levels/*, src/orchestrator.ts, src/archive.ts
# 标签：@invariant 属于提交前必跑集
@invariant @level @priority-critical
Feature: 级别下沉与有损压缩边界

  作为 Agent 运行时的上下文管理者
  我需要保证渐进式压缩是"逐级下沉且每级都从原文重生成"，而非"摘要的摘要"
  否则信息损耗会随压缩轮次指数级累积，这正是渐进式压缩越压越糊的直接成因

  Background:
    Given 一个已配置归档存储的会话
    And 下沉次数上限由配置注入

  Scenario: 永远从原文压缩而非从摘要压缩
    Given 一段内容已下沉至 L2 结构化摘要
    And 归档中保存其 L0 原文且 source_hash 校验通过
    When 该段需继续下沉至 L3
    Then 系统经 rehydrate 取回 L0 原文
    And L3 摘要由 L0 原文生成，输入中不含 L2 摘要文本
    And 新 CompressedBlock 的 source_span 指向 L0 原文的消息 ID

  # 规划原文写作"已达上限 2"，此处改为配置注入 + 关系断言。
  # 依据 §12.1 纪律：Gherkin 内不出现任何待标定的具体数字。
  # 断言从"值等于 2"改为"达上限即停、不再递增"，覆盖任意上限取值。
  Scenario: 下沉次数达上限后停止有损重压
    Given 一段内容的 compress_count 已等于配置注入的下沉次数上限
    When 再次触发压缩
    Then 该段直接落 L4 指针且不再调用摘要钩子
    And 其 compress_count 保持原值不再递增

  Scenario: 级别单调不回退
    Given 一段内容当前处于 L2
    When 触发新一轮压缩
    Then 其 target_level 大于或等于 2
    And 除非显式 rehydrate，否则不返回 L0 或 L1

  Scenario: L1 输出是输入的子集
    Given 中部内容含重复文件读取输出与超长 stdout
    When 执行 L1 去噪裁剪
    Then 裁剪结果中每个字符片段均可在原文中定位
    And 结果中不存在原文未出现的新字符串

  Scenario: 被后续引用的工具输出不裁剪
    Given 某次工具输出的内容在后续轮次被助手显式引用
    When 执行 L1 去噪裁剪
    Then 该输出被保留
    And 保留原因记为 referenced-later

  Scenario: 归档损坏时拒绝下沉
    Given 一段内容的 source_hash 与归档原文哈希不一致
    When 尝试 rehydrate
    Then 抛出 ArchiveCorrupted
    And 该段保持当前级别不下沉
    And 不生成任何基于可疑原文的新摘要

  # 以下三个场景超出规划 §12.4 的六个，补全 L1 级别尚未锁定的行为。
  # 理由：L1 是唯一被铁律强制"输出 ⊆ 输入"的级别，但它依赖具体去噪规则；
  # 规则若不在契约中固定，实现者会各自发明，导致同名 L1 行为不一致。
  Scenario Outline: L1 去噪规则逐项生效且均保持子集性质
    Given 中部内容含 <噪声形态>
    When 执行 L1 去噪裁剪
    Then 该噪声被裁剪或替换为其在原文中已存在的更短片段
    And 裁剪结果的字符集是原文字符集的子集
    And 本条裁剪记录命中的规则名为 <规则名>

    Examples:
      | 噪声形态                                       | 规则名                    |
      | 同一文件被反复读取产生的重复输出               | duplicate-read            |
      | 超出长度阈值的单条工具 stdout                  | oversized-stdout          |
      | 连续多次失败且错误文本相同的命令               | repeated-failure          |
      | 已被后续成功结果取代的中间结果                 | superseded-result         |

  Scenario: L2 摘要的硬槽位必须逐字摘抄原文
    Given 一段内容下沉至 L2 并生成分槽位摘要
    When 校验槽位内容
    Then constraints、artifacts、todos 三个槽位的每条取值均可在原文中逐字定位
    And 仅 narrative 槽位允许出现原文中不存在的改写文本

  Scenario: 无归档能力时禁止执行有损下沉
    Given 归档存储不可用或写入失败
    When 一段内容需从 L1 下沉至 L2
    Then 拒绝下沉并保持该段停留在 L1
    And 记录一条 archive-unavailable 告警说明原因是回溯能力缺失
