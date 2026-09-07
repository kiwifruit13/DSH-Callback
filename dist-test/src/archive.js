/**
 * 原文归档与按需回溯。
 *
 * 归档是 §1.3「语义反转」能成立的物质基础：没有它，「下沉不删除」就是一句空话。
 *
 * 契约要点（`rehydrate` 八个场景）：
 * - 只追加不覆盖，既有行的字节偏移不变；
 * - 重复 `source_hash` 不产生冗余行（多块共享同一段原文时只存一份）；
 * - 索引丢失可从 JSONL 全量重建，且重建过程不修改文件；
 * - 哈希不一致一律抛 {@link ArchiveCorrupted}，绝不返回部分内容；
 * - 归档不可用时禁止有损下沉，但仍允许 L1 无损裁剪。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArchiveCorrupted, ArchiveUnavailable } from './contract.js';
/** 默认哈希：SHA-256 十六进制。 */
export const defaultHash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/**
 * 消息序列的规范化序列化。
 * 显式列出字段顺序，避免属性顺序变化导致同一内容算出不同哈希。
 */
function canonicalize(msgs) {
    return JSON.stringify(msgs.map((m) => [
        m.id,
        m.role,
        m.content,
        m.toolCallId ?? null,
        m.toolCalls === undefined ? null : m.toolCalls.map((c) => [c.id, c.name, c.args ?? null]),
        m.raw === undefined ? null : m.raw,
        m.vendor ?? 'generic',
    ]));
}
/** 一批原文的 source_hash。 */
export function hashMessages(msgs, hash = defaultHash) {
    return hash(canonicalize(msgs));
}
/* ============================================================================
 * Sink 实现
 * ========================================================================== */
/**
 * 内存归档 sink。
 * 无文件系统权限或不想落盘时的等价实现，语义与 JSONL 版一致（只追加、偏移单调）。
 */
export class MemoryArchiveSink {
    records = [];
    cursor = 0;
    async append(record) {
        const line = JSON.stringify({ ...record, offset: this.cursor });
        const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
        const offset = this.cursor;
        this.records.push({ ...record, offset });
        this.cursor += bytes;
        return offset;
    }
    async read(ref) {
        return this.records.find((r) => r.ref === ref) ?? null;
    }
    async *readAll() {
        for (const record of this.records)
            yield record;
    }
    available() {
        return true;
    }
}
/** JSONL 追加文件归档 sink。 */
export class JsonlArchiveSink {
    filePath;
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
    }
    async append(record) {
        this.ensureDir();
        const offset = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
        const line = `${JSON.stringify({ ...record, offset })}\n`;
        fs.appendFileSync(this.filePath, line, 'utf8');
        return offset;
    }
    async read(ref) {
        for await (const record of this.readAll()) {
            if (record.ref === ref)
                return record;
        }
        return null;
    }
    async *readAll() {
        if (!fs.existsSync(this.filePath))
            return;
        const text = fs.readFileSync(this.filePath, 'utf8');
        for (const line of text.split('\n')) {
            if (line.trim().length === 0)
                continue;
            try {
                yield JSON.parse(line);
            }
            catch {
                // 损坏行跳过：归档已损坏时由哈希校验兜底，不让解析错误带崩整个流程
            }
        }
    }
    available() {
        try {
            this.ensureDir();
            fs.appendFileSync(this.filePath, '', 'utf8');
            return true;
        }
        catch {
            return false;
        }
    }
    ensureDir() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    }
}
/**
 * 创建归档门面。
 * `sink` 为 null 表示无归档能力：此时 `archive()` 恒返回 null、`isAvailable()` 恒为 false。
 */
export function createArchive(sink, hash = defaultHash) {
    /** hash → ref，用于「重复原文只存一份」。 */
    const byHash = new Map();
    /** ref → 记录（含 offset），用于快速读取。 */
    const byRef = new Map();
    const indexOf = (record) => {
        byRef.set(record.ref, record);
        if (!byHash.has(record.hash)) {
            byHash.set(record.hash, { ref: record.ref, offset: record.offset, hash: record.hash });
        }
    };
    const rebuildIndex = async () => {
        byHash.clear();
        byRef.clear();
        if (sink === null)
            return 0;
        for await (const record of sink.readAll())
            indexOf(record);
        return byRef.size;
    };
    // 首次使用时惰性重建：归档模块初始化即扫描 JSONL 建立 ref → 偏移索引
    let initialized = false;
    const ensureInit = async () => {
        if (initialized)
            return;
        initialized = true;
        await rebuildIndex();
    };
    return {
        async isAvailable() {
            return sink !== null && (await sink.available());
        },
        async archive(msgs, vendor = 'generic') {
            if (sink === null || msgs.length === 0)
                return null;
            await ensureInit();
            if (!(await sink.available()))
                return null;
            const contentHash = hashMessages(msgs, hash);
            const existing = byHash.get(contentHash);
            // 同一段原文被多个压缩块共享时只存储一份
            if (existing !== undefined)
                return existing;
            const ref = `arch-${contentHash.slice(0, 16)}`;
            const offset = await sink.append({ ref, hash: contentHash, msgs, vendor });
            const pointer = { ref, offset, hash: contentHash };
            byHash.set(contentHash, pointer);
            byRef.set(ref, { ref, offset, hash: contentHash, msgs, vendor });
            return pointer;
        },
        async rehydrate(ref) {
            if (sink === null)
                throw new ArchiveUnavailable('未配置归档存储，无法回溯原文');
            await ensureInit();
            let record = byRef.get(ref.ref);
            if (record === undefined) {
                if (!(await sink.available()))
                    throw new ArchiveUnavailable('归档存储不可用，无法回溯原文');
                const found = await sink.read(ref.ref);
                if (found === null)
                    throw new ArchiveCorrupted(`归档指针 ${ref.ref} 不存在`);
                record = found;
            }
            // 先比指针自带哈希，再重算内容哈希，两道都过才算内容未被篡改
            if (record.hash !== ref.hash) {
                throw new ArchiveCorrupted(`归档 ${ref.ref} 的 source_hash 与指针不一致`, {
                    expected: ref.hash,
                    actual: record.hash,
                });
            }
            const actual = hashMessages(record.msgs, hash);
            if (actual !== record.hash) {
                throw new ArchiveCorrupted(`归档 ${ref.ref} 的内容哈希不一致`, {
                    expected: record.hash,
                    actual,
                });
            }
            return record.msgs;
        },
        rebuildIndex,
        size() {
            return byRef.size;
        },
    };
}
//# sourceMappingURL=archive.js.map