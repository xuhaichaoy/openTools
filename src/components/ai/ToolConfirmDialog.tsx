import { ShieldAlert, Check, X } from 'lucide-react'
import { useAIStore } from '@/store/ai-store'
import { handleError } from '@/core/errors'

const TOOL_LABELS: Record<string, string> = {
  run_shell_command: '执行命令',
  write_file: '写入文件',
  str_replace_edit: '编辑文件',
  open_path: '打开文件/目录',
}

export function ToolConfirmDialog() {
  const { pendingToolConfirm, confirmTool } = useAIStore()

  if (!pendingToolConfirm) return null

  const label = TOOL_LABELS[pendingToolConfirm.name] || pendingToolConfirm.name

  let argsDisplay = pendingToolConfirm.arguments
  try {
    const parsed = JSON.parse(pendingToolConfirm.arguments)
    argsDisplay = JSON.stringify(parsed, null, 2)
  } catch (e) {
    handleError(e, { context: '解析工具参数', silent: true })
  }

  return (
    <div className="mx-2 my-1 rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="w-6 h-6 rounded-md bg-amber-500/10 flex items-center justify-center shrink-0">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-[var(--color-text)]">操作确认</span>
          <span className="text-[10px] text-[var(--color-text-secondary)] ml-2">{label}</span>
        </div>
      </div>

      {/* 参数预览 */}
      <div className="px-3 pb-2">
        <pre className="text-[10px] text-[var(--color-text)] font-mono bg-[var(--color-bg-secondary)] rounded-lg px-2.5 py-1.5 max-h-[100px] overflow-y-auto whitespace-pre-wrap break-all">
          {argsDisplay}
        </pre>
      </div>

      {/* 按钮 */}
      <div className="flex gap-1.5 px-3 pb-2.5">
        <button
          onClick={() => confirmTool(false)}
          className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <X className="w-3 h-3" />
          拒绝
        </button>
        <button
          onClick={() => confirmTool(true)}
          className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
        >
          <Check className="w-3 h-3" />
          允许
        </button>
      </div>
    </div>
  )
}
