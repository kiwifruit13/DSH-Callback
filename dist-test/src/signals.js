/**
 * 文本向量化：中文 bigram + 拉丁词 + 路径/命令整体 token 的 TF-IDF。
 *
 * 守护 `gain-budget` 的混排场景：
 * - 中文部分以**字符二元组**切分，拉丁部分以空白与标点切分；
 * - 文件路径与代码符号作为**整体 token** 参与计算，不被拆碎；
 * - 全过程不加载任何外部分词依赖、不产生任何网络调用；
 * - 关闭 embedding 时这是唯一的向量化来源（§1.4 退化路径）。
 */
import { RE_COMMAND, RE_HASH, RE_POSIX_PATH, RE_URL, RE_UUID, RE_WINDOWS_PATH, matchAll, } from './patterns.js';
/** CJK 统一表意区 + 假名区。 */
const CJK = '[㐀-䶿一-鿿぀-ヿ]';
const SEGMENT_RE = new RegExp(`(${CJK}+)|([A-Za-z0-9_]+)`, 'g');
/** 纯文本片段切分：CJK 段做字符二元组，拉丁词整体小写。 */
function textTokens(fragment) {
    const out = [];
    SEGMENT_RE.lastIndex = 0;
    let m;
    while ((m = SEGMENT_RE.exec(fragment)) !== null) {
        if (m[1] !== undefined) {
            const chars = [...m[1]];
            if (chars.length === 1) {
                out.push(chars[0]);
            }
            else {
                for (let i = 0; i < chars.length - 1; i++)
                    out.push(chars[i] + chars[i + 1]);
            }
        }
        else if (m[2] !== undefined) {
            out.push(m[2].toLowerCase());
        }
    }
    return out;
}
/** 整体 token 的匹配正则。顺序即优先级：URL 必须先于 POSIX 路径，否则会被拆散。 */
const COMPOSITE_PATTERNS = [RE_URL, RE_WINDOWS_PATH, RE_UUID, RE_COMMAND, RE_HASH, RE_POSIX_PATH];
/**
 * 分词。路径、URL、UUID、命令、哈希作为整体 token；
 * 其余文本按 CJK bigram + 拉丁词切分。确定性输出。
 */
export function splitTokens(text) {
    // 先收集整体 token 的区间，互不重叠（先到先得，按 COMPOSITE_PATTERNS 优先级）
    const marks = [];
    for (const pattern of COMPOSITE_PATTERNS) {
        for (const m of matchAll(text, pattern)) {
            const overlaps = marks.some((k) => m.start < k.end && k.start < m.end);
            if (!overlaps)
                marks.push(m);
        }
    }
    marks.sort((a, b) => a.start - b.start || a.end - b.end);
    const tokens = [];
    let cursor = 0;
    for (const mark of marks) {
        if (mark.start > cursor)
            tokens.push(...textTokens(text.slice(cursor, mark.start)));
        tokens.push(mark.value);
        cursor = mark.end;
    }
    if (cursor < text.length)
        tokens.push(...textTokens(text.slice(cursor)));
    return tokens;
}
export function createVectorSpace() {
    const termIndex = new Map();
    const docFreq = new Map();
    let docCount = 0;
    const ensureTerm = (term) => {
        const existing = termIndex.get(term);
        if (existing !== undefined)
            return existing;
        const index = termIndex.size;
        termIndex.set(term, index);
        return index;
    };
    return {
        addDocument(text) {
            docCount += 1;
            for (const term of new Set(splitTokens(text))) {
                ensureTerm(term);
                docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
            }
        },
        vectorize(text) {
            const vec = new Array(termIndex.size).fill(0);
            const tf = new Map();
            for (const term of splitTokens(text))
                tf.set(term, (tf.get(term) ?? 0) + 1);
            for (const [term, count] of tf) {
                const index = termIndex.get(term);
                if (index === undefined)
                    continue; // 未收录词不进向量，但也不报错
                const df = docFreq.get(term) ?? 0;
                const idf = Math.log((docCount + 1) / (df + 1)) + 1;
                vec[index] = count * idf;
            }
            return vec;
        },
        cosine(a, b) {
            const len = Math.min(a.length, b.length);
            let dot = 0;
            let normA = 0;
            let normB = 0;
            for (let i = 0; i < a.length; i++)
                normA += a[i] * a[i];
            for (let i = 0; i < b.length; i++)
                normB += b[i] * b[i];
            for (let i = 0; i < len; i++)
                dot += a[i] * b[i];
            if (normA === 0 || normB === 0)
                return 0;
            return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        },
        vocabularySize() {
            return termIndex.size;
        },
        documentCount() {
            return docCount;
        },
    };
}
/** 实体类别清单，供向量化场景外的调用复用。 */
export const ALL_ENTITY_CATEGORIES = [
    'windows-path',
    'posix-path',
    'url',
    'uuid-or-hash',
    'command-symbol',
    'number-percent',
    'person-name',
];
//# sourceMappingURL=signals.js.map