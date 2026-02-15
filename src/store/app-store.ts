import { create } from 'zustand'

export type AppMode = 'search' | 'ai'

const RECENT_TOOLS_KEY = 'mtools_recent_tools'
const MAX_RECENT_TOOLS = 20

function loadRecentTools(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_TOOLS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveRecentTools(tools: string[]) {
  try {
    localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify(tools))
  } catch { /* ignore */ }
}

export type AIInitialMode = 'ask' | 'agent'

export interface EmbedRequest {
  pluginId: string
  featureCode: string
  title?: string
}

export interface AppState {
  mode: AppMode
  searchValue: string
  selectedIndex: number
  windowExpanded: boolean
  /** 最近使用的工具 viewId 列表（最新在前） */
  recentTools: string[]
  /** AI 助手打开时的初始模式（一次性消费：读取后自动重置为 ask） */
  aiInitialMode: AIInitialMode
  /** 待处理的嵌入打开请求（一次性消费） */
  pendingEmbed: EmbedRequest | null

  setMode: (mode: AppMode) => void
  setSearchValue: (value: string) => void
  setSelectedIndex: (index: number) => void
  setWindowExpanded: (expanded: boolean) => void
  /** 记录一次工具使用 */
  addRecentTool: (viewId: string) => void
  /** 设置 AI 打开时的初始模式 */
  setAiInitialMode: (mode: AIInitialMode) => void
  /** 消费 aiInitialMode（读取并重置为 ask） */
  consumeAiInitialMode: () => AIInitialMode
  /** 请求在主窗口中嵌入打开外部插件 */
  requestEmbed: (req: EmbedRequest) => void
  /** 消费嵌入请求 */
  consumeEmbed: () => EmbedRequest | null
  reset: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: 'search',
  searchValue: '',
  selectedIndex: 0,
  windowExpanded: false,
  recentTools: loadRecentTools(),
  aiInitialMode: 'ask' as AIInitialMode,
  pendingEmbed: null as EmbedRequest | null,

  setMode: (mode) => set({ mode }),
  setSearchValue: (value) => {
    // 根据前缀自动切换模式
    let mode: AppMode = 'search'
    if (value.startsWith('ai ') || value.startsWith('AI ')) {
      mode = 'ai'
    }
    set({ searchValue: value, mode, selectedIndex: 0 })
  },
  setSelectedIndex: (index) => set({ selectedIndex: index }),
  setWindowExpanded: (expanded) => set({ windowExpanded: expanded }),
  addRecentTool: (viewId) => set((state) => {
    const filtered = state.recentTools.filter((id) => id !== viewId)
    const updated = [viewId, ...filtered].slice(0, MAX_RECENT_TOOLS)
    saveRecentTools(updated)
    return { recentTools: updated }
  }),
  setAiInitialMode: (mode) => set({ aiInitialMode: mode }),
  consumeAiInitialMode: () => {
    const current = get().aiInitialMode
    if (current !== 'ask') set({ aiInitialMode: 'ask' })
    return current
  },
  requestEmbed: (req) => set({ pendingEmbed: req }),
  consumeEmbed: () => {
    const current = get().pendingEmbed
    if (current) set({ pendingEmbed: null })
    return current
  },
  reset: () => set({ mode: 'search', searchValue: '', selectedIndex: 0, windowExpanded: false }),
}))
