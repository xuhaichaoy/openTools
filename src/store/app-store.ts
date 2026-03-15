import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { tauriPersistStorage } from '@/core/storage'
import type { AICenterModelScope } from '@/core/ai/ai-center-model-scope'
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

export type AIInitialMode = 'ask' | 'agent' | 'cluster' | 'dialog'
export type AICenterMode = 'ask' | 'agent' | 'cluster' | 'dialog'

export type AICenterModelScopeMap = Partial<Record<AICenterMode, AICenterModelScope>>

export interface AICenterSourceRef {
  /** 来源模式标识，用于跨模式会话追溯 */
  sourceMode: AICenterMode
  /** 来源会话/对话 ID，用于跨模式加载历史 */
  sourceSessionId?: string
  /** 对来源的用户可读说明，如“Ask 对话”“Cluster 报告” */
  sourceLabel?: string
  /** 附加摘要，用于在目标模式提示用户当前带入了什么 */
  summary?: string
}

export type AICenterHandoffIntent = 'general' | 'research' | 'delivery' | 'coding'

export interface AICenterHandoffFileRef {
  path: string
  label?: string
  reason?: string
  lineStart?: number
  lineEnd?: number
}

export interface AICenterHandoffSection {
  title: string
  items: string[]
}

export interface AICenterHandoff extends Partial<AICenterSourceRef> {
  query: string
  /** 传递的文件/文件夹附件绝对路径 */
  attachmentPaths?: string[]
  /** 任务包标题，用于跨模式展示 */
  title?: string
  /** 当前接力最想完成的目标 */
  goal?: string
  /** 通用执行意图，不绑定具体模式 */
  intent?: AICenterHandoffIntent
  /** 需要带过去的关键结论 / 约束 / 背景 */
  keyPoints?: string[]
  /** 建议目标模式接力后的下一步 */
  nextSteps?: string[]
  /** 更结构化的上下文片段 */
  contextSections?: AICenterHandoffSection[]
  /** 明确带入的文件或路径线索 */
  files?: AICenterHandoffFileRef[]
}

/** @deprecated 保留旧类型名，统一使用 AICenterHandoff */
export type AgentHandoff = AICenterHandoff

export interface PendingAICenterHandoff {
  mode: AICenterMode
  payload: AICenterHandoff
  createdAt: number
}

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
  /** AI 助手当前选中的 tab 模式（跨组件生命周期持久） */
  aiCenterMode: AICenterMode
  /** 待处理的嵌入打开请求（一次性消费） */
  pendingEmbed: EmbedRequest | null
  /** 待处理的视图导航请求（一次性消费） */
  pendingNavigate: string | null
  /** 跨模式接力的待注入输入（一次性消费，不持久化） */
  pendingAICenterHandoff: PendingAICenterHandoff | null
  /** 各模式记住自己的默认模型选择 */
  aiCenterModelScopes: AICenterModelScopeMap

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
  /** 设置 AI 助手当前 tab 模式 */
  setAiCenterMode: (mode: AICenterMode) => void
  /** 请求在主窗口中嵌入打开外部插件 */
  requestEmbed: (req: EmbedRequest) => void
  /** 消费嵌入请求 */
  consumeEmbed: () => EmbedRequest | null
  /** 请求导航到指定视图（子页面 → 主应用） */
  requestNavigate: (viewId: string) => void
  /** 消费导航请求 */
  consumeNavigate: () => string | null
  /** 设置跨模式 handoff（如 Ask/Cluster/Dialog「继续到其他模式」） */
  setPendingAICenterHandoff: (handoff: PendingAICenterHandoff | null) => void
  /** 消费并清空 pendingAICenterHandoff，返回当前值 */
  consumePendingAICenterHandoff: () => PendingAICenterHandoff | null
  /** 记住某个模式的模型选择 */
  setAICenterModelScope: (mode: AICenterMode, scope: AICenterModelScope) => void
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
      aiCenterMode: 'ask' as AICenterMode,
      pendingEmbed: null as EmbedRequest | null,
      pendingNavigate: null as string | null,
      pendingAICenterHandoff: null as PendingAICenterHandoff | null,
      aiCenterModelScopes: {} as AICenterModelScopeMap,
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
      setAiCenterMode: (mode) => set({ aiCenterMode: mode }),
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
      setPendingAICenterHandoff: (handoff) => set({ pendingAICenterHandoff: handoff }),
      consumePendingAICenterHandoff: () => {
        const current = get().pendingAICenterHandoff
        if (current != null) set({ pendingAICenterHandoff: null })
        return current ?? null
      },
      setAICenterModelScope: (mode, scope) =>
        set((state) => ({
          aiCenterModelScopes: {
            ...state.aiCenterModelScopes,
            [mode]: scope,
          },
        })),
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
        set((state) => ({
          viewStack: pushViewEntry(state.viewStack, { viewId, params }),
          searchValue: '',
          mode: 'search',
          selectedIndex: 0,
        })),
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
        aiCenterMode: state.aiCenterMode,
        aiCenterModelScopes: state.aiCenterModelScopes,
      }),
    },
  ),
)
