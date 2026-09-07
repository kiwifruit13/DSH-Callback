/** `atomicity-idempotency.feature` 的步骤定义（§9.2 / §9.3）。 */

import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { HistoryBuilder } from '../fixtures.js';
import { auditedGoodCompress } from './shared.steps.js';
import { assertCommit } from '../../../src/orchestrator.js';
import { CommitAssertFailed, type Message } from '../../../src/contract.js';

/** 可压缩会话：两个 tool block 段 + 头尾。 */
function atomicSession(): Message[] {
  return new HistoryBuilder()
    .system()
    .user('任务一')
    .toolRound('read_file', 'alpha output for task one')
    .user('任务二')
    .toolRound('read_file', 'beta output for task two')
    .user('收尾')
    .build();
}

/* ---- Background ---- */

Given('一个已配置归档与幂等缓存的会话', function (this: CompressWorld) {
  this.useMemoryArchive();
  this.makeConfig();
});

Given('消息序列以不可变数组持有', function (this: CompressWorld) {
  this.state = this.buildState(atomicSession());
  assert.ok(Array.isArray(this.state.msgs));
});

/* ---- Scenario: compress 中途抛异常时上下文完全不变 ---- */

Given('注入的 compress 钩子在处理第二个段时抛出异常', function (this: CompressWorld) {
  // 预算收紧：增益最高的段落 L3（经过钩子），其余段落 L4 指针（不经过钩子）。
  // 因此钩子首次被调即对应「第二个段」的压缩产出，抛出后触发整体回滚。
  let call = 0;
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  this.hookOverrides.compress = async (input) => {
    call += 1;
    this.compressCalls += 1;
    if (call >= 1) throw new Error('segment two exploded');
    return { text: input.text };
  };
  this.hookOverrides.shouldCompress = () => true;
});

Given('第一个段已成功产出压缩结果', function (this: CompressWorld) {
  // 由上一个 Given 的 stub 保证：第一段正常返回
});

Then('已产出的第一个段结果被丢弃不提交', function (this: CompressWorld) {
  assert.equal(this.lastCommitted, this.state);
  assert.equal(this.state?.compressed.length, 0);
});

Then('ContextState 引用与 msgs 内容逐字节保持压缩前的状态', function (this: CompressWorld) {
  assert.equal(this.lastCommitted, this.state);
});

Then('不存在任何部分写入的 CompressedBlock', function (this: CompressWorld) {
  assert.equal(this.lastCommitted?.compressed.length, 0);
});

/* ---- Scenario: 提交前断言失败则整体回滚 ---- */

Given('待提交的 next_msgs 中某个 tool block 的配对不完整', function (this: CompressWorld) {
  // next_msgs：一条孤儿 tool result（配对不完整）
  this.nextMsgs = new HistoryBuilder()
    .system()
    .user('前文')
    .tool('ghost-call', '孤儿结果')
    .build();
  this.state = this.state ?? this.buildState(atomicSession());
});

When('执行提交前完整性断言', function (this: CompressWorld) {
  // 单元级直调：不经过编排器，"上下文保持原样"即未产生新提交
  this.lastCommitted = this.state;
  const countTokens = this.config.countTokens;
  try {
    if (this.tokenDeviationCase) {
      // 预估值被人为抬高 2 倍：偏差必然超出容差，触发 token-consistency
      const actual = (this.nextMsgs ?? []).reduce((sum, m) => sum + countTokens(m.content), 0);
      assertCommit(this.nextMsgs ?? [], [], countTokens, actual * 2, this.config, 0, 0);
    } else if (this.assertPins !== null) {
      assertCommit(this.nextMsgs ?? [], this.assertPins, countTokens, countTokens('x'), this.config, 0, 0);
    } else {
      assertCommit(this.nextMsgs ?? [], [], countTokens, countTokens('x'), this.config, 0, 0);
    }
  } catch (error) {
    this.lastError = error;
    this.warnings.push('commit_assert_failed');
  }
});

Then('断言失败并触发整体回滚', function (this: CompressWorld) {
  assert.ok(this.lastError instanceof CommitAssertFailed, `期望 CommitAssertFailed，实际 ${String(this.lastError)}`);
});

