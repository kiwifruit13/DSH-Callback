# DSH-Callback

渐进式上下文压缩库：契约先行的 Agent 上下文管理者，五钩子回调架构 + 编排器内置触发路径，可嵌入任意 Agent 运行时。

- **零运行时依赖**：不绑定任何 LLM SDK，Node 18+，纯 TypeScript（ESM）。
- **契约先行**：全部行为由 Gherkin 场景锁定（`features/`），`npm run test` 即验收。
- **单一入口**：一切公共符号从 `dsh-callback` 根导入，API 文档由脚本从源码生成（`docs/api_reference.md`）。

## 三铁律

1. **永远从 L0 原文压缩** —— 再下沉基于 rehydrate 取回的归档原文，绝不基于摘要再压缩。
2. **级别单调、下沉有上限** —— 压缩级别只升不降；达到 `sinkLimit` 后直接落 L4 指针，不再调用摘要钩子。
3. **tool block 的 assistant 与全部 result 同侧** —— 切点永不落入 block 内部，杜绝 API 400。

压缩块以 `cb-<id>` 前缀的纯文本 user 消息呈现；L4 指针块仅保存 `archive_ref`，凭它可从归档取回完整 L0 原文。

## 安装

```bash
npm install dsh-callback
```

## 最小接入

宿主只需提供 `compress` 钩子，其余钩子走默认实现（触发判定由编排器内置路径承担，见「钩子替换」）：

```ts
import { createContextCompressor } from 'dsh-callback';

const compressor = createContextCompressor({
  config: {
    targetBudgetTokens: 2000,   // 目标 token 预算
    archive,                    // 归档 sink（JSONL / 自定义），L2+ 必需
  },
  callbacks: {
    compress: async (input, signal) => {
      // input.text 永远是 L0 原文；input.signal 超时后必须中止你的网络调用
      const text = await llm.summarize(input.text, { signal });
      // L2 及以上必须返回分槽位结果（constraints / artifacts / todos 逐字摘抄原文，
      // narrative 允许改写；无原文消息可摘抄时可用 extractSlots 兜底工具）
      return input.level >= 2 ? { text, slots: parseSlots(text) } : { text };
    },
  },
});

// 每轮对话结束后调用一次：
const nextState = await compressor.maybeCompress(state);
// nextState 要么是压缩后的全新 ContextState（epoch+1），
// 要么与原 state 引用相同（未触发 / 中止 / 原子回滚）。
```

## 钩子替换

五个可注入钩子全部可选（`compress` 除外），但**每个钩子的失败语义不同**：

| 钩子 | 抛异常时的处置 |
|---|---|
| `selectSegment` | **中止本轮**，不回退默认切割（边界错则全盘错） |
| `onPreCompress` | **继续**，退回静态 pin 白名单，记 `pin_hook_degraded` 告警 |
| `compress` | 走降级链 llm → heuristic → truncate → 放弃（`NoCompressionPossible`） |
| `verify` | **视为不通过**，走重压→抽取→截断降级链，不放行可疑摘要 |
| `onError` | 兜底出口；自身异常被吞掉，不影响主流程 |

`shouldCompress` 不在 `DEFAULT_CALLBACKS` 中：编排器内置触发路径是**唯一默认实现**，
它真实维护 `turnsSinceLastCompress` / `justCompressed`，并为 topic-shift 边界构建语料空间。
宿主需要自定义触发时，应基于真实轮次状态实现，或包装 `defaultShouldCompress` ——
以占位轮次覆盖内置路径会让频率下限、迟滞带与强制压缩全部失真。

```ts
import { createContextCompressor, DEFAULT_CALLBACKS } from 'dsh-callback';

const compressor = createContextCompressor({
  callbacks: {
    // 包装默认行为再增强，而不是从零重写：
    ...DEFAULT_CALLBACKS,

    onPreCompress: (state, config) => {
      // 返回额外 pin；tool-block-incomplete 强制 pin 不受此影响
      return detectBusinessPins(state);
    },
    verify: (input, config) => {
      // input.slots 由编排层注入（L2+ 分槽位结果，L1 为 null）
      // 硬实体（路径/URL/hash/命令）保留率必须 1.0
      return myDomainVerifier(input.original, input.summary, input.slots);
    },
    onError: (error, { hook, phase }) => {
      logger.error('compress-error', { hook, phase, error });
    },
  },
});
```

## 观测接入

告警与观测经 `config` 注入，每轮压缩提交后产生一条 `ObservationRecord`：

```ts
const compressor = createContextCompressor({
  config: {
    onWarning: (warning, details) => {
      // pin_hook_degraded / archive-unavailable / verify_failed_retry /
      // llm_hook_error / epoch_cas_conflict / commit_assert_failed …
      metrics.increment(warning, details);
    },
    onObservation: (record) => {
      // beforeTokens / afterTokens / ratio / level / method / degraded /
      // pinCount / durationMs / cacheImpact.prefixStable
      telemetry.record('context-compress', record);
    },
  },
});
```

`record.method` 标记本轮主要压缩来源（`llm` / `heuristic` / `truncate` / `none`），
`degraded` 置位表示走过降级链 —— 事后可据此判断该段上下文的可信度。

## 归档与回溯（rehydrate）

L2+ 有损压缩前必须归档成功；凭压缩块的 `archive_ref` 可随时取回 L0 原文。
归档 sink 经 `config.archive` 注入，回溯一律走门面 `compressor.archive` ——
它与内部压缩**共享同一实例与索引**：

```ts
import { createContextCompressor, JsonlArchiveSink } from 'dsh-callback';

const compressor = createContextCompressor({
  config: { archive: new JsonlArchiveSink('./context-archive.jsonl') },
  callbacks: {
    compress: async ({ text }) => ({ text: await llm.summarize(text) }),
  },
});

// 任意时刻回溯：
const originalMsgs = await compressor.archive.rehydrate(block.archiveRef);
// 进程重启后从 JSONL 重建索引（rebuildIndex 只在 Archive 门面上，sink 自身没有）：
const entries = await compressor.archive.rebuildIndex();
```

归档不可用时禁止有损下沉（自动退化为 L1 无损裁剪并告警）；
哈希校验失败的指针拒绝回溯，依赖它的再下沉操作被整体拒绝。

## 测试与契约

```bash
npm run test              # 全量契约回归（features/ 下 94 个场景）
npm run test:invariant    # 仅三铁律 + API 400 防线（改动核心模块时必跑）
npm run typecheck         # tsc --noEmit
npm run api:check         # 导出面与 docs/ 是否一致（CI 门禁）
npm run api:docs          # 重新生成 API 文档（禁止手改 docs/）
```

行为契约以 Gherkin 表达于 `features/*.feature`，按主题分为九组：
tool-block 完整性、pin 保护、级别下沉、原子性与幂等、触发与水位、
增益与预算、实体校验、降级链、归档与回溯。

## License

MIT
