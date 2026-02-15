import { useState, useEffect } from 'react'
import { ArrowLeft, Puzzle, Play, AppWindow, FolderOpen, Code, RefreshCw, ExternalLink, Loader2, ToggleLeft, ToggleRight, X, Plus } from 'lucide-react'
import { usePluginStore } from '@/store/plugin-store'
import { useAppStore } from '@/store/app-store'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useDragWindow } from '@/hooks/useDragWindow'

export function PluginMarket({ onBack }: { onBack: () => void }) {
  const { plugins, loadPlugins, openPlugin, addDevDir, removeDevDir, setPluginEnabled, devDirs } = usePluginStore()
  const [activeTab, setActiveTab] = useState<'installed' | 'dev'>('installed')
  const [loading, setLoading] = useState(false)
  const [devLogs, setDevLogs] = useState<string[]>([])
  const [developerMode, setDeveloperMode] = useState(false)
  const { onMouseDown } = useDragWindow()

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

  const handleRefresh = async () => {
    setLoading(true)
    await loadPlugins()
    setLoading(false)
  }

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
      addDevLog(`✗ 加载失败: ${e}`)
      console.error('选择目录失败:', e)
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
          onClick={() => setActiveTab('installed')}
          className={`text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'installed'
              ? 'border-orange-400 text-orange-400 bg-[var(--color-bg-secondary)]'
              : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
          }`}
        >
          已安装 ({plugins.length})
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
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'installed' && (
          <div className="space-y-2">
            {loading && (
              <div className="text-center py-8 text-[var(--color-text-secondary)]">
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                <span className="text-xs">加载中...</span>
              </div>
            )}

            {!loading && plugins.length === 0 && (
              <div className="text-center py-8 text-[var(--color-text-secondary)]">
                <Puzzle className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-xs">暂无安装的插件</p>
                <p className="text-[10px] mt-1">将插件目录放入 <code className="bg-[var(--color-bg-secondary)] px-1 rounded">plugins/</code> 或在开发者 Tab 中添加目录</p>
              </div>
            )}

            {plugins.map((plugin) => (
              <div
                key={plugin.id}
                className={`flex items-center justify-between p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-orange-400/50 transition-colors ${
                  !plugin.enabled ? 'opacity-50' : ''
                }`}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-orange-400/10 flex items-center justify-center shrink-0">
                    <Puzzle className="w-4 h-4 text-orange-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-[var(--color-text)] truncate">
                      {plugin.manifest.pluginName}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] truncate">
                      {plugin.manifest.description || '无描述'}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-2 mt-0.5">
                      <span>v{plugin.manifest.version}</span>
                      {plugin.manifest.author && <span>{plugin.manifest.author}</span>}
                      <span>{plugin.manifest.features.length} 个功能</span>
                      {plugin.isBuiltin && (
                        <span className="text-orange-400 bg-orange-400/10 px-1 rounded">内置</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 ml-2">
                  {/* 启用/禁用开关 */}
                  <button
                    onClick={() => setPluginEnabled(plugin.id, !plugin.enabled)}
                    className={`p-1.5 rounded transition-colors ${
                      plugin.enabled
                        ? 'text-green-400 hover:bg-green-400/10'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                    }`}
                    title={plugin.enabled ? '点击禁用' : '点击启用'}
                  >
                    {plugin.enabled ? (
                      <ToggleRight className="w-4 h-4" />
                    ) : (
                      <ToggleLeft className="w-4 h-4" />
                    )}
                  </button>
                  {/* Feature 打开按钮 */}
                  {plugin.enabled && plugin.manifest.features.map((feature) => (
                    <div key={feature.code} className="flex items-center gap-0.5">
                      <button
                        onClick={() => openPlugin(plugin.id, feature.code)}
                        className="p-1.5 rounded hover:bg-orange-400/10 text-[var(--color-text-secondary)] hover:text-orange-400 transition-colors"
                        title={`新窗口打开: ${feature.explain}`}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          useAppStore.getState().requestEmbed({
                            pluginId: plugin.id,
                            featureCode: feature.code,
                            title: feature.explain || plugin.manifest.pluginName,
                          })
                        }}
                        className="p-1.5 rounded hover:bg-blue-400/10 text-[var(--color-text-secondary)] hover:text-blue-400 transition-colors"
                        title={`嵌入打开: ${feature.explain}`}
                      >
                        <AppWindow className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'dev' && developerMode && (
          <div className="space-y-4">
            {/* 开发者模式说明 */}
            <div className="p-3 rounded-lg bg-orange-400/5 border border-orange-400/20">
              <h3 className="text-xs font-medium text-orange-400 mb-1">开发者模式</h3>
              <p className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed">
                支持 uTools <code className="bg-[var(--color-bg-secondary)] px-1 rounded">plugin.json</code> 和 Rubick <code className="bg-[var(--color-bg-secondary)] px-1 rounded">package.json</code> 格式。
                选择插件目录后会自动扫描并加载到已安装列表中。
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
        )}
      </div>
    </div>
  )
}
