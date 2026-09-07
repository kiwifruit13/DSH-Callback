/**
 * 契约测试世界（E1）。
 *
 * 职责（todo E1）：
 * - ContextState fixture 的构建与持有；
 * - stub compressor：截断式 / 固定槽位式（见 fixtures.ts）；
 * - 配置注入：场景内一切阈值经 makeConfig 注入，不硬编码；
 * - 临时归档目录隔离（JSONL sink 落 os.tmpdir()，场景结束清理）；
 * - 统一收集观测记录、告警、错误与压缩钩子调用计数。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { After, setWorldConstructor, World } from './cucumber.js';
import { defaultTokenCounter, resolveConfig } from '../../src/config.js';
import { createOrchestrator } from '../../src/orchestrator.js';
import { createArchive, JsonlArchiveSink, MemoryArchiveSink } from '../../src/archive.js';
import { parseToolBlocks, totalTokens } from '../../src/blocks.js';
export class CompressWorld extends World {
    /** 场景级配置覆盖（Background 里的「配置注入为…」写入这里）。 */
    configOverrides = {};
    config = resolveConfig();
    /** 当前会话消息与派生态。 */
    msgs = [];
    state = null;
    blocks = [];
    segments = [];
    pins = [];
    assignments = [];
    decision = null;
    report = null;
    lastError = null;
    /** 观测与告警。 */
    observations = [];
    warnings = [];
    /** 按告警名计数：select_abort → select_abort_count 等。 */
    metrics = {};
    /** compress 钩子调用审计。 */
    compressCalls = 0;
    compressInputs = [];
    compressTexts = [];
    /** 提交结果与归档。 */
    lastCommitted = null;
    sink = null;
    archive = null;
    tmpDir = null;
    /** 触发判定上下文（场景显式设置，缺省视为从未压缩过）。 */
    turnsSinceLastCompress = Number.MAX_SAFE_INTEGER;
    justCompressed = false;
    /** pin / gain 场景的辅助状态。 */
    pinnedMsgId = null;
    pinnedSegmentId = null;
    anchorOverride = null;
    counterexample = null;
    /** 场景注入的钩子覆盖（抛异常钩子、自定义 stub 等经此进入流程）。 */
    hookOverrides = {};
    /** 场景直接构造的消息（tool block 解析场景用）。 */
    pendingMsgs = [];
    /** 段文本表（预算分配的单元级场景用）。 */
    segmentTexts = new Map();
    /** 已保留文本（冗余度对照物）。 */
    retainedTexts = [];
    /** 压缩前 epoch 快照。 */
    lastEpochBefore = 0;
    /** 场景内持久编排器（幂等 / 并发 / CAS 场景必须复用同一实例）。 */
    cachedOrchestrator = null;
    /** 场景直接构造的门面实例（「只实现 compress」场景用）。 */
    pendingCompressor = null;
    /** 场景级暂存文本（路径断言等）。 */
    winPath = null;
    /* 以下为各 feature 步骤的场景级暂存。 */
    l2Block = null;
    l1Result = null;
    tamperedRef = null;
    slots = null;
    slotMissing = null;
    originalText = null;
    callsBeforeResink = 0;
    /* atomicity-idempotency 场景暂存 */
    nextMsgs = null;
    assertPins = null;
    tokenDeviationCase = false;
    firstRunCalls = 0;
    concurrentResults = null;
    staleState = null;
    /* trigger-watermark 场景暂存 */
    decisionLog = null;
    firstBlocks = null;
    /* gain-budget / entity-verify 场景暂存 */
    lowestBlock = null;
    mixedText = null;
    mixedTokens = null;
    l2SummaryText = null;
    verifyCallCount = 0;
    summaryText = null;
    entityCategory = null;
    verifyFullFlow = false;
    /* rehydrate 场景暂存 */
    blockUnderTest = null;
    rehydratedMsgs = null;
    jsonlBefore = null;
    sizeBeforeAppend = 0;
    rebuiltCount = null;
    sharedBlocks = null;
    sharedRehydrated = null;
    /** 合并 configOverrides 与临时覆盖，产出本场景生效配置。 */
    makeConfig(overrides = {}) {
        this.config = resolveConfig({
            // 测试注入：中部区间最大化，保证 block 落入可压缩区（tailTurns 属配置项，可被覆盖）
            tailTurns: 1,
            ...this.configOverrides,
            ...overrides,
            countTokens: defaultTokenCounter,
            archive: this.sink,
            onWarning: (warning) => {
                this.warnings.push(warning);
                this.metrics[warning] = (this.metrics[warning] ?? 0) + 1;
            },
            onObservation: (record) => {
                this.observations.push(record);
            },
        });
        return this.config;
    }
    /** 由消息序列构建 ContextState（解析 tool block、计算 token）。 */
    buildState(msgs, opts = {}) {
        const config = this.config;
        const blocks = parseToolBlocks(msgs, config.countTokens);
        const tokens = totalTokens(msgs, config.countTokens);
        const state = {
            msgs: [...msgs],
            epoch: opts.epoch ?? 0,
            blocks,
            pins: opts.pins ?? [],
            compressed: opts.compressed ?? [],
            tokens,
            capacity: opts.capacity ?? tokens + 1, // 缺省容量刚好超线：占用率 > 1
        };
        this.msgs = [...msgs];
        this.state = state;
        this.blocks = blocks;
        return state;
    }
    /** 令当前 token 占用率等于 ratio（capacity = tokens / ratio）。 */
    capacityForRatio(ratio) {
        const tokens = this.state?.tokens ?? 0;
        return Math.max(1, Math.ceil(tokens / ratio));
    }
    /** 用当前配置与给定回调创建编排器；同一场景内复用同一实例（幂等 / CAS 依赖）。 */
    orchestrator(callbacks) {
        this.cachedOrchestrator ??= createOrchestrator({ config: this.config, callbacks });
        return this.cachedOrchestrator;
    }
    /** 重置每轮压缩的临时观测（不清 configOverrides）。 */
    resetRoundState() {
        this.observations = [];
        this.warnings = [];
        this.metrics = {};
        this.lastError = null;
        this.report = null;
    }
    /** 创建内存归档（默认）。 */
    useMemoryArchive() {
        this.sink = new MemoryArchiveSink();
        this.archive = createArchive(this.sink);
        return this.archive;
    }
    /** 创建隔离于系统临时目录的 JSONL 归档。 */
    useJsonlArchive(fileName = 'archive.jsonl') {
        this.tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cb-'));
        this.sink = new JsonlArchiveSink(path.join(this.tmpDir, fileName));
        this.archive = createArchive(this.sink);
        return this.archive;
    }
    /** JSONL 文件的绝对路径（索引重建场景直接读文件用）。 */
    jsonlPath(fileName = 'archive.jsonl') {
        this.tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cb-'));
        return path.join(this.tmpDir, fileName);
    }
}
setWorldConstructor(CompressWorld);
After(function () {
    if (this.tmpDir !== null) {
        fs.rmSync(this.tmpDir, { recursive: true, force: true });
        this.tmpDir = null;
    }
});
//# sourceMappingURL=world.js.map