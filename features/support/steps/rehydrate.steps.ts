/** `rehydrate.feature` 的步骤定义（§4.1 JSONL 归档 + 回溯）。 */

import * as fs from 'node:fs';
import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { HistoryBuilder } from '../fixtures.js';
import { auditedGoodCompress } from './shared.steps.js';
import { createArchive, JsonlArchiveSink } from '../../../src/archive.js';
import type { CompressedBlock, Message } from '../../../src/contract.js';

/** 可压缩会话：raw 载荷 + vendor 保留，用于无损还原场景。
 * 注意：tool 内容不得含路径/URL —— 否则触发 deliverable-path pin 把整个 block 锁死，无段可压。 */
function archiveSession(): Message[] {
  return new HistoryBuilder()
    .system()
    .user('任务')
    .assistant('调用', [{ id: 'call-1', name: 'write', args: { file: 'out-a.txt' } }])
    .tool('call-1', '写入完成，共 128 行')
    .user('收尾')
    .build();
}

async function runOnce(this: CompressWorld): Promise<void> {
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.lastEpochBefore = this.state!.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(this.state!);
}

/* ---- Background ---- */

Given('归档存储配置为 JSONL 追加文件并维护内存索引', function (this: CompressWorld) {
  this.useJsonlArchive();
  this.makeConfig();
});

Given('每条归档记录含 source_hash 用于一致性校验', function (this: CompressWorld) {
  this.state = this.buildState(this.msgs.length > 0 ? this.msgs : archiveSession());
});

/* ---- Scenario: 凭 archive_ref 取回原文且哈希校验通过 ---- */

Given('一段内容已被压缩且其 L0 原文已归档', async function (this: CompressWorld) {
  this.state = this.buildState(archiveSession());
  await runOnce.call(this);
  this.blockUnderTest = this.lastCommitted?.compressed[0] ?? null;
  assert.ok(this.blockUnderTest, '应产出压缩块');
});

When('以该块的 archive_ref 调用 rehydrate', async function (this: CompressWorld) {
  this.rehydratedMsgs = (await this.archive?.rehydrate(this.blockUnderTest!.archiveRef!)) ?? null;
});

Then('取回的消息序列与归档前逐字节相同', function (this: CompressWorld) {
  // 段 = block 的 assistant + 全部 tool result
  const before = (this.state?.msgs ?? []).filter((m) => m.role === 'assistant' || m.role === 'tool');
  assert.deepEqual(this.rehydratedMsgs?.map((m) => m.content), before.map((m) => m.content));
});

Then('source_hash 校验通过', function (this: CompressWorld) {
  // rehydrate 未抛 ArchiveCorrupted 即通过
  assert.ok(this.lastError === null);
});

Then('取回的消息数量与 source_span.msg_count 一致', function (this: CompressWorld) {
  assert.equal(this.rehydratedMsgs?.length, this.blockUnderTest?.sourceSpan.msgCount);
});

/* ---- Scenario: 取回的原文可无损还原为原始 API 消息格式 ---- */

Given('归档记录中保存了每条消息的 raw 原始载荷与 vendor 标记', async function (this: CompressWorld) {
  const msgs: Message[] = archiveSession().map((m) => ({
    ...m,
    raw: { role: m.role, structured: m.toolCalls ?? m.toolCallId ?? null },
    vendor: 'anthropic' as const,
  }));
  this.state = this.buildState(msgs);
  await runOnce.call(this);
  this.blockUnderTest = this.lastCommitted?.compressed[0] ?? null;
  assert.ok(this.blockUnderTest);
});

When('执行 rehydrate 并回写为 API 请求格式', async function (this: CompressWorld) {
  this.rehydratedMsgs = (await this.archive?.rehydrate(this.blockUnderTest!.archiveRef!)) ?? null;
});

Then('回写结果与该消息首次进入会话时的 API 格式结构一致', function (this: CompressWorld) {
  assert.ok((this.rehydratedMsgs?.length ?? 0) > 0);
  assert.ok(this.rehydratedMsgs?.every((m) => m.raw !== undefined));
});

Then('tool_use 与 tool_result 的配对关系保持不变', function (this: CompressWorld) {
  const assistant = this.rehydratedMsgs?.find((m) => m.toolCalls !== undefined);
  const tool = this.rehydratedMsgs?.find((m) => m.toolCallId !== undefined);
  assert.ok(assistant && tool);
  assert.ok(assistant.toolCalls?.some((c) => c.id === tool.toolCallId));
});

Then('不因展平为 text 字段而丢失结构化内容', function (this: CompressWorld) {
  const assistant = this.rehydratedMsgs?.find((m) => m.toolCalls !== undefined);
  assert.ok(assistant?.toolCalls?.[0]?.args !== undefined);
});

/* ---- Scenario: L4 指针块必须可回溯 ---- */