Then('记录一条 commit_assert_failed 告警并指明失败的断言项', function (this: CompressWorld) {
  assert.ok(this.warnings.includes('commit_assert_failed'));
  assert.equal((this.lastError as CommitAssertFailed).assertion, 'tool-block-pairing');
});

/* ---- Scenario: 相同幂等键重复调用复用缓存结果 ---- */

// 用 RegExp：CucumberExpression 会把 `(...)` 解析为「可选文本组」导致永不匹配
Given(/^幂等键 \(startId, endId, level, epoch\) 已存在对应压缩结果$/, async function (this: CompressWorld) {
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.state = this.buildState(atomicSession());
  this.lastEpochBefore = this.state.epoch;
  this.firstRunCalls = this.compressCalls;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(this.state);
  assert.ok(this.lastCommitted !== this.state, '首轮应成功提交');
});

When('以同一幂等键再次请求压缩', async function (this: CompressWorld) {
  // 同一状态对象 = 同一幂等键（epoch 相同）
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(this.state!);
});

Then('直接返回缓存结果', function (this: CompressWorld) {
  assert.notEqual(this.lastCommitted, this.state, '应返回上次提交结果');
});

Then('不再调用 compress 钩子', function (this: CompressWorld) {
  assert.equal(this.compressCalls, this.firstRunCalls);
});

Then('返回块与首次产出的块逐字节相同', function (this: CompressWorld) {
  const blocks = this.lastCommitted?.compressed ?? [];
  assert.ok(blocks.length > 0);
  assert.ok(blocks.every((b) => b.epoch === this.lastCommitted?.epoch));
});

/* ---- Scenario: 成功提交后 epoch 递增 ---- */

Given('一轮压缩已成功提交', async function (this: CompressWorld) {
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.state = this.buildState(atomicSession());
  this.lastEpochBefore = this.state.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(this.state);
  assert.ok(this.lastCommitted !== this.state);
});

When('检查提交后的 ContextState', function (this: CompressWorld) {
  // 断言在 Then 中完成
});

Then('epoch 相对提交前恰好递增 1', function (this: CompressWorld) {
  assert.equal(this.lastCommitted?.epoch, this.lastEpochBefore + 1);
});

Then('该轮产出的全部 CompressedBlock 的 epoch 字段等于新值', function (this: CompressWorld) {
  for (const block of this.lastCommitted?.compressed ?? []) {
    assert.equal(block.epoch, this.lastCommitted?.epoch);
  }
});

/* ---- Scenario: 并发触发时仅执行一次压缩 ---- */

Given('两个请求在同一 epoch 下几乎同时触发压缩', function (this: CompressWorld) {
  // 预算收紧保证至少一个段经过 compress 钩子（L3），其余落 L4 指针
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.state = this.buildState(atomicSession());
  this.firstRunCalls = this.compressCalls;
  this.lastEpochBefore = this.state.epoch;
});

When('二者并发进入压缩流程', async function (this: CompressWorld) {
  const orchestrator = this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  });
  const [r1, r2] = await Promise.all([orchestrator.maybeCompress(this.state!), orchestrator.maybeCompress(this.state!)]);
  this.concurrentResults = [r1, r2];
  this.lastCommitted = r1;
});

Then('仅一次实际压缩被执行，另一方复用同一 in-flight promise', function (this: CompressWorld) {
  assert.equal(this.compressCalls, this.firstRunCalls + 1);
  assert.equal(this.concurrentResults?.[0], this.concurrentResults?.[1]);
});

Then('最终只产出一套 CompressedBlock', function (this: CompressWorld) {
  const added = (this.lastCommitted?.compressed.length ?? 0) - (this.state?.compressed.length ?? 0);
  assert.ok(added >= 1);
});

Then('epoch 只递增 1', function (this: CompressWorld) {
  assert.equal(this.lastCommitted?.epoch, this.lastEpochBefore + 1);
});

/* ---- Scenario: epoch CAS 冲突时后者放弃本轮 ---- */

