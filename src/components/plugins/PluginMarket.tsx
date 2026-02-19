import { useState, useEffect, useMemo } from 'react'
import {
  ArrowLeft,
  Puzzle,
  Play,
  FolderOpen,
  Code,
  RefreshCw,
  ExternalLink,
  Loader2,
  ToggleLeft,
  ToggleRight,
  X,
  Plus,
  Package,
  PlayCircle,
  StopCircle,
  Bug,
  Trash2,
  Download,
  ShieldCheck,
  FlaskConical,
  Search,
  Star,
} from 'lucide-react'
import { handleError } from '@/core/errors'
import { usePluginStore } from '@/store/plugin-store'
import { useAppStore } from '@/store/app-store'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { writeTextFile, readFile } from '@tauri-apps/plugin-fs'
import { useDragWindow } from '@/hooks/useDragWindow'
import { api, ApiError } from '@/core/api/client'
import { registry } from '@/core/plugin-system/registry'
import { builtinPlugins as builtinPluginCatalog, isBuiltinPluginInstallRequired } from '@/plugins/builtin'
import { getServerUrl } from '@/store/server-store'
import type {
  PluginCompatMatrixItem,
  PluginDevTraceItem,
  PluginDevWatchStatus,
  PluginMarketApp,
  PluginMarketPackage,
  PluginPreflightReport,
} from '@/core/plugin-system/types'

interface PluginDevFileChangedPayload {
  pluginIds?: string[]
  paths?: string[]
}

interface PluginDevReloadErrorPayload {
  errors?: Array<{ path?: string; error?: string }>
}

