import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type {
  PluginInstance,
  PluginMatchContext,
  PluginMatchResult,
} from '@/core/plugin-system/types'
import { handleError } from '@/core/errors'
import { matchPlugins } from '@/core/plugin-system/command-matcher'
import { registry } from '@/core/plugin-system/registry'

interface PluginState {
  plugins: PluginInstance[]
  isLoading: boolean
  devDirs: string[]

  loadPlugins: () => Promise<void>
  matchInput: (input: string, context?: PluginMatchContext) => PluginMatchResult[]
  openPlugin: (pluginId: string, featureCode: string) => Promise<void>
  closePlugin: (pluginId: string, featureCode: string) => Promise<void>
  addDevDir: (dirPath: string) => Promise<void>
  removeDevDir: (dirPath: string) => Promise<void>
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  isLoading: false,
  devDirs: [],

  loadPlugins: async () => {
    set({ isLoading: true })
    try {
      const rawPlugins = await invoke<PluginInstance[]>('plugin_list')
      set({ plugins: rawPlugins, isLoading: false })

      // 收集外部插件声明的 AI actions 并注册到 registry
      const externalActions = rawPlugins
        .filter((p) => p.enabled && p.manifest.mtools?.actions?.length)
        .flatMap((p) =>
          (p.manifest.mtools!.actions!).map((action) => ({
            pluginId: p.id,
            pluginName: p.manifest.pluginName,
            action,
          })),
        )
      registry.registerExternalActions(externalActions)
    } catch (e) {
      handleError(e, { context: '加载插件列表' })
      set({ isLoading: false })
    }
  },

  matchInput: (input: string, context?: PluginMatchContext) => {
    const { plugins } = get()
    return matchPlugins(plugins, input, context)
  },

  openPlugin: async (pluginId, featureCode) => {
    try {
      await invoke('plugin_open', { pluginId, featureCode })
    } catch (e) {
      handleError(e, { context: '打开插件' })
    }
  },

  closePlugin: async (pluginId, featureCode) => {
    try {
      await invoke('plugin_close', { pluginId, featureCode })
    } catch (e) {
      handleError(e, { context: '关闭插件' })
    }
  },

  addDevDir: async (dirPath: string) => {
    try {
      const rawPlugins = await invoke<PluginInstance[]>('plugin_add_dev_dir', { dirPath })
      set((state) => ({
        plugins: rawPlugins,
        devDirs: [...new Set([...state.devDirs, dirPath])],
      }))
    } catch (e) {
      handleError(e, { context: '添加开发者目录' })
    }
  },

  removeDevDir: async (dirPath: string) => {
    try {
      const rawPlugins = await invoke<PluginInstance[]>('plugin_remove_dev_dir', { dirPath })
      set((state) => ({
        plugins: rawPlugins,
        devDirs: state.devDirs.filter((d) => d !== dirPath),
      }))
    } catch (e) {
      handleError(e, { context: '移除开发者目录' })
    }
  },

  setPluginEnabled: async (pluginId: string, enabled: boolean) => {
    try {
      const rawPlugins = await invoke<PluginInstance[]>('plugin_set_enabled', { pluginId, enabled })
      set({ plugins: rawPlugins })
    } catch (e) {
      handleError(e, { context: '设置插件状态' })
    }
  },
}))
