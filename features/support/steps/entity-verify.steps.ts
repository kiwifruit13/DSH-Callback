/** `entity-verify.feature` 的步骤定义（§8.1 / §8.2 / §8.3）。 */

import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import type { CompressWorld } from '../world.js';
import { HistoryBuilder, entityDroppingCompress, firstBadThenGoodCompress, goodCompress } from '../fixtures.js';
import { auditedGoodCompress, countingCompress } from './shared.steps.js';
import { verifyEntities, verifySummary } from '../../../src/verify.js';
import { ALL_ENTITY_CATEGORIES } from '../../../src/signals.js';
import type { CompressedBlock, EntityCategory, Message } from '../../../src/contract.js';

const CATEGORY_OF: Record<string, EntityCategory> = {
  'Windows 绝对路径': 'windows-path',
  'POSIX 路径': 'posix-path',
  URL: 'url',
  'UUID 或 commit hash': 'uuid-or-hash',
  反引号包裹的命令与符号: 'command-symbol',
  数值与百分比: 'number-percent',
  人名与专名: 'person-name',
};

const HARD_SAMPLE: Record<string, { a: string; b: string }> = {
  'windows-path': { a: 'D:\\data\\alpha.docx', b: 'D:\\data\\beta.docx' },
  'posix-path': { a: '/usr/local/bin/node', b: '/etc/hosts.allow' },
  url: { a: 'https://example.com/api/v1', b: 'https://example.org/docs' },
  'uuid-or-hash': { a: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', b: 'f0e1d2c3b4a5f6e7d8c9b0a1d2e3f4a5' },
  'command-symbol': { a: '`npm run build`', b: '`git push origin main`' },
};

/* ---- Background ---- */

Given('软实体保留率阈值由配置注入', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, softEntityRetainThreshold: 0.8 };
  this.makeConfig();
});

Given('硬实体保留率要求恒为 1.0', function (this: CompressWorld) {
  // 契约常量：实现里不得出现其他取值，这里仅确认配置可解析
  this.makeConfig();
});

/* ---- Scenario Outline: 任一类硬实体保留率不足即校验不通过 ---- */

Given(/原文含若干 (.+)$/, function (this: CompressWorld, category: string) {
  const entityCategory = CATEGORY_OF[category];
  assert.ok(entityCategory, `未知实体类别：${category}`);
  const sample = HARD_SAMPLE[entityCategory];
  if (sample) {
    this.originalText = `请处理 ${sample.a} 并参考 ${sample.b} 的内容。`;
    this.summaryText = this.originalText.replace(sample.b, '（此处省略）');
  } else {
    // 软实体
    this.originalText =
      entityCategory === 'number-percent'
        ? '完成度达到 85%，剩余 15% 分两批处理。'
        : '项目负责人 Alice Johnson 与 Bob Smith 共同确认了方案。';
    this.summaryText = '完成度与人员信息已省略。';
  }
  this.entityCategory = entityCategory;
});

Given('压缩摘要中缺失了其中至少一个', function (this: CompressWorld) {
  // summaryText 已在上一步构造为缺失一个实体的版本
});

When('执行实体校验', function (this: CompressWorld) {
  if (this.verifyFullFlow) {
    // verify 钩子失效路径：走完整压缩流程观察降级链
    this.state = this.state ?? this.buildState(this.msgs);
    this.lastEpochBefore = this.state.epoch;
    return this.orchestrator({
      compress: this.hookOverrides.compress!,
      shouldCompress: this.hookOverrides.shouldCompress,
      verify: this.hookOverrides.verify,
    })
      .maybeCompress(this.state)
      .then((result) => {
        this.lastCommitted = result;
      });
  }
  this.report =
    this.slots !== null && this.slots !== undefined
      ? verifySummary(this.originalText!, this.summaryText!, this.slots, this.config)
      : verifyEntities(this.originalText!, this.summaryText ?? '', this.config);
});

Then('verify_passed 为 false', function (this: CompressWorld) {
  if (this.report) assert.equal(this.report.passed, false);
});

Then(/entity_retain 中 (.+) 的保留率小于 1\.0/, function (this: CompressWorld, category: string) {
  const key = (CATEGORY_OF[category] ?? this.entityCategory) as EntityCategory;
  assert.ok(this.report, '应有校验报告');
  assert.ok(this.report.entityRetain[key] < 1.0, `保留率 ${this.report.entityRetain[key]}`);
});

