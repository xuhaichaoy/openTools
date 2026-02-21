import {
  Bug,
  Download,
  ExternalLink,
  FlaskConical,
  FolderOpen,
  PlayCircle,
  Plus,
  ShieldCheck,
  StopCircle,
  Trash2,
  X,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type {
  PluginCompatMatrixItem,
  PluginDevTraceItem,
  PluginDevWatchStatus,
  PluginInstance,
  PluginPreflightReport,
} from '@/core/plugin-system/types'

interface PluginDeveloperPanelProps {
  plugins: PluginInstance[]
  devDirs: string[]
  onOpenPluginDir: () => void
  onRemoveDevDir: (dirPath: string) => void
  watchBusy: boolean
  watchStatus: PluginDevWatchStatus | null
  onWatchStart: () => void
  onWatchStop: () => void
  onOpenDevtools: () => void
  onExportTrace: () => void
  onClearTrace: () => void
  tracePluginFilter: string
  onTracePluginFilterChange: (value: string) => void
  traceMethodFilter: string
  onTraceMethodFilterChange: (value: string) => void
  traceMethods: string[]
  permissionSummary: {
    allow: number
    deny: number
    lastDenyReason: string
  }
  filteredTraces: PluginDevTraceItem[]
  simPluginId: string
  onSimPluginChange: (value: string) => void
  simFeatureCode: string
  onSimFeatureCodeChange: (value: string) => void
  simEventType: string
  onSimEventTypeChange: (value: string) => void
  simPayload: string
  onSimPayloadChange: (value: string) => void
  onSimulateEvent: () => void
  storagePluginId: string
  onStoragePluginChange: (value: string) => void
  onStorageDump: () => void
  onStorageClear: () => void
  preflightLoading: boolean
  onPreflight: () => void
  submitLoading: boolean
  onSubmitPlugin: () => void
  preflightReport: PluginPreflightReport | null
  submitMessage: string
  compatMatrix: PluginCompatMatrixItem[]
  devLogs: string[]
}

export function PluginDeveloperPanel({
  plugins,
  devDirs,
  onOpenPluginDir,
  onRemoveDevDir,
  watchBusy,
  watchStatus,
  onWatchStart,
  onWatchStop,
  onOpenDevtools,
  onExportTrace,
  onClearTrace,
  tracePluginFilter,
  onTracePluginFilterChange,
  traceMethodFilter,
  onTraceMethodFilterChange,
  traceMethods,
  permissionSummary,
  filteredTraces,
  simPluginId,
  onSimPluginChange,
  simFeatureCode,
  onSimFeatureCodeChange,
  simEventType,
  onSimEventTypeChange,
  simPayload,
  onSimPayloadChange,
  onSimulateEvent,
  storagePluginId,
  onStoragePluginChange,
  onStorageDump,
  onStorageClear,
  preflightLoading,
  onPreflight,
  submitLoading,
  onSubmitPlugin,
  preflightReport,
  submitMessage,
  compatMatrix,
  devLogs,
}: PluginDeveloperPanelProps) {
  const selectedSimPlugin = plugins.find((plugin) => plugin.id === simPluginId)

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="space-y-[var(--space-compact-3)]">
        <div className="p-[var(--space-compact-3)] rounded-lg bg-orange-400/5 border border-orange-400/20">
          <h3 className="text-xs font-medium text-orange-400 mb-1">开发者模式</h3>
          <p className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed">
            支持 uTools <code className="bg-[var(--color-bg-secondary)] px-1 rounded">plugin.json</code> 和
            Rubick <code className="bg-[var(--color-bg-secondary)] px-1 rounded">package.json</code> 格式。
            支持文件监听热重载、API 追踪、权限命中统计和事件模拟。调试日志保存在本地内存，重启后清空。
          </p>
        </div>

        <div>
          <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">添加插件目录</label>
          <button
            onClick={onOpenPluginDir}
            className="w-full flex items-center justify-center gap-2 px-[var(--space-compact-3)] py-[var(--space-compact-2)] text-xs rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-orange-400 hover:text-orange-400 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            选择目录
          </button>
        </div>

        {devDirs.length > 0 && (
          <div>
            <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">已添加目录</label>
            <div className="space-y-1">
              {devDirs.map((dir) => (
                <div
                  key={dir}
                  className="flex items-center gap-2 bg-[var(--color-bg-secondary)] rounded-lg px-[var(--space-compact-3)] py-[var(--space-compact-2)] border border-[var(--color-border)]"
                >
                  <FolderOpen className="w-3 h-3 text-orange-400 shrink-0" />
                  <span className="text-[10px] text-[var(--color-text)] font-mono truncate flex-1">{dir}</span>
                  <button
                    onClick={() => onRemoveDevDir(dir)}
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

        <div className="p-[var(--space-compact-3)] rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
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
              onClick={onWatchStart}
              disabled={watchBusy}
              className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] bg-green-500/15 text-green-300 hover:bg-green-500/25 disabled:opacity-40"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              开始监听
            </button>
            <button
              onClick={onWatchStop}
              disabled={watchBusy || !watchStatus?.running}
              className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] bg-red-500/15 text-red-300 hover:bg-red-500/25 disabled:opacity-40"
            >
              <StopCircle className="w-3.5 h-3.5" />
              停止监听
            </button>
            <button
              onClick={onOpenDevtools}
              className="px-2 py-1.5 rounded text-[10px] bg-blue-500/15 text-blue-300 hover:bg-blue-500/25"
            >
              打开 DevTools
            </button>
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)]">
            变更次数: {watchStatus?.changedCount || 0} | 最近变化: {watchStatus?.lastChangedAt || '-'}
          </div>
          {watchStatus?.lastError && <div className="text-[10px] text-red-400">{watchStatus.lastError}</div>}
        </div>

        <div className="p-[var(--space-compact-3)] rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-[var(--color-text)]">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              API 追踪
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onExportTrace}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-[var(--color-bg-hover)] hover:bg-[var(--color-border)] text-[var(--color-text-secondary)]"
              >
                <Download className="w-3 h-3" />
                导出 JSON
              </button>
              <button
                onClick={onClearTrace}
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
              onChange={(event) => onTracePluginFilterChange(event.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px] text-[var(--color-text)]"
            >
              <option value="">全部插件</option>
              {plugins.map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.manifest.pluginName}
                </option>
              ))}
            </select>
            <select
              value={traceMethodFilter}
              onChange={(event) => onTraceMethodFilterChange(event.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px] text-[var(--color-text)]"
            >
              <option value="">全部方法</option>
              {traceMethods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
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
            {filteredTraces.slice(0, 100).map((item, index) => (
              <div
                key={`${item.callId}-${index}`}
                className={item.success ? 'text-[var(--color-text-secondary)]' : 'text-red-300'}
              >
                [{new Date(item.createdAt).toLocaleTimeString()}] {item.pluginId} {item.method} #{item.callId}{' '}
                {item.durationMs}ms {item.success ? 'OK' : item.error}
              </div>
            ))}
          </div>
        </div>

        <div className="p-[var(--space-compact-3)] rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
          <div className="flex items-center gap-2 text-xs text-[var(--color-text)]">
            <FlaskConical className="w-3.5 h-3.5 text-purple-300" />
            事件模拟器
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={simPluginId}
              onChange={(event) => onSimPluginChange(event.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px]"
            >
              {plugins.map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.manifest.pluginName}
                </option>
              ))}
            </select>
            <select
              value={simFeatureCode}
              onChange={(event) => onSimFeatureCodeChange(event.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px]"
            >
              {(selectedSimPlugin?.manifest.features || []).map((feature) => (
                <option key={feature.code} value={feature.code}>
                  {feature.explain || feature.code}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={simEventType}
              onChange={(event) => onSimEventTypeChange(event.target.value)}
              className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px]"
            >
              <option value="onPluginEnter">onPluginEnter</option>
              <option value="onPluginOut">onPluginOut</option>
              <option value="setSubInput">setSubInput</option>
              <option value="redirect">redirect</option>
              <option value="screenCapture">screenCapture</option>
            </select>
            <button
              onClick={onSimulateEvent}
              className="px-2 py-1 rounded text-[10px] bg-purple-500/20 text-purple-200 hover:bg-purple-500/30"
            >
              发送事件
            </button>
          </div>
          <textarea
            value={simPayload}
            onChange={(event) => onSimPayloadChange(event.target.value)}
            rows={3}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px] font-mono"
            placeholder='{"code":"demo","type":"text","payload":"hello"}'
          />
        </div>

        <div className="p-[var(--space-compact-3)] rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
          <div className="text-xs text-[var(--color-text)]">插件本地存储调试</div>
          <div className="flex items-center gap-2">
            <select
              value={storagePluginId}
              onChange={(event) => onStoragePluginChange(event.target.value)}
              className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[10px]"
            >
              {plugins.map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.manifest.pluginName}
                </option>
              ))}
            </select>
            <button
              onClick={onStorageDump}
              className="px-2 py-1 rounded text-[10px] bg-[var(--color-bg-hover)] hover:bg-[var(--color-border)]"
            >
              Dump
            </button>
            <button
              onClick={onStorageClear}
              className="px-2 py-1 rounded text-[10px] bg-red-500/15 text-red-300 hover:bg-red-500/25"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="p-[var(--space-compact-3)] rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-2">
          <div className="text-xs text-[var(--color-text)]">提交前预检</div>
          <div className="flex items-center gap-2">
            <button
              onClick={onPreflight}
              disabled={preflightLoading}
              className="px-3 py-1.5 rounded text-[10px] bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30 disabled:opacity-40"
            >
              {preflightLoading ? '预检中...' : '选择 ZIP 并预检'}
            </button>
            <button
              onClick={onSubmitPlugin}
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
          {submitMessage && <div className="text-[10px] text-emerald-300">{submitMessage}</div>}
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
          <div className="p-[var(--space-compact-3)] rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
            <div className="text-xs text-[var(--color-text)] mb-2">兼容矩阵</div>
            <div className="space-y-1 text-[10px]">
              {compatMatrix.map((item) => (
                <div key={item.capability} className="flex items-center justify-between">
                  <span className="text-[var(--color-text-secondary)]">{item.capability}</span>
                  <span
                    className={
                      item.status === 'supported'
                        ? 'text-green-400'
                        : item.status === 'partial'
                          ? 'text-yellow-300'
                          : 'text-red-400'
                    }
                  >
                    {item.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">开发日志</label>
          <div className="bg-[var(--color-code-bg)] rounded-lg p-[var(--space-compact-3)] max-h-[160px] overflow-y-auto font-mono text-[10px] text-[var(--color-text-secondary)] space-y-0.5">
            {devLogs.length === 0 && <span className="opacity-50">等待操作...</span>}
            {devLogs.map((log, index) => (
              <div
                key={index}
                className={log.includes('✗') ? 'text-red-400' : log.includes('✓') ? 'text-green-400' : ''}
              >
                {log}
              </div>
            ))}
          </div>
        </div>

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
  )
}