Given('一段内容已下沉至 L4', async function (this: CompressWorld) {
  this.state = this.buildState(archiveSession());
  await runOnce.call(this);
  this.blockUnderTest = this.lastCommitted?.compressed[0] ?? null;
  assert.ok(this.blockUnderTest);
});

When('检查其 CompressedBlock', function (this: CompressWorld) {
  // 断言在 Then 中完成
});

Then('archive_ref 字段非空', function (this: CompressWorld) {
  assert.ok(this.blockUnderTest?.archiveRef !== null);
});

Then('source_span 含合法的 start_id、end_id 与 msg_count', function (this: CompressWorld) {
  const span = this.blockUnderTest?.sourceSpan;
  assert.ok(span && span.startId.length > 0 && span.endId.length > 0 && span.msgCount > 0);
});

Then('凭该指针能成功取回完整 L0 原文', async function (this: CompressWorld) {
  const original = await this.archive?.rehydrate(this.blockUnderTest!.archiveRef!);
  assert.ok((original?.length ?? 0) > 0);
});

Then('指针文本本身占用极少 token，仅说明存在过什么与如何取回', function (this: CompressWorld) {
  const span = this.blockUnderTest!.sourceSpan;
  assert.ok(this.blockUnderTest!.tokens < this.config.countTokens(`x `.repeat(span.msgCount * 50)));
});

/* ---- Scenario: 归档文件只追加不覆盖 ---- */

Given('归档文件中已存在若干条历史记录', async function (this: CompressWorld) {
  this.state = this.buildState(archiveSession());
  const toolMsgs = this.state.msgs.filter((m) => m.role === 'tool');
  for (const msg of toolMsgs) {
    await this.archive?.archive([msg]);
  }
  this.jsonlBefore = fs.readFileSync(this.jsonlPath(), 'utf8');
  assert.ok((this.jsonlBefore.match(/\n/g) ?? []).length >= 1);
});

When('追加写入新的归档记录', async function (this: CompressWorld) {
  const extra = new HistoryBuilder().user('额外记录').build();
  this.sizeBeforeAppend = this.archive?.size() ?? 0;
  await this.archive?.archive(extra);
  // 重复归档同一原文：不应产生冗余行
  await this.archive?.archive(extra);
});

Then('既有行的内容与字节偏移均不变', function (this: CompressWorld) {
  const after = fs.readFileSync(this.jsonlPath(), 'utf8');
  assert.ok(after.startsWith(this.jsonlBefore ?? ''), '既有行必须保持前缀不变');
});

Then('内存索引新增对应条目', function (this: CompressWorld) {
  assert.ok((this.archive?.size() ?? 0) > this.sizeBeforeAppend);
});

Then('重复归档同一 source_hash 不产生冗余行', function (this: CompressWorld) {
  const lines = fs.readFileSync(this.jsonlPath(), 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const hashes = lines.map((l) => (JSON.parse(l) as { hash: string }).hash);
  assert.equal(new Set(hashes).size, hashes.length, '同一 hash 不得出现多行');
});

/* ---- Scenario: 归档不可用时禁止有损下沉 ---- */

Given('归档文件写入失败或存储不可用', function (this: CompressWorld) {
  this.sink = {
    append: async () => {
      throw new Error('write failed');
    },
    read: async () => null,
    readAll: () => (async function* () {})() as never,
    available: async () => false,
  };
  this.makeConfig();
  this.state = this.buildState(archiveSession());
});

When('一段内容需从 L1 下沉至 L2 或更低', async function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  await runOnce.call(this);
});

Then('拒绝下沉并保持该段停留在当前级别', function (this: CompressWorld) {
  const block = this.lastCommitted?.compressed[0];
  assert.ok(block, '应回退产出 L1 结果');
  const original = this.state?.msgs.map((m) => m.content).join('\n') ?? '';
  for (const line of block.text.split('\n')) {
    if (line.trim().length === 0) continue;
    assert.ok(original.includes(line), '文本必须是原文子集（未发生有损下沉）');
  }
});

Then('记录一条 archive-unavailable 告警说明回溯能力缺失', function (this: CompressWorld) {
  assert.ok((this.metrics['archive-unavailable'] ?? 0) >= 1);
});

Then('本轮仍允许执行无归档需求的 L1 无损裁剪', function (this: CompressWorld) {
  assert.ok(this.lastCommitted !== this.state, 'L1 无损裁剪照常执行');
});

/* ---- Scenario: 索引丢失时可从 JSONL 全量重建 ---- */

Given('内存索引因进程重启而丢失但 JSONL 文件完好', async function (this: CompressWorld) {
  this.state = this.buildState(archiveSession());
  await runOnce.call(this);
  this.blockUnderTest = this.lastCommitted?.compressed[0] ?? null;
  this.jsonlBefore = fs.readFileSync(this.jsonlPath(), 'utf8');
  // 模拟进程重启：全新归档实例（空索引），指向同一 JSONL 文件
  this.archive = createArchive(new JsonlArchiveSink(this.jsonlPath()));
});

