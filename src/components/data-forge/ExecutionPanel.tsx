import { useState, useEffect, useRef } from 'react'
import { Play, Loader2, CheckCircle, XCircle, Download, RotateCcw, FileText } from 'lucide-react'

interface ExecutionLog {
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'stdout' | 'stderr'
  message: string
}

interface ExecutionPanelProps {
  scriptId: string
  scriptName: string
  status: 'idle' | 'running' | 'success' | 'error'
  progress?: number
  logs: ExecutionLog[]
  outputFiles?: string[]
  duration?: number
  recordCount?: number
  errorMsg?: string
  onRetry?: () => void
  onOpenFile?: (path: string) => void
}

export function ExecutionPanel({
  scriptId,
  scriptName,
  status,
  progress,
  logs,
  outputFiles,
  duration,
  recordCount,
  errorMsg,
  onRetry,
  onOpenFile,
}: ExecutionPanelProps) {
  const logsEndRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (autoScroll) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll])

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  }

  const getLogColor = (level: string) => {
    switch (level) {
      case 'error':
      case 'stderr':
        return 'text-red-400'
      case 'warn':
        return 'text-yellow-400'
      case 'info':
        return 'text-blue-400'
      default:
        return 'text-[var(--color-text-secondary)]'
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
      {/* 头部状态 */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-2">
          {status === 'running' && <Loader2 className="w-3.5 h-3.5 text-yellow-400 animate-spin" />}
          {status === 'success' && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
          {status === 'error' && <XCircle className="w-3.5 h-3.5 text-red-400" />}
          {status === 'idle' && <Play className="w-3.5 h-3.5 text-gray-400" />}

          <span className="text-xs font-medium text-[var(--color-text)]">{scriptName}</span>

          {status === 'running' && (
            <span className="text-[10px] text-yellow-400">执行中...</span>
          )}
          {status === 'success' && duration && (
            <span className="text-[10px] text-green-400">
              完成 · {formatDuration(duration)}
              {recordCount !== undefined && ` · ${recordCount} 条记录`}
            </span>
          )}
          {status === 'error' && (
            <span className="text-[10px] text-red-400">失败</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {status === 'error' && onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              重试
            </button>
          )}
        </div>
      </div>

      {/* 进度条 */}
      {status === 'running' && progress !== undefined && (
        <div className="h-1 bg-[var(--color-bg)]">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}
      {status === 'running' && progress === undefined && (
        <div className="h-1 bg-[var(--color-bg)] overflow-hidden">
          <div className="h-full w-1/3 bg-gradient-to-r from-indigo-500 to-purple-500 animate-pulse" />
        </div>
      )}

      {/* 日志区域 */}
      <div
        className="max-h-[200px] overflow-y-auto bg-[var(--color-code-bg)] p-3 font-mono text-[11px] leading-relaxed"
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
          setAutoScroll(atBottom)
        }}
      >
        {logs.length === 0 && (
          <span className="text-[var(--color-text-secondary)] opacity-50">等待执行...</span>
        )}
        {logs.map((log, i) => (
          <div key={i} className={`${getLogColor(log.level)} whitespace-pre-wrap break-all`}>
            <span className="opacity-40 select-none">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
            {log.message}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>

      {/* 输出文件 */}
      {status === 'success' && outputFiles && outputFiles.length > 0 && (
        <div className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="text-[10px] text-[var(--color-text-secondary)] mb-1.5">输出文件</div>
          <div className="space-y-1">
            {outputFiles.map((file, i) => {
              const fileName = file.split('/').pop() || file
              return (
                <button
                  key={i}
                  onClick={() => onOpenFile?.(file)}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded bg-green-500/5 border border-green-500/20 hover:border-green-500/40 transition-colors text-left"
                >
                  <FileText className="w-3.5 h-3.5 text-green-400 shrink-0" />
                  <span className="text-xs text-green-400 truncate flex-1">{fileName}</span>
                  <Download className="w-3 h-3 text-green-400/60" />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 错误信息 */}
      {status === 'error' && errorMsg && (
        <div className="px-3 py-2 border-t border-red-500/20 bg-red-500/5">
          <div className="text-[10px] text-red-400">{errorMsg}</div>
        </div>
      )}
    </div>
  )
}
