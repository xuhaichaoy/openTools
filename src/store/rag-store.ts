import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { KnowledgeDoc, RetrievalResult, RAGConfig, RAGStats } from '@/core/rag/types'
import { DEFAULT_RAG_CONFIG } from '@/core/rag/types'

interface RAGState {
  // 状态
  docs: KnowledgeDoc[]
  config: RAGConfig
  stats: RAGStats | null
  isLoading: boolean
  isIndexing: boolean
  searchResults: RetrievalResult[]
  searchQuery: string

  // 操作
  loadDocs: () => Promise<void>
  importDoc: (filePath: string, tags?: string[]) => Promise<void>
  removeDoc: (docId: string) => Promise<void>
  reindexDoc: (docId: string) => Promise<void>
  search: (query: string) => Promise<RetrievalResult[]>
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

  loadDocs: async () => {
    set({ isLoading: true })
    try {
      const docs = await invoke<KnowledgeDoc[]>('rag_list_docs')
      set({ docs })
    } catch (e) {
      console.error('加载知识库文档失败:', e)
    }
    set({ isLoading: false })
  },

  importDoc: async (filePath, tags) => {
    set({ isIndexing: true })
    try {
      await invoke('rag_import_doc', { filePath, tags: tags || [] })
      await get().loadDocs()
      await get().loadStats()
    } catch (e) {
      console.error('导入文档失败:', e)
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
      console.error('删除文档失败:', e)
    }
  },

  reindexDoc: async (docId) => {
    set({ isIndexing: true })
    try {
      await invoke('rag_reindex_doc', { docId })
      await get().loadDocs()
    } catch (e) {
      console.error('重建索引失败:', e)
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
      console.error('检索失败:', e)
      return []
    }
  },

  updateConfig: async (partial) => {
    const newConfig = { ...get().config, ...partial }
    set({ config: newConfig })
    try {
      await invoke('rag_set_config', { config: newConfig })
    } catch (e) {
      console.error('保存 RAG 配置失败:', e)
    }
  },

  loadStats: async () => {
    try {
      const stats = await invoke<RAGStats>('rag_get_stats')
      set({ stats })
    } catch (e) {
      console.error('加载统计失败:', e)
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
