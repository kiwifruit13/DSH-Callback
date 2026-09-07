/** `pin-protection.feature` 的步骤定义（§3 + §5）。 */

import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { HistoryBuilder } from '../fixtures.js';
import { auditedGoodCompress, assertReasonsInEnum } from './shared.steps.js';
import { verifyEntities } from '../../../src/verify.js';
import { selectSegment } from '../../../src/blocks.js';
import { resolvePins } from '../../../src/pins.js';
import type { Message } from '../../../src/contract.js';

/* ---- Background ---- */

Given('一个已解析出头部、中部与尾部的会话', function (this: CompressWorld) {
  this.msgs = new HistoryBuilder()
    .system()
    .user('初始任务说明')
    .toolRound('read_file', 'file content here')
    .user('继续任务')
    .assistant('任务进行中。')
    .build();
  this.state = this.buildState(this.msgs);
});

Given('pin 白名单识别器已启用', function (this: CompressWorld) {
  // 静态白名单始终生效；本步骤确保配置已就绪
  this.makeConfig();
});

/** 在会话早期插入含指定文本的用户消息并登记受保护消息 ID。 */
function seedProtectedMsg(this: CompressWorld, text: string): void {
  const msgs: Message[] = new HistoryBuilder()
    .system()
    .user(text)
    .toolRound('read_file', 'some output')
    .user('后续指令')
    .assistant('好的。')
    .build();
  this.msgs = msgs;
  this.state = this.buildState(msgs);
  this.pinnedMsgId = msgs.find((m) => m.content.includes(text))?.id ?? null;
}

/* ---- Scenario: 用户硬约束逐字节不变 ---- */

Given('会话早期用户消息含文本 {string}', function (this: CompressWorld, text: string) {
  seedProtectedMsg.call(this, text);
});

When('执行任意级别的压缩', function (this: CompressWorld) {
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.state = this.state ?? this.buildState(this.msgs);
  this.lastEpochBefore = this.state.epoch;
  return this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  })
    .maybeCompress(this.state)
    .then((result) => {
      this.lastCommitted = result;
    });
});

Then('该消息被 pin', function (this: CompressWorld) {
  assert.ok(this.lastCommitted?.pins.some((p) => p.msgId === this.pinnedMsgId), '受保护消息应被 pin');
});

Then('压缩后其文本与原消息逐字节相同', function (this: CompressWorld) {
  const original = this.state?.msgs.find((m) => m.id === this.pinnedMsgId);
  const after = this.lastCommitted?.msgs.find((m) => m.id === this.pinnedMsgId);
  assert.ok(original && after);
  assert.equal(after.content, original.content);
});

/* ---- Scenario: 交付物绝对路径完整保留 ---- */

Given('一条消息含 Windows 绝对路径 {string}', function (this: CompressWorld, winPath: string) {
  seedProtectedMsg.call(this, `结果保存到 ${winPath}`);
  this.winPath = winPath;
});

Then('该路径在压缩结果中逐字符存在', function (this: CompressWorld) {
  const joined = this.lastCommitted?.msgs.map((m) => m.content).join('\n') ?? '';
  assert.ok(joined.includes(this.winPath as string));
});

Then('路径类实体保留率为 1.0', function (this: CompressWorld) {
  const original = this.state?.msgs.map((m) => m.content).join('\n') ?? '';
  const after = this.lastCommitted?.msgs.map((m) => m.content).join('\n') ?? '';
  const report = verifyEntities(original, after, this.config);
  assert.equal(report.entityRetain['windows-path'], 1.0);
});

/* ---- Scenario: 权限确认记录可被追溯 ---- */

Given('会话中存在用户对高风险操作的批准记录', function (this: CompressWorld) {
  seedProtectedMsg.call(this, '我批准执行删除操作，可以执行。');
});

Then('该记录被 pin 且 pin_reason 为 permission-grant', function (this: CompressWorld) {
  assert.ok(this.lastCommitted?.pins.some((p) => p.reason === 'permission-grant'));
});

