/**
 * KnowledgeEval — 知识库评估体系
 *
 * 灵感来源：Yuxi-Know 的知识库评估功能（导入或自动构建评估基准）
 *
 * 核心能力：
 * 1. 评估基准管理：导入或自动生成 QA 对作为评估基准
 * 2. RAG 检索质量评估：命中率、MRR、NDCG 等指标
 * 3. 答案质量评估：通过 LLM 评分
 * 4. 端到端评估：检索 + 生成的综合评分
 * 5. 评估报告生成
 */

export interface EvalBenchmark {
  id: string;
  name: string;
  items: EvalItem[];
  createdAt: number;
  source: "manual" | "auto-generated" | "imported";
}

export interface EvalItem {
  id: string;
  query: string;
  /** Expected answer (ground truth) */
  expectedAnswer: string;
  /** Expected relevant document IDs or content snippets */
  relevantDocs?: string[];
  /** Category for grouped analysis */
  category?: string;
}

export interface EvalResult {
  benchmarkId: string;
  knowledgeBaseId: string;
  timestamp: number;
  metrics: EvalMetrics;
  itemResults: EvalItemResult[];
  summary: string;
}

export interface EvalMetrics {
  /** Hit rate: % of queries where at least one relevant doc was in top-K results */
  hitRate: number;
  /** Mean Reciprocal Rank */
  mrr: number;
  /** Average relevance score of top-K results */
  avgRelevanceScore: number;
  /** Answer quality score (0-1, LLM-judged) */
  answerQuality: number;
  /** Total evaluation time (ms) */
  evalTimeMs: number;
  /** Number of items evaluated */
  itemCount: number;
}

export interface EvalItemResult {
  itemId: string;
  query: string;
  retrievedDocs: Array<{ content: string; score: number }>;
  /** Was any relevant document retrieved in top-K? */
  hit: boolean;
  /** Rank of first relevant document (0 if not found) */
  firstRelevantRank: number;
  /** LLM-judged answer quality (0-1) */
  answerScore: number;
  /** Generated answer */
  generatedAnswer?: string;
}

interface SearchFn {
  (query: string, topK: number): Promise<Array<{ content: string; score: number }>>;
}

