/**
 * 实体与关键词的正则模式库。
 *
 * `pins.ts`（识别不可压缩区）与 `verify.ts`（压缩后保留率校验）共用同一套规则，
 * 避免两处各写一份导致「pin 认得出、校验认不出」的漂移。
 *
 * 这里的正则只做**保守匹配**：宁可漏，不可把普通文本误判为路径或 ID，
 * 因为误判会直接抬高硬实体的分母，让保留率永远达不到 1.0。
 */
/** 在文本中找出全部匹配，返回带区间的列表。 */
export function matchAll(text, re) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const scanner = new RegExp(re.source, flags);
    const out = [];
    let m;
    while ((m = scanner.exec(text)) !== null) {
        out.push({ value: m[0], start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0)
            scanner.lastIndex += 1;
    }
    return out;
}
/** Windows 绝对路径：`D:\Documents\out\报告.docx`。 */
export const RE_WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/;
/** POSIX 路径：至少两级，避免把单个 `/usr` 或除法算式误判为路径。 */
export const RE_POSIX_PATH = /(?:\/[\w.@-]+){2,}/;
/** URL。 */
export const RE_URL = /https?:\/\/[^\s)"'<>]+/;
/** UUID。 */
export const RE_UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
/** commit hash 一类十六进制串（7–40 位）。 */
export const RE_HASH = /\b[0-9a-f]{7,40}\b/;
/** 反引号包裹的命令与符号。 */
export const RE_COMMAND = /`[^`\n]+`/;
/** 未完成待办：`- [ ]`、`TODO:`、`待办：`。 */
export const RE_TODO_PENDING = /(?:^|\n)\s*(?:[-*]\s*\[\s\]|TODO\s*:|待办\s*[:：])[^\n]*/;
/** 已完成待办：`- [x]`、`DONE:`、`已完成`。 */
export const RE_TODO_DONE = /(?:^|\n)\s*(?:[-*]\s*\[[xX]\]|DONE\s*:|已完成\s*[:：])[^\n]*/;
/** 用户硬约束关键词。 */
export const KW_CONSTRAINT = [
    '必须在',
    '必须',
    '不要',
    '不得',
    '禁止',
    '只能',
    '务必',
    '原地',
    '不允许',
    'in-place',
    'must not',
    'do not',
    'never',
];
/** 持久性要求关键词（user-remember）。 */
export const KW_REMEMBER = ['记住', '以后都要', '以后都', '始终要', 'always', 'from now on'];
/** 权限确认关键词（permission-grant）。 */
export const KW_PERMISSION = ['批准', '同意', '授权', '允许执行', '可以执行', 'approved', 'confirmed', 'permission granted'];
/** 关键报错关键词（error-critical）。 */
export const KW_ERROR = ['error', 'Error', 'ERROR', 'exception', 'Exception', 'Traceback', 'failed', '失败', '报错', 'fatal'];
/** 交付物上下文关键词：路径出现在这类语境里才算交付物。 */
export const KW_ARTIFACT = ['输出', '保存', '生成', '写入', '交付', '写到', '输出到', 'save', 'write', 'output', 'artifact'];
/** 硬实体类别 → 正则。 */
export const HARD_ENTITY_PATTERNS = {
    'windows-path': RE_WINDOWS_PATH,
    'posix-path': RE_POSIX_PATH,
    'url': RE_URL,
    'uuid-or-hash': RE_UUID,
    'command-symbol': RE_COMMAND,
};
/** 软实体类别 → 正则。 */
export const SOFT_ENTITY_PATTERNS = {
    'number-percent': /-?\d+(?:\.\d+)?%/,
    'person-name': /[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}/,
};
/** 提取文本中某一类硬实体。uuid-or-hash 同时匹配 UUID 与十六进制串。 */
export function extractHardEntities(text, category) {
    if (category === 'uuid-or-hash') {
        return [...matchAll(text, RE_UUID), ...matchAll(text, RE_HASH)].map((m) => m.value);
    }
    if (category === 'windows-path')
        return matchAll(text, RE_WINDOWS_PATH).map((m) => m.value);
    if (category === 'posix-path')
        return matchAll(text, RE_POSIX_PATH).map((m) => m.value);
    if (category === 'url')
        return matchAll(text, RE_URL).map((m) => m.value);
    if (category === 'command-symbol')
        return matchAll(text, RE_COMMAND).map((m) => m.value);
    if (category === 'number-percent')
        return matchAll(text, SOFT_ENTITY_PATTERNS['number-percent']).map((m) => m.value);
    if (category === 'person-name')
        return matchAll(text, SOFT_ENTITY_PATTERNS['person-name']).map((m) => m.value);
    return [];
}
/** 文本是否命中任一词条（大小写不敏感）。 */
export function hasKeyword(text, keywords) {
    const lower = text.toLowerCase();
    return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}
//# sourceMappingURL=patterns.js.map