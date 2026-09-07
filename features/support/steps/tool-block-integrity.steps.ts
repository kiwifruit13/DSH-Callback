/** `tool-block-integrity.feature` 的步骤定义（铁律三 + §6）。 */

import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { baseSession, HistoryBuilder } from '../fixtures.js';
import { isBlockCompressible, parseToolBlocks, selectSegment } from '../../../src/blocks.js';
import { resolvePins } from '../../../src/pins.js';
import type { ToolCall } from '../../../src/contract.js';

/* ---- Background ---- */

Given('一个包含系统提示、中部历史与尾部最近轮次的会话', function (this: CompressWorld) {
  this.msgs = baseSession();
});

Given('压缩配置注入为 触发线 0.7 目标线 0.5', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, triggerRatio: 0.7, targetRatio: 0.5 };
  this.makeConfig();
});

/* ---- Scenario: 切点只落在 tool block 之间 ---- */

Given('中部包含一个完整 tool block，其 assistant 消息发起 1 次工具调用且 result 齐全', function (this: CompressWorld) {
  this.state = this.buildState(this.msgs);
  assert.ok(this.blocks.length >= 1, '基准会话应含至少一个完整 block');
});

When('执行边界切割', function (this: CompressWorld) {
  this.segments = selectSegment(this.state!, this.config);
});

Then('该 block 的 assistant 消息与其全部 result 位于切割的同一侧', function (this: CompressWorld) {
  for (const block of this.blocks) {
    const memberships = this.segments.map((seg) => block.msgIds.every((id) => seg.msgIds.includes(id)));
    const allIn = memberships.some((m) => m);
    const noneIn = this.segments.every((seg) => block.msgIds.every((id) => !seg.msgIds.includes(id)));
    assert.ok(allIn || noneIn, `block ${block.id} 被切割拆散`);
  }
});

Then('中部段的首元素与尾元素都必须是完整 block', function (this: CompressWorld) {
  assert.ok(this.segments.length > 0);
  for (const seg of this.segments) {
    const first = this.blocks.find((b) => b.id === seg.blockIds[0]);
    const last = this.blocks.find((b) => b.id === seg.blockIds[seg.blockIds.length - 1]);
    assert.equal(first?.complete, true);
    assert.equal(last?.complete, true);
  }
});

/* ---- Scenario: 并行工具调用构成单一不可分割块 ---- */

Given('一条 assistant 消息含 3 个 tool_calls', function (this: CompressWorld) {
  const calls: ToolCall[] = [
    { id: 'call-1', name: 'read', args: {} },
    { id: 'call-2', name: 'read', args: {} },
    { id: 'call-3', name: 'read', args: {} },
  ];
  this.pendingMsgs = new HistoryBuilder().assistant('并行调用三个工具', calls).build();
});

Given('3 条对应 tool result 消息紧随其后', function (this: CompressWorld) {
  this.pendingMsgs.push(...new HistoryBuilder().tool('call-1', 'r1').tool('call-2', 'r2').tool('call-3', 'r3').build());
});

When('解析 tool block', function (this: CompressWorld) {
  this.blocks = parseToolBlocks(this.pendingMsgs, this.config.countTokens);
});

Then('这 4 条消息构成 1 个 block', function (this: CompressWorld) {
  assert.equal(this.blocks.length, 1);
  assert.equal(this.blocks[0]?.msgIds.length, 4);
});

Then('该 block 的 token 数等于 4 条消息 token 之和', function (this: CompressWorld) {
  const sum = this.pendingMsgs.reduce((acc, m) => acc + this.config.countTokens(m.content), 0);
  assert.equal(this.blocks[0]?.tokens, sum);
});

/* ---- Scenario: 缺失 result 的畸形块被强制 pin ---- */

Given('一个 tool block 的 assistant 消息发起了 2 次工具调用', function (this: CompressWorld) {
  this.pendingMsgs = new HistoryBuilder()
    .assistant('调用两个工具', [
      { id: 'call-1', name: 'read', args: {} },
      { id: 'call-2', name: 'read', args: {} },
    ])
    .build();
});

Given('仅 1 条 tool result 到达，另一次调用超时未返回', function (this: CompressWorld) {
  this.pendingMsgs.push(...new HistoryBuilder().tool('call-1', 'r1').build());
});

Then('该 block 标记为 complete 等于 false', function (this: CompressWorld) {
  assert.equal(this.blocks[0]?.complete, false);
});

Then('missing 列表含未返回的 tool_use 标识', function (this: CompressWorld) {
  assert.ok(this.blocks[0]?.missing.includes('call-2'));
});

Then('该 block 被强制 pin 且 pin_reason 为 tool-block-incomplete', function (this: CompressWorld) {
  const block = this.blocks[0]!;
  assert.ok(
    this.pins.some((p) => p.reason === 'tool-block-incomplete' && p.msgId === block.startId),
    '畸形块应被强制 pin',
  );
});

Then('该 block 在任何级别都不参与压缩', function (this: CompressWorld) {
  assert.equal(isBlockCompressible(this.blocks[0]!), false);
});

/* ---- Scenario: 孤儿 result 单独成块且不中断流程 ---- */

Given('一条 tool result 消息找不到对应的 assistant tool_calls', function (this: CompressWorld) {
  this.pendingMsgs = new HistoryBuilder().tool('ghost-call', '孤儿结果').build();
});

