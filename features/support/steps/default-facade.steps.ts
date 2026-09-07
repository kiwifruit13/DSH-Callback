/**
 * `default-facade.feature` 的步骤定义（P0 门面级回归）。
 *
 * 与其他 feature 的关键差异：本文件**不注入 shouldCompress**、
 * 经 `createContextCompressor` 门面创建实例（默认回调补齐 + 编排器内置触发路径），
 * 让 P0-1（真实轮次状态）、P0-2（settled 判定）、P0-3（VerifyInput.slots 透传）
 * 的修复成果在默认链路上被真实执行，而非被测试夹具绕过。
 */

import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { HistoryBuilder, goodCompress } from '../fixtures.js';
import { countingCompress } from './shared.steps.js';
import { createContextCompressor } from '../../../src/api.js';
import type { CompressInput, CompressOutput } from '../../../src/callbacks.js';
import type { CompressedBlock, ContextState, Message } from '../../../src/contract.js';

/** 门面场景的基准会话：内容刻意避开一切 pin 触发模式（路径/URL/命令/待办/报错关键词）。 */
function facadeSession(): Message[] {
  return new HistoryBuilder()
    .system()
    .user('任务一')
    .toolRound('read_file', '输出记录一：常规文本内容，无需特别关注。')
    .user('任务二')
    .toolRound('read_file', '输出记录二：常规文本内容，同样无需特别关注。')
    .user('收尾')
    .build();
}

/** 最后一个非 L4 指针的压缩块（被测块）。 */
function lastNonPointerBlock(this: CompressWorld): CompressedBlock {
  const blocks = this.lastCommitted?.compressed ?? [];
  const real = blocks.filter((b) => b.method !== 'none');
  assert.ok(real.length > 0, '应存在非指针压缩块');
  return real[real.length - 1]!;
}

/* ---- 背景 ---- */

Given('归档使用内存 sink', function (this: CompressWorld) {
  this.useMemoryArchive();
});

Given('注入的 callback 只实现了 compress，其余钩子全部缺省', function (this: CompressWorld) {
  // 不注入 shouldCompress / selectSegment / onPreCompress / verify —— 触发走编排器内置路径，
  // 其余钩子由门面合并的 DEFAULT_CALLBACKS 提供。这正是 P0 修复前的测试盲区。
  this.hookOverrides.compress = countingCompress(this, goodCompress());
});

Given('会话为系统提示、两条用户消息与两个完整 tool block', function (this: CompressWorld) {
  this.msgs = facadeSession();
  this.makeConfig();
  this.state = this.buildState(this.msgs);
  // 门面在创建时固化配置，必须在 makeConfig 之后创建（告警/观测收集才接入同一份 config）
  this.pendingCompressor = createContextCompressor({
    config: this.config,
    callbacks: { compress: this.hookOverrides.compress! },
  });
});

Given('会话容量使占用率高于触发线', function (this: CompressWorld) {
  const state = this.state!;
  const ratio = state.tokens / state.capacity;
  assert.ok(
    ratio > this.config.triggerRatio,
    `占用率 ${ratio.toFixed(3)} 应高于触发线 ${this.config.triggerRatio}`,
  );
});

/* ---- 场景: 默认触发路径下压缩不会在首次成功后永久卡死（P0-1 回归） ---- */

Then('第一轮压缩成功提交', function (this: CompressWorld) {
  const committed = this.lastCommitted;
  assert.ok(committed !== null && committed !== this.state, '第一轮应提交新状态');
  assert.equal(committed!.epoch, (this.state?.epoch ?? 0) + 1);
  assert.ok(committed!.compressed.length > 0, '应产出压缩块');
  this.facadeCompressedAfterRound1 = committed!.compressed.length;
});

Given('在提交结果上追加新的用户消息与完整 tool block 构造下一轮状态', function (this: CompressWorld) {
  const committed = this.lastCommitted;
  assert.ok(committed !== null, '第一轮应已提交');
  const appended = new HistoryBuilder()
    .toolRound('read_file', '输出记录三：追加轮次的常规文本内容。')
    .user('收尾二')
    .build();
  this.state = this.buildState([...committed!.msgs, ...appended], {
    epoch: committed!.epoch,
    compressed: committed!.compressed,
    capacity: committed!.capacity,
  });
});

