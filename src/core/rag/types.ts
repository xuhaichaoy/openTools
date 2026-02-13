/**
 * RAG 本地知识库 — 核心类型定义
 */

/** 支持的文档格式 */
export type DocFormat = 'txt' | 'md' | 'pdf' | 'json' | 'csv' | 'html'

/** 文档状态 */
export type DocStatus = 'pending' | 'processing' | 'indexed' | 'error'

/** 文档元数据 */
export interface KnowledgeDoc {
  id: string
  name: string            // 文件名
  path: string            // 原始文件路径
  format: DocFormat
  size: number            // 字节数
  status: DocStatus
  chunkCount: number      // 分块数量
  tokenCount: number      // 总 token 数（估算）
  createdAt: number       // 导入时间戳
  updatedAt: number
  errorMsg?: string       // 处理失败时的错误信息
  tags?: string[]         // 用户自定义标签
}

/** 文档分块 */
export interface DocChunk {
  id: string
  docId: string           // 所属文档 ID
  content: string         // 文本内容
  index: number           // 在文档中的顺序
  tokenCount: number
  metadata: {
    source: string        // 来源文件名
    page?: number         // PDF 页码
    heading?: string      // 当前标题上下文
  }
}

/** 检索结果 */
export interface RetrievalResult {
  chunk: DocChunk
  score: number           // 相似度分数 (0-1)
  highlights?: string[]   // 匹配高亮片段
}

/** 知识库配置 */
export interface RAGConfig {
  chunkSize: number           // 每块最大 token 数, 默认 512
  chunkOverlap: number        // 块间重叠 token 数, 默认 50
  topK: number                // 检索返回数量, 默认 5
  scoreThreshold: number      // 最低相似度阈值, 默认 0.3
  embeddingModel: string      // Embedding 模型名, 默认 text-embedding-3-small
  embeddingDimension: number  // 向量维度, 默认 1536
}

/** 知识库统计 */
export interface RAGStats {
  totalDocs: number
  totalChunks: number
  totalTokens: number
  indexSize: number           // 索引文件大小（字节）
}

export const DEFAULT_RAG_CONFIG: RAGConfig = {
  chunkSize: 512,
  chunkOverlap: 50,
  topK: 5,
  scoreThreshold: 0.3,
  embeddingModel: 'text-embedding-3-small',
  embeddingDimension: 1536,
}
