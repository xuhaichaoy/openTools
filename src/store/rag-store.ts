import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { KnowledgeDoc, RetrievalResult, RAGConfig, RAGStats } from '@/core/rag/types'
import { DEFAULT_RAG_CONFIG } from '@/core/rag/types'
import { handleError } from '@/core/errors'

interface RAGState {
  docs: KnowledgeDoc[]
  config: RAGConfig
  stats: RAGStats | null
  isLoading: boolean
  isIndexing: boolean
  searchResults: RetrievalResult[]
  searchQuery: string

  loadConfig: () => Promise<void>
  loadDocs: () => Promise<void>
  importDoc: (filePath: string, tags?: string[], opts?: { autoIndex?: boolean }) => Promise<void>
  parseDoc: (docId: string) => Promise<void>
  indexDoc: (docId: string) => Promise<void>
  retryDoc: (docId: string) => Promise<void>
  removeDoc: (docId: string) => Promise<void>
  reindexDoc: (docId: string) => Promise<void>
  search: (query: string) => Promise<RetrievalResult[]>
  keywordSearch: (query: string) => Promise<RetrievalResult[]>
  updateConfig: (config: Partial<RAGConfig>) => Promise<void>
  loadStats: () => Promise<void>
  setSearchQuery: (q: string) => void
}

export const useRAGStore = create<RAGState>((set, get) => ({
  docs: [],
  config: { ...DEFAULT_RAG_CONFIG },
  stats: null,
  isLoading: false,
  isIndexing: false,
  searchResults: [],
  searchQuery: '',

  loadConfig: async () => {
    try {
      const config = await invoke<RAGConfig>('rag_get_config')
      set({ config: { ...DEFAULT_RAG_CONFIG, ...config } })
    } catch (e) {
      handleError(e, { context: '加载 RAG 配置', silent: true })
    }
  },

  loadDocs: async () => {
    set({ isLoading: true })
    try {
      const docs = await invoke<KnowledgeDoc[]>('rag_list_docs')
      set({ docs })
    } catch (e) {
      handleError(e, { context: '加载知识库文档' })
    }
    set({ isLoading: false })
  },

  importDoc: async (filePath, tags, opts) => {
    set({ isIndexing: true })
    try {
      await invoke('rag_import_doc', { filePath, tags: tags || [], autoIndex: opts?.autoIndex ?? true })
      await get().loadDocs()
      await get().loadStats()
    } catch (e) {
      handleError(e, { context: '导入文档' })
      throw e
    }
    set({ isIndexing: false })
  },

  parseDoc: async (docId) => {
    set({ isIndexing: true })
    try {
      await invoke('rag_parse_doc', { docId })
      await get().loadDocs()
      await get().loadStats()
    } catch (e) {
      handleError(e, { context: '解析文档' })
      throw e
    }
    set({ isIndexing: false })
  },

  indexDoc: async (docId) => {
    set({ isIndexing: true })
    try {
      await invoke('rag_index_doc', { docId })
      await get().loadDocs()
      await get().loadStats()
    } catch (e) {
      handleError(e, { context: '文档入库' })
      throw e
    }
    set({ isIndexing: false })
  },

  retryDoc: async (docId) => {
    set({ isIndexing: true })
    try {
      await invoke('rag_retry_doc', { docId })
      await get().loadDocs()
      await get().loadStats()
    } catch (e) {
      handleError(e, { context: '重试文档处理' })
      throw e
    }
    set({ isIndexing: false })
  },

  removeDoc: async (docId) => {
    try {
      await invoke('rag_remove_doc', { docId })
      set({ docs: get().docs.filter((d) => d.id !== docId) })
      await get().loadStats()
    } catch (e) {
      handleError(e, { context: '删除文档' })
    }
  },

  reindexDoc: async (docId) => {
    set({ isIndexing: true })
    try {
      await invoke('rag_reindex_doc', { docId })
      await get().loadDocs()
    } catch (e) {
      handleError(e, { context: '重建索引' })
    }
    set({ isIndexing: false })
  },

  search: async (query) => {
    try {
      const results = await invoke<RetrievalResult[]>('rag_search', {
        query,
        topK: get().config.topK,
        threshold: get().config.scoreThreshold,
      })
      set({ searchResults: results })
      return results
    } catch (e) {
      try {
        const fallback = await invoke<RetrievalResult[]>('rag_keyword_search', {
          query,
          topK: get().config.topK,
        })
        set({ searchResults: fallback })
        return fallback
      } catch (fallbackError) {
        handleError(fallbackError, { context: '检索知识库' })
        return []
      }
    }
  },

  keywordSearch: async (query) => {
    try {
      const results = await invoke<RetrievalResult[]>('rag_keyword_search', {
        query,
        topK: get().config.topK,
      })
      set({ searchResults: results })
      return results
    } catch (e) {
      handleError(e, { context: '关键词检索' })
      return []
    }
  },

  updateConfig: async (partial) => {
    const newConfig = { ...get().config, ...partial }
    set({ config: newConfig })
    try {
      await invoke('rag_set_config', { config: newConfig })
    } catch (e) {
      handleError(e, { context: '保存 RAG 配置' })
    }
  },

  loadStats: async () => {
    try {
      const stats = await invoke<RAGStats>('rag_get_stats')
      set({ stats })
    } catch (e) {
      handleError(e, { context: '加载 RAG 统计' })
    }
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
}))

// 监听索引进度事件（应用生命周期级别，存储 unlisten 以供需要时清理）
let _unlistenRagProgress: (() => void) | null = null
listen<{ docId: string; status: string; progress?: number; error?: string }>(
  'rag-index-progress',
  (event) => {
    const { docId, status, error } = event.payload
    useRAGStore.setState((state) => ({
      docs: state.docs.map((d) =>
        d.id === docId
          ? { ...d, status: status as any, errorMsg: error }
          : d
      ),
    }))
  }
).then((fn) => { _unlistenRagProgress = fn })

/** 清理 RAG 进度监听器（用于测试或热重载场景） */
export function cleanupRAGListener() {
  _unlistenRagProgress?.()
  _unlistenRagProgress = null
}