When('连续调用两次压缩', async function (this: CompressWorld) {
  const state = this.state!;
  this.facadeRound2Results = [];
  for (let i = 0; i < 2; i++) {
    this.lastCommitted = await this.pendingCompressor!.maybeCompress(state);
    this.facadeRound2Results.push(this.lastCommitted);
  }
});

Then('这两次调用均被频率下限抑制而不压缩', function (this: CompressWorld) {
  const state = this.state!;
  assert.ok(this.facadeRound2Results !== null && this.facadeRound2Results.length === 2);
  for (const result of this.facadeRound2Results) {
    // minGapTurns(3) 内 turnsSince 只推进到 1、2：占用超线 + 边界命中也必须被抑制，
    // 且返回原状态引用（逐字节原样，§9.2）
    assert.equal(result, state, '被抑制的轮次必须返回原状态引用');
  }
});

When('继续调用一次压缩', async function (this: CompressWorld) {
  this.lastCommitted = await this.pendingCompressor!.maybeCompress(this.state!);
});

Then('本轮压缩成功提交', function (this: CompressWorld) {
  const committed = this.lastCommitted;
  assert.ok(committed !== null && committed !== this.state, '本轮应提交新状态');
  assert.equal(committed!.epoch, (this.state?.epoch ?? 0) + 1);
});

Then('压缩块总数在原有基础上继续增长', function (this: CompressWorld) {
  assert.ok(this.facadeCompressedAfterRound1 !== null);
  assert.ok(
    (this.lastCommitted?.compressed.length ?? 0) > this.facadeCompressedAfterRound1!,
    `压缩块总数应大于第一轮的 ${this.facadeCompressedAfterRound1}`,
  );
});

Then('全程未出现钩子缺失或钩子异常错误', function (this: CompressWorld) {
  assert.equal(this.lastError, null);
  assert.ok(
    !this.warnings.some((w) => w.includes('hook_error')),
    `不应出现钩子异常告警，实际：${this.warnings.join(', ')}`,
  );
});

/* ---- 场景: 压缩后占用回落到目标线以下时不再压缩（P0-2 回归） ---- */

Given('把提交结果的容量放大使占用率回落到目标线以下', function (this: CompressWorld) {
  const committed = this.lastCommitted;
  assert.ok(committed !== null, '第一轮应已提交');
  const capacity = Math.max(1, committed!.tokens * 10);
  this.state = { ...committed!, capacity };
  assert.ok(
    committed!.tokens / capacity < this.config.targetRatio,
    `占用率应回落到目标线 ${this.config.targetRatio} 以下`,
  );
});

Then('本轮不压缩且状态逐字节保持原样', function (this: CompressWorld) {
  // settled 判定（justCompressed + ratio < targetRatio）命中后返回原状态引用
  assert.equal(this.lastCommitted, this.state, 'settled 轮次必须返回原状态引用');
});

/* ---- 场景: 默认校验链拒绝伪造槽位并走降级链（P0-3 回归） ---- */

Given('compress 钩子返回约束槽位含原文中不存在的取值', function (this: CompressWorld) {
  const FAKE = '绝不存在的约束标记QZX';
  this.facadeFakeSlotValue = FAKE;
  // 槽位形状合法（P2-4 校验通过）但取值无法逐字定位 —— 默认校验链（P0-3 后 slots 经
  // VerifyInput 透传给 verifySummary）必须拒绝它并触发 §8.2 降级链
  this.hookOverrides.compress = countingCompress(
    this,
    async (input: CompressInput): Promise<CompressOutput> => {
      const text = '叙述：本轮工作内容已经总结完毕，细节略。';
      return input.level >= 2
        ? { text, slots: { constraints: [FAKE], artifacts: [], todos: [], narrative: text } }
        : { text };
    },
  );
});

