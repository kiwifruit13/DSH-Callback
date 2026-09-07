/**
 * 配置层。
 *
 * 契约纪律：Gherkin 场景内不出现任何待标定数字，全部走本文件的 {@link CompressConfig} 注入。
 * 标定后调参数不需要改契约，也不需要改业务代码。
 *
 * 注意：本文件给出的默认值是**保守占位值**，需在规划 §13 实测标定后替换；
 * 它们不是契约的一部分。
 */
/** 保守占位默认值。规划 §13 实测标定后替换。 */
export const DEFAULT_CONFIG = {
    triggerRatio: 0.7,
    targetRatio: 0.5,
    minGapTurns: 3,
    maxWaitTurns: 12,
    relevanceThreshold: 0.15,
    tailTurns: 6,
    sinkLimit: 2,
    maxLevel: 4,
    lambda: 0.5,
    targetBudgetTokens: 2000,
    embeddingEnabled: false,
    softEntityRetainThreshold: 0.8,
    softEntityAction: {
        'number-percent': 'warn',
        'person-name': 'warn',
    },
    advancedVerifyEnabled: false,
    llmTimeoutMs: 15_000,
    heuristicTimeoutMs: 2_000,
    truncateTimeoutMs: 1_000,
    llmRetryCount: 1,
    tokenEstimateTolerance: 0.05,
    l1OversizeLines: 40,
    l1EdgeKeepLines: 5,
    l2NarrativeMaxLines: 6,
    archive: null,
    countTokens: defaultTokenCounter,
    embed: null,
    onObservation: null,
    onWarning: null,
};
/**
 * 内置 token 估算：中英文混排的保守近似。
 * 中文按字符计（P2-9：字符类覆盖 CJK 统一表意区、假名区、CJK 符号标点区 U+3000-303F
 * 与全角形式区 U+FF01-FF60 —— 中文标点不再粘进 latin 词导致计数系统性偏低），
 * 拉丁按空白与标点切分计。宿主环境应提供真实 tokenizer 替换它。
 */
export function defaultTokenCounter(text) {
    if (text.length === 0)
        return 0;
    const cjkPattern = /[㐀-䶿一-鿿぀-ヿ\u3000-\u303f\uff01-\uff60]/g;
    const cjk = (text.match(cjkPattern) ?? []).length;
    const latin = text
        .replace(cjkPattern, ' ')
        .split(/[\s,.;:!?()[\]{}"'`\/\\|<>+\-*=~@#$%^&_]+/)
        .filter((t) => t.length > 0).length;
    return cjk + latin;
}
/** 配置校验错误。 */
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}
/**
 * 合并用户配置与默认值，并做区间校验。
 * 非法配置在进入压缩流程前就失败，避免带着错误阈值静默运行。
 */
export function resolveConfig(overrides = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...overrides };
    assertRange('triggerRatio', cfg.triggerRatio, 0, 1);
    assertRange('targetRatio', cfg.targetRatio, 0, 1);
    if (cfg.targetRatio >= cfg.triggerRatio) {
        throw new ConfigError(`targetRatio(${cfg.targetRatio}) 必须小于 triggerRatio(${cfg.triggerRatio})`);
    }
    assertRange('minGapTurns', cfg.minGapTurns, 0, Number.MAX_SAFE_INTEGER);
    assertRange('maxWaitTurns', cfg.maxWaitTurns, 1, Number.MAX_SAFE_INTEGER);
    assertRange('tailTurns', cfg.tailTurns, 1, Number.MAX_SAFE_INTEGER);
    if (cfg.maxWaitTurns < cfg.minGapTurns) {
        throw new ConfigError(`maxWaitTurns(${cfg.maxWaitTurns}) 不得小于 minGapTurns(${cfg.minGapTurns})`);
    }
    assertRange('lambda', cfg.lambda, 0, 1);
    assertRange('targetBudgetTokens', cfg.targetBudgetTokens, 1, Number.MAX_SAFE_INTEGER);
    assertRange('sinkLimit', cfg.sinkLimit, 0, Number.MAX_SAFE_INTEGER);
    assertRange('softEntityRetainThreshold', cfg.softEntityRetainThreshold, 0, 1);
    assertRange('tokenEstimateTolerance', cfg.tokenEstimateTolerance, 0, 1);
    assertRange('l1OversizeLines', cfg.l1OversizeLines, 2, Number.MAX_SAFE_INTEGER);
    assertRange('l1EdgeKeepLines', cfg.l1EdgeKeepLines, 1, cfg.l1OversizeLines);
    assertRange('l2NarrativeMaxLines', cfg.l2NarrativeMaxLines, 1, Number.MAX_SAFE_INTEGER);
    assertRange('relevanceThreshold', cfg.relevanceThreshold, 0, 1);
    // P3-9：maxLevel 是枚举而非普通数值，非法值应在进入流程前失败；
    // 下界 1 —— maxLevel=0 意味着任何压缩都不允许，与库的存在前提矛盾。
    if (cfg.maxLevel !== 1 && cfg.maxLevel !== 2 && cfg.maxLevel !== 3 && cfg.maxLevel !== 4) {
        throw new ConfigError(`maxLevel(${cfg.maxLevel}) 必须取 1-4`);
    }
    if (cfg.embeddingEnabled && cfg.embed === null) {
        throw new ConfigError('embeddingEnabled 为 true 时必须提供 embed 向量化器');
    }
    return cfg;
}
function assertRange(name, value, min, max) {
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new ConfigError(`${name} 取值 ${value} 超出合法区间 [${min}, ${max}]`);
    }
}
//# sourceMappingURL=config.js.map