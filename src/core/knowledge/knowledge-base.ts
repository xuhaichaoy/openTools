/**
 * KnowledgeBase — 知识库管理系统
 *
 * 灵感来源：
 * - Yuxi-Know 的 KnowledgeBaseFactory 工厂模式 + RAGFlow-like 分块策略
 * - cocoindex-code 的增量索引 + sqlite-vec 向量存储
 *
 * 核心能力：
 * 1. 工厂模式：注册不同类型的知识库实现（向量、图谱等）
 * 2. 智能分块：支持 general/qa/book/laws 等多种预设策略
 * 3. 向量检索：基于 VectorStore 的语义搜索
 * 4. 增量更新：文档 hash 变更检测，只重建索引变更部分
 * 5. 知识库中间件集成：与 KnowledgeBaseMiddleware 配合注入 Agent
 */

import { getKnowledgeVectorStore, type VectorSearchResult } from "@/core/ai/vector-store";
import { documentProcessor, type ParsedDocument, type DocumentFormat } from "./document-processor";
import { registerKnowledgeBase, type KnowledgeBaseRef } from "@/core/agent/actor/middlewares/knowledge-base-middleware";

export interface KnowledgeBaseConfig {
  id: string;
  name: string;
  description?: string;
  /** 分块策略 */
  chunkingStrategy: ChunkingStrategy;
  /** 支持的文件格式 */
  supportedFormats?: DocumentFormat[];
  createdAt: number;
  updatedAt: number;
}

export type ChunkingStrategy = "general" | "qa" | "book" | "laws" | "code" | "custom";

export interface ChunkingConfig {
  strategy: ChunkingStrategy;
  /** 块大小（字符数） */
  chunkSize?: number;
  /** 最小块大小 */
  minChunkSize?: number;
  /** 块重叠量 */
  overlap?: number;
  /** 自定义分隔符 */
  separators?: string[];
}

