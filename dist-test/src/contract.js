/**
 * 公共契约层：本文件只声明类型、枚举与错误，**不包含任何实现、不产生任何副作用**。
 *
 * 设计约束（来自 Gherkin 契约）：
 * - 全部阈值走 {@link CompressConfig} 注入，本文件不出现任何待标定数字；
 * - 唯一硬编码常量是 {@link HARD_ENTITY_RETAIN_REQUIRED} = 1.0，它是契约本身而非阈值；
 * - 所有集合默认 `readonly`，消息序列以不可变数组持有（§9.2 原子性前提）。
 */
/**
 * pin 理由优先级（由高到低）。
 * 同一内容命中多个识别信号时，只产生一条 pin 记录，reason 取优先级更高的那一种。
 */
export const PIN_REASON_PRIORITY = [
    'tool-block-incomplete',
    'system-prompt',
    'user-constraint',
    'permission-grant',
    'deliverable-path',
    'user-remember',
    'latest-user-intent',
    'error-critical',
    'open-todo',
];
/** 硬实体类别集合。这些类别的保留率要求恒为 1.0。 */
export const HARD_ENTITY_CATEGORIES = [
    'windows-path',
    'posix-path',
    'url',
    'uuid-or-hash',
    'command-symbol',
];
/**
 * 硬实体保留率要求。
 * 它不是阈值而是契约本身：路径、URL、UUID、命令符号错一个字符，
 * Agent 就会对错误目标执行破坏性操作，因此没有标定空间。
 */
export const HARD_ENTITY_RETAIN_REQUIRED = 1.0;
/** 压缩错误基类。 */
export class CompressError extends Error {
    code;
    /** 结构化上下文，便于宿主环境记录与上报。 */
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'CompressError';
        this.code = code;
        this.details = details;
    }
}
/** 三级降级链全部失败。上下文必须保持逐字节原样。 */
export class NoCompressionPossible extends CompressError {
    constructor(message = 'llm、heuristic、truncate 三级均无法产出合法结果', details = {}) {
        super('no-compression-possible', message, details);
        this.name = 'NoCompressionPossible';
    }
}
/** 归档内容哈希与实际内容不一致，拒绝回溯、拒绝基于它的下沉。 */
export class ArchiveCorrupted extends CompressError {
    constructor(message = '归档内容与 source_hash 不一致', details = {}) {
        super('archive-corrupted', message, details);
        this.name = 'ArchiveCorrupted';
    }
}
/** 归档不可用。禁止有损下沉，但仍允许无归档需求的 L1 无损裁剪。 */
export class ArchiveUnavailable extends CompressError {
    constructor(message = '归档存储不可用', details = {}) {
        super('archive-unavailable', message, details);
        this.name = 'ArchiveUnavailable';
    }
}
/** 用户钩子抛异常。携带钩子名，便于区分 shouldCompress / onPreCompress / selectSegment 等不同处置方向。 */
export class HookError extends CompressError {
    hook;
    constructor(hook, cause) {
        super('hook-error', `钩子 ${hook} 抛出异常`, { hook, cause });
        this.name = 'HookError';
        this.hook = hook;
    }
}
/** 提交前断言失败。整体回滚，告警必须指明失败的断言项。 */
export class CommitAssertFailed extends CompressError {
    /** 失败的断言项：配对完整 / pin 在位 / token 一致。 */
    assertion;
    constructor(assertion, message, details = {}) {
        super('commit-assert-failed', message, { assertion, ...details });
        this.name = 'CommitAssertFailed';
        this.assertion = assertion;
    }
}
//# sourceMappingURL=contract.js.map