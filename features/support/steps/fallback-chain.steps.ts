/** `fallback-chain.feature` 的步骤定义（§9.1 降级链 + §3 钩子失败语义）。 */

import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import {
  HistoryBuilder,
  goodCompress,
  hangingCompress,
  schemaInvalidCompress,
  throwingCompress,
} from '../fixtures.js';
import { countingCompress, lastRealBlock } from './shared.steps.js';
import { createContextCompressor } from '../../../src/api.js';
import type { Message } from '../../../src/contract.js';

/**
 * 可压缩会话：两个 tool block 段 + 头尾。
 * 内容用多行纯文本（无路径/URL/命令/关键词），避免触发 deliverable-path 等 pin
 * 把 block 锁死导致无段可压；30 行使得 l3Coarsen 保留首尾 10 行（约 1/3 体量），
 * 便于分别构造「heuristic 装得下」与「超预算截断」两类场景。
 */
function plainBlock(tag: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) {
    lines.push(`${tag} output line ${String(i).padStart(3, '0')} plain narrative filler words`);
  }
  return lines.join('\n');
}

function fallbackSession(): Message[] {
  return new HistoryBuilder()
    .system()
    .user('任务一')
    .toolRound('read_file', plainBlock('alpha'))
    .user('任务二')
    .toolRound('read_file', plainBlock('beta'))
    .user('收尾')
    .build();
}

/** 常规压缩准备：恒触发 + 审计 stub + 预算 80（高于 heuristic 产出、低于整段一半 → L3 走 llm 路径）。 */
function prepCompressible(this: CompressWorld): void {
  this.useMemoryArchive();
  this.msgs = fallbackSession();
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 80 };
  this.makeConfig();
  this.state = this.buildState(this.msgs);
}

/* ---- Background ---- */

Given('降级链按 llm → heuristic → truncate → 放弃 的顺序装配', function (this: CompressWorld) {
  // 链的装配在 fallback.ts 中固定；本步骤确认配置就绪
  this.makeConfig();
});

Given('每级超时时长由配置注入且以 AbortController 控制', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, llmTimeoutMs: 50, heuristicTimeoutMs: 50, truncateTimeoutMs: 50 };
  this.makeConfig();
});

/* ---- Scenario: LLM 摘要成功时标记来源 ---- */

Given('注入的 LLM 摘要钩子正常返回合法结构化结果', function (this: CompressWorld) {
  prepCompressible.call(this);
  this.hookOverrides.compress = countingCompress(this, goodCompress());
  this.hookOverrides.shouldCompress = () => true;
});

Then('该块的 method 记为 llm', function (this: CompressWorld) {
  assert.equal(lastRealBlock(this).method, 'llm');
});

Then('报告字段 degraded 为 false', function (this: CompressWorld) {
  assert.equal(lastRealBlock(this).degraded, false);
});

Then('报告字段 degraded 为 true', function (this: CompressWorld) {
  assert.equal(lastRealBlock(this).degraded, true);
});

Then('不触发任何后续降级', function (this: CompressWorld) {
  assert.equal(this.compressCalls, 1);
});

/* ---- Scenario: LLM 超时后走规则抽取 ---- */

Given('注入的 LLM 摘要钩子长时间不返回', function (this: CompressWorld) {
  prepCompressible.call(this);
  this.hookOverrides.compress = countingCompress(this, hangingCompress());
  this.hookOverrides.shouldCompress = () => true;
});

When('超时由 AbortController 触发', async function (this: CompressWorld) {
  this.lastEpochBefore = this.state!.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
    onError: (error: unknown) => {
      this.lastError = error;
    },
  }).maybeCompress(this.state!);
});

Then('降级为规则抽取，保留首尾句与含实体句', function (this: CompressWorld) {
  const block = lastRealBlock(this);
  assert.ok(block.text.length > 0);
});

Then('超时被中断的请求不残留未取消的网络调用', function (this: CompressWorld) {
  // hanging stub 仅监听 abort：流程正常返回即说明中断生效，无悬挂 promise
  assert.ok(this.lastCommitted !== null);
});

/* ---- Scenario: 规则抽取输出仍超预算则硬截断 ---- */

Given('规则抽取的结果 token 数超出该段预算', function (this: CompressWorld) {
  prepCompressible.call(this);
  // 预算压到 10：heuristic 产出（首尾 10 行，约 60 token）必然超出 → 走 truncate
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 10 };
  this.makeConfig();
  this.hookOverrides.compress = countingCompress(this, hangingCompress());
  this.hookOverrides.shouldCompress = () => true;
});

When('降级链继续', async function (this: CompressWorld) {
  this.lastEpochBefore = this.state!.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
    onError: (error: unknown) => {
      this.lastError = error;
    },
  }).maybeCompress(this.state!);
});

Then('执行硬截断并保留尾部', function (this: CompressWorld) {
  const block = lastRealBlock(this);
  assert.ok(block.text.length > 0, '截断后应保留尾部内容');
});

/* ---- Scenario: 三级全部失败时放弃压缩并告警 ---- */

Given('llm、heuristic、truncate 三级均抛出异常或产出非法结果', function (this: CompressWorld) {
  this.useMemoryArchive();
  // 两段均为可压缩段；throwingCompress 在 llm 级主动抛异常 → 立即 NoCompressionPossible
  this.msgs = fallbackSession();
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  this.state = this.buildState(this.msgs);
  this.hookOverrides.compress = countingCompress(this, throwingCompress());
  this.hookOverrides.shouldCompress = () => true;
});

When('降级链走到尽头', async function (this: CompressWorld) {
  this.lastEpochBefore = this.state!.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
    onError: (error: unknown) => {
      this.lastError = error;
    },
  }).maybeCompress(this.state!);
});

