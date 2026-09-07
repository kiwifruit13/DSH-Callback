/**
 * 压缩后实体校验。
 *
 * 守护 §8.1：路径、ID、命令错一个字符，Agent 就会对错误目标执行破坏性操作。
 * 因此硬实体保留率**恒为 1.0**（契约本身，不是阈值，见 HARD_ENTITY_RETAIN_REQUIRED）。
 *
 * 行为要点（`entity-verify` 九个场景）：
 * - 原文不含某类实体时，该类保留率记 **1.0** 而非 0 或空值 —— 不因「未匹配到实体」被误判为信息丢失；
 * - 软实体低于配置阈值时按配置处置（warn 放行 / reject 拦下），处置结果写入报告；
 * - 本模块自身不抛异常；校验**钩子**的异常由编排层包装为「不通过 + 走降级链」；
 * - 硬槽位逐字校验在 `levels/l2.ts` 的 verifyHardSlots。
 */
import { HARD_ENTITY_CATEGORIES, } from './contract.js';
import { extractHardEntities, matchAll, SOFT_ENTITY_PATTERNS } from './patterns.js';
function unique(values) {
    return [...new Set(values)];
}
/** 正则实体校验。 */
export function verifyEntities(original, summary, config) {
    const entityRetain = {};
    const missing = [];
    const warnings = [];
    // —— 硬实体：保留率必须 1.0 ——
    for (const category of HARD_ENTITY_CATEGORIES) {
        const originals = unique(extractHardEntities(original, category));
        if (originals.length === 0) {
            entityRetain[category] = 1.0;
            continue;
        }
        const lost = originals.filter((value) => !summary.includes(value));
        entityRetain[category] = (originals.length - lost.length) / originals.length;
        for (const value of lost)
            missing.push(`${category}: ${value}`);
    }
    const hardPassed = HARD_ENTITY_CATEGORIES.every((category) => entityRetain[category] === 1.0);
    // —— 软实体：低于阈值按配置处置 ——
    let softPassed = true;
    for (const [category, pattern] of Object.entries(SOFT_ENTITY_PATTERNS)) {
        const name = category;
        const originals = unique(matchAll(original, pattern).map((m) => m.value));
        if (originals.length === 0) {
            entityRetain[name] = 1.0;
            continue;
        }
        const found = originals.filter((value) => summary.includes(value));
        const retain = found.length / originals.length;
        entityRetain[name] = retain;
        if (retain < config.softEntityRetainThreshold) {
            const action = config.softEntityAction[name] ?? 'warn';
            if (action === 'reject')
                softPassed = false;
            warnings.push(`软实体 ${name} 保留率 ${retain.toFixed(3)} 低于阈值 ${config.softEntityRetainThreshold}，处置：${action}`);
        }
    }
    return { passed: hardPassed && softPassed, entityRetain, missing, hookError: false, warnings };
}
/**
 * 针对 constraints、artifacts、todos 三个槽位各生成一题。
 * 槽位为空的类别跳过（无内容可问，不制造必错题）。
 */
export function generateSlotQuestions(slots) {
    const questions = [];
    if (slots.constraints.length > 0) {
        questions.push({
            category: 'constraints',
            question: '用户提出了哪些必须遵守的约束？',
            answer: slots.constraints.join(' '),
        });
    }
    if (slots.artifacts.length > 0) {
        questions.push({
            category: 'artifacts',
            question: '涉及哪些交付物路径与标识？',
            answer: slots.artifacts.join(' '),
        });
    }
    if (slots.todos.length > 0) {
        questions.push({
            category: 'todos',
            question: '有哪些待办事项？',
            answer: slots.todos.join(' '),
        });
    }
    return questions;
}
/**
 * §8.3 进阶事实问答校验。`config.advancedVerifyEnabled` 为 true 时由
 * {@link verifySummary} 自动调用；任一题答案无法在原文中逐字定位即判定关键信息丢失。
 */
export function advancedVerify(original, slots) {
    const questions = generateSlotQuestions(slots);
    const missing = [];
    for (const qa of questions) {
        if (!original.includes(qa.answer)) {
            missing.push(`qa[${qa.category}]: ${qa.answer}`);
        }
    }
    return { passed: missing.length === 0, missing, questions };
}
/**
 * 完整校验入口：先跑硬槽位逐字定位（有槽位时），再跑正则实体校验；
 * 进阶问答开关开启时追加 §8.3 问答校验。
 * 三者任一不通过即整体不通过。
 */
export function verifySummary(original, summary, slots, config) {
    // §8 L2 分槽位摘要：硬实体允许落在硬槽位内（逐字摘抄），
    // 实体校验基于「narrative + 槽位取值」的联合文本，而非只看 narrative 改写。
    const combined = slots === null
        ? summary
        : [summary, ...slots.constraints, ...slots.artifacts, ...slots.todos].join('\n');
    const report = verifyEntities(original, combined, config);
    if (slots === null)
        return report;
    // 硬槽位（constraints / artifacts / todos）逐字定位校验
    const slotMissing = [];
    for (const value of [...slots.constraints, ...slots.artifacts, ...slots.todos]) {
        if (!original.includes(value))
            slotMissing.push(`slot: ${value}`);
    }
    // §8.3 进阶事实问答：默认关闭，开启时每槽位一题、答案必须可在原文逐字定位
    let qaMissing = [];
    let questions = [];
    if (config.advancedVerifyEnabled) {
        const advanced = advancedVerify(original, slots);
        qaMissing = [...advanced.missing];
        questions = advanced.questions;
    }
    const allMissing = [...report.missing, ...slotMissing, ...qaMissing];
    if (allMissing.length === 0 && questions.length === 0)
        return report;
    return {
        ...report,
        passed: report.passed && slotMissing.length === 0 && qaMissing.length === 0,
        missing: allMissing,
        warnings: [
            ...report.warnings,
            ...(slotMissing.length > 0
                ? [`硬槽位校验失败：${slotMissing.length} 条取值无法在原文中逐字定位`]
                : []),
            ...(qaMissing.length > 0 ? [`进阶问答校验失败：${qaMissing.length} 题答案无法定位`] : []),
        ],
        qa: questions,
    };
}
//# sourceMappingURL=verify.js.map