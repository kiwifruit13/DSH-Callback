/**
 * 信息增益与预算分配。
 *
 * 守护 §1.3 语义反转：按「对既有硬约束的贡献」而非「对当前查询的贴合度」分配预算。
 * anchor 是 **pin 约束集的文本表示**，绝不是当前用户查询。
 *
 * 硬性保证（`gain-budget` 九个场景）：
 * - 增益最低的段也只落 L4 指针，**绝不删除**，archive_ref 与 source_span 必须有效；
 * - 各段 budget 之和不超过目标 token 预算，pin 段不占预算额度；
 * - 全部段增益相同时按原始顺序稳定分配，同一输入两次执行结果逐字节相同；
 * - 已下沉段的增益基于 rehydrate 取回的 L0 原文计算，不用摘要文本（与铁律一一致）。
 */

import type { CompressConfig } from './config.js';
import type { Embedder } from './config.js';
import type { BudgetAssignment, Segment } from './contract.js';
import { cosineSimilarity } from './signals.js';

/** embedding 模式的相似度空间：向量化由宿主提供，余弦本地计算（复用共享实现，P2-2）。 */
export function createEmbedderSpace(embed: Embedder): SimilaritySpace {
  return {
    vectorize: (text) => embed(text),
    cosine(a, b) {
      return cosineSimilarity(a, b);
    },
  };
}

/** 向量化能力的最小接口。TF-IDF 与 embedding 两种实现都满足它。 */
export interface SimilaritySpace {
  vectorize(text: string): readonly number[];
  cosine(a: readonly number[], b: readonly number[]): number;
  /** 登记语料参与 IDF 统计。embedding 实现无需此步。 */
  addDocument?(text: string): void;
}

export interface AssignBudgetInput {
  /** 待分配的中部段。 */
  readonly segments: readonly Segment[];
  /** anchor 文本：pin 约束集的拼接。 */
  readonly anchorText: string;
  /** segmentId → 该段的 **L0 原文**。铁律一：绝不传摘要。 */
  readonly segmentTexts: ReadonlyMap<string, string>;
  /**
   * 已保留内容的文本，冗余度对照物。
   * 当前编排器实现只传 pin 约束集文本（不含 head system prompt）——
   * 与此字段语义保持一致的调用方契约：传「视为已占用的内容」。
   */
  readonly retainedTexts: readonly string[];
  /** 相似度空间。embedding 关闭时为 TF-IDF 实现，不产生任何网络调用。 */
  readonly space: SimilaritySpace;
}

/**
 * 执行预算分配。
 *
 * targetLevel 判定（无新增魔法数字，全部由预算关系决定）：
 * - 预算装得下整段 → L1；
 * - 预算装得下至少一半 → L2；
 * - 预算 > 0 → L3；
 * - 预算为 0 → L4；
 * - 增益最低的段恒为 L4（语义反转的反向对照锚点）。
 */
export function assignBudget(input: AssignBudgetInput, config: CompressConfig): BudgetAssignment[] {
  const { segments, anchorText, segmentTexts, retainedTexts, space } = input;

  const anchorVec = space.vectorize(anchorText);
  const retainedVecs = retainedTexts.map((t) => space.vectorize(t));

  // 评分。稳定顺序 = 原始段顺序
  const scored = segments.map((segment, order) => {
    const text = segmentTexts.get(segment.id) ?? '';
    const vec = space.vectorize(text);
    const relevance = space.cosine(vec, anchorVec);
    let redundancy = 0;
    for (const rv of retainedVecs) {
      const c = space.cosine(vec, rv);
      if (c > redundancy) redundancy = c;
    }
    const gain = relevance - config.lambda * redundancy;
    return { segment, order, relevance, redundancy, gain };
  });

  // 增益降序；并列时按原始顺序（比较器显式用 order 决胜，保证确定性）
  const ranked = [...scored].sort((a, b) => b.gain - a.gain || a.order - b.order);
  const lowestGain = ranked[ranked.length - 1];

  // 贪心分配：增益高的先拿预算
  let remaining = config.targetBudgetTokens;
  const budgetOf = new Map<string, number>();
  for (const item of ranked) {
    const want = item.segment.tokens;
    const give = Math.min(want, Math.max(0, remaining));
    budgetOf.set(item.segment.id, give);
    remaining -= give;
  }

  return scored.map((item) => {
    const budget = budgetOf.get(item.segment.id) ?? 0;
    let targetLevel: BudgetAssignment['targetLevel'];
    if (lowestGain !== undefined && item.segment.id === lowestGain.segment.id) {
      targetLevel = 4;
    } else if (budget >= item.segment.tokens) {
      targetLevel = 1;
    } else if (budget >= item.segment.tokens / 2) {
      targetLevel = 2;
    } else if (budget > 0) {
      targetLevel = 3;
    } else {
      targetLevel = 4;
    }
    return {
      segmentId: item.segment.id,
      relevance: item.relevance,
      redundancy: item.redundancy,
      gain: item.gain,
      budget,
      targetLevel,
    };
  });
}
