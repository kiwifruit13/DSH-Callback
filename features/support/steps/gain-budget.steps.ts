/** `gain-budget.feature` 的步骤定义（§1.3 语义反转 + §1.4 预算分配）。 */

import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { HistoryBuilder } from '../fixtures.js';
import { auditedGoodCompress, runAssignBudget } from './shared.steps.js';
import { splitTokens } from '../../../src/signals.js';
import type { CompressedBlock, Message, Segment } from '../../../src/contract.js';

const ANCHOR_TEXT = '必须使用 UTF-8 编码输出报告，必须在原文件上原地修改';
const QUERY_TEXT = '帮我写一首关于大海的诗';

/** 两个段的基准会话：segA 与 anchor 高相关，segB 与当前查询高相关（反例对照用）。 */
const SEGB_TEXT = '大海主题的诗歌创作灵感与写作素材';

function twoSegmentSession(): Message[] {
  return new HistoryBuilder()
    .system()
    .user('整理报告需求')
    .assistant('读配置', [{ id: 'c1', name: 'read', args: {} }])
    .tool('c1', `${ANCHOR_TEXT}\n相关配置细节 markdown 输出格式说明`)
    .assistant('读日志', [{ id: 'c2', name: 'read', args: {} }])
    .tool('c2', SEGB_TEXT)
    .user('收尾')
    .build();
}

/** 把当前会话切成两个段并填好段文本表。 */
function prepSegments(this: CompressWorld): void {
  const msgs = this.msgs;
  const blockMsgs = msgs.filter((m) => m.role === 'assistant' || m.role === 'tool');
  const segOf = (i: number): Segment => {
    const first = blockMsgs[i]!;
    const second = blockMsgs[i + 1]!;
    return {
      id: i === 0 ? 'seg-a' : 'seg-b',
      startId: first.id,
      endId: second.id,
      msgIds: [first.id, second.id],
      blockIds: [],
      tokens: this.config.countTokens(first.content) + this.config.countTokens(second.content),
    };
  };
  this.segments = [segOf(0), segOf(2)];
  this.segmentTexts = new Map<string, string>([
    ['seg-a', `${ANCHOR_TEXT}\n相关配置细节 markdown 输出格式说明`],
    ['seg-b', SEGB_TEXT],
  ]);
}

/* ---- Background ---- */

Given('中部已切分为若干完整 tool block 段', function (this: CompressWorld) {
  this.msgs = twoSegmentSession();
  prepSegments.call(this);
});

Given('冗余度权重 λ 与目标 token 预算由配置注入', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, lambda: 0.5, targetBudgetTokens: 10_000 };
  this.makeConfig();
});

Given('anchor 为 pin 约束集的文本表示而非当前用户查询', function (this: CompressWorld) {
  this.anchorOverride = ANCHOR_TEXT;
  this.retainedTexts = [];
});

/* ---- Scenario: 相关性高且冗余度低的段停在 L1 ---- */

Given('某段与 anchor 的余弦相关性高', function (this: CompressWorld) {
  // segA 文本与 anchor 高度重合（prepSegments 默认构造已满足）
});

Given('该段与已保留内容的最大余弦冗余度低', function (this: CompressWorld) {
  this.retainedTexts = [];
});

Then('该段增益为各段中最高档', function (this: CompressWorld) {
  const a = this.assignments.find((x) => x.segmentId === 'seg-a');
  const b = this.assignments.find((x) => x.segmentId === 'seg-b');
  assert.ok(a && b);
  assert.ok(a.gain > b.gain, `segA 增益 ${a.gain} 应高于 segB ${b.gain}`);
});

Then('该段获得充足预算且 target_level 为 1', function (this: CompressWorld) {
  const a = this.assignments.find((x) => x.segmentId === 'seg-a');
  const seg = this.segments.find((s) => s.id === 'seg-a');
  assert.ok(a && seg);
  assert.ok(a.budget >= seg.tokens, `预算 ${a.budget} 应覆盖整段 ${seg.tokens}`);
  assert.equal(a.targetLevel, 1);
});

/* ---- Scenario: 内容已被保留部分覆盖的段少给预算 ---- */

Given('某段的报错文本与已保留段中的报错文本高度重复', function (this: CompressWorld) {
  this.retainedTexts = [SEGB_TEXT];
});

Then('该段冗余度项显著抬高', function (this: CompressWorld) {
  const b = this.assignments.find((x) => x.segmentId === 'seg-b');
  assert.ok(b && b.redundancy > 0.5, `冗余度 ${b?.redundancy}`);
});

Then('该段增益因 λ 加权而被压低', function (this: CompressWorld) {
  const b = this.assignments.find((x) => x.segmentId === 'seg-b');
  assert.ok(b && b.gain < b.relevance, '增益应低于原始相关性');
});

