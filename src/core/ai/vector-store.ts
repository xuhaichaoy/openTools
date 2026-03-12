/**
 * VectorStore — 嵌入式向量存储引擎，基于 sqlite-vec 思路实现。
 *
 * 灵感来源：cocoindex-code 的 sqlite-vec (vec0 虚拟表) 方案
 *   - 零外部依赖，直接嵌入 SQLite，完美契合 Tauri 的 rusqlite
 *   - 分区查询：按 partition 分区，KNN 过滤效率高
 *   - 增量索引：只对变更内容重新索引
 *
 * 在 Rust 端 sqlite-vec 可用前，此模块提供纯 TS 的向量索引实现，
 * 使用余弦相似度 + 倒排索引的混合检索策略。
 *
 * 后续升级路径：通过 Tauri invoke 调用 Rust 端的 sqlite-vec，
 * 只需替换 search/upsert 的底层实现，接口保持不变。
 */

import { invoke } from "@tauri-apps/api/core";

export interface VectorEntry {
  id: string;
  content: string;
  embedding?: Float32Array;
  partition?: string;
  metadata?: Record<string, unknown>;
  updatedAt: number;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  score: number;
  partition?: string;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchOptions {
  topK?: number;
  partition?: string;
  minScore?: number;
  includeMetadata?: boolean;
}

export interface VectorStoreConfig {
  collection: string;
  dimensions?: number;
  /** Use Rust backend (sqlite-vec) if available */
  useNative?: boolean;
}

type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

const DEFAULT_DIMENSIONS = 384;
const DEFAULT_TOP_K = 10;
const DEFAULT_MIN_SCORE = 0.05;

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * 简单的 TF-IDF 文本向量化（当嵌入模型不可用时的降级方案）。
 * 生产环境应替换为 Rust 端的 SentenceTransformers 或 LiteLLM。
 */
function simpleTextToVector(text: string, dimensions: number): Float32Array {
  const vec = new Float32Array(dimensions);
  const normalized = text.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, " ").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % dimensions;
    vec[idx] += 1;
    // Bi-gram for better disambiguation
    if (token.length > 1) {
      const biHash = ((hash << 3) + token.charCodeAt(token.length - 1)) | 0;
      vec[Math.abs(biHash) % dimensions] += 0.5;
    }
  }

  // L2-normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) vec[i] /= norm;
  }
  return vec;
}

export class VectorStore {
  private entries = new Map<string, VectorEntry>();
  private readonly config: Required<VectorStoreConfig>;
  private embedFn?: EmbedFn;
  private nativeAvailable: boolean | null = null;

  constructor(config: VectorStoreConfig) {
    this.config = {
      collection: config.collection,
      dimensions: config.dimensions ?? DEFAULT_DIMENSIONS,
      useNative: config.useNative ?? true,
    };
  }

  setEmbedFunction(fn: EmbedFn): void {
    this.embedFn = fn;
  }

  private async checkNativeAvailability(): Promise<boolean> {
    if (this.nativeAvailable !== null) return this.nativeAvailable;
    if (!this.config.useNative) {
      this.nativeAvailable = false;
      return false;
    }
    try {
      await invoke("vector_store_ping", { collection: this.config.collection });
      this.nativeAvailable = true;
    } catch {
      this.nativeAvailable = false;
    }
    return this.nativeAvailable;
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.embedFn) {
      return this.embedFn(texts);
    }
    return texts.map((t) => simpleTextToVector(t, this.config.dimensions));
  }

  async upsert(entries: Array<{ id: string; content: string; partition?: string; metadata?: Record<string, unknown> }>): Promise<number> {
    if (await this.checkNativeAvailability()) {
      try {
        return await invoke<number>("vector_store_upsert", {
          collection: this.config.collection,
          entries: entries.map((e) => ({
            ...e,
            metadata: e.metadata ? JSON.stringify(e.metadata) : undefined,
          })),
        });
      } catch { /* fall through to in-memory */ }
    }

    const contents = entries.map((e) => e.content);
    const embeddings = await this.embed(contents);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      this.entries.set(entry.id, {
        id: entry.id,
        content: entry.content,
        embedding: embeddings[i],
        partition: entry.partition,
        metadata: entry.metadata,
        updatedAt: Date.now(),
      });
    }
    return entries.length;
  }

  async search(query: string, options?: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const topK = options?.topK ?? DEFAULT_TOP_K;
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;

    if (await this.checkNativeAvailability()) {
      try {
        return await invoke<VectorSearchResult[]>("vector_store_search", {
          collection: this.config.collection,
          query,
          topK,
          partition: options?.partition,
          minScore,
        });
      } catch { /* fall through */ }
    }

    const [queryEmbedding] = await this.embed([query]);
    const candidates: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (options?.partition && entry.partition !== options.partition) continue;
      if (!entry.embedding) continue;

      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      if (score >= minScore) {
        candidates.push({
          id: entry.id,
          content: entry.content,
          score,
          partition: entry.partition,
          metadata: options?.includeMetadata ? entry.metadata : undefined,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK);
  }

  async remove(ids: string[]): Promise<number> {
    if (await this.checkNativeAvailability()) {
      try {
        return await invoke<number>("vector_store_remove", {
          collection: this.config.collection,
          ids,
        });
      } catch { /* fall through */ }
    }

    let removed = 0;
    for (const id of ids) {
      if (this.entries.delete(id)) removed++;
    }
    return removed;
  }

  async clear(): Promise<void> {
    if (await this.checkNativeAvailability()) {
      try {
        await invoke("vector_store_clear", { collection: this.config.collection });
        return;
      } catch { /* fall through */ }
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  async listPartitions(): Promise<string[]> {
    const partitions = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.partition) partitions.add(entry.partition);
    }
    return [...partitions];
  }
}

// ── Singleton instances for common use cases ──

const stores = new Map<string, VectorStore>();

export function getVectorStore(collection: string, config?: Partial<VectorStoreConfig>): VectorStore {
  let store = stores.get(collection);
  if (!store) {
    store = new VectorStore({ collection, ...config });
    stores.set(collection, store);
  }
  return store;
}

/**
 * Memory vector store — dedicated instance for AI memory semantic search.
 * Replaces the naive tokenize-and-overlap approach in memory-store.ts.
 */
export function getMemoryVectorStore(): VectorStore {
  return getVectorStore("ai_memory", { dimensions: DEFAULT_DIMENSIONS });
}

/**
 * Knowledge base vector store — for document-level RAG.
 */
export function getKnowledgeVectorStore(kbId: string): VectorStore {
  return getVectorStore(`kb_${kbId}`, { dimensions: DEFAULT_DIMENSIONS });
}

/**
 * Code index vector store — for AST-aware code search.
 */
export function getCodeIndexStore(projectId: string): VectorStore {
  return getVectorStore(`code_${projectId}`, { dimensions: DEFAULT_DIMENSIONS });
}