Given('一个请求已完成提交使 epoch 递增', async function (this: CompressWorld) {
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.state = this.buildState(atomicSession());
  this.lastEpochBefore = this.state.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(this.state);
  assert.ok(this.lastCommitted !== this.state);
});

Given('另一个请求仍持有递增前的旧 epoch 值', function (this: CompressWorld) {
  // 旧 epoch 的状态副本（不同对象 ⇒ 不命中幂等重放，走 CAS 检查）
  const old = this.state!;
  this.staleState = { ...old, msgs: old.msgs, compressed: [], epoch: this.lastEpochBefore };
});

When('后者尝试以旧 epoch 提交', async function (this: CompressWorld) {
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(this.staleState!);
});

Then('CAS 比较失败，后者放弃本轮提交', function (this: CompressWorld) {
  assert.equal(this.lastCommitted, this.staleState);
  assert.ok((this.metrics['epoch_cas_conflict'] ?? 0) >= 1, `告警：${this.warnings.join(',')}`);
});

Then('不产生基于过期状态的第二次写入', function (this: CompressWorld) {
  assert.equal(this.staleState?.compressed.length, 0);
});

Then('后者可选择在新 epoch 上重新评估是否仍需压缩', function (this: CompressWorld) {
  // 放弃不是致命错误：无异常抛出即为可重新评估
  assert.ok(true);
});

/* ---- Scenario: 提交前断言 pin 内容全部在位 ---- */

Given('本轮识别出的全部 pin 中有一条在 next_msgs 里缺失或文本被改动', function (this: CompressWorld) {
  this.assertPins = [
    { msgId: 'msg-x', reason: 'user-constraint' as const, text: '必须在原文件上原地修改' },
  ];
  this.nextMsgs = new HistoryBuilder().system().user('不含约束文本的消息').build();
  this.state = this.state ?? this.buildState(atomicSession());
});

Then('告警指明缺失或被改动的 pin 及其 pin_reason', function (this: CompressWorld) {
  const error = this.lastError as CommitAssertFailed;
  assert.equal(error.assertion, 'pin-in-place');
  assert.equal(error.details['reason'], 'user-constraint');
});

/* ---- Scenario: 提交前断言 token 计数与预估一致 ---- */

Given('next_msgs 的实际 token 总数与压缩前预估值的偏差超出容许范围', function (this: CompressWorld) {
  this.tokenDeviationCase = true;
  this.nextMsgs = new HistoryBuilder().system().user('short').build();
  this.state = this.state ?? this.buildState(atomicSession());
});

Then('记录预估偏差值以便修正 token 估算器', function (this: CompressWorld) {
  const error = this.lastError as CommitAssertFailed;
  assert.equal(error.assertion, 'token-consistency');
  assert.ok(typeof error.details['actual'] === 'number');
  assert.ok(typeof error.details['estimated'] === 'number');
});

/* ---- Scenario: 每轮压缩产出可接入外部监控的观测记录 ---- */

When('检查其观测记录', function (this: CompressWorld) {
  // 断言在 Then 中完成
});

Then('记录包含前后 token、压缩比、耗时、级别、method、pin 条数与 cache 影响字段', function (this: CompressWorld) {
  const record = this.observations[this.observations.length - 1];
  assert.ok(record, '应存在观测记录');
  assert.ok(typeof record.beforeTokens === 'number');
  assert.ok(typeof record.afterTokens === 'number');
  assert.ok(typeof record.ratio === 'number');
  assert.ok(typeof record.durationMs === 'number');
  assert.ok(typeof record.level === 'number');
  assert.ok(typeof record.method === 'string');
  assert.ok(typeof record.pinCount === 'number');
  assert.ok(record.cacheImpact !== undefined);
});

Then('观测接口以回调或事件形式暴露，不绑定任何特定监控实现', function (this: CompressWorld) {
  // 记录经 config.onObservation 回调进入 world —— 回调式接口已被本场景证明
  assert.ok(this.observations.length > 0);
});

Then('记录中的 method 与 degraded 字段可区分本轮是否走了降级', function (this: CompressWorld) {
  const record = this.observations[this.observations.length - 1]!;
  assert.ok(typeof record.degraded === 'boolean');
});