Then('依据压缩后的上下文仍能判定该操作已获批准', function (this: CompressWorld) {
  const joined = this.lastCommitted?.msgs.map((m) => m.content).join('\n') ?? '';
  assert.ok(joined.includes('批准'));
});

/* ---- Scenario: 未完成待办 pin，已完成待办可下沉 ---- */

Given('存在一条状态为 pending 的待办与一条状态为 completed 的待办', function (this: CompressWorld) {
  const msgs: Message[] = new HistoryBuilder()
    .system()
    .user('- [ ] 待办：修复登录问题\n- [x] 待办：整理文档')
    .toolRound('read_file', 'repo output')
    .user('继续')
    .assistant('好的。')
    .build();
  this.msgs = msgs;
  this.state = this.buildState(msgs);
});

Then('pending 待办被 pin 且 pin_reason 为 open-todo', function (this: CompressWorld) {
  assert.ok(this.lastCommitted?.pins.some((p) => p.reason === 'open-todo' && p.text.includes('[ ]')));
});

Then('completed 待办允许下沉至 L2 的 todos 槽位', function (this: CompressWorld) {
  assert.ok(this.lastCommitted?.pins.every((p) => !p.text.includes('[x]')), '已完成待办不应被 pin');
});

/* ---- Scenario: 每条 pin 携带可审计理由 ---- */

When('完成一轮压缩', function (this: CompressWorld) {
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.lastEpochBefore = this.state?.epoch ?? 0;
  return this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  })
    .maybeCompress(this.state ?? this.buildState(this.msgs))
    .then((result) => {
      this.lastCommitted = result;
    });
});

Then('每个 pin 的 pin_reason 字段均非空', function (this: CompressWorld) {
  this.pins = [...(this.lastCommitted?.pins ?? [])];
  assert.ok(this.pins.length > 0);
  assert.ok(this.pins.every((p) => p.reason.length > 0));
});

Then('全部 pin_reason 取值属于既定枚举集合', function (this: CompressWorld) {
  assertReasonsInEnum(this);
});

/* ---- Scenario: pin 豁免于增益计算 ---- */

Given('某段内容已被 pin', function (this: CompressWorld) {
  const text = '必须在原文件上原地修改';
  seedProtectedMsg.call(this, text);
  // 把静态识别结果写回状态，切割层据此剔除 pin 消息
  const { pins } = resolvePins(this.state!, this.config);
  this.pins = [...pins];
  this.state = this.buildState(this.msgs, { pins });
});

Then('该段不参与增益评分', function (this: CompressWorld) {
  // pin 消息在切割前已被剔除：任何段都不包含它
  const segments = selectSegment(this.state!, this.config);
  this.segments = segments;
  assert.ok(segments.every((seg) => !seg.msgIds.includes(this.pinnedMsgId ?? '')));
});

Then('该段不占用中部预算且 target_level 恒为 0（逐字保留）', function (this: CompressWorld) {
  const after = this.lastCommitted ?? this.state;
  const original = this.state?.msgs.find((m) => m.id === this.pinnedMsgId);
  const kept = after?.msgs.find((m) => m.id === this.pinnedMsgId);
  assert.ok(original && kept && kept.content === original.content, 'pin 内容逐字保留（target_level 0）');
});

/* ---- Scenario Outline: 各类受保护内容被识别为对应 pin 理由 ---- */

Given(/会话中存在一条 (.+)$/, function (this: CompressWorld, shape: string) {
  const builder = new HistoryBuilder().system().user('普通开场');
  let msgs: Message[];
  switch (shape) {
    case '系统提示消息':
      msgs = builder.toolRound('read_file', 'output').user('收尾').build();
      this.pinnedMsgId = msgs[0]?.id ?? null;
      break;
    case '用户最新一轮的原始需求文本':
      msgs = builder.toolRound('read_file', 'output').user('最新的完整需求描述').build();
      this.pinnedMsgId = msgs[msgs.length - 1]?.id ?? null;
      break;
    case '用户消息含 "记住" 或 "以后都要" 字样':
      msgs = builder.user('记住：以后都要先跑测试').toolRound('read_file', 'output').user('收尾').build();
      this.pinnedMsgId = msgs.find((m) => m.content.includes('记住'))?.id ?? null;
      break;
    case '尚未被后续成功输出取代的关键报错行':
      msgs = builder.toolRound('run_cmd', 'Error: connection refused to 127.0.0.1:3067').user('收尾').build();
      this.pinnedMsgId = msgs.find((m) => m.content.includes('Error'))?.id ?? null;
      break;
    default:
      throw new Error(`未知内容形态：${shape}`);
  }
  this.msgs = msgs;
  this.state = this.buildState(msgs);
});