Given('会话改用含重复 hash 指纹的读取输出使 L1 降级输出可被去重缩小', function (this: CompressWorld) {
  // 两个 tool block 均为并行读取，同一 hash 跨消息重复 → P2-7 消息级 duplicate-read
  // 只保留最新一条消息，L1 降级输出（约 10 token）远小于整段（约 40 token）。
  // 降级链的截断判据是 countTokens(l1) > budget：预算 ≥ L1 输出才能停在 heuristic 而非 truncate。
  const builder = new HistoryBuilder().system().user('任务一');
  builder.assistant('调用 read_file', [
    { id: 'call-a1', name: 'read_file', args: {} },
    { id: 'call-a2', name: 'read_file', args: {} },
    { id: 'call-a3', name: 'read_file', args: {} },
  ]);
  builder
    .tool('call-a1', 'commit a1b2c3d4 保存了输出甲：常规文本内容记录')
    .tool('call-a2', 'commit a1b2c3d4 保存了输出乙：常规文本内容记录')
    .tool('call-a3', '结果已记录 commit a1b2c3d4');
  builder.assistant('调用 read_file', [
    { id: 'call-b1', name: 'read_file', args: {} },
    { id: 'call-b2', name: 'read_file', args: {} },
  ]);
  builder
    .tool('call-b1', 'commit f0e1d2c3 输出了结果丙：常规文本内容记录')
    .tool('call-b2', '结果已记录 commit f0e1d2c3')
    .user('收尾');
  this.msgs = builder.build();
  this.makeConfig();
  this.state = this.buildState(this.msgs);
});

Given('目标预算压到整段一半以下使目标段走 L2 及以上的 LLM 路径', function (this: CompressWorld) {
  // 预算标定（夹具实测）：segA 整段约 42 token、L1 降级输出约 10 token。
  // 20 < tokens/2 → targetLevel L3（LLM 路径）；20 ≥ L1 输出 → 降级后不被截断（method 保持 heuristic）。
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 20 };
  this.makeConfig();
  // 门面在创建时固化配置：钩子与预算覆盖后必须重建（此时尚未执行过压缩，重建无副作用）
  this.pendingCompressor = createContextCompressor({
    config: this.config,
    callbacks: { compress: this.hookOverrides.compress! },
  });
});

Then('被测块最终降级为抽取式', function (this: CompressWorld) {
  assert.equal(lastNonPointerBlock.call(this).method, 'heuristic');
});

Then('被测块标记为走了降级链', function (this: CompressWorld) {
  assert.equal(lastNonPointerBlock.call(this).degraded, true);
});

Then('伪造的槽位取值不出现在任何压缩块文本中', function (this: CompressWorld) {
  const fake = this.facadeFakeSlotValue!;
  for (const block of this.lastCommitted?.compressed ?? []) {
    assert.ok(!block.text.includes(fake), `伪造槽位取值泄漏进压缩块 ${block.id}`);
  }
});

Then('有损级别的归档指针仍然有效', function (this: CompressWorld) {
  const block = lastNonPointerBlock.call(this);
  // 降级不回退级别（P1-2 口径）：块仍记 L3，则 archiveRef 必须非空且哈希非空
  assert.ok(block.level >= 2, `被测块级别应 ≥ 2，实际 ${block.level}`);
  assert.ok(block.archiveRef !== null, '有损级别（含降级块）的 archiveRef 必须非空');
  assert.ok(block.archiveRef!.hash.length > 0);
});

Then('观测告警双通道同步记录了校验重试与降级链告警', function (this: CompressWorld) {
  // R5-3 回归：runCycle 内的 warn() 必须同步写入 ObservationRecord.warnings，
  // 观测记录的「本轮告警」不再是恒空数组（本场景降级走编排器 §8.2 直降 L1，
  // 不经 fallback 链，故 R5-4 的链内告警由独立场景锁定）
  const record = this.observations[this.observations.length - 1];
  assert.ok(record !== undefined, '应存在本轮观测记录');
  assert.ok(
    record!.warnings.includes('verify_failed_retry'),
    `观测告警应含 verify_failed_retry，实际：${record!.warnings.join(', ')}`,
  );
  assert.ok(this.warnings.includes('verify_failed_retry'), 'onWarning 通道同步收到同一告警');
});

/* ---- 场景: 整体取消通道在提交前放弃本轮（R5-9 回归） ---- */

Given('准备一个已经中止的取消信号', function (this: CompressWorld) {
  this.facadeSignal = AbortSignal.abort();
  this.facadeBaselineObservations = this.observations.length;
});

When('带着取消信号执行完整压缩流程', async function (this: CompressWorld) {
  this.lastCommitted = await this.pendingCompressor!.maybeCompress(this.state!, this.facadeSignal!);
});

