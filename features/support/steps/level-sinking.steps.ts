/** `level-sinking.feature` 的步骤定义（铁律一 + 铁律二）。 */

import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { HistoryBuilder } from '../fixtures.js';
import { auditedGoodCompress } from './shared.steps.js';
import { l1Denoise } from '../../../src/levels/l1.js';
import { extractSlots, verifyHardSlots } from '../../../src/levels/l2.js';
import { verifySummary } from '../../../src/verify.js';
import type { CompressedBlock, Message } from '../../../src/contract.js';

const L0_TEXT = '读取 D:\\data\\report.docx 完成：报告包含 42 个章节，附录见 D:\\data\\appendix.docx。';

/** 构造带两个 L2 压缩块的已提交状态（原文已归档，compressCount = 1 < 上限）。 */
async function craftTwoL2Blocks(this: CompressWorld): Promise<void> {
  const msgs = new HistoryBuilder()
    .system()
    .user('开始整理报告')
    .assistant('读取报告', [{ id: 'call-a', name: 'read', args: {} }])
    .tool('call-a', L0_TEXT)
    .assistant('读取附录', [{ id: 'call-b', name: 'read', args: {} }])
    .tool('call-b', 'unrelated gibberish content zzz 12345')
    // 收尾语不与 L0 原文共享任何字符二元组：保证两段增益并列（稳定序 = 原始顺序），
    // 否则 anchor 与原文重叠会触发冗余惩罚，使排序翻转
    .user('确认整理完毕')
    .build();
  this.state = this.buildState(msgs);
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  this.l2Block = null;

  const blocks: CompressedBlock[] = [];
  const blockMsgs: Message[] = [];
  for (const [i, segMsg] of [toolMsgs[0]!, toolMsgs[1]!].entries()) {
    const ref = await this.archive?.archive([segMsg]);
    assert.ok(ref, '归档应成功');
    const text = `摘要块 ${i + 1}`;
    const block: CompressedBlock = {
      id: `cb-l2-${i + 1}`,
      level: 2,
      method: 'llm',
      text,
      sourceSpan: { startId: segMsg.id, endId: segMsg.id, msgCount: 1 },
      archiveRef: ref,
      epoch: 1,
      compressCount: 1,
      tokens: this.config.countTokens(text),
      degraded: false,
    };
    blocks.push(block);
    blockMsgs.push({ id: `cb-${block.id}`, role: 'user', content: text });
  }
  this.l2Block = blocks[0] ?? null;
  // 已提交态：被压缩的原始块消息已被 cb 呈现消息替换，不得残留在 msgs 里
  const replacedIds = new Set(msgs.filter((m) => m.role === 'tool' || (m.role === 'assistant' && m.toolCalls !== undefined)).map((m) => m.id));
  const keptMsgs = msgs.filter((m) => !replacedIds.has(m.id));
  this.state = this.buildState([...keptMsgs, ...blockMsgs], { epoch: 1, compressed: blocks });
}

/** 配置 shouldCompress 恒真 + 审计 compress，跑指定状态一轮。 */
async function runRoundOn(this: CompressWorld, state: NonNullable<CompressWorld['state']>): Promise<void> {
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.lastEpochBefore = state.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(state);
}

/* ---- Background ---- */

Given('一个已配置归档存储的会话', function (this: CompressWorld) {
  this.useMemoryArchive();
  this.makeConfig();
});

Given('下沉次数上限由配置注入', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, sinkLimit: 2 };
  this.makeConfig();
});

/* ---- Scenario: 永远从原文压缩而非从摘要压缩 ---- */

Given('一段内容已下沉至 L2 结构化摘要', async function (this: CompressWorld) {
  await craftTwoL2Blocks.call(this);
  this.l2Block = this.state?.compressed.find((b) => b.id === 'cb-l2-1') ?? null;
  this.compressCalls = 0; // 本轮尚未调用钩子
});

