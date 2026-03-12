/**
 * KnowledgeBaseMiddleware — 知识库检索注入中间件
 *
 * 灵感来源：Yuxi-Know 的 KnowledgeBaseMiddleware
 *
 * 在 Agent 执行前自动检索相关知识库内容并注入到 context 中。
 * 支持多知识库、按相关度排序、token 预算自适应控制。
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { estimateTokens, estimateMessagesTokens } from "@/core/ai/token-utils";

export interface KnowledgeBaseRef {
  id: string;
  name: string;
  search: (query: string, topK: number) => Promise<Array<{ content: string; score: number; source?: string }>>;
}

/** Global registry for knowledge bases available to agents */
const knowledgeBaseRegistry = new Map<string, KnowledgeBaseRef>();

export function registerKnowledgeBase(kb: KnowledgeBaseRef): void {
  knowledgeBaseRegistry.set(kb.id, kb);
}

export function unregisterKnowledgeBase(id: string): void {
  knowledgeBaseRegistry.delete(id);
}

export function getRegisteredKnowledgeBases(): KnowledgeBaseRef[] {
  return [...knowledgeBaseRegistry.values()];
}

const DEFAULT_KB_TOP_K = 5;
const DEFAULT_KB_MAX_TOKENS = 1500;
/** KB context 不能超过 Actor 总 token 预算的这个比例 */
const KB_BUDGET_RATIO = 0.15;
/** 结果低于此分数将被丢弃 */
const MIN_RELEVANCE_SCORE = 0.25;

export class KnowledgeBaseMiddleware implements ActorMiddleware {
  readonly name = "KnowledgeBase";
  private knowledgeBaseIds?: string[];
  private topK: number;
  private maxTokens: number;

  constructor(opts?: { knowledgeBaseIds?: string[]; topK?: number; maxTokens?: number }) {
    this.knowledgeBaseIds = opts?.knowledgeBaseIds;
    this.topK = opts?.topK ?? DEFAULT_KB_TOP_K;
    this.maxTokens = opts?.maxTokens ?? DEFAULT_KB_MAX_TOKENS;
  }

  async apply(ctx: ActorRunContext): Promise<void> {
    const kbs = this.knowledgeBaseIds
      ? this.knowledgeBaseIds.map((id) => knowledgeBaseRegistry.get(id)).filter(Boolean) as KnowledgeBaseRef[]
      : [...knowledgeBaseRegistry.values()];

    if (kbs.length === 0) return;

    // 自适应 token 预算：基于 Actor 的 contextTokens 配置或已使用的 context
    const actorBudget = ctx.contextTokens ?? 100_000;
    const existingContextTokens = estimateMessagesTokens(
      ctx.contextMessages.map((m) => ({ role: m.role, content: m.content })),
    );
    const availableBudget = Math.max(
      500,
      Math.min(this.maxTokens, Math.floor((actorBudget - existingContextTokens) * KB_BUDGET_RATIO)),
    );

    const allResults: Array<{ content: string; score: number; source?: string; kbName: string }> = [];

    await Promise.all(
      kbs.map(async (kb) => {
        try {
          const results = await kb.search(ctx.query, this.topK);
          for (const r of results) {
            if (r.score >= MIN_RELEVANCE_SCORE) {
              allResults.push({ ...r, kbName: kb.name });
            }
          }
        } catch (err) {
          console.warn(`[KnowledgeBase] Search failed for ${kb.name}:`, err);
        }
      }),
    );

    if (allResults.length === 0) return;

    allResults.sort((a, b) => b.score - a.score);

    let tokenBudget = availableBudget;
    const selected: string[] = [];

    for (const result of allResults) {
      const entry = `[${result.kbName}${result.source ? ` / ${result.source}` : ""}] (${(result.score * 100).toFixed(0)}%) ${result.content}`;
      const cost = estimateTokens(entry);
      if (cost > tokenBudget) {
        // 尝试截断以填充剩余预算
        if (tokenBudget > 100 && selected.length < 2) {
          const truncated = entry.slice(0, tokenBudget * 3) + "…";
          selected.push(truncated);
        }
        break;
      }
      selected.push(entry);
      tokenBudget -= cost;
    }

    if (selected.length === 0) return;

    const block = [
      "## 相关知识库内容",
      `(共检索到 ${allResults.length} 条结果，选取 ${selected.length} 条，token 预算 ${availableBudget})`,
      "",
      ...selected.map((s, i) => `${i + 1}. ${s}`),
    ].join("\n");

    ctx.contextMessages = [
      ...ctx.contextMessages,
      { role: "user" as const, content: `[系统注入] 知识库检索结果：\n${block}` },
      { role: "assistant" as const, content: "好的，我会参考这些知识库内容来回答你的问题。" },
    ];
  }
}
