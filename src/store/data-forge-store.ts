import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ScriptMeta, ScriptCategory, ExecutionRecord, ExecutionStatus } from '@/core/data-forge/types'
import { handleError } from '@/core/errors'
import { multiFieldPinyinScore } from '@/utils/pinyin-search'

interface DataForgeState {
  // 数据
  categories: ScriptCategory[]
  allScripts: ScriptMeta[]
  executionHistory: ExecutionRecord[]
  currentExecution: ExecutionRecord | null

  // UI 状态
  selectedCategory: string | null   // null = 全部
  selectedScript: ScriptMeta | null
  searchQuery: string
  isLoading: boolean

  // Actions
  loadScripts: () => Promise<void>
  searchScripts: (query: string) => Promise<void>
  setSelectedCategory: (category: string | null) => void
  setSelectedScript: (script: ScriptMeta | null) => void
  setSearchQuery: (query: string) => void
  runScript: (scriptId: string, params: Record<string, unknown>) => Promise<void>
  rerunFromHistory: (record: ExecutionRecord) => Promise<void>
  loadHistory: () => Promise<void>

  // 计算属性
  getFilteredScripts: () => ScriptMeta[]
}

export const useDataForgeStore = create<DataForgeState>((set, get) => ({
  categories: [],
  allScripts: [],
  executionHistory: [],
  currentExecution: null,
  selectedCategory: null,
  selectedScript: null,
  searchQuery: '',
  isLoading: false,

  loadScripts: async () => {
    set({ isLoading: true })
    try {
      const categories = await invoke<ScriptCategory[]>('dataforge_get_scripts')
      const allScripts = categories.flatMap(c => c.scripts)
      set({ categories, allScripts, isLoading: false })
    } catch (e) {
      handleError(e, { context: '加载脚本列表' })
      set({ isLoading: false })
    }
  },

  searchScripts: async (query: string) => {
    // 只更新搜索关键词，由 getFilteredScripts() 做本地拼音过滤
    // 不再破坏性地覆盖 allScripts
    set({ searchQuery: query.trim() })
  },

  setSelectedCategory: (category) => set({ selectedCategory: category }),

  setSelectedScript: (script) => set({ selectedScript: script }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  runScript: async (scriptId, params) => {
    const state = get()
    const script = state.allScripts.find(s => s.id === scriptId)
    if (!script) return

    const execution: ExecutionRecord = {
      id: crypto.randomUUID(),
      script_id: scriptId,
      script_name: script.name,
      category: script.category,
      params,
      status: 'running' as ExecutionStatus,
      started_at: Date.now(),
      output_files: [],
      logs: '',
    }

    set({ currentExecution: execution })

    // 监听执行事件
    let eventHandled = false
    const unlistenDone = await listen<{ execution_id: string; record: ExecutionRecord }>(
      'dataforge-execution-done',
      (event) => {
        if (eventHandled) return
        eventHandled = true
        const record = event.payload.record
        set((state) => ({
          currentExecution: null,
          executionHistory: [record, ...state.executionHistory],
        }))
        unlistenDone()
      }
    )

    try {
      const result = await invoke<ExecutionRecord>('dataforge_run_script', {
        scriptId,
        params,
      })
      // invoke 直接返回了结果 → 如果事件还没处理过则写入
      if (result && !eventHandled) {
        eventHandled = true
        unlistenDone()
        set((state) => ({
          currentExecution: null,
          executionHistory: [result, ...state.executionHistory],
        }))
      }
    } catch (e) {
      handleError(e, { context: '执行脚本' })
      unlistenDone() // 清理监听
      set({
        currentExecution: {
          ...execution,
          status: 'failed' as ExecutionStatus,
          error: String(e),
          finished_at: Date.now(),
        },
      })
    }
  },

  rerunFromHistory: async (record: ExecutionRecord) => {
    const state = get()
    // 找到对应脚本并设置为选中
    const script = state.allScripts.find(s => s.id === record.script_id)
    if (script) {
      set({ selectedScript: script })
    }
    // 用历史记录中保存的参数重新执行
    await get().runScript(record.script_id, record.params)
  },

  loadHistory: async () => {
    try {
      const history = await invoke<ExecutionRecord[]>('dataforge_get_history')
      set({ executionHistory: history })
    } catch (e) {
      handleError(e, { context: '加载执行历史', silent: true })
    }
  },

  getFilteredScripts: () => {
    const { allScripts, selectedCategory, searchQuery } = get()
    let filtered = allScripts

    if (selectedCategory) {
      filtered = filtered.filter(s => s.category === selectedCategory)
    }

    if (searchQuery) {
      filtered = filtered
        .map((s) => ({
          script: s,
          score: multiFieldPinyinScore([s.name, s.description, s.category, ...s.tags], searchQuery),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ script }) => script)
    }

    return filtered
  },
}))
