# 守护：§1.4 预算分配算法 + §1.3 相关性 anchor 语义反转｜对应：src/gain.ts, src/signals.ts
# 本特性最关键的一条是"增益最低的一段仍不被删除"，它专门守护语义反转
@gain @budget
Feature: 信息增益预算分配

  作为 Agent 运行时的上下文管理者
  我需要按"对既有硬约束的贡献"而非"对当前查询的贴合度"来分配压缩预算
  否则用户早期提出的硬约束会因与当前轮次相关性低而被系统性误删

  Background:
    Given 中部已切分为若干完整 tool block 段
    And 冗余度权重 λ 与目标 token 预算由配置注入
    And anchor 为 pin 约束集的文本表示而非当前用户查询

  Scenario: 相关性高且冗余度低的段停在 L1
    Given 某段与 anchor 的余弦相关性高
    And 该段与已保留内容的最大余弦冗余度低
    When 执行预算分配
    Then 该段增益为各段中最高档
    And 该段获得充足预算且 target_level 为 1

  Scenario: 内容已被保留部分覆盖的段少给预算
    Given 某段的报错文本与已保留段中的报错文本高度重复
    When 执行预算分配
    Then 该段冗余度项显著抬高
    And 该段增益因 λ 加权而被压低
    And 该段获得的预算低于内容不重复的同类段

  # 本特性最重要的一条：直接锁定 §1.3 的语义反转。
  # "相关性低 ≠ 可以删"，低增益只能降粒度，不能降为不存在。
  Scenario: 增益最低的段仍只落 L4 指针而不被删除
    Given 某段与 anchor 相关性极低且冗余度极高，增益为全部段中最低
    When 执行预算分配并完成压缩
    Then 该段 target_level 为 4
    And 该段仍生成一个 CompressedBlock，未被丢弃
    And 该块的 archive_ref 非空且可成功 rehydrate 取回 L0 原文
    And 该块保留合法的 source_span 指向原始消息 ID

  Scenario: 预算分配总和不超过目标 token 数
    Given 目标 token 预算已由配置注入
    When 对全部中部段完成预算分配
    Then 各段 budget 之和小于或等于目标 token 预算
    And pin 段不占用该预算额度

  Scenario: 关闭 embedding 时退化为纯 TF-IDF 计算
    Given 配置中 embedding 开关为关闭
    When 执行预算分配
    Then 相关性项与冗余度项均由 TF-IDF 字符二元组向量计算
    And 流程不抛异常且不产生任何网络调用
    And 增益排序结果与开启 embedding 时同为确定值

  # 以下四个场景超出规划 §12.5 的五个，补全 anchor 语义反转与算法退化路径。
  # 理由：§1.3 是本方案区别于 DSPC/COMI/APCE 的核心主张，但原清单只从"低增益不删"单向验证；
  # 若不同时验证"anchor 换了之后排序确实随之改变"，实现可能仍悄悄用当前 query 当 anchor 而测试照样通过。
  Scenario: anchor 替换为当前查询会导致早期硬约束降档
    Given 一段内容为会话早期的用户硬约束，与当前查询相关性低
    When 以 pin 约束集为 anchor 执行预算分配
    Then 该段增益处于高档且 target_level 为 1
    # 反向对照：证明 anchor 的选择确实影响结果，而非无关变量
    When 改以当前用户查询为 anchor 重新执行预算分配
    Then 该段增益显著下降且 target_level 大于 1
    And 该对照结果被记录为反例，说明为何本方案不采用当前查询作 anchor

  Scenario: 中英文混排文本的向量化不依赖分词器
    Given 某段同时包含中文句子、英文标识符与文件路径
    When 计算该段的 TF-IDF 向量
    Then 中文部分以字符二元组切分，拉丁部分以空白与标点切分
    And 文件路径与代码符号作为整体 token 参与计算不被拆碎
    And 全过程不加载任何外部分词依赖

  Scenario: 全部段增益相同时按原始顺序稳定分配
    Given 中部各段的增益计算结果完全相等
    When 执行预算分配
    Then 分配结果按段的原始先后顺序确定，不随排序实现波动
    And 对同一输入重复执行两次得到逐字节相同的分配结果

  Scenario: 已下沉段的增益基于归档原文重算而非基于摘要
    Given 某段已处于 L2 且需评估是否继续下沉
    When 执行预算分配
    Then 该段的向量由 rehydrate 取回的 L0 原文计算
    And 不使用其 L2 摘要文本参与相关性或冗余度计算
    And 此行为与铁律一保持一致