export function PluginMarket({ onBack }: { onBack: () => void }) {
  const { plugins, loadPlugins, openPlugin, addDevDir, removeDevDir, setPluginEnabled, devDirs } = usePluginStore()
  const [activeTab, setActiveTab] = useState<'builtin' | 'external' | 'dev'>('builtin')
  const [loading, setLoading] = useState(false)
  const [devLogs, setDevLogs] = useState<string[]>([])
  const [developerMode, setDeveloperMode] = useState(false)
  const [watchBusy, setWatchBusy] = useState(false)
  const [watchStatus, setWatchStatus] = useState<PluginDevWatchStatus | null>(null)
  const [traceItems, setTraceItems] = useState<PluginDevTraceItem[]>([])
  const [tracePluginFilter, setTracePluginFilter] = useState<string>('')
  const [traceMethodFilter, setTraceMethodFilter] = useState<string>('')
  const [simPluginId, setSimPluginId] = useState<string>('')
  const [simFeatureCode, setSimFeatureCode] = useState<string>('')
  const [simEventType, setSimEventType] = useState<string>('onPluginEnter')
  const [simPayload, setSimPayload] = useState<string>('{}')
  const [storagePluginId, setStoragePluginId] = useState<string>('')
  const [compatMatrix, setCompatMatrix] = useState<PluginCompatMatrixItem[]>([])
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [preflightReport, setPreflightReport] = useState<PluginPreflightReport | null>(null)
  const [preflightFilePath, setPreflightFilePath] = useState<string>('')
  const [submitLoading, setSubmitLoading] = useState(false)
  const [submitMessage, setSubmitMessage] = useState<string>('')
  const [marketQuery, setMarketQuery] = useState('')
  const [marketBatchSeed, setMarketBatchSeed] = useState(0)
  const [marketApps, setMarketApps] = useState<PluginMarketApp[]>([])
  const [marketTotal, setMarketTotal] = useState(0)
  const [marketLoading, setMarketLoading] = useState(false)
  const [debouncedMarketQuery, setDebouncedMarketQuery] = useState('')
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [uninstallingPluginId, setUninstallingPluginId] = useState<string | null>(null)
  const [selectedExternalPluginId, setSelectedExternalPluginId] = useState<string | null>(null)
  const [selectedMarketAppSlug, setSelectedMarketAppSlug] = useState<string | null>(null)
  const { onMouseDown } = useDragWindow()

  // 获取内置插件目录（过滤掉「插件」和「设置」这类系统页面）
  const builtinPlugins = useMemo(() => {
    const systemViewIds = new Set(['plugins', 'settings'])
    return builtinPluginCatalog
      .filter((p) => !systemViewIds.has(p.viewId))
      .filter((p) => !isBuiltinPluginInstallRequired(p.id))
      .map((plugin) => {
        return {
          ...plugin,
          installRequired: false,
          installed: true,
        }
      })
  }, [])

  const traceMethods = useMemo(() => {
    const methods = new Set(traceItems.map((t) => t.method))
    return Array.from(methods).sort()
  }, [traceItems])

  const filteredTraces = useMemo(() => {
    return traceItems.filter((item) => {
      if (tracePluginFilter && item.pluginId !== tracePluginFilter) return false
      if (traceMethodFilter && item.method !== traceMethodFilter) return false
      return true
    })
  }, [traceItems, tracePluginFilter, traceMethodFilter])

  const permissionSummary = useMemo(() => {
    const allow = filteredTraces.filter((t) => t.permissionDecision === 'allow').length
    const denyItems = filteredTraces.filter((t) => t.permissionDecision === 'deny')
    return {
      allow,
      deny: denyItems.length,
      lastDenyReason: denyItems[0]?.permissionReason || '',
    }
  }, [filteredTraces])

  const externalPlugins = useMemo(() => {
    return plugins.filter((p) => !p.isBuiltin)
  }, [plugins])

  const selectedExternalPlugin = useMemo(() => {
    if (!selectedExternalPluginId) return null
    return externalPlugins.find((plugin) => plugin.id === selectedExternalPluginId) || null
  }, [externalPlugins, selectedExternalPluginId])

  const selectedExternalPrimaryFeature = selectedExternalPlugin?.manifest.features[0]
  const selectedExternalSlug = selectedExternalPlugin?.slug?.toLowerCase()
  const selectedExternalIsMigratedBuiltin = Boolean(
    selectedExternalPlugin &&
    selectedExternalPlugin.source === 'official' &&
    selectedExternalSlug &&
    isBuiltinPluginInstallRequired(selectedExternalSlug),
  )

  const marketCards = useMemo(() => {
    if (marketApps.length === 0) return []
    const start = marketBatchSeed % marketApps.length
    const rotated = [...marketApps.slice(start), ...marketApps.slice(0, start)]
    return rotated.slice(0, 6)
  }, [marketApps, marketBatchSeed])

  const selectedMarketApp = useMemo(() => {
    if (!selectedMarketAppSlug) return null
    const key = selectedMarketAppSlug.toLowerCase()
    return marketApps.find((item) => item.slug.toLowerCase() === key) || null
  }, [marketApps, selectedMarketAppSlug])

  const installedPluginBySlug = useMemo(() => {
    const map = new Map<string, (typeof externalPlugins)[number]>()
    externalPlugins.forEach((plugin) => {
      if (plugin.slug) {
        map.set(plugin.slug.toLowerCase(), plugin)
      }
    })
    return map
  }, [externalPlugins])

  const resolveDownloadUrl = (downloadUrl: string): string => {
    if (downloadUrl.startsWith('http://') || downloadUrl.startsWith('https://')) {
      return downloadUrl
    }
    const base = getServerUrl().replace(/\/$/, '')
    if (downloadUrl.startsWith('/')) {
      return `${base}${downloadUrl}`
    }
    return `${base}/${downloadUrl}`
  }

  const formatPackageSize = (bytes?: number | null): string => {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
      return '大小待发布'
    }
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}KB`
    return `${Math.round(bytes / 1024 / 102.4) / 10}MB`
  }

  const reportInstall = async (slug: string) => {
    try {
      await api.post(`/plugins/market/apps/${encodeURIComponent(slug)}/install-report`)
      setMarketApps((prev) => prev.map((item) => (
        item.slug.toLowerCase() === slug.toLowerCase()
          ? { ...item, installs: item.installs + 1 }
          : item
      )))
    } catch (e) {
      handleError(e, { context: '上报插件安装量', silent: true })
    }
  }

  useEffect(() => {
    handleRefresh()
    // 加载开发者模式设置
    invoke<string>("load_general_settings")
      .then((json) => {
        try {
          const s = JSON.parse(json)
          if (s.developerMode) setDeveloperMode(true)
        } catch { /* ignore */ }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!developerMode || activeTab !== 'dev') return
    loadWatchStatus()
    loadTraceBuffer()
    loadCompatMatrix()

    const timer = window.setInterval(() => {
      loadTraceBuffer()
    }, 1200)

    const unlistenTasks = [
      listen<PluginDevFileChangedPayload>('plugin-dev:file-changed', async (event) => {
        const pluginIds = Array.isArray(event.payload?.pluginIds) ? event.payload.pluginIds : []
        addDevLog(`✓ 文件变化: ${pluginIds.join(', ') || '未知插件'} (${event.payload?.paths?.length || 0} files)`)
        await loadPlugins()
        loadTraceBuffer()
      }),
      listen<PluginDevReloadErrorPayload>('plugin-dev:reload-error', (event) => {
        const errors = Array.isArray(event.payload?.errors) ? event.payload.errors : []
        addDevLog(`✗ 重载失败: ${errors.map((e) => e.path || 'unknown').slice(0, 2).join(', ') || '清单解析错误'}`)
        loadWatchStatus()
      }),
      listen<PluginDevWatchStatus>('plugin-dev:watch-status', (event) => {
        setWatchStatus(event.payload)
      }),
    ]

    return () => {
      window.clearInterval(timer)
      unlistenTasks.forEach((task) => task.then((fn) => fn()).catch(() => {}))
    }
  }, [developerMode, activeTab])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedMarketQuery(marketQuery.trim())
    }, 250)
    return () => window.clearTimeout(timer)
  }, [marketQuery])

  useEffect(() => {
    if (activeTab !== 'external') return
    loadMarketApps(debouncedMarketQuery)
  }, [activeTab, debouncedMarketQuery])

  useEffect(() => {
    if (!selectedExternalPluginId) return
    if (externalPlugins.some((plugin) => plugin.id === selectedExternalPluginId)) return
    setSelectedExternalPluginId(null)
  }, [externalPlugins, selectedExternalPluginId])

  useEffect(() => {
    if (!selectedMarketAppSlug) return
    const key = selectedMarketAppSlug.toLowerCase()
    if (marketApps.some((item) => item.slug.toLowerCase() === key)) return
    setSelectedMarketAppSlug(null)
  }, [marketApps, selectedMarketAppSlug])

  useEffect(() => {
    if (!selectedMarketAppSlug) return
    const installed = installedPluginBySlug.get(selectedMarketAppSlug.toLowerCase())
    if (!installed) return
    setSelectedExternalPluginId(installed.id)
    setSelectedMarketAppSlug(null)
  }, [installedPluginBySlug, selectedMarketAppSlug])

  const handleRefresh = async () => {
    setLoading(true)
    await loadPlugins()
    setLoading(false)
    if (activeTab === 'external') {
      await loadMarketApps(debouncedMarketQuery)
    }
  }

  const handleRotateMarket = () => {
    setMarketBatchSeed((prev) => prev + 3)
  }

  const loadWatchStatus = async () => {
    try {
      const status = await invoke<PluginDevWatchStatus>('plugin_dev_watch_status')
      setWatchStatus(status)
    } catch (e) {
      handleError(e, { context: '获取监听状态', silent: true })
    }
  }

  const loadTraceBuffer = async () => {
    try {
      const traces = await invoke<PluginDevTraceItem[]>('plugin_dev_get_trace_buffer', {
        pluginId: tracePluginFilter || null,
      })
      setTraceItems(traces)
    } catch (e) {
      handleError(e, { context: '加载 API 追踪', silent: true })
    }
  }

  const loadCompatMatrix = async () => {
    try {
      const data = await api.get<{ matrix: PluginCompatMatrixItem[] }>('/plugins/compat-matrix')
      setCompatMatrix(Array.isArray(data?.matrix) ? data.matrix : [])
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_FOUND') return
      handleError(e, { context: '加载兼容矩阵', silent: true })
    }
  }

  const loadMarketApps = async (query: string) => {
    try {
      setMarketLoading(true)
      const data = await api.get<{ items: PluginMarketApp[]; total: number }>('/plugins/market/apps', {
        q: query || undefined,
        limit: 60,
        offset: 0,
      })
      setMarketApps(Array.isArray(data.items) ? data.items : [])
      setMarketTotal(typeof data.total === 'number' ? data.total : 0)
      setMarketBatchSeed(0)
    } catch (e) {
      handleError(e, { context: '加载插件市场' })
      setMarketApps([])
      setMarketTotal(0)
    } finally {
      setMarketLoading(false)
    }
  }

  const handleInstallFromMarket = async (appItem: PluginMarketApp) => {
    try {
      setInstallingSlug(appItem.slug)
      try {
        const pkg = await api.get<PluginMarketPackage>(`/plugins/market/apps/${encodeURIComponent(appItem.slug)}/package`)
        const downloadUrl = resolveDownloadUrl(pkg.downloadUrl)

        await invoke('plugin_market_install', {
          slug: pkg.slug,
          version: pkg.version,
          downloadUrl,
          sha256: pkg.packageSha256,
          sizeBytes: pkg.packageSizeBytes,
        })
        await loadPlugins()
        await reportInstall(appItem.slug)
        addDevLog(`✓ 安装成功: ${appItem.name} ${pkg.version}`)
      } catch (e) {
        const shouldFallbackToLocalOfficial =
          developerMode === true &&
          appItem.isOfficial === true &&
          e instanceof ApiError &&
          e.code === 'PLUGIN_PACKAGE_NOT_FOUND'

        if (!shouldFallbackToLocalOfficial) {
          throw e
        }

        await invoke('plugin_market_install_official_local', {
          slug: appItem.slug,
        })
        await loadPlugins()
        addDevLog(`✓ 安装成功(本地官方包): ${appItem.name}`)
      }
    } catch (e) {
      handleError(e, { context: `安装插件 ${appItem.name}` })
      addDevLog(`✗ 安装失败: ${appItem.name} ${String(e)}`)
    } finally {
      setInstallingSlug(null)
    }
  }

  const resolveUninstallChoice = (pluginName: string, dataProfile?: string): 'cancel' | 'uninstall' | 'uninstall_and_clear' => {
    if (!window.confirm(`确认卸载插件「${pluginName}」吗？`)) {
      return 'cancel'
    }
    if (!dataProfile || dataProfile === 'none') {
      return 'uninstall'
    }
    const raw = window.prompt(
      `插件「${pluginName}」支持清理本地数据。输入 1=仅卸载，2=卸载并清数据，3=取消`,
      '1',
    )
    if (!raw || raw.trim() === '3') {
      return 'cancel'
    }
    return raw.trim() === '2' ? 'uninstall_and_clear' : 'uninstall'
  }

  const handleUninstallPlugin = async (pluginId: string, pluginName: string, dataProfile?: string) => {
    const choice = resolveUninstallChoice(pluginName, dataProfile)
    if (choice === 'cancel') return

    try {
      setUninstallingPluginId(pluginId)
      if (choice === 'uninstall_and_clear' && dataProfile && dataProfile !== 'none') {
        await invoke('plugin_market_clear_data', { dataProfile })
      }
      await invoke('plugin_market_uninstall', { pluginId })
      await loadPlugins()
      addDevLog(`✓ 卸载成功: ${pluginName}`)
    } catch (e) {
      handleError(e, { context: `卸载插件 ${pluginName}` })
      addDevLog(`✗ 卸载失败: ${pluginName} ${String(e)}`)
    } finally {
      setUninstallingPluginId(null)
    }
  }

  const handleWatchStart = async () => {
    const watchDirs = devDirs.length > 0
      ? devDirs
      : plugins.filter((p) => !p.isBuiltin).map((p) => p.dirPath)

    if (watchDirs.length === 0) {
      addDevLog('✗ 请先添加开发目录')
      return
    }
    setWatchBusy(true)
    try {
      const status = await invoke<PluginDevWatchStatus>('plugin_dev_watch_start', {
        dirPaths: watchDirs,
        pluginId: tracePluginFilter || null,
      })
      setWatchStatus(status)
      addDevLog(`✓ 已开始监听 ${status.watchedDirs.length} 个目录`)
    } catch (e) {
      handleError(e, { context: '启动监听' })
      addDevLog(`✗ 启动监听失败: ${String(e)}`)
    } finally {
      setWatchBusy(false)
    }
  }

  const handleWatchStop = async () => {
    setWatchBusy(true)
    try {
      const status = await invoke<PluginDevWatchStatus>('plugin_dev_watch_stop')
      setWatchStatus(status)
      addDevLog('✓ 已停止监听')
    } catch (e) {
      handleError(e, { context: '停止监听' })
      addDevLog(`✗ 停止监听失败: ${String(e)}`)
    } finally {
      setWatchBusy(false)
    }
  }

  const handleClearTrace = async () => {
    try {
      await invoke('plugin_dev_clear_trace_buffer', { pluginId: tracePluginFilter || null })
      await loadTraceBuffer()
      addDevLog('✓ 已清空追踪缓存')
    } catch (e) {
      handleError(e, { context: '清空追踪缓存' })
    }
  }

  const handleExportTrace = async () => {
    try {
      const selected = await save({
        title: '导出 API 追踪',
        defaultPath: `plugin-dev-trace-${Date.now()}.json`,
      })
      if (!selected) return
      await writeTextFile(selected, JSON.stringify(filteredTraces, null, 2))
      addDevLog(`✓ 追踪已导出: ${selected}`)
    } catch (e) {
      handleError(e, { context: '导出追踪' })
    }
  }

  const handleSimulateEvent = async () => {
    try {
      if (!simPluginId || !simFeatureCode) {
        addDevLog('✗ 请先选择插件与功能')
        return
      }
      await invoke('plugin_dev_simulate_event', {
        pluginId: simPluginId,
        featureCode: simFeatureCode,
        eventType: simEventType,
        payloadJson: simPayload || '{}',
      })
      addDevLog(`✓ 已注入事件 ${simEventType} -> ${simPluginId}/${simFeatureCode}`)
    } catch (e) {
      handleError(e, { context: '注入事件' })
      addDevLog(`✗ 事件注入失败: ${String(e)}`)
    }
  }

  const handleOpenDevtools = async () => {
    try {
      await invoke('plugin_dev_open_devtools', { windowLabelOrEmbedTarget: 'main' })
    } catch (e) {
      handleError(e, { context: '打开 DevTools' })
    }
  }

  const handleStorageDump = async () => {
    try {
      if (!storagePluginId) {
        addDevLog('✗ 请先选择存储目标插件')
        return
      }
      const data = await invoke<Record<string, unknown>>('plugin_dev_storage_dump', {
        pluginId: storagePluginId,
      })
      const selected = await save({
        title: '导出插件本地存储',
        defaultPath: `${storagePluginId}-storage.json`,
      })
      if (!selected) return
      await writeTextFile(selected, JSON.stringify(data, null, 2))
      addDevLog(`✓ 已导出本地存储: ${selected}`)
    } catch (e) {
      handleError(e, { context: '导出插件存储' })
    }
  }

  const handleStorageClear = async () => {
    try {
      if (!storagePluginId) {
        addDevLog('✗ 请先选择存储目标插件')
        return
      }
      await invoke('plugin_dev_storage_clear', { pluginId: storagePluginId })
      addDevLog(`✓ 已清空插件存储: ${storagePluginId}`)
    } catch (e) {
      handleError(e, { context: '清空插件存储' })
    }
  }

  const handlePreflight = async () => {
    try {
      const selected = await open({
        title: '选择插件 ZIP 包',
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      })
      if (!selected || Array.isArray(selected)) return
      setPreflightLoading(true)
      const filePath = selected as string
      const bytes = await readFile(filePath)
      const fileName = filePath.split('/').pop()?.split('\\').pop() || 'plugin.zip'
      const formData = new FormData()
      formData.append('file', new Blob([bytes]), fileName)
      const report = await api.upload<PluginPreflightReport>('/plugins/submissions/preflight', formData)
      setPreflightReport(report)
      setPreflightFilePath(filePath)
      setSubmitMessage('')
      addDevLog(`✓ 预检完成: ${fileName}`)
    } catch (e) {
      handleError(e, { context: '插件预检' })
      addDevLog(`✗ 预检失败: ${String(e)}`)
    } finally {
      setPreflightLoading(false)
    }
  }

  const handleSubmitPlugin = async () => {
    if (!preflightReport?.ok || !preflightFilePath) {
      addDevLog('✗ 请先完成预检并确保通过')
      return
    }
    try {
      setSubmitLoading(true)
      const bytes = await readFile(preflightFilePath)
      const fileName = preflightFilePath.split('/').pop()?.split('\\').pop() || 'plugin.zip'
      const formData = new FormData()
      formData.append('file', new Blob([bytes]), fileName)
      const result = await api.upload<{ submissionId: string; status: string; message: string }>(
        '/plugins/submissions',
        formData,
      )
      setSubmitMessage(`${result.message}（${result.status}）`)
      addDevLog(`✓ 提交成功: ${result.submissionId}`)
    } catch (e) {
      handleError(e, { context: '正式提交插件' })
      addDevLog(`✗ 提交失败: ${String(e)}`)
    } finally {
      setSubmitLoading(false)
    }
  }

  useEffect(() => {
    if (plugins.length === 0) return
    if (!simPluginId || !plugins.some((p) => p.id === simPluginId)) {
      const first = plugins[0]
      setSimPluginId(first.id)
      setSimFeatureCode(first.manifest.features[0]?.code || '')
    } else {
      const plugin = plugins.find((p) => p.id === simPluginId)
      if (plugin && !plugin.manifest.features.some((f) => f.code === simFeatureCode)) {
        setSimFeatureCode(plugin.manifest.features[0]?.code || '')
      }
    }
    if (!storagePluginId || !plugins.some((p) => p.id === storagePluginId)) {
      setStoragePluginId(plugins[0].id)
    }
  }, [plugins, simPluginId, simFeatureCode, storagePluginId])

  const handleOpenPluginDir = async () => {
    try {
      const selected = await open({
        directory: true,
        title: '选择插件目录',
      })
      if (selected) {
        addDevLog(`正在加载目录: ${selected}`)
        await addDevDir(selected as string)
        const count = usePluginStore.getState().plugins.length
        addDevLog(`✓ 插件列表已刷新，共 ${count} 个插件`)
      }
    } catch (e) {
      handleError(e, { context: '选择插件目录' })
      addDevLog(`✗ 加载失败: ${e}`)
    }
  }

  const handleRemoveDevDir = async (dirPath: string) => {
    addDevLog(`移除开发目录: ${dirPath}`)
    await removeDevDir(dirPath)
    addDevLog(`✓ 已移除，剩余 ${usePluginStore.getState().plugins.length} 个插件`)
  }

  const addDevLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString()
    setDevLogs((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 50))
  }

  return (
    <div className="bg-[var(--color-bg)] overflow-hidden flex flex-col h-full">
      {/* 顶部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Puzzle className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-medium text-[var(--color-text)]">插件</span>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          title="刷新"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Tab */}
      <div className="flex gap-1 px-4 pt-2">
        <button
          onClick={() => setActiveTab('builtin')}
          className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'builtin'
              ? 'border-orange-400 text-orange-400 bg-[var(--color-bg-secondary)]'
              : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
          }`}
        >
          <Package className="w-3 h-3" />
          内置 ({builtinPlugins.length})
        </button>
        <button
          onClick={() => setActiveTab('external')}
          className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'external'
              ? 'border-orange-400 text-orange-400 bg-[var(--color-bg-secondary)]'
              : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
          }`}
        >
          <Puzzle className="w-3 h-3" />
          扩展 ({externalPlugins.length})
        </button>
        {developerMode && <button
          onClick={() => setActiveTab('dev')}
          className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'dev'
              ? 'border-orange-400 text-orange-400 bg-[var(--color-bg-secondary)]'
              : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
          }`}
        >
          <Code className="w-3 h-3" />
          开发者
        </button>}
      </div>
      <div className="h-px bg-[var(--color-border)]" />

      {/* 内容 */}
      <div className="flex-1 overflow-hidden min-h-0 p-1.5">
        {/* 内置插件 */}
        {activeTab === 'builtin' && (
          <div className="h-full overflow-y-auto pr-1">
            <div className="space-y-2">
              {builtinPlugins.map((bp) => (
                <div
                  key={bp.id}
                  onClick={() => {
                    if (!bp.installed) return
                    useAppStore.getState().addRecentTool(bp.viewId)
                    useAppStore.getState().requestNavigate(bp.viewId)
                  }}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                    bp.installed
                      ? 'bg-[var(--color-bg-secondary)] border-[var(--color-border)] hover:border-orange-400/50 cursor-pointer'
                      : 'bg-[var(--color-bg-secondary)] border-[var(--color-border)] opacity-70'
                  }`}
                >
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${bp.color} [&_svg]:w-4 [&_svg]:h-4`}>
                    {bp.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-[var(--color-text)] truncate">
                      {bp.name}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] truncate">
                      {bp.description}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-2 mt-0.5">
                      <span className="px-1 rounded bg-[var(--color-bg-hover)]">{bp.category}</span>
                      {bp.actions && bp.actions.length > 0 && (
                        <span className="text-indigo-400 bg-indigo-400/10 px-1 rounded">AI {bp.actions.length} 动作</span>
                      )}
                      <span className="text-green-400 bg-green-400/10 px-1 rounded">内置</span>
                    </div>
                  </div>
                  <Play className="w-3.5 h-3.5 text-[var(--color-text-secondary)] shrink-0" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 扩展插件（外部 uTools/Rubick） */}
        {activeTab === 'external' && (
          <div className="h-full min-h-0 grid grid-cols-1 md:grid-cols-[208px_1fr] gap-1.5 overflow-hidden">
            <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-2 h-full flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-xs font-semibold text-[var(--color-text)]">已安装插件应用</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">{externalPlugins.length} 个插件</div>
                </div>
                <button
                  onClick={handleOpenPluginDir}
                  className="px-2 py-1 text-[10px] rounded bg-orange-400/15 text-orange-300 hover:bg-orange-400/25"
                >
                  导入
                </button>
              </div>
              {loading && (
                <div className="text-center py-8 text-[var(--color-text-secondary)]">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                  <span className="text-xs">加载中...</span>
                </div>
              )}
              {!loading && externalPlugins.length === 0 && (
                <div className="text-center py-8 text-[var(--color-text-secondary)]">
                  <Puzzle className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-xs">暂无扩展插件</p>
                  <p className="text-[10px] mt-1">点击右上角导入，或在开发者页添加目录</p>
                </div>
              )}
              <div className="space-y-1 flex-1 min-h-0 overflow-y-auto">
                {externalPlugins.map((plugin) => {
                  const selected = selectedExternalPluginId === plugin.id
                  return (
                    <button
                      key={plugin.id}
                      onClick={() => {
                        setSelectedExternalPluginId(plugin.id)
                        setSelectedMarketAppSlug(null)
                      }}
                      className={`w-full rounded-lg border px-1 py-1.5 transition-colors text-left ${
                        selected
                          ? 'border-orange-400/60 bg-orange-400/10'
                          : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:border-orange-300/40'
                      } ${plugin.enabled ? '' : 'opacity-65'}`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-md bg-orange-400/12 text-orange-300 flex items-center justify-center shrink-0">
                          <Puzzle className="w-3.5 h-3.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-[var(--color-text)] truncate">{plugin.manifest.pluginName}</div>
                        </div>
                        <span className={`w-2 h-2 rounded-full ${plugin.enabled ? 'bg-green-400' : 'bg-gray-400'}`} />
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="h-full min-w-0 overflow-hidden">
              {selectedExternalPlugin ? (
                <div className="h-full rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col overflow-hidden">
                  <div className="px-3 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between">
                    <button
                      onClick={() => setSelectedExternalPluginId(null)}
                      className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      返回插件中心
                    </button>
                    <span className="text-[11px] text-[var(--color-text-secondary)]">插件详情</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-1.5 space-y-3">
                    <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-3">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-lg bg-orange-400/15 text-orange-300 flex items-center justify-center shrink-0">
                          <Puzzle className="w-5 h-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-[var(--color-text)] truncate">{selectedExternalPlugin.manifest.pluginName}</div>
                          <div className="text-xs text-[var(--color-text-secondary)] mt-1">{selectedExternalPlugin.manifest.description || '无描述'}</div>
                          <div className="mt-2 text-[11px] text-[var(--color-text-secondary)] flex items-center gap-2">
                            <span>v{selectedExternalPlugin.manifest.version}</span>
                            {selectedExternalPlugin.source && (
                              <span className="px-1 rounded bg-[var(--color-bg-hover)]">
                                {selectedExternalPlugin.source}
                              </span>
                            )}
                            <span>{selectedExternalPlugin.manifest.features.length} 功能</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-3">
                      <div className="text-xs font-medium text-[var(--color-text)] mb-2">可执行操作</div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          disabled={!selectedExternalPlugin.enabled || !selectedExternalPrimaryFeature}
                          onClick={() => {
                            if (!selectedExternalPlugin.enabled || !selectedExternalPrimaryFeature) return
                            if (selectedExternalSlug && registry.getByViewId(selectedExternalSlug)) {
                              useAppStore.getState().requestNavigate(selectedExternalSlug)
                              return
                            }
                            openPlugin(selectedExternalPlugin.id, selectedExternalPrimaryFeature.code)
                          }}
                          className="px-2.5 py-1.5 rounded text-[11px] bg-orange-400/12 text-orange-300 hover:bg-orange-400/22 disabled:opacity-40 inline-flex items-center gap-1"
                        >
                          <Play className="w-3.5 h-3.5" />
                          打开
                        </button>
                        <button
                          onClick={() => setPluginEnabled(selectedExternalPlugin.id, !selectedExternalPlugin.enabled)}
                          className={`px-2.5 py-1.5 rounded text-[11px] inline-flex items-center gap-1 ${
                            selectedExternalPlugin.enabled
                              ? 'bg-green-500/12 text-green-300 hover:bg-green-500/22'
                              : 'bg-gray-500/12 text-gray-300 hover:bg-gray-500/22'
                          }`}
                        >
                          {selectedExternalPlugin.enabled ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                          {selectedExternalPlugin.enabled ? '已启用' : '已禁用'}
                        </button>
                        <button
                          disabled={!selectedExternalPlugin.enabled || !selectedExternalPrimaryFeature || selectedExternalIsMigratedBuiltin}
                          onClick={() => {
                            if (!selectedExternalPrimaryFeature || selectedExternalIsMigratedBuiltin) return
                            useAppStore.getState().requestEmbed({
                              pluginId: selectedExternalPlugin.id,
                              featureCode: selectedExternalPrimaryFeature.code,
                              title: selectedExternalPrimaryFeature.explain || selectedExternalPlugin.manifest.pluginName,
                            })
                          }}
                          className="px-2.5 py-1.5 rounded text-[11px] bg-blue-400/12 text-blue-300 hover:bg-blue-400/22 disabled:opacity-40 inline-flex items-center gap-1"
                          title={selectedExternalIsMigratedBuiltin ? '官方迁移插件请使用内置视图，不支持嵌入' : '嵌入'}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          嵌入
                        </button>
                        <button
                          disabled={uninstallingPluginId === selectedExternalPlugin.id}
                          onClick={() =>
                            handleUninstallPlugin(
                              selectedExternalPlugin.id,
                              selectedExternalPlugin.manifest.pluginName,
                              selectedExternalPlugin.dataProfile,
                            )
                          }
                          className="px-2.5 py-1.5 rounded text-[11px] bg-red-500/15 text-red-300 hover:bg-red-500/25 disabled:opacity-40 inline-flex items-center gap-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {uninstallingPluginId === selectedExternalPlugin.id ? '卸载中...' : '卸载'}
                        </button>
                      </div>
                    </div>

                    <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-3">
                      <div className="text-xs font-medium text-[var(--color-text)] mb-2">插件信息</div>
                      <div className="space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
                        <div>插件 ID: {selectedExternalPlugin.id}</div>
                        <div>目录路径: {selectedExternalPlugin.dirPath}</div>
                        <div>入口功能: {selectedExternalPrimaryFeature?.code || '-'}</div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : selectedMarketApp ? (
                <div className="h-full rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col overflow-hidden">
                  <div className="px-3 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between">
                    <button
                      onClick={() => setSelectedMarketAppSlug(null)}
                      className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      返回插件中心
                    </button>
                    <span className="text-[11px] text-[var(--color-text-secondary)]">市场详情</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-1.5 space-y-3">
                    <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-3">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-lg bg-indigo-500/15 text-indigo-300 flex items-center justify-center text-base font-semibold shrink-0">
                          {selectedMarketApp.name.slice(0, 2)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-[var(--color-text)] truncate">{selectedMarketApp.name}</div>
                          <div className="text-xs text-[var(--color-text-secondary)] mt-1">{selectedMarketApp.description || '无描述'}</div>
                          <div className="mt-2 text-[11px] text-[var(--color-text-secondary)] flex items-center gap-2 flex-wrap">
                            <span>v{selectedMarketApp.version}</span>
                            <span>{selectedMarketApp.tag}</span>
                            <span>{selectedMarketApp.installs} 安装</span>
                            <span>{formatPackageSize(selectedMarketApp.packageSizeBytes)}</span>
                            <span className={`px-1 rounded ${selectedMarketApp.isOfficial ? 'bg-orange-400/15 text-orange-300' : 'bg-blue-400/15 text-blue-300'}`}>
                              {selectedMarketApp.isOfficial ? '官方' : '社区'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-3">
                      <div className="text-xs font-medium text-[var(--color-text)] mb-2">可执行操作</div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => handleInstallFromMarket(selectedMarketApp)}
                          disabled={installingSlug === selectedMarketApp.slug}
                          className="px-2.5 py-1.5 rounded text-[11px] bg-orange-400/12 text-orange-300 hover:bg-orange-400/22 disabled:opacity-40 inline-flex items-center gap-1"
                        >
                          <Download className="w-3.5 h-3.5" />
                          {installingSlug === selectedMarketApp.slug ? '安装中...' : '安装'}
                        </button>
                      </div>
                    </div>

                    <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-3">
                      <div className="text-xs font-medium text-[var(--color-text)] mb-2">插件信息</div>
                      <div className="space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
                        <div>插件标识: {selectedMarketApp.slug}</div>
                        <div>当前版本: v{selectedMarketApp.version}</div>
                        <div>包体大小: {formatPackageSize(selectedMarketApp.packageSizeBytes)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full overflow-y-auto pr-1">
                  <div className="space-y-4 min-w-0">
                    {/* <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="h-28 rounded-xl border border-blue-200/30 bg-gradient-to-r from-blue-100/80 to-indigo-200/40 dark:from-blue-400/15 dark:to-indigo-400/15 px-5 py-4 flex flex-col justify-between">
                        <div className="text-[10px] uppercase tracking-wide text-blue-600 dark:text-blue-300">AI 制作插件应用</div>
                        <div className="text-2xl font-semibold text-blue-700 dark:text-blue-200">智能体</div>
                      </div>
                      <div className="h-28 rounded-xl border border-indigo-300/30 bg-gradient-to-r from-slate-900 to-indigo-950 px-5 py-4 flex flex-col justify-between">
                        <div className="text-sm text-white/85">uTools / Rubick 兼容专区</div>
                        <div className="text-[10px] text-white/65">人工审核 · 免费下载 · 开发者可提交</div>
                      </div>
                    </div> */}

                    <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                        <div>
                          <div className="text-sm font-semibold text-[var(--color-text)]">精选</div>
                          <div className="text-[10px] text-[var(--color-text-secondary)]">市场插件 {marketTotal} 款</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="relative">
                            <Search className="absolute left-2 top-1.5 w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
                            <input
                              value={marketQuery}
                              onChange={(e) => setMarketQuery(e.target.value)}
                              placeholder="搜索插件"
                              className="h-6 w-40 pl-7 pr-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[10px] text-[var(--color-text)] outline-none focus:border-orange-300"
                            />
                          </div>
                          <button
                            onClick={handleRotateMarket}
                            className="text-[10px] px-2 py-1 rounded border border-[var(--color-border)] hover:border-orange-300 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                          >
                            换一批
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                        {marketLoading && (
                          <div className="col-span-full text-center text-[10px] text-[var(--color-text-secondary)] py-6">
                            <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                            加载市场插件中...
                          </div>
                        )}
                        {marketCards.length === 0 && (
                          <div className="col-span-full text-center text-[10px] text-[var(--color-text-secondary)] py-6">
                            {marketLoading ? '' : '市场暂无插件（等待审核发布）'}
                          </div>
                        )}
                        {marketCards.map((item) => {
                          const installedPlugin = installedPluginBySlug.get(item.slug.toLowerCase())
                          const installed = Boolean(installedPlugin)
                          const packageSize = formatPackageSize(item.packageSizeBytes)
                          return (
                            <div
                              key={item.id}
                              onClick={() => {
                                if (installedPlugin) {
                                  setSelectedExternalPluginId(installedPlugin.id)
                                  setSelectedMarketAppSlug(null)
                                  return
                                }
                                setSelectedExternalPluginId(null)
                                setSelectedMarketAppSlug(item.slug)
                              }}
                              className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer hover:border-orange-300/40"
                            >
                              <div className="w-9 h-9 rounded-lg bg-indigo-500/15 text-indigo-300 flex items-center justify-center text-xs font-semibold shrink-0">
                                {item.name.slice(0, 2)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs text-[var(--color-text)] font-medium truncate">{item.name}</div>
                                <div className="text-[10px] text-[var(--color-text-secondary)] truncate">{item.description}</div>
                                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 flex items-center gap-1.5">
                                  <span>{item.tag} · {item.installs} 安装 · {packageSize}</span>
                                  <span className={`px-1 rounded ${item.isOfficial ? 'bg-orange-400/15 text-orange-300' : 'bg-blue-400/15 text-blue-300'}`}>
                                    {item.isOfficial ? '官方' : '社区'}
                                  </span>
                                </div>
                              </div>
                              {installed && installedPlugin ? (
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleUninstallPlugin(
                                      installedPlugin.id,
                                      installedPlugin.manifest.pluginName,
                                      installedPlugin.dataProfile,
                                    )
                                  }}
                                  disabled={uninstallingPluginId === installedPlugin.id}
                                  className={`px-2 py-1 rounded text-[10px] shrink-0 ${
                                    uninstallingPluginId === installedPlugin.id
                                      ? 'bg-red-500/15 text-red-300 opacity-70'
                                      : 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
                                  }`}
                                >
                                  {uninstallingPluginId === installedPlugin.id ? '卸载中...' : '卸载'}
                                </button>
                              ) : (
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleInstallFromMarket(item)
                                  }}
                                  disabled={installingSlug === item.slug}
                                  className="p-1.5 rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"
                                  title="下载插件"
                                >
                                  {installingSlug === item.slug ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Download className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {/* <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                        <div className="flex items-center gap-2 text-[var(--color-text)] text-sm font-semibold">
                          <Star className="w-4 h-4 text-amber-400" />
                          最受欢迎
                        </div>
                        <div className="text-[10px] text-[var(--color-text-secondary)] mt-2">{marketCards[0]?.name || '暂无数据'}</div>
                      </div>
                      <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                        <div className="flex items-center gap-2 text-[var(--color-text)] text-sm font-semibold">
                          <Star className="w-4 h-4 text-emerald-400" />
                          月度新品
                        </div>
                        <div className="text-[10px] text-[var(--color-text-secondary)] mt-2">{marketCards[1]?.name || '暂无数据'}</div>
                      </div>
                      <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                        <div className="flex items-center gap-2 text-[var(--color-text)] text-sm font-semibold">
                          <Star className="w-4 h-4 text-blue-400" />
                          开发者推荐
                        </div>
                        <div className="text-[10px] text-[var(--color-text-secondary)] mt-2">{marketCards[2]?.name || '暂无数据'}</div>
                      </div>
                    </div> */}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'dev' && developerMode && (
          <div className="h-full overflow-y-auto pr-1">
            <div className="space-y-4">
            {/* 开发者模式说明 */}
            <div className="p-3 rounded-lg bg-orange-400/5 border border-orange-400/20">
              <h3 className="text-xs font-medium text-orange-400 mb-1">开发者模式</h3>
              <p className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed">
                支持 uTools <code className="bg-[var(--color-bg-secondary)] px-1 rounded">plugin.json</code> 和 Rubick <code className="bg-[var(--color-bg-secondary)] px-1 rounded">package.json</code> 格式。
                支持文件监听热重载、API 追踪、权限命中统计和事件模拟。调试日志保存在本地内存，重启后清空。
              </p>
            </div>

            {/* 添加开发目录 */}
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">添加插件目录</label>
              <button
                onClick={handleOpenPluginDir}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-xs rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-orange-400 hover:text-orange-400 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                选择目录
              </button>
            </div>

            {/* 已添加的开发目录 */}
            {devDirs.length > 0 && (
              <div>
                <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">已添加目录</label>
                <div className="space-y-1">
                  {devDirs.map((dir) => (
                    <div key={dir} className="flex items-center gap-2 bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 border border-[var(--color-border)]">
                      <FolderOpen className="w-3 h-3 text-orange-400 shrink-0" />
                      <span className="text-[10px] text-[var(--color-text)] font-mono truncate flex-1">{dir}</span>
                      <button
                        onClick={() => handleRemoveDevDir(dir)}
                        className="p-0.5 rounded hover:bg-red-400/10 text-[var(--color-text-secondary)] hover:text-red-400 transition-colors shrink-0"
                        title="移除"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-[var(--color-text)]">
                  <Bug className="w-3.5 h-3.5 text-orange-400" />
                  调试监听
                </div>
                <div className="text-[10px] text-[var(--color-text-secondary)]">
                  {watchStatus?.running ? '运行中' : '未启动'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleWatchStart}
                  disabled={watchBusy}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] bg-green-500/15 text-green-300 hover:bg-green-500/25 disabled:opacity-40"
                >
                  <PlayCircle className="w-3.5 h-3.5" />
                  开始监听
                </button>
                <button
                  onClick={handleWatchStop}
                  disabled={watchBusy || !watchStatus?.running}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] bg-red-500/15 text-red-300 hover:bg-red-500/25 disabled:opacity-40"
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  停止监听
                </button>
                <button
                  onClick={handleOpenDevtools}
                  className="px-2 py-1.5 rounded text-[10px] bg-blue-500/15 text-blue-300 hover:bg-blue-500/25"
                >
                  打开 DevTools
                </button>
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                变更次数: {watchStatus?.changedCount || 0} | 最近变化: {watchStatus?.lastChangedAt || '-'}
              </div>
              {watchStatus?.lastError && (
                <div className="text-[10px] text-red-400">{watchStatus.lastError}</div>
              )}
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-[var(--color-text)]">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  API 追踪
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleExportTrace}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-[var(--color-bg-hover)] hover:bg-[var(--color-border)] text-[var(--color-text-secondary)]"
                  >
                    <Download className="w-3 h-3" />
                    导出 JSON
                  </button>
                  <button
                    onClick={handleClearTrace}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-red-500/15 hover:bg-red-500/25 text-red-300"
                  >
                    <Trash2 className="w-3 h-3" />
                    清空
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={tracePluginFilter}
                  onChange={(e) => setTracePluginFilter(e.target.value)}
                  className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px] text-[var(--color-text)]"
                >
                  <option value="">全部插件</option>
                  {plugins.map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>{plugin.manifest.pluginName}</option>
                  ))}
                </select>
                <select
                  value={traceMethodFilter}
                  onChange={(e) => setTraceMethodFilter(e.target.value)}
                  className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px] text-[var(--color-text)]"
                >
                  <option value="">全部方法</option>
                  {traceMethods.map((method) => (
                    <option key={method} value={method}>{method}</option>
                  ))}
                </select>
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                权限命中: 放行 {permissionSummary.allow} / 拒绝 {permissionSummary.deny}
              </div>
              {permissionSummary.lastDenyReason && (
                <div className="text-[10px] text-red-400 truncate">最近拒绝: {permissionSummary.lastDenyReason}</div>
              )}
              <div className="max-h-[180px] overflow-y-auto rounded bg-[var(--color-code-bg)] p-2 space-y-1 text-[10px] font-mono">
                {filteredTraces.length === 0 && <div className="opacity-50">暂无追踪数据</div>}
                {filteredTraces.slice(0, 100).map((item, idx) => (
                  <div key={`${item.callId}-${idx}`} className={item.success ? 'text-[var(--color-text-secondary)]' : 'text-red-300'}>
                    [{new Date(item.createdAt).toLocaleTimeString()}] {item.pluginId} {item.method} #{item.callId} {item.durationMs}ms {item.success ? 'OK' : item.error}
                  </div>
                ))}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
              <div className="flex items-center gap-2 text-xs text-[var(--color-text)]">
                <FlaskConical className="w-3.5 h-3.5 text-purple-300" />
                事件模拟器
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={simPluginId}
                  onChange={(e) => {
                    setSimPluginId(e.target.value)
                    const plugin = plugins.find((p) => p.id === e.target.value)
                    setSimFeatureCode(plugin?.manifest.features[0]?.code || '')
                  }}
                  className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px]"
                >
                  {plugins.map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>{plugin.manifest.pluginName}</option>
                  ))}
                </select>
                <select
                  value={simFeatureCode}
                  onChange={(e) => setSimFeatureCode(e.target.value)}
                  className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px]"
                >
                  {(plugins.find((p) => p.id === simPluginId)?.manifest.features || []).map((feature) => (
                    <option key={feature.code} value={feature.code}>{feature.explain || feature.code}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={simEventType}
                  onChange={(e) => setSimEventType(e.target.value)}
                  className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px]"
                >
                  <option value="onPluginEnter">onPluginEnter</option>
                  <option value="onPluginOut">onPluginOut</option>
                  <option value="setSubInput">setSubInput</option>
                  <option value="redirect">redirect</option>
                  <option value="screenCapture">screenCapture</option>
                </select>
                <button
                  onClick={handleSimulateEvent}
                  className="px-2 py-1 rounded text-[10px] bg-purple-500/20 text-purple-200 hover:bg-purple-500/30"
                >
                  发送事件
                </button>
              </div>
              <textarea
                value={simPayload}
                onChange={(e) => setSimPayload(e.target.value)}
                rows={3}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px] font-mono"
                placeholder='{"code":"demo","type":"text","payload":"hello"}'
              />
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
              <div className="text-xs text-[var(--color-text)]">插件本地存储调试</div>
              <div className="flex items-center gap-2">
                <select
                  value={storagePluginId}
                  onChange={(e) => setStoragePluginId(e.target.value)}
                  className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px]"
                >
                  {plugins.map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>{plugin.manifest.pluginName}</option>
                  ))}
                </select>
                <button
                  onClick={handleStorageDump}
                  className="px-2 py-1 rounded text-[10px] bg-[var(--color-bg-hover)] hover:bg-[var(--color-border)]"
                >
                  Dump
                </button>
                <button
                  onClick={handleStorageClear}
                  className="px-2 py-1 rounded text-[10px] bg-red-500/15 text-red-300 hover:bg-red-500/25"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
              <div className="text-xs text-[var(--color-text)]">提交前预检</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePreflight}
                  disabled={preflightLoading}
                  className="px-3 py-1.5 rounded text-[10px] bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30 disabled:opacity-40"
                >
                  {preflightLoading ? '预检中...' : '选择 ZIP 并预检'}
                </button>
                <button
                  onClick={handleSubmitPlugin}
                  disabled={submitLoading || !preflightReport?.ok}
                  className="px-3 py-1.5 rounded text-[10px] bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-40"
                >
                  {submitLoading ? '提交中...' : '正式提交'}
                </button>
                {preflightReport && (
                  <span className={`text-[10px] ${preflightReport.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {preflightReport.ok ? '预检通过' : '预检未通过'}
                  </span>
                )}
              </div>
              {submitMessage && (
                <div className="text-[10px] text-emerald-300">{submitMessage}</div>
              )}
              {preflightReport && (
                <div className="text-[10px] text-[var(--color-text-secondary)] space-y-1">
                  <div>包大小: {Math.round(preflightReport.fileSizeBytes / 1024)} KB</div>
                  <div>权限: {(preflightReport.manifest?.permissions || []).join(', ') || '无'}</div>
                  {preflightReport.risks.length > 0 && (
                    <div className="text-yellow-300">风险提示: {preflightReport.risks.join('；')}</div>
                  )}
                </div>
              )}
            </div>

            {compatMatrix.length > 0 && (
              <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <div className="text-xs text-[var(--color-text)] mb-2">兼容矩阵</div>
                <div className="space-y-1 text-[10px]">
                  {compatMatrix.map((item) => (
                    <div key={item.capability} className="flex items-center justify-between">
                      <span className="text-[var(--color-text-secondary)]">{item.capability}</span>
                      <span className={item.status === 'supported' ? 'text-green-400' : item.status === 'partial' ? 'text-yellow-300' : 'text-red-400'}>
                        {item.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 开发日志 */}
            <div>
              <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">开发日志</label>
              <div className="bg-[var(--color-code-bg)] rounded-lg p-3 max-h-[160px] overflow-y-auto font-mono text-[10px] text-[var(--color-text-secondary)] space-y-0.5">
                {devLogs.length === 0 && (
                  <span className="opacity-50">等待操作...</span>
                )}
                {devLogs.map((log, i) => (
                  <div key={i} className={log.includes('✗') ? 'text-red-400' : log.includes('✓') ? 'text-green-400' : ''}>
                    {log}
                  </div>
                ))}
              </div>
            </div>

            {/* 插件开发参考 */}
            <div className="pt-2 border-t border-[var(--color-border)]">
              <div className="text-xs text-[var(--color-text-secondary)] mb-2">参考文档</div>
              <div className="space-y-1">
                <a
                  className="flex items-center gap-1.5 text-[10px] text-indigo-400 hover:text-indigo-300 cursor-pointer"
                  onClick={() => invoke('open_url', { url: 'https://www.u.tools/docs/developer/welcome.html' })}
                >
                  <ExternalLink className="w-3 h-3" />
                  uTools 插件开发文档
                </a>
                <a
                  className="flex items-center gap-1.5 text-[10px] text-indigo-400 hover:text-indigo-300 cursor-pointer"
                  onClick={() => invoke('open_url', { url: 'https://rubickcenter.github.io/docs/' })}
                >
                  <ExternalLink className="w-3 h-3" />
                  Rubick 插件开发文档
                </a>
              </div>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