Then(/该内容被 pin 且 pin_reason 为 (.+)$/, function (this: CompressWorld, reason: string) {
  assert.ok(
    this.pins.some((p) => p.msgId === this.pinnedMsgId && p.reason === reason),
    `期望 ${reason}，实际：${JSON.stringify(this.pins)}`,
  );
});

/* ---- Scenario: 仅 pin 消息内的关键片段而非整条长消息 ---- */

Given('一条超长用户消息，其中仅有一句包含交付物绝对路径', function (this: CompressWorld) {
  const filler = Array.from({ length: 12 }, (_, i) => `填充句 ${i + 1}：这里没有任何关键信息。`).join('\n');
  const text = `${filler}\n交付物输出到 D:\\out\\final-report.docx`;
  seedProtectedMsg.call(this, text);
});

Then('该消息产生的 pin 携带 span 字段指向含路径的字符区间', function (this: CompressWorld) {
  const spanPins = this.pins.filter((p) => p.msgId === this.pinnedMsgId && p.span !== undefined);
  assert.ok(spanPins.length > 0, '应有 span 局部 pin');
  assert.ok(spanPins.every((p) => p.text.includes('D:')));
});

Then('该消息中 span 之外的内容仍可下沉至 L2 或更低级别', function (this: CompressWorld) {
  // span pin 只锁定片段：该消息本体不在 pins 的整条保护名单里即可继续下沉
  const fullPins = this.pins.filter((p) => p.msgId === this.pinnedMsgId && p.span === undefined);
  assert.equal(fullPins.length, 0);
});

/* ---- Scenario: on_pre_compress 抛异常时退回静态白名单 ---- */

Given('已注入的 on_pre_compress 钩子会抛出异常', function (this: CompressWorld) {
  this.hookOverrides.onPreCompress = () => {
    throw new Error('pin hook exploded');
  };
  this.state = this.state ?? this.buildState(this.msgs);
});

Then('压缩不中断且使用静态 pin 白名单继续', function (this: CompressWorld) {
  assert.notEqual(this.lastCommitted, this.state, '压缩应继续而非中止');
  assert.ok((this.lastCommitted?.pins.length ?? 0) > 0, '静态白名单 pin 应生效');
});

Then('本轮指标记录一条 pin_hook_degraded 告警', function (this: CompressWorld) {
  assert.ok((this.metrics['pin_hook_degraded'] ?? 0) >= 1);
});

/* ---- Scenario: 重复识别同一内容不产生重复 pin ---- */

Given('同一条消息同时命中 deliverable-path 与 latest-user-intent 两种识别信号', function (this: CompressWorld) {
  // 最新一条用户消息 = latest-user-intent，同时含 Windows 绝对路径 = deliverable-path
  const msgs: Message[] = new HistoryBuilder()
    .system()
    .toolRound('read_file', 'output')
    .user('把最终报告写到 D:\\out\\summary.docx')
    .build();
  this.msgs = msgs;
  this.state = this.buildState(msgs);
  this.pinnedMsgId = msgs[msgs.length - 1]?.id ?? null;
});

Then('该消息仅产生一条 pin 记录', function (this: CompressWorld) {
  const mine = this.pins.filter((p) => p.msgId === this.pinnedMsgId);
  assert.equal(mine.length, 1, `期望 1 条 pin，实际 ${mine.length}`);
});

Then('其 pin_reason 取优先级更高的那一种', function (this: CompressWorld) {
  assert.equal(this.pins.find((p) => p.msgId === this.pinnedMsgId)?.reason, 'deliverable-path');
});
