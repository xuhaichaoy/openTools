import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type { PluginInstance, PluginMatchResult } from '@/core/plugin-system/types'
import { matchPlugins } from '@/core/plugin-system/command-matcher'

interface PluginState {
  plugins: PluginInstance[]
  isLoading: boolean

  loadPlugins: () => Promise<void>
  matchInput: (input: string) => PluginMatchResult[]
  openPlugin: (pluginId: string, featureCode: string) => Promise<void>
  closePlugin: (pluginId: string, featureCode: string) => Promise<void>
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  isLoading: false,

  loadPlugins: async () => {
    set({ isLoading: true })
    try {
      const rawPlugins = await invoke<PluginInstance[]>('plugin_list')
      set({ plugins: rawPlugins, isLoading: false })
    } catch (e) {
      console.error('加载插件列表失败:', e)
      set({ isLoading: false })
    }
  },

  matchInput: (input: string) => {
    const { plugins } = get()
    return matchPlugins(plugins, input)
  },

  openPlugin: async (pluginId, featureCode) => {
    try {
      await invoke('plugin_open', { pluginId, featureCode })
    } catch (e) {
      console.error('打开插件失败:', e)
    }
  },

  closePlugin: async (pluginId, featureCode) => {
    try {
      await invoke('plugin_close', { pluginId, featureCode })
    } catch (e) {
      console.error('关闭插件失败:', e)
    }
  },
}))
