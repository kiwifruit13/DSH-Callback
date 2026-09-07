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
import type { ArchiveRecord, ArchiveSink } from './config.js';
import type { ArchiveRef, Message } from './contract.js';
import { ArchiveCorrupted, ArchiveUnavailable } from './contract.js';

/** 哈希函数。宿主可注入（例如浏览器环境替换 node:crypto）。 */
export type HashFn = (text: string) => string;

/** 默认哈希：SHA-256 十六进制。 */
export const defaultHash: HashFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 消息序列的规范化序列化。
 * 显式列出字段顺序，避免属性顺序变化导致同一内容算出不同哈希。
 */
function canonicalize(msgs: readonly Message[]): string {
  return JSON.stringify(
    msgs.map((m) => [
      m.id,
      m.role,
      m.content,
      m.toolCallId ?? null,
      m.toolCalls === undefined ? null : m.toolCalls.map((c) => [c.id, c.name, c.args ?? null]),
      m.raw === undefined ? null : m.raw,
      m.vendor ?? 'generic',
    ]),
  );
}

/** 一批原文的 source_hash。 */
export function hashMessages(msgs: readonly Message[], hash: HashFn = defaultHash): string {
  return hash(canonicalize(msgs));
}

/* ============================================================================
 * Sink 实现
 * ========================================================================== */

/**
 * 内存归档 sink。
 * 无文件系统权限或不想落盘时的等价实现，语义与 JSONL 版一致（只追加、偏移单调）。
 */
export class MemoryArchiveSink implements ArchiveSink {
  private readonly records: ArchiveRecord[] = [];
  private cursor = 0;

  async append(record: Omit<ArchiveRecord, 'offset'>): Promise<number> {
    const line = JSON.stringify({ ...record, offset: this.cursor });
    const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
    const offset = this.cursor;
    this.records.push({ ...record, offset });
    this.cursor += bytes;
    return offset;
  }

  async read(ref: string): Promise<ArchiveRecord | null> {
    return this.records.find((r) => r.ref === ref) ?? null;
  }

  async *readAll(): AsyncIterable<ArchiveRecord> {
    for (const record of this.records) yield record;
  }

  available(): boolean {
    return true;
  }
}

/** JSONL 追加文件归档 sink。 */
export class JsonlArchiveSink implements ArchiveSink {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async append(record: Omit<ArchiveRecord, 'offset'>): Promise<number> {
    this.ensureDir();
    const offset = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    const line = `${JSON.stringify({ ...record, offset })}\n`;
    fs.appendFileSync(this.filePath, line, 'utf8');
    return offset;
  }

  async read(ref: string): Promise<ArchiveRecord | null> {
    for await (const record of this.readAll()) {
      if (record.ref === ref) return record;
    }
    return null;
  }

  async *readAll(): AsyncIterable<ArchiveRecord> {
    if (!fs.existsSync(this.filePath)) return;
    const text = fs.readFileSync(this.filePath, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        yield JSON.parse(line) as ArchiveRecord;
      } catch {
        // 损坏行跳过：归档已损坏时由哈希校验兜底，不让解析错误带崩整个流程
      }
    }
  }

  available(): boolean {
    try {
      this.ensureDir();
      fs.appendFileSync(this.filePath, '', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/* ============================================================================
 * Archive 门面
 * ========================================================================== */

/** 归档存储门面。 */
export interface Archive {
  /** 存储是否可用。不可用时应禁止有损下沉。 */
  isAvailable(): Promise<boolean>;
  /**
   * 归档一段原文。相同内容只存一次，返回既有或新建的指针。
   * 归档不可用时返回 null，由调用方决定是否拒绝下沉。
   */
  archive(msgs: readonly Message[], vendor?: string): Promise<ArchiveRef | null>;
  /** 凭指针取回原文。哈希不一致抛 {@link ArchiveCorrupted}。 */
  rehydrate(ref: ArchiveRef): Promise<readonly Message[]>;
  /** 重建索引，返回条目数。用于进程重启后索引丢失的场景。 */
  rebuildIndex(): Promise<number>;
  /** 当前归档条目数。 */
  size(): number;
}

/**
 * 创建归档门面。
 * `sink` 为 null 表示无归档能力：此时 `archive()` 恒返回 null、`isAvailable()` 恒为 false。
 */
export function createArchive(sink: ArchiveSink | null, hash: HashFn = defaultHash): Archive {
  /** hash → ref，用于「重复原文只存一份」。 */
  const byHash = new Map<string, ArchiveRef>();
  /** ref → 记录（含 offset），用于快速读取。 */
  const byRef = new Map<string, ArchiveRecord>();

  const indexOf = (record: ArchiveRecord): void => {
    byRef.set(record.ref, record);
    if (!byHash.has(record.hash)) {
      byHash.set(record.hash, { ref: record.ref, offset: record.offset, hash: record.hash });
    }
  };

  const rebuildIndex = async (): Promise<number> => {
    byHash.clear();
    byRef.clear();
    if (sink === null) return 0;
    for await (const record of sink.readAll()) indexOf(record);
    return byRef.size;
  };

  // 首次使用时惰性重建：归档模块初始化即扫描 JSONL 建立 ref → 偏移索引
  let initialized = false;
  const ensureInit = async (): Promise<void> => {
    if (initialized) return;
    initialized = true;
    await rebuildIndex();
  };

  return {
    async isAvailable(): Promise<boolean> {
      return sink !== null && (await sink.available());
    },

    async archive(msgs: readonly Message[], vendor = 'generic'): Promise<ArchiveRef | null> {
      if (sink === null || msgs.length === 0) return null;
      await ensureInit();
      if (!(await sink.available())) return null;

      const contentHash = hashMessages(msgs, hash);
      const existing = byHash.get(contentHash);
      // 同一段原文被多个压缩块共享时只存储一份
      if (existing !== undefined) return existing;

      const ref = `arch-${contentHash.slice(0, 16)}`;
      const offset = await sink.append({ ref, hash: contentHash, msgs, vendor });
      const pointer: ArchiveRef = { ref, offset, hash: contentHash };
      byHash.set(contentHash, pointer);
      byRef.set(ref, { ref, offset, hash: contentHash, msgs, vendor });
      return pointer;
    },

    async rehydrate(ref: ArchiveRef): Promise<readonly Message[]> {
      if (sink === null) throw new ArchiveUnavailable('未配置归档存储，无法回溯原文');
      await ensureInit();

      let record = byRef.get(ref.ref);
      if (record === undefined) {
        if (!(await sink.available())) throw new ArchiveUnavailable('归档存储不可用，无法回溯原文');
        const found = await sink.read(ref.ref);
        if (found === null) throw new ArchiveCorrupted(`归档指针 ${ref.ref} 不存在`);
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

    size(): number {
      return byRef.size;
    },
  };
}
