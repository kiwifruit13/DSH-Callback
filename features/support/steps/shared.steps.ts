/**
 * 跨 feature 共享步骤（阶段 E3）。
 *
 * cucumber 的步骤定义是全局命名空间：多个 feature 复用的 Given/When/Than
 * 全部收敛在此文件，避免重复定义导致的 Ambiguous step。
 */

import assert from 'node:assert/strict';
import { When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { ArchiveCorrupted } from '../../../src/contract.js';
import { assignBudget, createEmbedderSpace } from '../../../src/gain.js';
import { createVectorSpace } from '../../../src/signals.js';
import { resolvePins } from '../../../src/pins.js';
import { PIN_REASON_PRIORITY } from '../../../src/contract.js';
import type { CompressCallbacks, CompressInput, CompressOutput } from '../../../src/callbacks.js';
import type { CompressedBlock, ContextState } from '../../../src/contract.js';
import { goodCompress } from '../fixtures.js';

/** 全量压缩执行：统一走编排器，收集观测 / 告警 / 错误 / compress 调用审计。 */
async function runFullCompress(this: CompressWorld): Promise<void> {
  this.resetRoundState();
  const state: ContextState = this.state ?? this.buildState(this.msgs);
  this.lastEpochBefore = state.epoch;

  const callbacks = {
    onError: (error: unknown) => {
      this.lastError = error;
    },
    ...this.hookOverrides,
  } as CompressCallbacks;

  const compressor = this.pendingCompressor ?? this.orchestrator(callbacks);
  this.lastCommitted = await compressor.maybeCompress(state);
}

When('执行完整压缩流程', runFullCompress);
When('执行压缩', runFullCompress);

When('执行 on_pre_compress', function (this: CompressWorld) {
  const state = this.state ?? this.buildState(this.pendingMsgs.length > 0 ? this.pendingMsgs : this.msgs);
  const resolved = resolvePins(state, this.config, this.hookOverrides.onPreCompress);
  this.pins = [...resolved.pins];
});

/** 预算分配执行体：供共享 When 与 gain 场景复用。 */
export function runAssignBudget(world: CompressWorld): void {
  const anchor = world.anchorOverride ?? world.pins.map((p) => p.text).join('\n');
  const space =
    world.config.embeddingEnabled && world.config.embed !== null
      ? createEmbedderSpace(world.config.embed)
      : createVectorSpace();
  space.addDocument?.(anchor);
  const texts = new Map<string, string>();
  for (const seg of world.segments) {
    const text = world.segmentTexts.get(seg.id) ?? '';
    texts.set(seg.id, text);
    space.addDocument?.(text);
  }
  world.assignments = assignBudget(
    { segments: world.segments, anchorText: anchor, segmentTexts: texts, retainedTexts: world.retainedTexts, space },
    world.config,
  );
}

When('执行预算分配', function (this: CompressWorld) {
  runAssignBudget(this);
});

Then('epoch 不递增', function (this: CompressWorld) {
  assert.equal(this.lastCommitted?.epoch, this.lastEpochBefore);
});

Then('上下文保持原样', function (this: CompressWorld) {
  assert.ok(this.lastCommitted !== null && this.state !== null);
  assert.equal(this.lastCommitted, this.state);
});

Then('上下文保持逐字节原样不产生任何 CompressedBlock', function (this: CompressWorld) {
  // 引用相等 ⇒ msgs / compressed 全部保持压缩前状态（§9.2 整体替换提交的逆否）
  assert.equal(this.lastCommitted, this.state);
});

/** 最后一个非 L4 指针（method !== 'none'）的压缩块；降级链断言只针对实体压缩块。 */
export function lastRealBlock(world: CompressWorld): CompressedBlock {
  const blocks = world.lastCommitted?.compressed ?? [];
  const real = blocks.filter((b) => b.method !== 'none');
  assert.ok(real.length > 0, '应存在非指针压缩块');
  return real[real.length - 1]!;
}

Then('该块的 method 记为 heuristic', function (this: CompressWorld) {
  assert.equal(lastRealBlock(this).method, 'heuristic');
});

Then('该块的 method 记为 truncate', function (this: CompressWorld) {
  assert.equal(lastRealBlock(this).method, 'truncate');
});

Then('抛出 ArchiveCorrupted', function (this: CompressWorld) {
  assert.ok(this.lastError instanceof ArchiveCorrupted, `期望 ArchiveCorrupted，实际 ${String(this.lastError)}`);
});

/** 导出给各 feature 步骤文件复用的压缩审计辅助。 */
export function countingCompress(
  world: CompressWorld,
  impl: (input: CompressInput, signal: AbortSignal) => CompressOutput | Promise<CompressOutput>,
): NonNullable<CompressCallbacks['compress']> {
  return async (input: CompressInput, signal: AbortSignal) => {
    world.compressCalls += 1;
    world.compressInputs.push(input);
    world.compressTexts.push(input.text);
    return impl(input, signal);
  };
}

/** 默认可用的 compress 钩子：goodCompress + 调用审计。 */
export function auditedGoodCompress(world: CompressWorld): NonNullable<CompressCallbacks['compress']> {
  return countingCompress(world, goodCompress());
}

/** 断言全部 pin_reason 属于枚举集合。 */
export function assertReasonsInEnum(world: CompressWorld): void {
  const valid = new Set<string>(PIN_REASON_PRIORITY);
  for (const pin of world.pins) {
    assert.ok(pin.reason.length > 0, 'pin_reason 非空');
    assert.ok(valid.has(pin.reason), `pin_reason ${pin.reason} 不在枚举集合内`);
  }
}
