# 守护：§9.1 降级链 + §3 onError 钩子失败语义｜对应：src/fallback.ts, src/defaults.ts
# 依据 §12.1 纪律：超时时长由配置注入，场景内不硬编码毫秒数
@fallback @degrade
Feature: 压缩降级链

  作为 Agent 运行时的上下文管理者
  我需要 LLM 摘要失败时有逐级兜底，最终兜底是"放弃压缩并保持原样"
  否则一次模型超时就会让整轮会话崩溃，或悄悄塞进一段未经校验的可疑摘要

  Background:
    Given 降级链按 llm → heuristic → truncate → 放弃 的顺序装配
    And 每级超时时长由配置注入且以 AbortController 控制

  Scenario: LLM 摘要成功时标记来源
    Given 注入的 LLM 摘要钩子正常返回合法结构化结果
    When 执行压缩
    Then 该块的 method 记为 llm
    And 报告字段 degraded 为 false
    And 不触发任何后续降级

  Scenario: LLM 超时后走规则抽取
    Given 注入的 LLM 摘要钩子长时间不返回
    When 超时由 AbortController 触发
    Then 降级为规则抽取，保留首尾句与含实体句
    And 该块的 method 记为 heuristic
    And 报告字段 degraded 为 true
    And 超时被中断的请求不残留未取消的网络调用

  Scenario: 规则抽取输出仍超预算则硬截断
    Given 规则抽取的结果 token 数超出该段预算
    When 降级链继续
    Then 执行硬截断并保留尾部
    And 该块的 method 记为 truncate
    And 报告字段 degraded 为 true

  Scenario: 三级全部失败时放弃压缩并告警
    Given llm、heuristic、truncate 三级均抛出异常或产出非法结果
    When 降级链走到尽头
    Then 抛出 NoCompressionPossible
    And 上下文保持逐字节原样不产生任何 CompressedBlock
    And epoch 不递增
    And 记录一条含三级失败原因的告警

  Scenario: 每次降级都落盘 method 标记以便事后判断可信度
    Given 一次压缩最终由 truncate 级完成
    When 检查产出的 CompressedBlock
    Then 其 method 字段准确记为 truncate 而非 llm
    And 依据该标记可判定此段上下文可信度低于 llm 级摘要
    And 标记随报告一并写入观测数据

  # 以下四个场景超出规划 §12.5 的五个，补全 §3 已声明但原清单未覆盖的钩子失败语义。
  # 理由：§3 明确写了五个钩子各自的失败语义，其中三个（shouldCompress / onPreCompress / selectSegment）
  # 的处置方向完全不同——一个视为不压缩、一个继续、一个必须中止。不锁定就会实现错。
  Scenario: LLM 返回非法 JSON 时先重试再降级
    Given 注入的 LLM 摘要钩子返回不符合槽位 schema 的文本
    When 执行压缩
    Then 按 §5 约定重试一次
    And 重试仍非法则降级为 heuristic，不再继续重试
    And 非法输出被记录用于事后分析而非静默丢弃

  Scenario: should_compress 钩子抛异常时保守地不压缩
    Given 已注入的 should_compress 钩子会抛出异常
    When 调用触发判定
    Then 视为不压缩决策
    And 上下文保持原样
    And 不因钩子异常而使会话崩溃

  Scenario: select_segment 钩子抛异常时中止本轮压缩
    Given 已注入的 select_segment 钩子会抛出异常
    When 执行完整压缩流程
    Then 本轮压缩被中止且上下文完全不变
    And 不回退到任何默认切割实现（边界错则全盘错）
    And 记录一条 select_hook_error 告警

  Scenario: 用户仅提供 compress 钩子时其余钩子走默认实现
    Given 注入的 callback 只实现了 compress，其余五个钩子均未提供
    When 执行完整压缩流程
    Then 流程可正常跑通不抛缺失实现错误
    And 触发、切割、校验、降级均由默认实现承担
    And 产出的 CompressedBlock 字段完整可被 rehydrate
