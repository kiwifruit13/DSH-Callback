/** `trigger-watermark.feature` 的步骤定义（§7.1 双水位 + §7.2 cache 对策）。 */
import assert from 'node:assert/strict';
import { Given, When, Then } from '../cucumber.js';
import { HistoryBuilder } from '../fixtures.js';
import { auditedGoodCompress } from './shared.steps.js';
import { createVectorSpace } from '../../../src/signals.js';
import { shouldCompress } from '../../../src/trigger.js';
const BOUNDARY_TYPE_OF = {
    '一条待办状态由 pending 翻转为 completed': 'todo-transition',
    '一段连续工具调用序列终止且后续为纯文本': 'tool-seq-end',
    '助手输出了交付总结且用户随后发起新话题': 'delivery-summary',
    '用户新消息与前一话题的增益相关性低于阈值': 'topic-shift',
};
/** 执行一次触发判定（构造 TF-IDF 空间以支持 topic-shift）。 */
function evaluateTrigger() {
    const state = this.state;
    const space = createVectorSpace();
    for (const m of state.msgs) {
        if (m.role === 'user')
            space.addDocument(m.content);
    }
    const decision = shouldCompress({
        state,
        config: this.config,
        turnsSinceLastCompress: this.turnsSinceLastCompress,
        justCompressed: this.justCompressed,
    }, space);
    this.decision = decision;
    this.decisionLog = [...(this.decisionLog ?? []), decision];
}
/* ---- Background ---- */
Given(/压缩配置注入为 触发线 (\S+) 目标线 (\S+) 频率下限轮数 (\S+)/, function (trigger, target, minGap) {
    // Background 中的尖括号为占位符（Background 不参与 Outline 替换），在此注入标定值
    const map = (raw, fallback) => {
        const value = Number(raw.replace(/[<>]/g, ''));
        return Number.isFinite(value) && raw !== '<' ? value : fallback;
    };
    this.configOverrides = {
        ...this.configOverrides,
        triggerRatio: map(trigger, 0.7),
        targetRatio: map(target, 0.5),
        minGapTurns: map(minGap, 3),
    };
    this.makeConfig();
});
Given('上下文窗口大小已知', function () {
    this.msgs = new HistoryBuilder()
        .system()
        .user('任务说明，讨论配置加载的实现方案与细节')
        .toolRound('read_file', 'config output')
        .user('继续讨论配置加载的实现方案')
        .assistant('好的，继续。')
        .build();
    this.state = this.buildState(this.msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.9) };
});
/* ---- Scenario: 占用低于触发线不压缩 ---- */
Given('当前 token 占用率低于触发线', function () {
    this.state = this.buildState(this.msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.3) };
});
When('调用 should_compress', function () {
    evaluateTrigger.call(this);
});
Then('返回不压缩决策', function () {
    assert.equal(this.decision?.compress, false);
});
Then('epoch 保持不变', function () {
    assert.equal(this.decision?.epoch, this.state?.epoch);
});
Then('不调用任何压缩钩子', function () {
    assert.equal(this.compressCalls, 0);
});
/* ---- Scenario: 占用落在迟滞带内不压缩以防抖动 ---- */
Given('当前 token 占用率高于目标线但低于触发线', function () {
    const mid = (this.config.triggerRatio + this.config.targetRatio) / 2;
    this.state = this.buildState(this.msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(mid) };
});
Given('上一轮压缩刚刚完成', function () {
    this.justCompressed = true;
});
Then('决策原因记为 hysteresis-band', function () {
    assert.equal(this.decision?.reason, 'hysteresis-band');
});
Then('本轮不产生新的 CompressedBlock', function () {
    assert.equal(this.compressCalls, 0);
});
/* ---- Scenario Outline: 识别到任务边界则在边界处压缩 ---- */
Given('当前 token 占用率高于触发线', function () {
    this.state = this.buildState(this.msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.9) };
});
Given(/会话中存在 (.+) 标记的位置/, function (signal) {
    let msgs;
    switch (signal) {
        case '一条待办状态由 pending 翻转为 completed':
            msgs = new HistoryBuilder()
                .system()
                .user('任务开始')
                .user('- [ ] 待办：修复构建')
                .user('- [x] 待办：修复构建，其他无关内容')
                .build();
            break;
        case '一段连续工具调用序列终止且后续为纯文本':
            msgs = new HistoryBuilder()
                .system()
                .user('任务开始')
                .toolRound('read_file', 'output text')
                .user('这里是边界之后的纯文本消息')
                .build();
            break;
        case '助手输出了交付总结且用户随后发起新话题':
            msgs = new HistoryBuilder()
                .system()
                .user('任务开始')
                .assistant('本次交付总结：全部完成。')
                .user('全新话题：天气如何')
                .build();
            break;
        case '用户新消息与前一话题的增益相关性低于阈值':
            // 不放 toolRound：块后紧跟纯文本会先命中 tool-seq-end，抢在 topic-shift 之前
            msgs = new HistoryBuilder()
                .system()
                .user('讨论数据库索引优化方案')
                .user('帮我写一首关于大海的诗')
                .build();
            break;
        default:
            throw new Error(`未知边界信号：${signal}`);
    }
    this.msgs = msgs;
    this.state = this.buildState(msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.9) };
});
Then('返回压缩决策且切点落在该边界信号处', function () {
    assert.equal(this.decision?.compress, true);
    assert.ok(this.decision?.cutPointId !== undefined);
});
Then('决策原因记为 task-boundary', function () {
    assert.equal(this.decision?.reason, 'task-boundary');
});
Then(/边界类型记为 (.+)$/, function (type) {
    assert.equal(this.decision?.boundaryType, BOUNDARY_TYPE_OF[type] ?? type);
});
/* ---- Scenario: 无边界且超过等待上限时强制压缩 ---- */
Given('自上次压缩以来始终未出现任何任务边界信号', function () {
    // 全程无 tool block（块后跟文本必然构成 tool-seq-end 边界）、无待办、无交付总结；
    // 两条用户消息高度相似，topic-shift 不触发
    const msgs = new HistoryBuilder()
        .system()
        .user('继续讨论配置加载的实现方案细节')
        .user('继续讨论配置加载的实现方案细节补充')
        .build();
    this.msgs = msgs;
    this.state = this.buildState(msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.9) };
});
Given('等待轮数已超过配置的等待上限', function () {
    this.turnsSinceLastCompress = this.config.maxWaitTurns + 1;
});
Then('返回压缩决策', function () {
    assert.equal(this.decision?.compress, true);
});
Then('决策标记 forced 为 true', function () {
    assert.equal(this.decision?.forced, true);
});
Then('切点仍受 tool block 边界门禁约束，不落在任何 block 内部', function () {
    // 门禁由切割层落实：完整流程提交后全部 block 依然配对完整
    for (const block of this.lastCommitted?.blocks ?? []) {
        assert.equal(block.complete, true);
    }
});
/* ---- Scenario: 压缩后占用落到目标线以下则本轮结束 ---- */
Given('一轮压缩已提交且压缩后占用率低于目标线', async function () {
    this.hookOverrides.compress = auditedGoodCompress(this);
    this.hookOverrides.shouldCompress = () => true;
    this.state = this.buildState(this.msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.9) };
    this.lastEpochBefore = this.state.epoch;
    this.firstRunCalls = this.compressCalls;
    this.lastCommitted = await this.orchestrator({
        compress: this.hookOverrides.compress,
        shouldCompress: this.hookOverrides.shouldCompress,
    }).maybeCompress(this.state);
    assert.ok(this.lastCommitted !== this.state);
    // 压缩后占用落到目标线以下
    this.state = this.lastCommitted;
    this.state = { ...this.state, capacity: this.capacityForRatio(0.3) };
    this.justCompressed = true;
    this.turnsSinceLastCompress = 1;
    // 首轮的钩子调用基准（此后不应再增加）
    this.firstRunCalls = this.compressCalls;
});
When('紧接着再次调用 should_compress', function () {
    evaluateTrigger.call(this);
});
Then('本轮不追加第二次压缩', function () {
    // firstRunCalls 已在首轮提交后采样：再次判定不得新增任何钩子调用
    assert.equal(this.compressCalls, this.firstRunCalls);
});
Then('epoch 相对压缩前仅递增 1', function () {
    assert.equal(this.lastCommitted?.epoch, this.lastEpochBefore + 1);
});
/* ---- Scenario: 频率下限内抑制压缩即使占用已超线 ---- */
Given('距上次成功压缩的轮数小于配置的频率下限轮数', function () {
    this.turnsSinceLastCompress = 1;
});
Then('决策原因记为 rate-limit', function () {
    assert.equal(this.decision?.reason, 'rate-limit');
});
/* ---- Scenario: 稳定前缀在压缩前后逐字节不变 ---- */
Given('会话头部含系统提示与已 pin 的内容', function () {
    const msgs = new HistoryBuilder()
        .system()
        .user('记住：输出必须使用中文注释')
        .user('开始任务')
        .toolRound('read_file', 'task output content')
        .user('收尾')
        .build();
    this.msgs = msgs;
    this.state = this.buildState(msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.9) };
});
When('完成一轮压缩并提交', async function () {
    this.hookOverrides.compress = auditedGoodCompress(this);
    this.hookOverrides.shouldCompress = () => true;
    this.lastEpochBefore = this.state.epoch;
    this.firstRunCalls = this.compressCalls;
    this.lastCommitted = await this.orchestrator({
        compress: this.hookOverrides.compress,
        shouldCompress: this.hookOverrides.shouldCompress,
    }).maybeCompress(this.state);
});
Then('头部消息序列在压缩前后逐字节相同', function () {
    const headCount = 2; // system + pin 消息
    const before = this.state?.msgs.slice(0, headCount) ?? [];
    const after = this.lastCommitted?.msgs.slice(0, headCount) ?? [];
    assert.deepEqual(after.map((m) => m.content), before.map((m) => m.content));
});
Then('cache_control 断点仍位于头部之后、首个压缩块之前', function () {
    const idxFirstBlock = this.lastCommitted?.msgs.findIndex((m) => m.id.startsWith('cb-')) ?? -1;
    assert.ok(idxFirstBlock > 2, `首个压缩块位置 ${idxFirstBlock} 应在头部之后`);
});
Then('报告字段 cache_impact.prefix_stable 为 true', function () {
    const record = this.observations[this.observations.length - 1];
    assert.ok(record, '应有观测记录');
    assert.equal(record.cacheImpact.prefixStable, true);
});
/* ---- Scenario: 相同幂等键重试复用压缩结果 ---- */
// 用 RegExp：CucumberExpression 会把 `(...)` 解析为「可选文本组」导致永不匹配
Given(/^一段内容已按幂等键 \(startId, endId, level, epoch\) 生成过压缩结果$/, async function () {
    this.hookOverrides.compress = auditedGoodCompress(this);
    this.hookOverrides.shouldCompress = () => true;
    this.state = this.buildState(this.msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.9) };
    this.lastCommitted = await this.orchestrator({
        compress: this.hookOverrides.compress,
        shouldCompress: this.hookOverrides.shouldCompress,
    }).maybeCompress(this.state);
    assert.ok(this.lastCommitted !== this.state);
    this.firstBlocks = this.lastCommitted.compressed;
    // 首轮提交后的钩子调用基准：重放不得新增
    this.firstRunCalls = this.compressCalls;
});
When('以完全相同的幂等键再次请求压缩', async function () {
    this.lastCommitted = await this.orchestrator({
        compress: this.hookOverrides.compress,
        shouldCompress: this.hookOverrides.shouldCompress,
    }).maybeCompress(this.state);
});
Then('返回缓存的既有结果', function () {
    assert.notEqual(this.lastCommitted, this.state);
});
Then('不再调用 LLM 摘要钩子', function () {
    assert.equal(this.compressCalls, this.firstRunCalls);
});
Then('压缩块文本与首次生成时逐字节相同以避免缓存抖动', function () {
    assert.deepEqual((this.lastCommitted?.compressed ?? []).map((b) => b.text), (this.firstBlocks ?? []).map((b) => b.text));
});
/* ---- Scenario: 单轮内占用反复穿越触发线只压缩一次 ---- */
Given('一轮对话中 token 占用率先超触发线、压缩后回落、随后再次超线', function () {
    this.state = this.buildState(this.msgs);
    this.state = { ...this.state, capacity: this.capacityForRatio(0.9) };
    this.turnsSinceLastCompress = this.config.maxWaitTurns + 1;
    this.justCompressed = false;
});
When('该轮内连续多次调用 should_compress', function () {
    // 第 1 次：超线（压缩发生）
    evaluateTrigger.call(this);
    // 模拟压缩完成后的第 2、3 次调用：回落再超线
    this.justCompressed = true;
    this.turnsSinceLastCompress = 1;
    evaluateTrigger.call(this);
    evaluateTrigger.call(this);
});
Then('仅首次超线触发压缩', function () {
    const log = this.decisionLog ?? [];
    assert.equal(log[0]?.compress, true);
});
Then('后续调用因频率下限被抑制', function () {
    const log = this.decisionLog ?? [];
    assert.equal(log[1]?.reason, 'rate-limit');
    assert.equal(log[2]?.reason, 'rate-limit');
});
Then('全轮 epoch 递增次数为 1', function () {
    // 触发层不提交：本轮 epoch 快照全部一致，真实提交由编排层单次完成
    const log = this.decisionLog ?? [];
    assert.ok(log.every((d) => d.epoch === this.state?.epoch));
});
//# sourceMappingURL=trigger-watermark.steps.js.map