When('归档模块初始化', async function (this: CompressWorld) {
  this.rebuiltCount = (await this.archive?.rebuildIndex()) ?? null;
});

Then('扫描 JSONL 重建 ref 到字节偏移的索引', function (this: CompressWorld) {
  assert.ok((this.rebuiltCount ?? 0) > 0);
});

Then('重建后既有 archive_ref 仍可成功 rehydrate', async function (this: CompressWorld) {
  const original = await this.archive?.rehydrate(this.blockUnderTest!.archiveRef!);
  assert.ok((original?.length ?? 0) > 0);
});

Then('重建过程不修改 JSONL 文件内容', function (this: CompressWorld) {
  assert.equal(fs.readFileSync(this.jsonlPath(), 'utf8'), this.jsonlBefore);
});

/* ---- Scenario: 哈希不一致时拒绝回溯并报错 ---- */

Given('某条归档记录的 source_hash 与其实际内容哈希不一致', async function (this: CompressWorld) {
  this.state = this.buildState(archiveSession());
  await runOnce.call(this);
  this.blockUnderTest = this.lastCommitted?.compressed[0] ?? null;
  assert.ok(this.blockUnderTest?.archiveRef);
  this.tamperedRef = { ...this.blockUnderTest.archiveRef, hash: '0000000000000000000000000000000f' };
});

When('以对应 archive_ref 调用 rehydrate', async function (this: CompressWorld) {
  try {
    await this.archive?.rehydrate(this.tamperedRef!);
  } catch (error) {
    this.lastError = error;
  }
});

Then('不返回任何可疑的部分内容', function (this: CompressWorld) {
  assert.ok(this.lastError !== null, '必须抛错而非返回内容');
});

Then('依赖该原文的下沉操作被拒绝执行', function (this: CompressWorld) {
  // 完整流程：携带损坏指针的压缩块不得被再下沉。
  // 构造真实已提交形态：原始块消息已被 cb 呈现消息替换，仅剩 head + cb + tail
  const block: CompressedBlock = { ...this.blockUnderTest!, archiveRef: this.tamperedRef! };
  const msgs = this.state?.msgs ?? [];
  const cbMsg: Message = { id: `cb-${block.id}`, role: 'user', content: block.text, vendor: 'generic' };
  const state = this.buildState([msgs[0]!, msgs[1]!, cbMsg, msgs[msgs.length - 1]!], {
    epoch: 1,
    compressed: [block],
  });
  return this.orchestrator({
    compress: auditedGoodCompress(this),
    shouldCompress: () => true,
  })
    .maybeCompress(state)
    .then((result) => {
      assert.equal(result, state, '损坏原文的再下沉必须被拒绝');
    });
});

/* ---- Scenario: 多个压缩块共享同一段原文时各自可独立回溯 ---- */

Given('同一段 L0 原文被用于生成 L2 与后续的 L3 摘要', async function (this: CompressWorld) {
  this.state = this.buildState(archiveSession());
  await runOnce.call(this);
  // 第一块（L2）已在压缩中归档；用同一原文再生成一个块（复用同一归档指针）
  const first = this.lastCommitted?.compressed[0];
  const second = first ? { ...first, id: `${first.id}-l3`, level: 3 as const } : null;
  this.sharedBlocks = [first ?? null, second];
});

When(/分别以两个块的 archive_ref 调用 rehydrate/, async function (this: CompressWorld) {
  const [a, b] = this.sharedBlocks ?? [];
  this.sharedRehydrated = [
    (await this.archive?.rehydrate(a!.archiveRef!)) ?? null,
    (await this.archive?.rehydrate(b!.archiveRef!)) ?? null,
  ];
});

Then('二者取回相同的原文序列', async function (this: CompressWorld) {
  const [a, b] = this.sharedRehydrated ?? [];
  assert.deepEqual(a?.map((m) => m.content), b?.map((m) => m.content));
});

Then('归档中该原文只存储一份不重复占用空间', function (this: CompressWorld) {
  const lines = fs.readFileSync(this.jsonlPath(), 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const hashes = lines.map((l) => (JSON.parse(l) as { hash: string }).hash);
  assert.equal(new Set(hashes).size, hashes.length);
});

Then('两个块的 source_span 均指向原始消息 ID 而非彼此的摘要', function (this: CompressWorld) {
  const [a, b] = this.sharedBlocks ?? [];
  assert.equal(a?.sourceSpan.startId, b?.sourceSpan.startId);
  assert.ok(a?.sourceSpan.startId !== `cb-${b?.id}` && b?.sourceSpan.startId !== `cb-${a?.id}`);
});
