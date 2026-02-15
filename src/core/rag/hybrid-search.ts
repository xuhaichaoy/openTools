/**
 * 混合搜索算法 — 融合多种搜索策略
 * 来源: note-gen 的 RAG 混合搜索实现
 *
 * 策略:
 * 1. 模糊搜索 (字符串匹配)
 * 2. 向量搜索 (语义嵌入)
 * 3. BM25 (TF-IDF 变体)
 *
 * 最终通过加权归一化融合结果。
 */

import type { MToolsAI } from "@/core/plugin-system/plugin-interface";

// ── 类型定义 ──

export interface SearchDocument {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  document: SearchDocument;
  score: number;
  method: "fuzzy" | "vector" | "bm25" | "hybrid";
}

export interface HybridSearchConfig {
  /** 模糊搜索权重 (0-1) */
  fuzzyWeight: number;
  /** 向量搜索权重 (0-1) */
  vectorWeight: number;
  /** BM25 权重 (0-1) */
  bm25Weight: number;
  /** 返回结果数 */
  topK: number;
  /** 文本分块大小 */
  chunkSize: number;
  /** 分块重叠 */
  chunkOverlap: number;
}

export const DEFAULT_CONFIG: HybridSearchConfig = {
  fuzzyWeight: 0.2,
  vectorWeight: 0.5,
  bm25Weight: 0.3,
  topK: 10,
  chunkSize: 500,
  chunkOverlap: 100,
};

// ── 文本分块 ──