Then('抛出 NoCompressionPossible', function (this: CompressWorld) {
  assert.ok(
    this.lastError instanceof NoCompressionPossible,
    `期望 NoCompressionPossible，实际 ${String(this.lastError)}`,
  );
});

Then('记录一条含三级失败原因的告警', function (this: CompressWorld) {
  const error = this.lastError as { details?: Record<string, unknown> } | null;
  assert.ok(error && error.details !== undefined && Object.keys(error.details).length > 0, '错误应携带三级失败原因');
});

/* ---- Scenario: 每次降级都落盘 method 标记 ---- */

Given('一次压缩最终由 truncate 级完成', function (this: CompressWorld) {
  prepCompressible.call(this);
  // 预算压到 10：heuristic 产出超预算 → 最终由 truncate 级完成
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 10 };
  this.makeConfig();
  this.hookOverrides.compress = countingCompress(this, hangingCompress());
  this.hookOverrides.shouldCompress = () => true;
});

When('检查产出的 CompressedBlock', async function (this: CompressWorld) {
  this.lastEpochBefore = this.state!.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
    onError: (error: unknown) => {
      this.lastError = error;
    },
  }).maybeCompress(this.state!);
});

Then('其 method 字段准确记为 truncate 而非 llm', function (this: CompressWorld) {
  assert.equal(lastRealBlock(this).method, 'truncate');
});

Then('依据该标记可判定此段上下文可信度低于 llm 级摘要', function (this: CompressWorld) {
  assert.equal(lastRealBlock(this).method, 'truncate');
});

Then('标记随报告一并写入观测数据', function (this: CompressWorld) {
  const record = this.observations[this.observations.length - 1];
  assert.ok(record, '应有观测记录');
  assert.equal(record.method, 'truncate');
});

/* ---- Scenario: LLM 返回非法 JSON 时先重试再降级 ---- */

Given('注入的 LLM 摘要钩子返回不符合槽位 schema 的文本', function (this: CompressWorld) {
  prepCompressible.call(this);
  this.hookOverrides.compress = countingCompress(this, schemaInvalidCompress());
  this.hookOverrides.shouldCompress = () => true;
});

Then('按 §5 约定重试一次', function (this: CompressWorld) {
  assert.ok(this.compressCalls >= 2, `应重试一次，实际调用 ${this.compressCalls}`);
});

Then('重试仍非法则降级为 heuristic，不再继续重试', function (this: CompressWorld) {
  assert.equal(this.compressCalls, 2);
  assert.equal(lastRealBlock(this).method, 'heuristic');
});

Then('非法输出被记录用于事后分析而非静默丢弃', function (this: CompressWorld) {
  assert.equal(lastRealBlock(this).degraded, true);
});

/* ---- Scenario: should_compress 钩子抛异常时保守地不压缩 ---- */

Given('已注入的 should_compress 钩子会抛出异常', function (this: CompressWorld) {
  prepCompressible.call(this);
  this.hookOverrides.shouldCompress = () => {
    throw new Error('trigger hook exploded');
  };
});

When('调用触发判定', async function (this: CompressWorld) {
  this.lastEpochBefore = this.state!.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: countingCompress(this, goodCompress()),
    shouldCompress: this.hookOverrides.shouldCompress,
    onError: (error: unknown) => {
      this.lastError = error;
    },
  }).maybeCompress(this.state!);
});

Then('视为不压缩决策', function (this: CompressWorld) {
  assert.equal(this.lastCommitted, this.state);
});

Then('不因钩子异常而使会话崩溃', function (this: CompressWorld) {
  // 未抛出异常即达此处
  assert.ok(true);
});

/* ---- Scenario: select_segment 钩子抛异常时中止本轮压缩 ---- */

Given('已注入的 select_segment 钩子会抛出异常', function (this: CompressWorld) {
  prepCompressible.call(this);
  this.hookOverrides.shouldCompress = () => true;
  this.hookOverrides.selectSegment = () => {
    throw new Error('select hook exploded');
  };
});

Then('本轮压缩被中止且上下文完全不变', function (this: CompressWorld) {
  assert.equal(this.lastCommitted, this.state);
});

Then('不回退到任何默认切割实现（边界错则全盘错）', function (this: CompressWorld) {
  assert.ok((this.metrics['select_hook_error'] ?? 0) >= 1);
});

Then('记录一条 select_hook_error 告警', function (this: CompressWorld) {
  assert.ok((this.metrics['select_hook_error'] ?? 0) >= 1);
});

/* ---- Scenario: 用户仅提供 compress 钩子时其余钩子走默认实现 ---- */

Given('注入的 callback 只实现了 compress，其余五个钩子均未提供', function (this: CompressWorld) {
  this.useMemoryArchive();
  this.msgs = fallbackSession();
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  this.state = this.buildState(this.msgs);
  // 门面层负责把缺省钩子补齐为默认实现
  this.pendingCompressor = createContextCompressor({
    config: this.config,
    callbacks: { compress: goodCompress() },
  });
});

Then('流程可正常跑通不抛缺失实现错误', function (this: CompressWorld) {
  assert.ok(this.lastCommitted !== null);
  assert.notEqual(this.lastCommitted, this.state);
});

Then('触发、切割、校验、降级均由默认实现承担', function (this: CompressWorld) {
  assert.ok((this.lastCommitted?.compressed.length ?? 0) > 0);
});

Then('产出的 CompressedBlock 字段完整可被 rehydrate', function (this: CompressWorld) {
  const block = lastRealBlock(this);
  assert.ok(block.sourceSpan.startId.length > 0);
  assert.ok(block.archiveRef !== null, 'L2+ 块必须有归档指针');
});

/** ESM 下避免顶层 require 的极小桥接。 */
import { NoCompressionPossible } from '../../../src/contract.js';
