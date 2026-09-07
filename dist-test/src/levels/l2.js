/**
 * L2 分槽位摘要的兜底抽取与逐字校验辅助。
 *
 * L2 的生成主路径是 compress 钩子（LLM）；本模块提供：
 * 1. 无 LLM / 钩子失败时的**抽取式兜底**：硬槽位直接摘抄原文行，
 *    天然满足「constraints、artifacts、todos 逐字定位」（`level-sinking` 硬槽位场景）；
 * 2. 硬槽位逐字校验，供 verify 阶段复用。
 *
 * 接线现状（P3-4）：两者都是**公共兜底工具**（自 index.ts 导出），宿主自定义
 * compress/verify 钩子时可直接复用；框架主链路当前不经过它们 ——
 * 降级链的 heuristic 级走 l3Coarsen（纯文本），verify 的槽位校验在 verify.ts 内实现。
 */
import { DEFAULT_CONFIG } from '../config.js';
import { KW_ARTIFACT, KW_CONSTRAINT, RE_COMMAND, RE_POSIX_PATH, RE_TODO_DONE, RE_TODO_PENDING, RE_URL, RE_WINDOWS_PATH, matchAll, } from '../patterns.js';
/** 行是否包含硬实体（路径 / URL / 命令）。 */
function hasHardEntity(line) {
    return (matchAll(line, RE_WINDOWS_PATH).length > 0 ||
        matchAll(line, RE_POSIX_PATH).length > 0 ||
        matchAll(line, RE_URL).length > 0 ||
        matchAll(line, RE_COMMAND).length > 0);
}
/**
 * 从原文抽取分槽位摘要。
 * 全部硬槽位取值都是原文的逐字行，narrative 也取原文行（兜底路径不引入改写）。
 *
 * @param config 可选配置覆盖；narrative 上限缺省取 `DEFAULT_CONFIG.l2NarrativeMaxLines`（P3-5）
 */
export function extractSlots(msgs, config) {
    const narrativeMax = config?.l2NarrativeMaxLines ?? DEFAULT_CONFIG.l2NarrativeMaxLines;
    const constraints = [];
    const artifacts = [];
    const todos = [];
    const narrative = [];
    for (const msg of msgs) {
        for (const line of msg.content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0)
                continue;
            if (matchAll(line, RE_TODO_PENDING).length > 0 || matchAll(line, RE_TODO_DONE).length > 0) {
                todos.push(trimmed);
                continue;
            }
            if (KW_CONSTRAINT.some((kw) => line.includes(kw))) {
                constraints.push(trimmed);
                continue;
            }
            if (hasHardEntity(line) || KW_ARTIFACT.some((kw) => line.includes(kw))) {
                artifacts.push(trimmed);
                continue;
            }
            if (narrative.length < narrativeMax)
                narrative.push(trimmed);
        }
    }
    return { constraints, artifacts, todos, narrative: narrative.join(' ') };
}
/**
 * 硬槽位逐字校验：constraints、artifacts、todos 的每条取值都必须能在原文中逐字定位。
 * 返回无法定位的取值列表；为空即通过。
 */
export function verifyHardSlots(slots, original) {
    const missing = [];
    for (const value of [...slots.constraints, ...slots.artifacts, ...slots.todos]) {
        if (!original.includes(value))
            missing.push(value);
    }
    return missing;
}
//# sourceMappingURL=l2.js.map