import { create } from 'zustand'

export type AppMode = 'search' | 'ai' | 'plugin'

export interface AppState {
  mode: AppMode
  searchValue: string
  selectedIndex: number
  windowExpanded: boolean

  setMode: (mode: AppMode) => void
  setSearchValue: (value: string) => void
  setSelectedIndex: (index: number) => void
  setWindowExpanded: (expanded: boolean) => void
  reset: () => void
}

export const useAppStore = create<AppState>((set) => ({
  mode: 'search',
  searchValue: '',
  selectedIndex: 0,
  windowExpanded: false,

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
  reset: () => set({ mode: 'search', searchValue: '', selectedIndex: 0, windowExpanded: false }),
}))