export interface KnowledgeDocument {
  id: string;
  filePath: string;
  title: string;
  format: DocumentFormat;
  /** Content hash for incremental detection */
  hash: string;
  chunkCount: number;
  indexedAt: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  content: string;
  /** Chunk position within the document */
  position: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchResult {
  content: string;
  score: number;
  documentTitle: string;
  source?: string;
  chunkPosition?: number;
}

// ── Chunking Strategies (inspired by Yuxi-Know's RAGFlow-like chunking) ──

const STRATEGY_CONFIGS: Record<ChunkingStrategy, ChunkingConfig> = {
  general: {
    strategy: "general",
    chunkSize: 500,
    minChunkSize: 100,
    overlap: 50,
    separators: ["\n\n", "\n", "。", ".", "！", "!", "？", "?", "；", ";"],
  },
  qa: {
    strategy: "qa",
    chunkSize: 300,
    minChunkSize: 50,
    overlap: 30,
    separators: ["\n\n", "\nQ:", "\n问:", "\n问题"],
  },
  book: {
    strategy: "book",
    chunkSize: 1000,
    minChunkSize: 200,
    overlap: 100,
    separators: ["\n\n\n", "\n\n", "\n# ", "\n## ", "\n### "],
  },
  laws: {
    strategy: "laws",
    chunkSize: 400,
    minChunkSize: 80,
    overlap: 40,
    separators: ["\n\n", "\n第", "\n条", "\n款"],
  },
  code: {
    strategy: "code",
    chunkSize: 2000,
    minChunkSize: 100,
    overlap: 200,
    separators: ["\n\nfunction ", "\n\nclass ", "\n\ndef ", "\n\npub fn ", "\n\n"],
  },
  custom: {
    strategy: "custom",
    chunkSize: 500,
    minChunkSize: 100,
    overlap: 50,
  },
};

function chunkText(text: string, config: ChunkingConfig): string[] {
  const chunkSize = config.chunkSize ?? 500;
  const minChunkSize = config.minChunkSize ?? 100;
  const overlap = config.overlap ?? 50;
  const separators = config.separators ?? ["\n\n", "\n", ".", "。"];

  const chunks: string[] = [];

  function splitRecursive(text: string, sepIdx: number): void {
    if (text.length <= chunkSize) {
      if (text.trim().length >= minChunkSize) chunks.push(text.trim());
      return;
    }

    if (sepIdx >= separators.length) {
      // No more separators: force split by size
      for (let i = 0; i < text.length; i += chunkSize - overlap) {
        const chunk = text.slice(i, i + chunkSize).trim();
        if (chunk.length >= minChunkSize) chunks.push(chunk);
      }
      return;
    }

    const sep = separators[sepIdx];
    const parts = text.split(sep);
    let current = "";

    for (const part of parts) {
      if ((current + sep + part).length > chunkSize && current.length > 0) {
        if (current.trim().length >= minChunkSize) chunks.push(current.trim());
        // Overlap: keep end of previous chunk
        const overlapText = current.slice(-overlap);
        current = overlapText + sep + part;
      } else {
        current = current ? current + sep + part : part;
      }
    }

    if (current.trim().length >= minChunkSize) {
      if (current.length > chunkSize) {
        splitRecursive(current, sepIdx + 1);
      } else {
        chunks.push(current.trim());
      }
    }
  }

  splitRecursive(text, 0);
  return chunks;
}

function hashString(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ── KnowledgeBase Implementation ──

export class KnowledgeBase {
  readonly config: KnowledgeBaseConfig;
  private documents = new Map<string, KnowledgeDocument>();
  private chunkingConfig: ChunkingConfig;

  constructor(config: KnowledgeBaseConfig) {
    this.config = config;
    this.chunkingConfig = STRATEGY_CONFIGS[config.chunkingStrategy] ?? STRATEGY_CONFIGS.general;
  }

  get id(): string { return this.config.id; }
  get name(): string { return this.config.name; }
  get documentCount(): number { return this.documents.size; }

  /**
   * Add a document to the knowledge base. Parses, chunks, and indexes it.
   * Uses content hash for incremental detection — unchanged documents are skipped.
   */
  async addDocument(filePath: string, content?: string): Promise<KnowledgeDocument> {
    const parsed = await documentProcessor.parse(filePath, content);
    const hash = hashString(parsed.content);

    // Check if document already indexed with same hash
    const existing = [...this.documents.values()].find((d) => d.filePath === filePath);
    if (existing && existing.hash === hash) {
      return existing;
    }

    // Remove old version if exists
    if (existing) {
      await this.removeDocument(existing.id);
    }

    // Chunk the document
    const textChunks = chunkText(parsed.content, this.chunkingConfig);
    const docId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // Index chunks into vector store
    const store = getKnowledgeVectorStore(this.config.id);
    await store.upsert(
      textChunks.map((chunk, idx) => ({
        id: `${docId}:${idx}`,
        content: chunk,
        partition: parsed.format,
        metadata: {
          documentId: docId,
          documentTitle: parsed.title,
          filePath: parsed.filePath,
          position: idx,
        },
      })),
    );

    const doc: KnowledgeDocument = {
      id: docId,
      filePath: parsed.filePath,
      title: parsed.title,
      format: parsed.format,
      hash,
      chunkCount: textChunks.length,
      indexedAt: Date.now(),
      metadata: parsed.metadata,
    };
    this.documents.set(docId, doc);
    return doc;
  }

  /** Add multiple documents in batch */
  async addDocuments(files: Array<{ path: string; content?: string }>): Promise<{ added: number; skipped: number; errors: string[] }> {
    let added = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const file of files) {
      try {
        const existing = [...this.documents.values()].find((d) => d.filePath === file.path);
        if (existing && file.content && hashString(file.content) === existing.hash) {
          skipped++;
          continue;
        }
        await this.addDocument(file.path, file.content);
        added++;
      } catch (err) {
        errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { added, skipped, errors };
  }

  /** Remove a document and its chunks */
  async removeDocument(documentId: string): Promise<boolean> {
    const doc = this.documents.get(documentId);
    if (!doc) return false;

    const store = getKnowledgeVectorStore(this.config.id);
    const chunkIds = Array.from({ length: doc.chunkCount }, (_, i) => `${documentId}:${i}`);
    await store.remove(chunkIds);
    this.documents.delete(documentId);
    return true;
  }

  /** Search the knowledge base */
  async search(query: string, topK = 5): Promise<KnowledgeSearchResult[]> {
    const store = getKnowledgeVectorStore(this.config.id);
    const results = await store.search(query, { topK, minScore: 0.1, includeMetadata: true });

    return results.map((r) => ({
      content: r.content,
      score: r.score,
      documentTitle: String(r.metadata?.documentTitle ?? ""),
      source: String(r.metadata?.filePath ?? ""),
      chunkPosition: Number(r.metadata?.position ?? 0),
    }));
  }

  /** Get all documents */
  getDocuments(): KnowledgeDocument[] {
    return [...this.documents.values()];
  }

  /** Register this KB with the agent middleware system */
  registerForAgent(): void {
    registerKnowledgeBase({
      id: this.config.id,
      name: this.config.name,
      search: (query, topK) => this.search(query, topK),
    });
  }
}

// ── KnowledgeBase Manager (Factory Pattern, inspired by Yuxi-Know) ──

class KnowledgeBaseManager {
  private bases = new Map<string, KnowledgeBase>();

  create(config: KnowledgeBaseConfig): KnowledgeBase {
    if (this.bases.has(config.id)) {
      throw new Error(`Knowledge base ${config.id} already exists`);
    }
    const kb = new KnowledgeBase(config);
    this.bases.set(config.id, kb);
    return kb;
  }

  get(id: string): KnowledgeBase | undefined {
    return this.bases.get(id);
  }

  getAll(): KnowledgeBase[] {
    return [...this.bases.values()];
  }

  delete(id: string): boolean {
    return this.bases.delete(id);
  }

  /** Register all KBs for agent middleware */
  registerAllForAgent(): void {
    for (const kb of this.bases.values()) {
      kb.registerForAgent();
    }
  }
}

export const knowledgeBaseManager = new KnowledgeBaseManager();