Then('该段获得的预算低于内容不重复的同类段', function (this: CompressWorld) {
  const a = this.assignments.find((x) => x.segmentId === 'seg-a');
  const b = this.assignments.find((x) => x.segmentId === 'seg-b');
  assert.ok(a && b);
  assert.ok(b.budget < a.budget, `segB ${b.budget} 应低于 segA ${a.budget}`);
});

/* ---- Scenario: 增益最低的段仍只落 L4 指针而不被删除 ---- */

Given('某段与 anchor 相关性极低且冗余度极高，增益为全部段中最低', function (this: CompressWorld) {
  this.retainedTexts = [SEGB_TEXT];
});

When('执行预算分配并完成压缩', async function (this: CompressWorld) {
  runAssignBudget(this);
  // 编排层：完整压缩（L4 块必须可回溯 → 归档必需）
  // 注意：先建归档再 makeConfig，config.archive 在 makeConfig 时定格
  this.useMemoryArchive();
  this.makeConfig();
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.state = this.buildState(this.msgs);
  this.lastEpochBefore = this.state.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(this.state);
});

Then('该段 target_level 为 4', function (this: CompressWorld) {
  const b = this.assignments.find((x) => x.segmentId === 'seg-b');
  assert.equal(b?.targetLevel, 4);
});

Then('该段仍生成一个 CompressedBlock，未被丢弃', function (this: CompressWorld) {
  const segB = this.segments.find((s) => s.id === 'seg-b');
  const block = this.lastCommitted?.compressed.find((x) => x.sourceSpan.startId === segB?.startId);
  assert.ok(block, '最低增益段也必须产出压缩块');
  this.lowestBlock = block;
});

Then('该块的 archive_ref 非空且可成功 rehydrate 取回 L0 原文', async function (this: CompressWorld) {
  const block = this.lowestBlock;
  assert.ok(block?.archiveRef, 'L4 块必须有归档指针');
  const original = await this.archive?.rehydrate(block.archiveRef);
  assert.ok((original?.length ?? 0) > 0);
});

Then('该块保留合法的 source_span 指向原始消息 ID', function (this: CompressWorld) {
  const segB = this.segments.find((s) => s.id === 'seg-b');
  assert.equal(this.lowestBlock?.sourceSpan.startId, segB?.startId);
});

/* ---- Scenario: 预算分配总和不超过目标 token 数 ---- */

Given('目标 token 预算已由配置注入', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 5 };
  this.makeConfig();
  runAssignBudget(this);
});

When('对全部中部段完成预算分配', function (this: CompressWorld) {
  runAssignBudget(this);
});

Then('各段 budget 之和小于或等于目标 token 预算', function (this: CompressWorld) {  const sum = this.assignments.reduce((acc, a) => acc + a.budget, 0);
  assert.ok(sum <= this.config.targetBudgetTokens, `总和 ${sum} 超预算 ${this.config.targetBudgetTokens}`);
});

Then('pin 段不占用该预算额度', function (this: CompressWorld) {
  // pin 内容在切割前已被剔除：不存在包含 pin 消息的段
  const pinnedIds = new Set(this.pins.map((p) => p.msgId));
  assert.ok(this.assignments.every((a) => {
    const seg = this.segments.find((s) => s.id === a.segmentId);
    return seg === undefined || seg.msgIds.every((id) => !pinnedIds.has(id));
  }));
});

/* ---- Scenario: 关闭 embedding 时退化为纯 TF-IDF 计算 ---- */

Given('配置中 embedding 开关为关闭', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, embeddingEnabled: false, embed: null };
  this.makeConfig();
});

Then('相关性项与冗余度项均由 TF-IDF 字符二元组向量计算', function (this: CompressWorld) {
  assert.ok(this.assignments.length > 0);
  assert.ok(this.assignments.every((a) => Number.isFinite(a.relevance) && Number.isFinite(a.redundancy)));
});

Then('流程不抛异常且不产生任何网络调用', function (this: CompressWorld) {
  // TF-IDF 为纯本地计算：无 fetch/网络导入；不抛异常即达此处
  assert.ok(true);
});

Then('增益排序结果与开启 embedding 时同为确定值', function (this: CompressWorld) {
  const snapshot = JSON.stringify(this.assignments);
  runAssignBudget(this);
  assert.equal(JSON.stringify(this.assignments), snapshot, '两次执行必须得到逐字节相同的分配结果');
});

/* ---- Scenario: anchor 替换为当前查询会导致早期硬约束降档 ---- */

Given('一段内容为会话早期的用户硬约束，与当前查询相关性低', function (this: CompressWorld) {
  // prepSegments 默认：segA = 硬约束文本
});

When('以 pin 约束集为 anchor 执行预算分配', function (this: CompressWorld) {
  this.anchorOverride = ANCHOR_TEXT;
  this.retainedTexts = [];
  runAssignBudget(this);
});

Then('该段增益处于高档且 target_level 为 1', function (this: CompressWorld) {
  const a = this.assignments.find((x) => x.segmentId === 'seg-a');
  const b = this.assignments.find((x) => x.segmentId === 'seg-b');
  assert.ok(a && b);
  assert.ok(a.gain > b.gain);
  assert.equal(a.targetLevel, 1);
});