Given('归档中保存其 L0 原文且 source_hash 校验通过', async function (this: CompressWorld) {
  const ref = this.l2Block?.archiveRef;
  assert.ok(ref, 'L2 块应有归档指针');
  const original = await this.archive?.rehydrate(ref);
  assert.ok((original?.length ?? 0) > 0);
});

When('该段需继续下沉至 L3', async function (this: CompressWorld) {
  // 第二轮：预算收紧到 1 → 排名靠前的段拿 1 token（L3），另一段为最低增益（L4）
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  this.callsBeforeResink = this.compressCalls;
  await runRoundOn.call(this, this.lastCommitted ?? this.state!);
});

/** 取本轮提交中新产出的同源块（epoch = 提交 epoch；旧块仍留在 compressed 历史里）。 */
function resunkBlockOf(this: CompressWorld): CompressedBlock | undefined {
  const epoch = this.lastCommitted?.epoch;
  return this.lastCommitted?.compressed.find(
    (b) => b.sourceSpan.startId === this.l2Block?.sourceSpan.startId && b.epoch === epoch,
  );
}

Then('系统经 rehydrate 取回 L0 原文', function (this: CompressWorld) {
  const round2Inputs = this.compressTexts.slice(this.callsBeforeResink);
  assert.ok(round2Inputs.includes(L0_TEXT), `第二轮压缩输入应为 L0 原文，实际：${JSON.stringify(round2Inputs)}`);
});

Then('L3 摘要由 L0 原文生成，输入中不含 L2 摘要文本', function (this: CompressWorld) {
  const round2Inputs = this.compressTexts.slice(this.callsBeforeResink);
  assert.ok(round2Inputs.every((t) => !t.startsWith('摘要块')), '输入不得包含 L2 摘要文本');
});

Then('新 CompressedBlock 的 source_span 指向 L0 原文的消息 ID', function (this: CompressWorld) {
  const resunk = resunkBlockOf.call(this);
  assert.ok(resunk, '再下沉后应存在同源新块');
  assert.equal(resunk.sourceSpan.startId, this.l2Block?.sourceSpan.startId);
  assert.equal(resunk.level, 3);
});

/* ---- Scenario: 下沉次数达上限后停止有损重压 ---- */

Given('一段内容的 compress_count 已等于配置注入的下沉次数上限', async function (this: CompressWorld) {
  const msgs = new HistoryBuilder()
    .system()
    .user('任务')
    .assistant('调用', [{ id: 'call-a', name: 'read', args: {} }])
    .tool('call-a', L0_TEXT)
    .user('收尾')
    .build();
  this.state = this.buildState(msgs);
  const segMsg = msgs.find((m) => m.role === 'tool')!;
  const ref = await this.archive?.archive([segMsg]);
  assert.ok(ref);
  const block: CompressedBlock = {
    id: 'cb-limit',
    level: 2,
    method: 'llm',
    text: '旧摘要文本',
    sourceSpan: { startId: segMsg.id, endId: segMsg.id, msgCount: 1 },
    archiveRef: ref,
    epoch: 1,
    compressCount: 2, // == sinkLimit
    tokens: this.config.countTokens('旧摘要文本'),
    degraded: false,
  };
  this.l2Block = block;
  this.state = this.buildState([...msgs, { id: `cb-${block.id}`, role: 'user', content: block.text }], {
    epoch: 1,
    compressed: [block],
  });
  this.compressCalls = 0;
});

When('再次触发压缩', async function (this: CompressWorld) {
  this.callsBeforeResink = this.compressCalls;
  await runRoundOn.call(this, this.state!);
});

Then('该段直接落 L4 指针且不再调用摘要钩子', function (this: CompressWorld) {
  const resunk = resunkBlockOf.call(this);
  assert.ok(resunk, '应产出替换块');
  assert.equal(resunk.level, 4);
  assert.equal(this.compressCalls, this.callsBeforeResink, '达上限后不得调用摘要钩子');
});

