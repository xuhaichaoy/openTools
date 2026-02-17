import { Wrench, CheckCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { handleError } from '@/core/errors'
import type { ToolCallInfo } from '@/store/ai-store'

const TOOL_LABELS: Record<string, string> = {
  search_data_scripts: '搜索数据脚本',
  run_data_script: '执行数据脚本',
  run_shell_command: '执行命令',
  read_clipboard: '读取剪贴板',
  write_clipboard: '写入剪贴板',
  search_knowledge_base: '搜索知识库',
  read_file: '读取文件',
  write_file: '写入文件',
  list_directory: '列出目录',
  get_system_info: '获取系统信息',
  open_url: '打开网址',
  open_path: '打开文件/目录',
  get_running_processes: '获取进程列表',
}

export function ToolCallDisplay({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  return (
    <div className="space-y-2 my-2">
      {toolCalls.map((tc) => (
        <ToolCallItem key={tc.id} toolCall={tc} />
      ))}
    </div>
  )
}

function ToolCallItem({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false)
  const isDone = toolCall.result !== undefined
  const label = TOOL_LABELS[toolCall.name] || toolCall.name

  // 尝试格式化参数
  let argsDisplay = toolCall.arguments
  try {
    const parsed = JSON.parse(toolCall.arguments)
    argsDisplay = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(', ')
  } catch (e) {
    handleError(e, { context: '解析工具参数', silent: true })
  }

  return (
    <div className="rounded-lg bg-[var(--color-code-bg)] border border-[var(--color-border)] overflow-hidden">
      {/* 头部 */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {isDone ? (
          <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
        ) : (
          <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
        )}
        <Wrench className="w-3 h-3 text-[var(--color-text-secondary)] shrink-0" />
        <span className="text-xs text-[var(--color-text)] font-medium">{label}</span>
        <span className="text-[10px] text-[var(--color-text-secondary)] truncate flex-1">
          {argsDisplay}
        </span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-[var(--color-text-secondary)] shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)] shrink-0" />
        )}
      </button>

      {/* 展开详情 */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-[var(--color-border)]">
          <div className="pt-1.5">
            <div className="text-[10px] text-[var(--color-text-secondary)] mb-0.5">参数</div>
            <pre className="text-[10px] text-[var(--color-text)] font-mono whitespace-pre-wrap break-all bg-[var(--color-bg-secondary)] rounded p-1.5">
              {toolCall.arguments}
            </pre>
          </div>
          {toolCall.result && (
            <div>
              <div className="text-[10px] text-[var(--color-text-secondary)] mb-0.5">结果</div>
              <pre className="text-[10px] text-[var(--color-text)] font-mono whitespace-pre-wrap break-all bg-[var(--color-bg-secondary)] rounded p-1.5 max-h-[150px] overflow-y-auto">
                {toolCall.result.slice(0, 2000)}
                {toolCall.result.length > 2000 && '...'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
