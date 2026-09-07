# 守护：§4.1 可回溯实现（JSONL 归档 + rehydrate）｜对应：src/archive.ts
# 归档是 §1.3 语义反转能成立的物质基础：没有它，"下沉不删除"就是一句空话
@rehydrate @archive
Feature: 原文归档与按需回溯

  作为 Agent 运行时的上下文管理者
  我需要任何被压缩的内容都能凭指针取回逐字原文并还原为合法的 API 消息格式
  否则激进下沉会永久丢信息，而"压了还能找回"正是敢用激进级别的前提

  Background:
    Given 归档存储配置为 JSONL 追加文件并维护内存索引
    And 每条归档记录含 source_hash 用于一致性校验

  Scenario: 凭 archive_ref 取回原文且哈希校验通过
    Given 一段内容已被压缩且其 L0 原文已归档
    When 以该块的 archive_ref 调用 rehydrate
    Then 取回的消息序列与归档前逐字节相同
    And source_hash 校验通过
    And 取回的消息数量与 source_span.msg_count 一致

  Scenario: 取回的原文可无损还原为原始 API 消息格式
    Given 归档记录中保存了每条消息的 raw 原始载荷与 vendor 标记
    When 执行 rehydrate 并回写为 API 请求格式
    Then 回写结果与该消息首次进入会话时的 API 格式结构一致
    And tool_use 与 tool_result 的配对关系保持不变
    And 不因展平为 text 字段而丢失结构化内容

  Scenario: L4 指针块必须可回溯
    Given 一段内容已下沉至 L4
    When 检查其 CompressedBlock
    Then archive_ref 字段非空
    And source_span 含合法的 start_id、end_id 与 msg_count
    And 凭该指针能成功取回完整 L0 原文
    And 指针文本本身占用极少 token，仅说明存在过什么与如何取回

  Scenario: 归档文件只追加不覆盖
    Given 归档文件中已存在若干条历史记录
    When 追加写入新的归档记录
    Then 既有行的内容与字节偏移均不变
    And 内存索引新增对应条目
    And 重复归档同一 source_hash 不产生冗余行

  # 以下四个场景超出规划 §12.5 的四个，补全归档的失效与生命周期路径。
  # 理由：归档不可用、索引丢失、多段共享原文、归档清理这四条若不锁定，
  # 实现可能在归档失败时仍执行有损下沉——那等于永久丢信息，是最严重的一类静默故障。
  Scenario: 归档不可用时禁止有损下沉
    Given 归档文件写入失败或存储不可用
    When 一段内容需从 L1 下沉至 L2 或更低
    Then 拒绝下沉并保持该段停留在当前级别
    And 记录一条 archive-unavailable 告警说明回溯能力缺失
    And 本轮仍允许执行无归档需求的 L1 无损裁剪

  Scenario: 索引丢失时可从 JSONL 全量重建
    Given 内存索引因进程重启而丢失但 JSONL 文件完好
    When 归档模块初始化
    Then 扫描 JSONL 重建 ref 到字节偏移的索引
    And 重建后既有 archive_ref 仍可成功 rehydrate
    And 重建过程不修改 JSONL 文件内容

  Scenario: 哈希不一致时拒绝回溯并报错
    Given 某条归档记录的 source_hash 与其实际内容哈希不一致
    When 以对应 archive_ref 调用 rehydrate
    Then 抛出 ArchiveCorrupted
    And 不返回任何可疑的部分内容
    And 依赖该原文的下沉操作被拒绝执行

  Scenario: 多个压缩块共享同一段原文时各自可独立回溯
    Given 同一段 L0 原文被用于生成 L2 与后续的 L3 摘要
    When 分别以两个块的 archive_ref 调用 rehydrate
    Then 二者取回相同的原文序列
    And 归档中该原文只存储一份不重复占用空间
    And 两个块的 source_span 均指向原始消息 ID 而非彼此的摘要