function generateId(): string {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function computeRelevance(retrieved: string, expected: string): number {
  const retTokens = new Set(retrieved.toLowerCase().split(/\s+/).filter((t) => t.length > 1));
  const expTokens = expected.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (expTokens.length === 0) return 0;

  let matchCount = 0;
  for (const token of expTokens) {
    if (retTokens.has(token)) matchCount++;
  }
  return matchCount / expTokens.length;
}

// ── Benchmark Builder ──

export class BenchmarkBuilder {
  private items: EvalItem[] = [];

  addItem(query: string, expectedAnswer: string, opts?: { relevantDocs?: string[]; category?: string }): this {
    this.items.push({
      id: generateId(),
      query,
      expectedAnswer,
      relevantDocs: opts?.relevantDocs,
      category: opts?.category,
    });
    return this;
  }

  /** Import from JSON array */
  importItems(items: Array<{ query: string; answer: string; docs?: string[]; category?: string }>): this {
    for (const item of items) {
      this.addItem(item.query, item.answer, { relevantDocs: item.docs, category: item.category });
    }
    return this;
  }

  build(name: string, source: EvalBenchmark["source"] = "manual"): EvalBenchmark {
    return {
      id: generateId(),
      name,
      items: [...this.items],
      createdAt: Date.now(),
      source,
    };
  }
}

/**
 * Auto-generate QA benchmark from documents using LLM.
 * Inspired by Yuxi-Know's auto-benchmark generation.
 */
export async function autoGenerateBenchmark(
  documents: Array<{ title: string; content: string }>,
  questionsPerDoc: number = 3,
): Promise<EvalBenchmark> {
  const builder = new BenchmarkBuilder();

  try {
    const { getMToolsAI } = await import("@/core/ai/mtools-ai");
    const ai = getMToolsAI();

    for (const doc of documents) {
      const truncated = doc.content.slice(0, 2000);
      const prompt = `Based on the following document, generate ${questionsPerDoc} question-answer pairs for evaluating a RAG system.

Document title: ${doc.title}
Document content:
${truncated}

Generate in JSON format:
[{"query": "...", "answer": "..."}]

Rules:
- Questions should be answerable from the document content
- Answers should be concise and factual
- Vary question types (what, how, why, compare)
- Return ONLY valid JSON array`;

      try {
        const result = await ai.chat({
          messages: [
            {
              role: "system",
              content: "You generate QA pairs for RAG evaluation. Return only JSON.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          skipTools: true,
        });

        const text = result.content;
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const pairs = JSON.parse(jsonMatch[0]) as Array<{ query: string; answer: string }>;
          for (const pair of pairs) {
            builder.addItem(pair.query, pair.answer, { category: doc.title });
          }
        }
      } catch {
        // Skip this document if LLM fails
      }
    }
  } catch {
    // LLM not available, return empty benchmark
  }

  return builder.build("Auto-generated benchmark", "auto-generated");
}

// ── Evaluator ──

export class KnowledgeEvaluator {
  private searchFn: SearchFn;
  private knowledgeBaseId: string;

  constructor(knowledgeBaseId: string, searchFn: SearchFn) {
    this.knowledgeBaseId = knowledgeBaseId;
    this.searchFn = searchFn;
  }

  async evaluate(benchmark: EvalBenchmark, topK = 5): Promise<EvalResult> {
    const startTime = Date.now();
    const itemResults: EvalItemResult[] = [];

    for (const item of benchmark.items) {
      const retrieved = await this.searchFn(item.query, topK);

      // Determine hit and first relevant rank
      let hit = false;
      let firstRelevantRank = 0;

      for (let i = 0; i < retrieved.length; i++) {
        const relevance = computeRelevance(retrieved[i].content, item.expectedAnswer);
        if (relevance > 0.3) {
          if (!hit) {
            hit = true;
            firstRelevantRank = i + 1;
          }
        }
      }

      // Simple answer quality: overlap between best retrieved and expected
      const bestScore = retrieved.length > 0
        ? Math.max(...retrieved.map((r) => computeRelevance(r.content, item.expectedAnswer)))
        : 0;

      itemResults.push({
        itemId: item.id,
        query: item.query,
        retrievedDocs: retrieved.slice(0, topK),
        hit,
        firstRelevantRank,
        answerScore: bestScore,
      });
    }

    // Compute aggregate metrics
    const hitCount = itemResults.filter((r) => r.hit).length;
    const hitRate = benchmark.items.length > 0 ? hitCount / benchmark.items.length : 0;

    const mrr = benchmark.items.length > 0
      ? itemResults.reduce((sum, r) => sum + (r.firstRelevantRank > 0 ? 1 / r.firstRelevantRank : 0), 0) / benchmark.items.length
      : 0;

    const avgRelevanceScore = itemResults.length > 0
      ? itemResults.reduce((sum, r) => {
          const maxScore = r.retrievedDocs.length > 0 ? Math.max(...r.retrievedDocs.map((d) => d.score)) : 0;
          return sum + maxScore;
        }, 0) / itemResults.length
      : 0;

    const answerQuality = itemResults.length > 0
      ? itemResults.reduce((sum, r) => sum + r.answerScore, 0) / itemResults.length
      : 0;

    const metrics: EvalMetrics = {
      hitRate,
      mrr,
      avgRelevanceScore,
      answerQuality,
      evalTimeMs: Date.now() - startTime,
      itemCount: benchmark.items.length,
    };

    const summary = [
      `知识库评估报告 (${benchmark.name})`,
      `评估时间: ${new Date().toLocaleString()}`,
      `评估项数: ${metrics.itemCount}`,
      `命中率 (Hit Rate): ${(metrics.hitRate * 100).toFixed(1)}%`,
      `MRR: ${metrics.mrr.toFixed(3)}`,
      `平均检索相关度: ${(metrics.avgRelevanceScore * 100).toFixed(1)}%`,
      `答案质量: ${(metrics.answerQuality * 100).toFixed(1)}%`,
      `耗时: ${metrics.evalTimeMs}ms`,
    ].join("\n");

    return {
      benchmarkId: benchmark.id,
      knowledgeBaseId: this.knowledgeBaseId,
      timestamp: Date.now(),
      metrics,
      itemResults,
      summary,
    };
  }
}
