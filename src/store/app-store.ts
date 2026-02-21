import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { tauriPersistStorage } from '@/core/storage'
import {
  MAIN_VIEW_ID,
  createRootViewStack,
  getTopViewEntry,
  popViewEntry,
  pushViewEntry,
  replaceTopViewEntry,
  type ViewEntry,
} from '@/core/navigation/view-stack'

export type AppMode = 'search' | 'ai'

const MAX_RECENT_TOOLS = 20

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
  /** 待处理的视图导航请求（一次性消费） */
  pendingNavigate: string | null

  /** 视图栈（支持多层返回） */
  viewStack: ViewEntry[]

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
  /** 请求导航到指定视图（子页面 → 主应用） */
  requestNavigate: (viewId: string) => void
  /** 消费导航请求 */
  consumeNavigate: () => string | null
  /** 仅重置搜索态，不修改视图栈 */
  resetSearchState: () => void
  reset: () => void

  // ── 视图栈导航 ──
  /** 当前视图（栈顶） */
  currentView: () => string
  /** 当前视图的完整条目（含 params） */
  currentViewEntry: () => ViewEntry
  /** 压入新视图（可附带参数） */
  pushView: (viewId: string, params?: Record<string, unknown>) => void
  /** 返回上一级 */
  popView: () => void
  /** 替换当前视图（不增加栈深度） */
  replaceView: (viewId: string, params?: Record<string, unknown>) => void
  /** 回到主界面（清空栈） */
  resetToMain: () => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      mode: 'search',
      searchValue: '',
      selectedIndex: 0,
      windowExpanded: false,
      recentTools: [] as string[],
      aiInitialMode: 'ask' as AIInitialMode,
      pendingEmbed: null as EmbedRequest | null,
      pendingNavigate: null as string | null,
      viewStack: createRootViewStack(),

      setMode: (mode) => set({ mode }),
      setSearchValue: (value) => {
        let mode: AppMode = 'search'
        if (value.startsWith('ai ') || value.startsWith('AI ')) {
          mode = 'ai'
        }
        set({ searchValue: value, mode, selectedIndex: 0 })
      },
      setSelectedIndex: (index) => set({ selectedIndex: index }),
      setWindowExpanded: (expanded) => set({ windowExpanded: expanded }),
      addRecentTool: (viewId) =>
        set((state) => {
          const filtered = state.recentTools.filter((id) => id !== viewId)
          const updated = [viewId, ...filtered].slice(0, MAX_RECENT_TOOLS)
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
      requestNavigate: (viewId) => set({ pendingNavigate: viewId }),
      consumeNavigate: () => {
        const current = get().pendingNavigate
        if (current) set({ pendingNavigate: null })
        return current
      },
      resetSearchState: () =>
        set({ mode: 'search', searchValue: '', selectedIndex: 0, windowExpanded: false }),
      reset: () =>
        set({
          mode: 'search',
          searchValue: '',
          selectedIndex: 0,
          windowExpanded: false,
          viewStack: createRootViewStack(),
        }),

      // ── 视图栈导航 ──
      currentView: () => getTopViewEntry(get().viewStack).viewId ?? MAIN_VIEW_ID,
      currentViewEntry: () => getTopViewEntry(get().viewStack),
      pushView: (viewId, params) =>
        set((state) => ({ viewStack: pushViewEntry(state.viewStack, { viewId, params }) })),
      popView: () => set((state) => ({ viewStack: popViewEntry(state.viewStack) })),
      replaceView: (viewId, params) =>
        set((state) => ({ viewStack: replaceTopViewEntry(state.viewStack, { viewId, params }) })),
      resetToMain: () => set({ viewStack: createRootViewStack() }),
    }),
    {
      name: "mtools-app",
      storage: tauriPersistStorage("app-settings.json", "应用设置"),
      partialize: (state) => ({
        recentTools: state.recentTools,
      }),
    },
  ),
)