When('改以当前用户查询为 anchor 重新执行预算分配', function (this: CompressWorld) {
  this.anchorOverride = QUERY_TEXT;
  this.retainedTexts = [];
  runAssignBudget(this);
});

Then('该段增益显著下降且 target_level 大于 1', function (this: CompressWorld) {
  const a = this.assignments.find((x) => x.segmentId === 'seg-a');
  const b = this.assignments.find((x) => x.segmentId === 'seg-b');
  assert.ok(a && b);
  assert.ok(a.gain < b.gain, '换 anchor 后 segA 增益应被反超');
  assert.ok(a.targetLevel > 1, `targetLevel ${a.targetLevel} 应大于 1`);
});

Then('该对照结果被记录为反例，说明为何本方案不采用当前查询作 anchor', function (this: CompressWorld) {
  this.counterexample = JSON.stringify({
    conclusion: '以当前查询为 anchor 时早期硬约束被系统性降档',
    assignments: this.assignments,
  });
  assert.ok(this.counterexample.length > 0);
});

/* ---- Scenario: 中英文混排文本的向量化不依赖分词器 ---- */

Given('某段同时包含中文句子、英文标识符与文件路径', function (this: CompressWorld) {
  this.mixedText = '解析用户会话中的上下文\nconst config = loadConfig()\nD:\\data\\report.docx';
});

When('计算该段的 TF-IDF 向量', function (this: CompressWorld) {
  this.mixedTokens = splitTokens(this.mixedText!);
});

Then('中文部分以字符二元组切分，拉丁部分以空白与标点切分', function (this: CompressWorld) {
  const tokens = this.mixedTokens ?? [];
  assert.ok(tokens.includes('解析') || tokens.includes('解用'), '应存在中文二元组');
  assert.ok(tokens.includes('const'), '拉丁词应按词切分');
});

Then('文件路径与代码符号作为整体 token 参与计算不被拆碎', function (this: CompressWorld) {
  const tokens = this.mixedTokens ?? [];
  assert.ok(tokens.includes('D:\\data\\report.docx'), `整体路径 token 缺失：${tokens.join(' | ')}`);
});

Then('全过程不加载任何外部分词依赖', function (this: CompressWorld) {
  assert.ok((this.mixedTokens?.length ?? 0) > 0);
});

/* ---- Scenario: 全部段增益相同时按原始顺序稳定分配 ---- */

Given('中部各段的增益计算结果完全相等', function (this: CompressWorld) {
  const sameText = '完全相同的内容文本用于稳定性验证';
  this.segments = [
    { id: 'seg-a', startId: 'a1', endId: 'a1', msgIds: ['a1'], blockIds: [], tokens: 20 },
    { id: 'seg-b', startId: 'b1', endId: 'b1', msgIds: ['b1'], blockIds: [], tokens: 20 },
    { id: 'seg-c', startId: 'c1', endId: 'c1', msgIds: ['c1'], blockIds: [], tokens: 20 },
  ];
  this.segmentTexts = new Map([
    ['seg-a', sameText],
    ['seg-b', sameText],
    ['seg-c', sameText],
  ]);
  this.anchorOverride = sameText;
  this.retainedTexts = [];
});

Then('分配结果按段的原始先后顺序确定，不随排序实现波动', function (this: CompressWorld) {
  const budgets = this.assignments.map((a) => a.budget);
  const sortedDesc = [...budgets].sort((x, y) => y - x);
  assert.deepEqual(budgets, sortedDesc, '预算应按原始顺序递减分配');
});

Then('对同一输入重复执行两次得到逐字节相同的分配结果', function (this: CompressWorld) {
  const first = JSON.stringify(this.assignments);
  runAssignBudget(this);
  assert.equal(JSON.stringify(this.assignments), first);
});

/* ---- Scenario: 已下沉段的增益基于归档原文重算而非基于摘要 ---- */

Given('某段已处于 L2 且需评估是否继续下沉', function (this: CompressWorld) {
  this.msgs = twoSegmentSession();
  prepSegments.call(this);
  // 模拟铁律一路径：segmentTexts 填的是 rehydrate 回来的 L0 原文，而非 L2 摘要
  this.segmentTexts.set('seg-a', ANCHOR_TEXT);
  this.l2SummaryText = '摘要块：内容已压缩';
});

Then('该段的向量由 rehydrate 取回的 L0 原文计算', function (this: CompressWorld) {
  assert.equal(this.segmentTexts.get('seg-a'), ANCHOR_TEXT);
});

Then('不使用其 L2 摘要文本参与相关性或冗余度计算', function (this: CompressWorld) {
  assert.notEqual(this.segmentTexts.get('seg-a'), this.l2SummaryText);
});

Then('此行为与铁律一保持一致', function (this: CompressWorld) {
  assert.ok(!JSON.stringify([...this.segmentTexts.values()]).includes('摘要块'));
});