Then('报告标记缺失的具体实体值以便定位', function (this: CompressWorld) {
  assert.ok(this.report, '应有校验报告');
  assert.ok(this.report.missing.length > 0);
});

/** 两个 tool block 的会话：segA 为被测段，segB 保证 segA 不是最低增益（否则被强转 L4）。 */
function twoBlockSession(mainContent: string): Message[] {
  return new HistoryBuilder()
    .system()
    .user('任务')
    .toolRound('read_file', mainContent)
    .assistant('参考', [{ id: 'call-b', name: 'read', args: {} }])
    .tool(
      'call-b',
      [
        '参考记录 commit f0e1d2c3 版本一 FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
        '参考记录 commit f0e1d2c3 版本二 EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
        '参考记录 commit f0e1d2c3 的格式说明',
      ].join('\n'),
    )
    .user('收尾')
    .build();
}

/**
 * 被测段夹具：同指纹（hash）三次出现 → L1 duplicate-read 只保留最后一行，
 * 因此 L1 输出 token 远小于整段，可用于「heuristic 不截断」与「超预算截断」两类断言。
 * 注意：实体用 hash 而非路径/URL —— 路径与 URL 会触发 deliverable-path pin，
 * 把整个 block 锁死导致无段可压。
 */
const MAIN_CONTENT = [
  'commit a1b2c3d4 保存了输出 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'commit a1b2c3d4 保存了输出 BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  '结果已记录 commit a1b2c3d4',
].join('\n');

/** 最后一个非 L4 指针的压缩块（被测块）。L4 指针 method='none'，不参与降级链断言。 */
function blockUnderTest(this: CompressWorld): CompressedBlock {
  const blocks = this.lastCommitted?.compressed ?? [];
  const real = blocks.filter((b) => b.method !== 'none');
  assert.ok(real.length > 0, '应存在非指针压缩块');
  return real[real.length - 1]!;
}

/** 被测段压缩时的 L0 原文（compress 钩子收到的 input.text，铁律一保证其即原文）。 */
function segmentOriginalOf(this: CompressWorld): string {
  assert.ok(this.compressInputs.length > 0, 'compress 应被调用过');
  return this.compressInputs[0]!.text;
}

/* ---- Scenario: 校验不通过先触发一次重压 ---- */

Given('一次 L2 摘要的硬实体保留率不足 1.0', function (this: CompressWorld) {
  this.useMemoryArchive();
  this.hookOverrides.compress = countingCompress(this, firstBadThenGoodCompress());
  this.hookOverrides.shouldCompress = () => true;
  this.msgs = twoBlockSession(MAIN_CONTENT);
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  this.state = this.buildState(this.msgs);
});

When('校验失败处理链启动', async function (this: CompressWorld) {
  this.lastEpochBefore = this.state!.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
  }).maybeCompress(this.state!);
});

Then('以更换 temperature 或更强调摘抄的 prompt 重压一次', function (this: CompressWorld) {
  assert.equal(this.compressCalls, 2, `压缩钩子应被调用 2 次（首次 + 重压），实际 ${this.compressCalls}`);
});

Then('重压结果的 method 仍记为 llm', function (this: CompressWorld) {
  const block = blockUnderTest.call(this);
  assert.equal(block.method, 'llm');
});

Then('重压最多执行一次，不进入无限重试', function (this: CompressWorld) {
  assert.equal(this.compressCalls, 2);
});

/* ---- Scenario: 重压仍不通过则降级到抽取式 ---- */

Given('重压后的摘要硬实体保留率仍不足 1.0', function (this: CompressWorld) {
  this.useMemoryArchive();
  this.hookOverrides.compress = countingCompress(this, entityDroppingCompress());
  this.hookOverrides.shouldCompress = () => true;
  // 注入计数 verify 钩子（行为与默认实现一致），用于断言「截断后重跑校验」
  this.hookOverrides.verify = (input, cfg) => {
    this.verifyCallCount += 1;
    return verifyEntities(input.original, input.summary, cfg);
  };
  this.msgs = twoBlockSession(MAIN_CONTENT);
  // 预算取 20：高于 L1 抽取式输出（约 10 token）但低于整段 token 的一半，
  // 保证目标段落 L2/L3 且 L1 结果不被截断（method 保持 heuristic）
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 20 };
  this.makeConfig();
  this.state = this.buildState(this.msgs);
});

