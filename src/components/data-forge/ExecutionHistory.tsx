import { CheckCircle, XCircle, Clock, FileText, RotateCcw, Database } from 'lucide-react'
import { useDataForgeStore } from '@/store/data-forge-store'
import { handleError } from '@/core/errors'
import { invoke } from '@tauri-apps/api/core'

export function ExecutionHistory() {
  const { executionHistory, allScripts, setSelectedScript, rerunFromHistory } = useDataForgeStore()

  const handleOpenFile = async (filePath: string) => {
    try {
      await invoke('open_file_location', { filePath })
    } catch (e) {
      handleError(e, { context: '打开文件位置' })
    }
  }

  if (executionHistory.length === 0 && allScripts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)]">
        <Database className="w-12 h-12 mb-3 opacity-30" />
        <p className="text-sm">数据工坊</p>
        <p className="text-xs mt-1">在左侧选择分类或搜索脚本开始</p>
        <p className="text-xs mt-0.5 opacity-60">或输入 <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded text-[10px]">data </kbd> 前缀用 AI 描述需求</p>
      </div>
    )
  }

  // 如果没有执行历史，显示脚本列表
  if (executionHistory.length === 0) {
    return (
      <div className="p-4">
        <h3 className="text-xs font-medium text-[var(--color-text)] mb-3">所有脚本</h3>
        <div className="space-y-1">
          {allScripts.map((script) => (
            <button
              key={script.id}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors text-left"
              onClick={() => setSelectedScript(script)}
            >
              <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
                <FileText className="w-4 h-4 text-purple-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-[var(--color-text)]">{script.name}</div>
                <div className="text-[10px] text-[var(--color-text-secondary)] truncate">
                  {script.description}
                </div>
              </div>
              <span className="text-[10px] text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] px-1.5 py-0.5 rounded shrink-0">
                {script.category}
              </span>
              {script.estimated_time && (
                <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
                  {script.estimated_time}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-4">
      <h3 className="text-xs font-medium text-[var(--color-text)] mb-3">执行历史</h3>
      <div className="space-y-1">
        {executionHistory.map((record) => (
          <div
            key={record.id}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            {/* 状态图标 */}
            {record.status === 'success' ? (
              <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
            ) : record.status === 'failed' ? (
              <XCircle className="w-4 h-4 text-red-400 shrink-0" />
            ) : (
              <Clock className="w-4 h-4 text-yellow-400 animate-pulse shrink-0" />
            )}

            {/* 信息 */}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-[var(--color-text)]">{record.script_name}</div>
              <div className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-2">
                <span>{formatTime(record.started_at)}</span>
                {record.duration_ms && <span>耗时 {(record.duration_ms / 1000).toFixed(1)}s</span>}
                {record.record_count && <span>{record.record_count} 条</span>}
                {record.error && <span className="text-red-400 truncate">{record.error}</span>}
              </div>
            </div>

            {/* 操作 */}
            {record.output_files.length > 0 && (
              <button
                onClick={() => handleOpenFile(record.output_files[0])}
                className="text-[10px] text-[var(--color-accent)] hover:underline shrink-0"
              >
                打开文件
              </button>
            )}
            {record.status === 'failed' && (
              <button
                onClick={() => rerunFromHistory(record)}
                className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] shrink-0"
                title="重新执行"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function formatTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}
