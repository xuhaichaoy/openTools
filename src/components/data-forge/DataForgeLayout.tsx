import { useEffect } from 'react'
import { ArrowLeft, Database, Bot } from 'lucide-react'
import { useDataForgeStore } from '@/store/data-forge-store'
import { ScriptBrowser } from './ScriptBrowser'
import { ScriptDetail } from './ScriptDetail'
import { ExecutionHistory } from './ExecutionHistory'
import { useDragWindow } from '@/hooks/useDragWindow'

export function DataForgeLayout({ onBack }: { onBack: () => void }) {
  const { selectedScript, loadScripts, loadHistory } = useDataForgeStore()
  const { onMouseDown } = useDragWindow()

  useEffect(() => {
    loadScripts()
    loadHistory()
  }, [loadScripts, loadHistory])

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] shadow-2xl overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Database className="w-4 h-4 text-purple-400" />
          <span className="text-sm font-medium text-[var(--color-text)]">数据工坊</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            title="AI 助手"
          >
            <Bot className="w-3.5 h-3.5" />
            <span>AI 助手</span>
          </button>
        </div>
      </div>

      {/* 主体区域 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧: 脚本浏览器 */}
        <div className="w-[180px] border-r border-[var(--color-border)] overflow-y-auto shrink-0">
          <ScriptBrowser />
        </div>

        {/* 右侧: 脚本详情 / 执行面板 */}
        <div className="flex-1 overflow-y-auto">
          {selectedScript ? (
            <ScriptDetail />
          ) : (
            <ExecutionHistory />
          )}
        </div>
      </div>
    </div>
  )
}
