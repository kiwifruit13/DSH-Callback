/**
 * L4 指针块。
 *
 * `rehydrate` 契约：L4 块的 archive_ref 非空、source_span 合法、
 * 指针文本本身占用极少 token，仅说明存在过什么与如何取回。
 */
/** L4 指针文本。 */
export function l4PointerText(startId, endId, msgCount, archiveRef) {
    return `[archived] 消息 ${startId}..${endId}（${msgCount} 条）已归档，凭 archive_ref=${archiveRef} 可取回原文`;
}
//# sourceMappingURL=l4.js.map