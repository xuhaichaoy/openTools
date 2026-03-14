/**
 * KnowledgeBaseMiddleware — 知识库检索注入中间件
 *
 * 灵感来源：Yuxi-Know 的 KnowledgeBaseMiddleware
 *
 * 在 Agent 执行前自动检索相关知识库内容并注入到 context 中。
 * 支持多知识库、按相关度排序、token 预算自适应控制。
 */

import { invoke } from "@tauri-apps/api/core";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { estimateTokens, estimateMessagesTokens } from "@/core/ai/token-utils";
import { useAIStore } from "@/store/ai-store";
import { isAssistantKnowledgeAutoSearchEnabled } from "@/core/ai/assistant-config";

export interface KnowledgeBaseRef {
  id: string;
  name: string;
  search: (query: string, topK: number) => Promise<Array<{ content: string; score: number; source?: string }>>;
}

interface LocalRAGDocSummary {
  id: string;
  name: string;
  status: string;
}

interface LocalRAGSearchResult {
  chunk?: {
    content?: string;
    metadata?: {
      source?: string;
      heading?: string;
    };
  };
  score?: number;
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
const PRODUCT_KB_NAME = "本地知识库";

function isKnowledgeAutoSearchEnabled(): boolean {
  return isAssistantKnowledgeAutoSearchEnabled(useAIStore.getState().config);
}

function normalizeLocalRAGScores(
  results: Array<{ content: string; score: number; source?: string; kbName: string }>,
): Array<{ content: string; score: number; source?: string; kbName: string }> {
  if (results.length === 0) return results;

  const scores = results
    .map((item) => item.score)
    .filter((score) => Number.isFinite(score));

  if (scores.length === 0) return results;

  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);

  // `rag_search` 的 RRF 融合分数历史上可能落在 ~0.01-0.03。
  // 对这类 rank-score 做一次归一化，便于统一进入中间件筛选。
  if (maxScore > 0.1) return results;

  if (maxScore <= minScore) {
    return results.map((item) => ({ ...item, score: 0.7 }));
  }

  const range = maxScore - minScore;
  return results.map((item) => ({
    ...item,
    score: 0.3 + ((item.score - minScore) / range) * 0.7,
  }));
}

async function searchProductRAG(
  query: string,
  topK: number,
): Promise<Array<{ content: string; score: number; source?: string; kbName: string }>> {
  let docs: LocalRAGDocSummary[] = [];
  try {
    docs = await invoke<LocalRAGDocSummary[]>("rag_list_doc_summaries");
  } catch {
    return [];
  }

  if (!Array.isArray(docs) || docs.length === 0) return [];

  let results: LocalRAGSearchResult[] = [];
  try {
    results = await invoke<LocalRAGSearchResult[]>("rag_search", {
      query,
      topK,
    });
  } catch {
    try {
      results = await invoke<LocalRAGSearchResult[]>("rag_keyword_search", {
        query,
        topK,
      });
    } catch {
      return [];
    }
  }

  const mapped = (Array.isArray(results) ? results : [])
    .map((item) => {
      const content = item.chunk?.content?.trim() ?? "";
      const source = [item.chunk?.metadata?.source, item.chunk?.metadata?.heading]
        .filter(Boolean)
        .join(" / ");
      return {
        content,
        source: source || undefined,
        score: Number(item.score ?? 0),
        kbName: PRODUCT_KB_NAME,
      };
    })
    .filter((item) => item.content);

  return normalizeLocalRAGScores(mapped);
}

export interface BuildKnowledgeContextMessagesOptions {
  knowledgeBaseIds?: string[];
  topK?: number;
  maxTokens?: number;
  contextTokens?: number;
  existingContextMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}

export async function buildKnowledgeContextMessages(
  query: string,
  opts?: BuildKnowledgeContextMessagesOptions,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  if (!query.trim() || !isKnowledgeAutoSearchEnabled()) return [];

  const knowledgeBaseIds = opts?.knowledgeBaseIds;
  const topK = opts?.topK ?? DEFAULT_KB_TOP_K;
  const maxTokens = opts?.maxTokens ?? DEFAULT_KB_MAX_TOKENS;
  const existingContextMessages = opts?.existingContextMessages ?? [];

  const kbs = knowledgeBaseIds
    ? knowledgeBaseIds
      .map((id) => knowledgeBaseRegistry.get(id))
      .filter(Boolean) as KnowledgeBaseRef[]
    : [...knowledgeBaseRegistry.values()];

  const actorBudget = opts?.contextTokens ?? 100_000;
  const existingContextTokens = estimateMessagesTokens(
    existingContextMessages.map((m) => ({ role: m.role, content: m.content })),
  );
  const availableBudget = Math.max(
    500,
    Math.min(maxTokens, Math.floor((actorBudget - existingContextTokens) * KB_BUDGET_RATIO)),
  );

  const allResults: Array<{ content: string; score: number; source?: string; kbName: string }> = [];

  try {
    const localResults = await searchProductRAG(query, topK);
    for (const result of localResults) {
      if (result.score >= MIN_RELEVANCE_SCORE) {
        allResults.push(result);
      }
    }
  } catch (err) {
    console.warn("[KnowledgeBase] Local RAG search failed:", err);
  }

  await Promise.all(
    kbs.map(async (kb) => {
      try {
        const results = await kb.search(query, topK);
        for (const result of results) {
          if (result.score >= MIN_RELEVANCE_SCORE) {
            allResults.push({ ...result, kbName: kb.name });
          }
        }
      } catch (err) {
        console.warn(`[KnowledgeBase] Search failed for ${kb.name}:`, err);
      }
    }),
  );

  if (allResults.length === 0) return [];

  allResults.sort((a, b) => b.score - a.score);

  let tokenBudget = availableBudget;
  const selected: string[] = [];

  for (const result of allResults) {
    const entry = `[${result.kbName}${result.source ? ` / ${result.source}` : ""}] (${(result.score * 100).toFixed(0)}%) ${result.content}`;
    const cost = estimateTokens(entry);
    if (cost > tokenBudget) {
      if (tokenBudget > 100 && selected.length < 2) {
        selected.push(`${entry.slice(0, tokenBudget * 3)}…`);
      }
      break;
    }
    selected.push(entry);
    tokenBudget -= cost;
  }

  if (selected.length === 0) return [];

  const block = [
    "## 相关知识库内容",
    `(共检索到 ${allResults.length} 条结果，选取 ${selected.length} 条，token 预算 ${availableBudget})`,
    "",
    ...selected.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");

  return [
    { role: "user", content: `[系统注入] 知识库检索结果：\n${block}` },
    { role: "assistant", content: "好的，我会参考这些知识库内容来回答你的问题。" },
  ];
}

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
    const injectedMessages = await buildKnowledgeContextMessages(ctx.query, {
      knowledgeBaseIds: this.knowledgeBaseIds,
      topK: this.topK,
      maxTokens: this.maxTokens,
      contextTokens: ctx.contextTokens,
      existingContextMessages: ctx.contextMessages,
    });
    if (injectedMessages.length === 0) return;

    ctx.contextMessages = [...ctx.contextMessages, ...injectedMessages];
  }
}