Then('其 compress_count 保持原值不再递增', function (this: CompressWorld) {
  const resunk = resunkBlockOf.call(this);
  assert.equal(resunk?.compressCount, 2);
});

/* ---- Scenario: 级别单调不回退 ---- */

Given('一段内容当前处于 L2', async function (this: CompressWorld) {
  await craftTwoL2Blocks.call(this);
});

When('触发新一轮压缩', async function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  await runRoundOn.call(this, this.lastCommitted ?? this.state!);
});

Then('其 target_level 大于或等于 2', function (this: CompressWorld) {
  const resunk = resunkBlockOf.call(this);
  assert.ok(resunk && resunk.level >= 2, `实际 level=${resunk?.level}`);
});

Then('除非显式 rehydrate，否则不返回 L0 或 L1', function (this: CompressWorld) {
  for (const block of this.lastCommitted?.compressed ?? []) {
    assert.ok(block.level >= 2, `级别 ${block.level} 回退到 L0/L1`);
  }
});

/* ---- Scenario Outline: L1 去噪规则逐项生效（含 L1 子集场景的构造） ---- */

// `\s*`：L1 子集场景的步骤文本无空格（中部内容含重复文件…），Outline 展开后有空格
Given(/中部内容含\s*(.+)$/, function (this: CompressWorld, noise: string) {
  const builder = new HistoryBuilder().system().user('执行任务');
  switch (noise) {
    case '重复文件读取输出与超长 stdout':
    case '同一文件被反复读取产生的重复输出':
      if (noise === '重复文件读取输出与超长 stdout') {
        const long = Array.from({ length: 60 }, (_, i) => `stdout 行 ${i + 1}`).join('\n');
        builder
          .assistant('读配置', [{ id: 'c1', name: 'read', args: {} }])
          .tool('c1', 'config: D:\\app\\config.yaml')
          .assistant('再读配置', [{ id: 'c2', name: 'read', args: {} }])
          .tool('c2', 'config: D:\\app\\config.yaml')
          .assistant('长输出', [{ id: 'c3', name: 'build', args: {} }])
          .tool('c3', long);
      } else {
        builder
          .assistant('读文件', [{ id: 'c1', name: 'read', args: {} }])
          .tool('c1', 'D:\\log\\app.log: line 1')
          .assistant('再读', [{ id: 'c2', name: 'read', args: {} }])
          .tool('c2', 'D:\\log\\app.log: line 1 updated');
      }
      break;
    case '超出长度阈值的单条工具 stdout':
      builder
        .assistant('构建', [{ id: 'c1', name: 'build', args: {} }])
        .tool('c1', Array.from({ length: 60 }, (_, i) => `build line ${i + 1}`).join('\n'));
      break;
    case '连续多次失败且错误文本相同的命令':
      builder
        .assistant('跑命令', [{ id: 'c1', name: 'run', args: {} }])
        .tool('c1', 'Error: npm install failed')
        .assistant('重试', [{ id: 'c2', name: 'run', args: {} }])
        .tool('c2', 'Error: npm install failed');
      break;
    case '已被后续成功结果取代的中间结果':
      // 失败与成功共享同一目标指纹（部署路径），superseded-result 依赖指纹匹配
      builder
        .assistant('测试', [{ id: 'c1', name: 'test', args: {} }])
        .tool('c1', 'deploy D:\\srv\\app: Error: tests failed')
        .assistant('修复后重跑', [{ id: 'c2', name: 'test', args: {} }])
        .tool('c2', 'deploy D:\\srv\\app: All tests passed');
      break;
    default:
      throw new Error(`未知噪声形态：${noise}`);
  }
  builder.user('收尾');
  this.msgs = builder.build();
  this.state = this.buildState(this.msgs);
});

When('执行 L1 去噪裁剪', function (this: CompressWorld) {
  const segMsgs = this.state?.msgs ?? this.msgs;
  const result = l1Denoise(segMsgs, this.config);
  this.l1Result = { text: result.text, rules: [...result.appliedRules] };
});