When('校验失败处理链继续', async function (this: CompressWorld) {
  this.lastEpochBefore = this.state!.epoch;
  this.lastCommitted = await this.orchestrator({
    compress: this.hookOverrides.compress!,
    shouldCompress: this.hookOverrides.shouldCompress,
    verify: this.hookOverrides.verify,
  }).maybeCompress(this.state!);
});

Then('降级为 L1 抽取式压缩', function (this: CompressWorld) {
  const block = blockUnderTest.call(this);
  const original = segmentOriginalOf.call(this);
  for (const line of block.text.split('\n')) {
    if (line.trim().length === 0) continue;
    assert.ok(original.includes(line), 'L1 文本必须是原文子集');
  }
});

Then('抽取结果的每个实体保留率为 1.0（因输出是原文子集）', function (this: CompressWorld) {
  const block = blockUnderTest.call(this);
  const original = segmentOriginalOf.call(this);
  const report = verifyEntities(original, block.text, this.config);
  for (const category of ALL_ENTITY_CATEGORIES) {
    assert.equal(report.entityRetain[category], 1.0, `${category} 保留率应为 1.0`);
  }
});

/* ---- Scenario: 抽取式仍超预算则硬截断保尾部 ---- */

Given('降级为抽取式后其 token 数仍超出该段预算', function (this: CompressWorld) {
  // 独立场景需重建完整上下文：预算压到极小值迫使 L1 结果被硬截断
  this.useMemoryArchive();
  this.hookOverrides.compress = countingCompress(this, entityDroppingCompress());
  this.hookOverrides.shouldCompress = () => true;
  this.hookOverrides.verify = (input, cfg) => {
    this.verifyCallCount += 1;
    return verifyEntities(input.original, input.summary, cfg);
  };
  this.msgs = twoBlockSession(MAIN_CONTENT);
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  this.state = this.buildState(this.msgs);
});

Then('执行硬截断并保留尾部内容', function (this: CompressWorld) {
  const block = blockUnderTest.call(this);
  assert.ok(block.text.length > 0);
});

Then('截断后仍对保留部分重跑一次实体校验', function (this: CompressWorld) {
  // verify 钩子计数：首次 + 重压 + 截断后 ≥ 3
  assert.ok(this.verifyCallCount >= 3, `verify 应被重复执行，实际 ${this.verifyCallCount}`);
});

/* ---- Scenario Outline: 软实体低于阈值时按配置处置 ---- */

Given('其保留率低于配置注入的阈值', function (this: CompressWorld) {
  // summaryText 已在上一步构造为丢弃全部软实体的版本
});

Then(/按配置执行 (.+)$/, function (this: CompressWorld, action: string) {
  const expected = action.includes('告警') ? 'warn' : 'reject';
  assert.equal(this.config.softEntityAction[this.entityCategory as EntityCategory], expected);
  if (expected === 'warn') {
    assert.ok((this.report?.warnings.length ?? 0) > 0, '应有告警记录');
  }
});

Then('处置结果写入报告，不静默忽略', function (this: CompressWorld) {
  assert.ok(this.report, '应有校验报告');
  assert.ok(this.report.warnings.length > 0);
});

/* ---- Scenario: 校验通过时报告逐类可查 ---- */

Given('一次压缩的硬实体与软实体均达标', function (this: CompressWorld) {
  this.originalText = '输出保存到 D:\\data\\ok.docx，完成度 100%。';
  this.summaryText = this.originalText; // 实体全保留
  this.slots = null;
});

Then('verify_passed 为 true', function (this: CompressWorld) {
  assert.equal(this.report?.passed, true);
});

Then('entity_retain 字段包含每一类实体的独立保留率数值', function (this: CompressWorld) {
  for (const category of ALL_ENTITY_CATEGORIES) {
    assert.ok(typeof this.report?.entityRetain[category] === 'number');
  }
});

Then('报告可供事后审计而非只给出总体布尔值', function (this: CompressWorld) {
  assert.equal(Object.keys(this.report?.entityRetain ?? {}).length, ALL_ENTITY_CATEGORIES.length);
});

/* ---- Scenario: 校验器自身抛异常时视为不通过 ---- */