Given('compress 钩子在被调用时触发外部取消并返回合法输出', function (this: CompressWorld) {
  // 默认预算下背景会话的段全部落 L1（不调 compress 钩子，取消无从发生），
  // 必须压小预算使目标段走 L2+ 的 LLM 路径
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 5 };
  this.makeConfig();
  const controller = new AbortController();
  this.facadeSignal = controller.signal;
  this.facadeBaselineObservations = this.observations.length;
  this.hookOverrides.compress = countingCompress(
    this,
    async (input: CompressInput, signal: AbortSignal): Promise<CompressOutput> => {
      // 中途取消：钩子收到外部信号后触发取消，再返回合法输出 ——
      // 信号必须已透传（不再是编排器自造的死信号），且本轮最终不得提交
      controller.abort();
      this.facadeHookSawAbort = input.signal.aborted;
      return goodCompress()(input, signal);
    },
  );
  // 门面在创建时固化回调引用：钩子变更后必须重建，否则新钩子不生效
  this.pendingCompressor = createContextCompressor({
    config: this.config,
    callbacks: { compress: this.hookOverrides.compress! },
  });
});

Then('提交前被取消：状态逐字节保持原样且不产生观测记录', function (this: CompressWorld) {
  assert.equal(this.lastCommitted, this.state, '被取消的轮次必须返回原状态引用');
  assert.equal(
    this.observations.length,
    this.facadeBaselineObservations,
    '被取消的轮次不得产生观测记录',
  );
});

Then('compress 钩子收到了已中止的信号', function (this: CompressWorld) {
  assert.equal(this.facadeHookSawAbort, true, 'compress 钩子的 input.signal 应已中止');
});

/* ---- 场景: 布尔触发的决策原因如实标注（R5-8 回归） ---- */

Given('注入恒返回布尔真值的 shouldCompress', function (this: CompressWorld) {
  this.hookOverrides.shouldCompress = () => true;
  // 钩子变更后需重建门面使新回调生效
  this.pendingCompressor = createContextCompressor({
    config: this.config,
    callbacks: { compress: this.hookOverrides.compress!, shouldCompress: this.hookOverrides.shouldCompress! },
  });
});

Then('观测记录的触发原因标注为宿主决策而非任务边界', function (this: CompressWorld) {
  const record = this.observations[this.observations.length - 1];
  assert.ok(record !== undefined, '应存在本轮观测记录');
  // R5-8：布尔返回无边界语义，不得伪造 task-boundary（其要求携带 cutPointId）
  assert.equal(record!.triggerReason, 'host-decision');
  assert.notEqual(record!.triggerReason, 'task-boundary');
});

Then('观测记录确认头部前缀稳定且断点可置于头部之后', function (this: CompressWorld) {
  const record = this.observations[this.observations.length - 1];
  assert.ok(record !== undefined, '应存在本轮观测记录');
  // R5-8：首条消息即压缩块时 prefixStable 不得报 true；正常保留 head 的轮次应为 true
  assert.equal(record!.cacheImpact.prefixStable, true);
  assert.equal(record!.cacheImpact.breakpointAfterHead, true);
});

/* ---- 场景: 降级链的非法 schema 告警进入观测记录（R5-4 回归） ---- */

Given('compress 钩子返回不符合槽位 schema 的输出', function (this: CompressWorld) {
  // 默认预算下段全部落 L1（不调钩子），压小预算强制 L2+ 走 LLM 路径，
  // fallback 链才会真实执行：槽位形状非法（P2-4 拒绝）→ 重试后降级，
  // llm_invalid_schema_attempt_N 属 fallback 链内告警，必须经 R5-4 转发进入观测记录
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 5 };
  this.makeConfig();
  this.hookOverrides.compress = countingCompress(
    this,
    async (input: CompressInput): Promise<CompressOutput> => {
      const text = '叙述：本轮工作内容已经总结完毕，细节略。';
      return input.level >= 2
        ? { text, slots: 42 as unknown as CompressOutput['slots'] }
        : { text };
    },
  );
  this.pendingCompressor = createContextCompressor({
    config: this.config,
    callbacks: { compress: this.hookOverrides.compress! },
  });
});

Then('观测告警包含降级链的非法 schema 记录', function (this: CompressWorld) {
  const record = this.observations[this.observations.length - 1];
  assert.ok(record !== undefined, '应存在本轮观测记录');
  assert.ok(
    record!.warnings.some((w) => w.startsWith('llm_invalid_schema_attempt')),
    `观测告警应含 fallback 链的 llm_invalid_schema_attempt_N，实际：${record!.warnings.join(', ')}`,
  );
  const block = lastNonPointerBlock.call(this);
  assert.ok(
    block.method === 'heuristic' || block.method === 'truncate',
    `非法 schema 应降级为抽取式或截断，实际 ${block.method}`,
  );
});