Then('裁剪结果中每个字符片段均可在原文中定位', function (this: CompressWorld) {
  const original = (this.state?.msgs ?? this.msgs).map((m) => m.content).join('\n');
  for (const line of (this.l1Result?.text ?? '').split('\n')) {
    if (line.trim().length === 0) continue;
    assert.ok(original.includes(line), `行不可定位：${line.slice(0, 30)}`);
  }
});

Then('结果中不存在原文未出现的新字符串', function (this: CompressWorld) {
  const originalChars = new Set((this.state?.msgs ?? this.msgs).map((m) => m.content).join(''));
  for (const ch of this.l1Result?.text ?? '') {
    if (ch === '\n') continue;
    assert.ok(originalChars.has(ch), `出现原文没有的字符：${ch}`);
  }
});

/* ---- Scenario: 被后续引用的工具输出不裁剪 ---- */

Given('某次工具输出的内容在后续轮次被助手显式引用', function (this: CompressWorld) {
  // 同一配置文件读两次：首个输出按 duplicate-read 应被裁剪，
  // 但后续 assistant 显式引用了其指纹（文件路径）→ 触发 referenced-later 保护
  const msgs = new HistoryBuilder()
    .system()
    .user('跑命令')
    .assistant('读配置', [{ id: 'c1', name: 'read', args: {} }])
    .tool('c1', 'config D:\\app\\config.yaml: port=3067')
    .assistant('再读配置', [{ id: 'c2', name: 'read', args: {} }])
    .tool('c2', 'config D:\\app\\config.yaml: port=3067')
    .user('收尾')
    .assistant('确认：使用 D:\\app\\config.yaml 的 port=3067 配置。')
    .build();
  this.msgs = msgs;
  this.state = this.buildState(msgs);
});

Then('该输出被保留', function (this: CompressWorld) {
  assert.ok(this.l1Result?.text.includes('D:\\app\\config.yaml'));
});

Then('保留原因记为 referenced-later', function (this: CompressWorld) {
  assert.ok(this.l1Result?.rules.includes('referenced-later'), `规则：${this.l1Result?.rules.join(',')}`);
});

/* ---- Scenario: 归档损坏时拒绝下沉 ---- */

Given('一段内容的 source_hash 与归档原文哈希不一致', async function (this: CompressWorld) {
  const msgs = new HistoryBuilder()
    .system()
    .user('任务')
    .assistant('调用', [{ id: 'call-a', name: 'read', args: {} }])
    .tool('call-a', L0_TEXT)
    .user('收尾')
    .build();
  this.state = this.buildState(msgs);
  const segMsg = msgs.find((m) => m.role === 'tool')!;
  const ref = await this.archive?.archive([segMsg]);
  assert.ok(ref);
  this.tamperedRef = { ...ref, hash: 'deadbeefdeadbeefdeadbeefdeadbeef' };
  const block: CompressedBlock = {
    id: 'cb-corrupt',
    level: 2,
    method: 'llm',
    text: '可疑摘要',
    sourceSpan: { startId: segMsg.id, endId: segMsg.id, msgCount: 1 },
    archiveRef: this.tamperedRef,
    epoch: 1,
    compressCount: 1,
    tokens: this.config.countTokens('可疑摘要'),
    degraded: false,
  };
  this.state = this.buildState([...msgs, { id: `cb-${block.id}`, role: 'user', content: block.text }], {
    epoch: 1,
    compressed: [block],
  });
});

When('尝试 rehydrate', async function (this: CompressWorld) {
  try {
    await this.archive?.rehydrate(this.tamperedRef!);
  } catch (error) {
    this.lastError = error;
  }
  // 完整流程：损坏块的再下沉必须被拒绝
  await runRoundOn.call(this, this.state!);
});

Then('该段保持当前级别不下沉', function (this: CompressWorld) {
  assert.equal(this.lastCommitted, this.state, '损坏块的再下沉应被拒绝，上下文不变');
});