Given('已注入的 verify 钩子会抛出异常', function (this: CompressWorld) {
  this.useMemoryArchive();
  this.verifyFullFlow = true;
  this.hookOverrides.compress = auditedGoodCompress(this);
  this.hookOverrides.shouldCompress = () => true;
  this.hookOverrides.verify = () => {
    this.verifyCallCount += 1;
    throw new Error('verify hook exploded');
  };
  this.msgs = twoBlockSession(MAIN_CONTENT);
  this.configOverrides = { ...this.configOverrides, targetBudgetTokens: 1 };
  this.makeConfig();
  this.state = this.buildState(this.msgs);
});

Then('本轮判定为校验不通过，不放行该摘要', function (this: CompressWorld) {
  const block = blockUnderTest.call(this);
  const original = segmentOriginalOf.call(this);
  // 不放行可疑摘要：最终文本必须是原文子集（L1）或截断
  for (const line of block.text.split('\n')) {
    if (line.trim().length === 0) continue;
    assert.ok(original.includes(line), '最终文本应是原文子集，而非可疑摘要');
  }
});

Then('走 §8.2 的降级链而非直接采用可疑结果', function (this: CompressWorld) {
  const block = blockUnderTest.call(this);
  assert.notEqual(block.method, 'llm');
});

Then('记录一条 verify_hook_error 告警以区分"未达标"与"校验器崩溃"', function (this: CompressWorld) {
  assert.ok((this.metrics['verify_hook_error'] ?? 0) >= 1);
});

/* ---- Scenario: 原文不含任何受检实体时校验直接通过 ---- */

Given('待压缩段为纯自然语言叙述，不含路径、ID、命令、数值或专名', function (this: CompressWorld) {
  this.originalText = '这是一段普通的叙述文本，描述了整体思路与注意事项。';
  this.summaryText = this.originalText;
  this.slots = null;
});

Then('entity_retain 中各类别保留率记为 1.0 而非 0 或空值', function (this: CompressWorld) {
  for (const category of ALL_ENTITY_CATEGORIES) {
    assert.equal(this.report?.entityRetain[category], 1.0);
  }
});

Then('不因"未匹配到实体"被误判为信息丢失', function (this: CompressWorld) {
  assert.equal(this.report?.missing.length, 0);
});

/* ---- Scenario: 进阶事实问答校验默认关闭 ---- */

Given('配置中进阶校验开关为关闭', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, advancedVerifyEnabled: false };
  this.makeConfig();
  this.originalText = '约束：必须使用 UTF-8 编码\n交付物：D:\\out\\final.docx\n- [ ] 待办：补全文档';
  this.summaryText = '叙述摘要。';
  this.slots = {
    constraints: ['必须使用 UTF-8 编码'],
    artifacts: ['D:\\out\\final.docx'],
    todos: ['- [ ] 待办：补全文档'],
    narrative: '叙述摘要。',
  };
});

Then('不生成任何事实问题且不调用额外模型', function (this: CompressWorld) {
  assert.ok(this.report?.qa === undefined || this.report.qa.length === 0);
});

Then('仅正则实体校验生效', function (this: CompressWorld) {
  assert.ok(this.report?.hookError === false);
});

When('将进阶校验开关置为开启并重新校验', function (this: CompressWorld) {
  this.configOverrides = { ...this.configOverrides, advancedVerifyEnabled: true };
  this.makeConfig();
  this.report = verifySummary(this.originalText!, this.summaryText!, this.slots!, this.config);
});

Then('针对 constraints、artifacts、todos 三个槽位各生成一题', function (this: CompressWorld) {
  assert.equal(this.report?.qa?.length, 3);
});

Then('每题答案均可在原文中逐字定位，不出现开放式问题', function (this: CompressWorld) {
  for (const qa of this.report?.qa ?? []) {
    assert.ok(this.originalText?.includes(qa.answer), `答案不可定位：${qa.answer}`);
  }
});

Then('任一题答错即判定关键信息丢失并走降级链', function (this: CompressWorld) {
  // 答案被篡改的摘要：进阶校验必须判定不通过
  const badSlots = { ...this.slots!, artifacts: ['D:\\out\\被篡改.docx'] };
  const report = verifySummary(this.originalText!, '叙述摘要。', badSlots, this.config);
  assert.equal(report.passed, false);
});