export function chunkText(
  text: string,
  chunkSize: number,
  overlap: number,
): string[] {
  const chunks: string[] = [];
  if (text.length <= chunkSize) {
    chunks.push(text);
    return chunks;
  }

  let start = 0;
  while (start < text.length) {
    let end = start + chunkSize;

    // 尝试在句子边界断开
    if (end < text.length) {
      const boundary = text.lastIndexOf("。", end);
      const boundary2 = text.lastIndexOf(". ", end);
      const boundary3 = text.lastIndexOf("\n", end);
      const best = Math.max(boundary, boundary2, boundary3);
      if (best > start + chunkSize / 2) {
        end = best + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
  }

  return chunks.filter((c) => c.length > 0);
}

// ── BM25 算法 ──

class BM25 {
  private k1: number;
  private b: number;
  private avgDocLen: number;
  private docCount: number;
  private docFreqs: Map<string, number>;
  private docs: { tokens: string[]; id: string }[];

  constructor(documents: { id: string; content: string }[], k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docFreqs = new Map();
    this.docs = [];

    let totalLen = 0;
    for (const doc of documents) {
      const tokens = this.tokenize(doc.content);
      this.docs.push({ tokens, id: doc.id });
      totalLen += tokens.length;

      const seen = new Set<string>();
      for (const token of tokens) {
        if (!seen.has(token)) {
          seen.add(token);
          this.docFreqs.set(token, (this.docFreqs.get(token) || 0) + 1);
        }
      }
    }

    this.docCount = documents.length;
    this.avgDocLen = totalLen / Math.max(this.docCount, 1);
  }

  private tokenize(text: string): string[] {
    // 简单分词: 按空格和标点分割, 同时支持中文单字切分
    const words = text.toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9]+/g) || [];
    return words;
  }

  search(query: string, topK: number): { id: string; score: number }[] {
    const queryTokens = this.tokenize(query);
    const scores: { id: string; score: number }[] = [];

    for (const doc of this.docs) {
      let score = 0;
      const docLen = doc.tokens.length;

      // 计算每个 token 的频率
      const tf = new Map<string, number>();
      for (const token of doc.tokens) {
        tf.set(token, (tf.get(token) || 0) + 1);
      }

      for (const qToken of queryTokens) {
        const freq = tf.get(qToken) || 0;
        if (freq === 0) continue;

        const df = this.docFreqs.get(qToken) || 0;
        const idf = Math.log(
          (this.docCount - df + 0.5) / (df + 0.5) + 1,
        );

        const numerator = freq * (this.k1 + 1);
        const denominator =
          freq + this.k1 * (1 - this.b + (this.b * docLen) / this.avgDocLen);

        score += idf * (numerator / denominator);
      }

      scores.push({ id: doc.id, score });
    }

    return scores
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ── 模糊搜索 ──

function fuzzySearch(
  query: string,
  documents: SearchDocument[],
  topK: number,
): SearchResult[] {
  const lower = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const doc of documents) {
    const content = doc.content.toLowerCase();
    let score = 0;

    // 完全包含
    if (content.includes(lower)) {
      score = 0.8 + 0.2 * (lower.length / content.length);
    } else {
      // 按词匹配
      const words = lower.split(/\s+/);
      const matched = words.filter((w) => content.includes(w));
      score = matched.length / words.length;
    }

    if (score > 0) {
      results.push({ document: doc, score, method: "fuzzy" });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ── 查询扩展 (简单同义词) ──

const SYNONYMS: Record<string, string[]> = {
  javascript: ["js", "ecmascript"],
  typescript: ["ts"],
  python: ["py"],
  数据库: ["database", "db"],
  接口: ["api", "interface"],
  函数: ["function", "方法"],
  组件: ["component"],
  样式: ["style", "css"],
};

function expandQuery(query: string): string {
  let expanded = query;
  for (const [key, synonyms] of Object.entries(SYNONYMS)) {
    if (query.toLowerCase().includes(key)) {
      expanded += " " + synonyms.join(" ");
    }
    for (const syn of synonyms) {
      if (query.toLowerCase().includes(syn)) {
        expanded += " " + key;
      }
    }
  }
  return expanded;
}

// ── 归一化分数 ──

function normalizeScores(
  results: { id: string; score: number }[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (results.length === 0) return map;

  const maxScore = Math.max(...results.map((r) => r.score));
  if (maxScore === 0) return map;

  for (const r of results) {
    map.set(r.id, r.score / maxScore);
  }
  return map;
}

// ── 混合搜索主入口 ──

export async function hybridSearch(
  query: string,
  documents: SearchDocument[],
  ai?: MToolsAI,
  config: HybridSearchConfig = DEFAULT_CONFIG,
): Promise<SearchResult[]> {
  const expandedQuery = expandQuery(query);
  const docMap = new Map(documents.map((d) => [d.id, d]));

  // 1. 模糊搜索
  const fuzzyResults = fuzzySearch(expandedQuery, documents, config.topK * 2);
  const fuzzyScores = normalizeScores(
    fuzzyResults.map((r) => ({ id: r.document.id, score: r.score })),
  );

  // 2. BM25 搜索
  const bm25 = new BM25(documents);
  const bm25Results = bm25.search(expandedQuery, config.topK * 2);
  const bm25Scores = normalizeScores(bm25Results);

  // 3. 向量搜索 (如果 AI 可用)
  let vectorScores = new Map<string, number>();
  if (ai && config.vectorWeight > 0) {
    try {
      const queryEmbedding = await ai.embedding(query);
      // 简单的余弦相似度计算
      const docScores: { id: string; score: number }[] = [];
      for (const doc of documents) {
        try {
          const docEmbedding = await ai.embedding(
            doc.content.slice(0, 500),
          );
          const sim = cosineSimilarity(queryEmbedding, docEmbedding);
          docScores.push({ id: doc.id, score: sim });
        } catch {
          // 跳过嵌入失败的文档
        }
      }
      vectorScores = normalizeScores(docScores);
    } catch {
      // 向量搜索不可用，权重分配给其他方法
    }
  }

  // 4. 融合分数
  const allIds = new Set([
    ...fuzzyScores.keys(),
    ...bm25Scores.keys(),
    ...vectorScores.keys(),
  ]);

  const hybridResults: SearchResult[] = [];
  for (const id of allIds) {
    const fuzzyS = fuzzyScores.get(id) || 0;
    const bm25S = bm25Scores.get(id) || 0;
    const vectorS = vectorScores.get(id) || 0;

    const totalWeight =
      config.fuzzyWeight + config.bm25Weight + config.vectorWeight;
    const score =
      (fuzzyS * config.fuzzyWeight +
        bm25S * config.bm25Weight +
        vectorS * config.vectorWeight) /
      totalWeight;

    const doc = docMap.get(id);
    if (doc && score > 0) {
      hybridResults.push({ document: doc, score, method: "hybrid" });
    }
  }

  return hybridResults
    .sort((a, b) => b.score - a.score)
    .slice(0, config.topK);
}

// ── 工具函数 ──

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