Then('不生成任何基于可疑原文的新摘要', function (this: CompressWorld) {
  assert.equal(this.lastCommitted?.compressed.length, this.state?.compressed.length);
});

/* ---- Scenario Outline 断言 ---- */

Then('该噪声被裁剪或替换为其在原文中已存在的更短片段', function (this: CompressWorld) {
  const originalLen = this.msgs.map((m) => m.content).join('\n').length;
  assert.ok((this.l1Result?.text.length ?? 0) < originalLen);
});

Then('裁剪结果的字符集是原文字符集的子集', function (this: CompressWorld) {
  const originalChars = new Set(this.msgs.map((m) => m.content).join(''));
  for (const ch of this.l1Result?.text ?? '') {
    if (ch === '\n') continue;
    assert.ok(originalChars.has(ch));
  }
});

Then(/本条裁剪记录命中的规则名为 (.+)$/, function (this: CompressWorld, rule: string) {
  assert.ok(this.l1Result?.rules.includes(rule), `规则：${this.l1Result?.rules.join(',')}，期望 ${rule}`);
});

/* ---- Scenario: L2 摘要的硬槽位必须逐字摘抄原文 ---- */

Given('一段内容下沉至 L2 并生成分槽位摘要', function (this: CompressWorld) {
  const msgs = new HistoryBuilder()
    .system()
    .user('约束：必须使用 UTF-8 编码\n交付物输出到 D:\\out\\demo.docx\n- [ ] 待办：补全测试')
    .toolRound('read_file', 'plain output')
    .user('收尾')
    .build();
  this.msgs = msgs;
  this.state = this.buildState(msgs);
  this.slots = extractSlots(msgs);
  this.originalText = msgs.map((m) => m.content).join('\n');
});

When('校验槽位内容', function (this: CompressWorld) {
  this.slotMissing = verifyHardSlots(this.slots!, this.originalText!);
});

Then('constraints、artifacts、todos 三个槽位的每条取值均可在原文中逐字定位', function (this: CompressWorld) {
  assert.equal(this.slotMissing?.length, 0, `缺失：${this.slotMissing?.join(';')}`);
});

Then('仅 narrative 槽位允许出现原文中不存在的改写文本', function (this: CompressWorld) {
  const report = verifySummary(this.originalText!, '叙述改写', this.slots!, this.config);
  assert.equal(report.passed, true);
});

/* ---- Scenario: 无归档能力时禁止执行有损下沉 ---- */

Given('归档存储不可用或写入失败', function (this: CompressWorld) {
  this.sink = {
    append: async () => {
      throw new Error('disk full');
    },
    read: async () => null,
    // 注意：readAll 是方法（返回异步生成器），不能写成立即调用的生成器对象
    readAll: () => (async function* () {})() as never,
    available: async () => false,
  };
  this.makeConfig();
});

When('一段内容需从 L1 下沉至 L2', async function (this: CompressWorld) {
  // 输出不含路径/URL/待办等 pin 触发实体，保证该块能进入压缩候选
  const msgs = new HistoryBuilder()
    .system()
    .user('任务')
    .toolRound('read_file', 'plain sample output line one\nplain sample output line two')
    .user('收尾')
    .build();
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  await runRoundOn.call(this, this.buildState(msgs));
});

Then('拒绝下沉并保持该段停留在 L1', function (this: CompressWorld) {
  const block = this.lastCommitted?.compressed[0];
  assert.ok(block, '应回退产出 L1 结果');
  const original = this.state?.msgs.map((m) => m.content).join('\n') ?? '';
  for (const line of block.text.split('\n')) {
    if (line.trim().length === 0) continue;
    assert.ok(original.includes(line), 'L1 文本必须是原文子集');
  }
});

Then('记录一条 archive-unavailable 告警说明原因是回溯能力缺失', function (this: CompressWorld) {
  assert.ok((this.metrics['archive-unavailable'] ?? 0) >= 1);
});
