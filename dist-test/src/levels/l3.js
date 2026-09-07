/**
 * L3 更粗粒度摘要。
 *
 * 铁律一：L3 摘要必须由 L0 原文生成（调用方负责传入 rehydrate 后的原文）。
 * 默认实现是行过滤：保留首尾行、含硬实体的行与待办行，其余视为可粗化内容。
 * 它同时是 fallback 链里 heuristic 级的执行体（保留首尾句与含实体句，§9.1）。
 */
import { matchAll, RE_COMMAND, RE_HASH, RE_POSIX_PATH, RE_TODO_DONE, RE_TODO_PENDING, RE_URL, RE_UUID, RE_WINDOWS_PATH, } from '../patterns.js';
/** 该行是否含硬实体或待办 —— 这类行在任何粗化级别都必须存活。 */
function isSignificant(line) {
    return (matchAll(line, RE_WINDOWS_PATH).length > 0 ||
        matchAll(line, RE_POSIX_PATH).length > 0 ||
        matchAll(line, RE_URL).length > 0 ||
        matchAll(line, RE_UUID).length > 0 ||
        matchAll(line, RE_HASH).length > 0 ||
        matchAll(line, RE_COMMAND).length > 0 ||
        matchAll(line, RE_TODO_PENDING).length > 0 ||
        matchAll(line, RE_TODO_DONE).length > 0);
}
/**
 * L3 粗化：保留首尾各 `l1EdgeKeepLines` 行 + 全部显著行，其余删除。
 * 输出仍是原文行子集（method 记 heuristic 时依赖这一性质）。
 */
export function l3Coarsen(text, config) {
    const lines = text.split('\n');
    if (lines.length <= config.l1EdgeKeepLines * 2)
        return text;
    const keep = new Set();
    const edge = config.l1EdgeKeepLines;
    for (let i = 0; i < edge; i++)
        keep.add(i);
    for (let i = Math.max(edge, lines.length - edge); i < lines.length; i++)
        keep.add(i);
    lines.forEach((line, i) => {
        if (isSignificant(line))
            keep.add(i);
    });
    return [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n');
}
//# sourceMappingURL=l3.js.map