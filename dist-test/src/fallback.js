/**
 * 压缩降级链：llm → heuristic → truncate → 放弃。
 *
 * 守护 §9.1 与 `fallback-chain` 九个场景：
 * - 每级超时由 AbortController 控制，中断后组合信号立即 abort，
 *   宿主的网络调用据此自行清理，不留悬挂请求；
 * - LLM 返回不符合槽位 schema 时**重试一次**，仍非法则降级，非法输出记录不静默丢弃；
 * - 每次降级都准确落 method 标记（llm / heuristic / truncate），degraded 相应置位；
 * - 三级全部失败抛 {@link NoCompressionPossible}，携带三级失败原因，上下文保持原样。
 */
import { idempotencyKeyOf } from './callbacks.js';
import { NoCompressionPossible } from './contract.js';
import { l3Coarsen } from './levels/l3.js';
/** 组合外部信号与超时信号：任一 abort 都会中止 fn。返回本次实际使用的组合控制器。 */
async function withTimeout(timeoutMs, external, controller, fn) {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternal = () => controller.abort();
    external.addEventListener('abort', onExternal, { once: true });
    try {
        return await fn(controller.signal);
    }
    finally {
        clearTimeout(timer);
        external.removeEventListener('abort', onExternal);
    }
}
/** L2 及以上必须有槽位，且槽位形状合法、硬槽位取值非空字符串 —— 否则视为不符合 schema。 */
function isValidSchema(output, level) {
    if (output.text.trim().length === 0)
        return false;
    if (level < 2)
        return true;
    return isValidSlots(output.slots);
}
/**
 * 槽位形状校验（P2-4）：constraints / artifacts / todos 必须是数组、narrative 必须是字符串。
 * 类型层的 SummarySlots 形状在运行时同样要验证 —— 宿主返回 `slots: 42` 之类不能放行。
 */
function isValidSlots(slots) {
    if (typeof slots !== 'object' || slots === null)
        return false;
    const candidate = slots;
    return (Array.isArray(candidate.constraints) &&
        Array.isArray(candidate.artifacts) &&
        Array.isArray(candidate.todos) &&
        typeof candidate.narrative === 'string');
}
/**
 * 硬截断：从尾部往前累积行，直到预算用尽（R5-6 收敛为唯一实现，
 * 编排器降级链的截断复用此处，消除双实现漂移）。
 */
export function truncateToBudget(text, budget, config) {
    const lines = text.split('\n');
    const kept = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const cost = config.countTokens(line);
        // 至少保留一行，哪怕超预算 —— 空结果比超预算更糟
        if (kept.length > 0 && used + cost > budget)
            break;
        kept.unshift(line);
        used += cost;
    }
    return kept.join('\n');
}
/**
 * 执行降级链。
 *
 * @param input 压缩入参（text 永远是 L0 原文）
 * @param compress 用户的 compress 钩子（llm 级）
 */
export async function runFallbackChain(input, compress, config) {
    const warnings = [];
    const failures = {};
    // —— 第 1 级：llm ——
    let hookThrew = false;
    if (compress === null) {
        failures.llm = '未提供 compress 钩子';
    }
    else {
        let output = null;
        let lastError = null;
        // §5 约定：非法 schema 最多重试一次（llmRetryCount，默认 1）
        for (let attempt = 0; attempt <= config.llmRetryCount; attempt++) {
            const controller = new AbortController();
            try {
                const result = await withTimeout(config.llmTimeoutMs, input.signal, controller, (signal) => Promise.resolve(compress({ ...input, signal }, signal)));
                if (isValidSchema(result, input.level)) {
                    output = result;
                    break;
                }
                lastError = new Error('输出不符合槽位 schema');
                warnings.push(`llm_invalid_schema_attempt_${attempt + 1}`);
                // 非法输出记录用于事后分析，而非静默丢弃
                config.onWarning?.('llm_invalid_schema', {
                    key: idempotencyKeyOf(input.key),
                    attempt: attempt + 1,
                    text: result.text.slice(0, 200),
                });
            }
            catch (error) {
                lastError = error;
                // 组合信号已 abort（超时或外部取消）是预期内的 llm 失败 → 立即跳出重试、进入降级链（P2-3）；
                // 钩子在未 abort 时主动抛异常属于宿主侧崩溃，不可静默降级 → 立即放弃本轮（§9.2 原子性）
                if (controller.signal.aborted) {
                    warnings.push('llm_aborted');
                    config.onWarning?.('llm_hook_error', { key: idempotencyKeyOf(input.key), error: String(error) });
                    break;
                }
                else {
                    hookThrew = true;
                    warnings.push('llm_hook_error');
                    config.onWarning?.('llm_hook_error', { key: idempotencyKeyOf(input.key), error: String(error) });
                    break;
                }
            }
        }
        if (output !== null) {
            return { output, method: 'llm', degraded: false, warnings };
        }
        failures.llm = String(lastError);
    }
    if (hookThrew) {
        throw new NoCompressionPossible('compress 钩子抛出异常，放弃本轮压缩', { failures, warnings });
    }
    // —— 第 2 级：heuristic（规则抽取，保留首尾与含实体句）——
    try {
        const heuristicText = l3Coarsen(input.text, config);
        if (heuristicText.trim().length === 0) {
            // P2-5：空文本与 truncate 级对称防护 —— 空 content 的压缩块消息会被主流 Chat API 拒绝
            throw new Error('heuristic 输出为空');
        }
        const heuristicTokens = config.countTokens(heuristicText);
        if (heuristicTokens > input.budget) {
            warnings.push('heuristic_over_budget');
            // 落到 truncate，不直接返回
            throw new OverBudget();
        }
        return {
            output: { text: heuristicText },
            method: 'heuristic',
            degraded: true,
            warnings,
        };
    }
    catch (error) {
        failures.heuristic = String(error);
    }
    // —— 第 3 级：truncate（硬截断保留尾部）——
    try {
        const truncatedText = truncateToBudget(input.text, input.budget, config);
        if (truncatedText.trim().length === 0)
            throw new Error('截断后为空');
        return {
            output: { text: truncatedText },
            method: 'truncate',
            degraded: true,
            warnings,
        };
    }
    catch (error) {
        failures.truncate = String(error);
    }
    throw new NoCompressionPossible('三级降级全部失败', { failures, warnings });
}
/** 内部信号：heuristic 结果超预算时跳到 truncate 级。 */
class OverBudget extends Error {
    constructor() {
        super('heuristic 输出超出预算');
        this.name = 'OverBudget';
    }
}
//# sourceMappingURL=fallback.js.map