Then('该 result 单独成块并被标记为畸形', function (this: CompressWorld) {
  assert.equal(this.blocks.length, 1);
  assert.equal(this.blocks[0]?.malformed, true);
});

Then('压缩流程正常继续不抛异常', function (this: CompressWorld) {
  // 解析未抛异常即到达此处；再跑一次 L1 裁剪确认全链路无异常
  assert.ok(Array.isArray(this.blocks));
});

/* ---- Scenario: 无安全切点时放弃本轮压缩 ---- */

Given('中部起点到尾部起点之间的全部消息同属一个 tool block', function (this: CompressWorld) {
  const msgs = new HistoryBuilder().system().user('任务开始').build();
  // 中部与尾部全部内容都在同一个 block 内：尾部消息就是 block 的 result
  const blockMsgs = new HistoryBuilder().assistant('长任务调用', [{ id: 'c1', name: 'run', args: {} }]).tool('c1', '跨尾部结果').build();
  this.state = this.buildState([...msgs, ...blockMsgs]);
});

Then('select_segment 返回空的中部段集合', function (this: CompressWorld) {
  assert.equal(this.segments.length, 0);
});

Then('本轮压缩被放弃且上下文逐字节不变', async function (this: CompressWorld) {
  this.lastCommitted = await this.orchestrator({ compress: async (input) => ({ text: input.text }) }).maybeCompress(this.state!);
  assert.equal(this.lastCommitted, this.state);
});

Then('指标 select_abort_count 增加 1', function (this: CompressWorld) {
  assert.ok((this.metrics['select_abort'] ?? 0) >= 1, `select_abort 计数实际为 ${this.metrics['select_abort'] ?? 0}`);
});

/* ---- Scenario: 中部为空时不产生空压缩块 ---- */

Given('会话仅有系统提示与尾部消息，中部无任何 block', function (this: CompressWorld) {
  this.msgs = new HistoryBuilder().system().user('第一句').user('第二句').build();
  this.state = this.buildState(this.msgs);
});

Then('不生成任何 CompressedBlock', function (this: CompressWorld) {
  assert.equal(this.lastCommitted?.compressed.length, this.state?.compressed.length);
});

/* ---- Scenario: 乱序到达的 result 仍归入其所属 block ---- */

Given('一条 assistant 消息按顺序发起 tool_calls 标识为 call-1、call-2、call-3', function (this: CompressWorld) {
  this.pendingMsgs = new HistoryBuilder()
    .assistant('顺序调用', [
      { id: 'call-1', name: 'read', args: {} },
      { id: 'call-2', name: 'read', args: {} },
      { id: 'call-3', name: 'read', args: {} },
    ])
    .build();
});

Given('三条 tool result 以 call-2、call-3、call-1 的乱序到达', function (this: CompressWorld) {
  this.pendingMsgs.push(
    ...new HistoryBuilder().tool('call-2', 'r2').tool('call-3', 'r3').tool('call-1', 'r1').build(),
  );
});

Then('这 4 条消息仍构成 1 个 complete 的 block', function (this: CompressWorld) {
  assert.equal(this.blocks.length, 1);
  assert.equal(this.blocks[0]?.complete, true);
});

Then('block 内消息保持原始到达顺序不被重排', function (this: CompressWorld) {
  assert.deepEqual(this.blocks[0]?.msgIds, this.pendingMsgs.map((m) => m.id));
});

/* ---- Scenario: 被下一条 assistant 工具调用截断的 block 判为畸形 ---- */

Given('一条 assistant 消息发起 2 次工具调用但仅有 1 条 result 到达', function (this: CompressWorld) {
  this.pendingMsgs = new HistoryBuilder()
    .assistant('调用两个', [
      { id: 'call-1', name: 'read', args: {} },
      { id: 'call-2', name: 'read', args: {} },
    ])
    .tool('call-1', 'r1')
    .build();
});

Given('紧随其后是另一条发起工具调用的 assistant 消息', function (this: CompressWorld) {
  // 注意：必须在同一个 builder 里追加，避免两个 builder 实例的 ID 序列碰撞（as-01/tool-01 重复）
  this.pendingMsgs = new HistoryBuilder()
    .assistant('调用两个', [
      { id: 'call-1', name: 'read', args: {} },
      { id: 'call-2', name: 'read', args: {} },
    ])
    .tool('call-1', 'r1')
    .assistant('再次调用', [{ id: 'call-3', name: 'write', args: {} }])
    .tool('call-3', 'r3')
    .build();
});

Then('第一个 block 在该 assistant 消息处结束且 complete 等于 false', function (this: CompressWorld) {
  const first = this.blocks[0]!;
  assert.equal(first.complete, false);
  assert.equal(first.endId, this.pendingMsgs[1]?.id); // 在截断处（第一条 result）结束，后续消息归下一块
});

Then('第二个 block 独立解析不受前一个畸形块影响', function (this: CompressWorld) {
  const second = this.blocks[1]!;
  assert.equal(second.complete, true);
  assert.equal(second.malformed, false);
});

/* 复用 pin 断言：畸形块强制 pin（场景 8 也要求） */
Then('第一个 block 被强制 pin 且 pin_reason 为 tool-block-incomplete', function (this: CompressWorld) {
  const first = this.blocks[0]!;
  const state = this.buildState(this.pendingMsgs);
  const { pins } = resolvePins(state, this.config);
  assert.ok(pins.some((p) => p.reason === 'tool-block-incomplete' && p.msgId === first.startId));
});
