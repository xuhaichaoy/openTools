import { ShieldAlert, Check, X } from 'lucide-react'
import { useAIStore } from '@/store/ai-store'

const TOOL_LABELS: Record<string, string> = {
  run_shell_command: '执行命令',
  write_file: '写入文件',
  open_path: '打开文件/目录',
}

export function ToolConfirmDialog() {
  const { pendingToolConfirm, confirmTool } = useAIStore()

  if (!pendingToolConfirm) return null

  const label = TOOL_LABELS[pendingToolConfirm.name] || pendingToolConfirm.name

  // 尝试格式化参数
  let argsDisplay = pendingToolConfirm.arguments
  try {
    const parsed = JSON.parse(pendingToolConfirm.arguments)
    argsDisplay = JSON.stringify(parsed, null, 2)
  } catch {}

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[380px] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--color-border)] bg-amber-500/5">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <ShieldAlert className="w-4.5 h-4.5 text-amber-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">操作确认</h3>
            <p className="text-[10px] text-[var(--color-text-secondary)]">AI 请求执行以下危险操作</p>
          </div>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4 space-y-3">
          <div>
            <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">工具</div>
            <div className="text-xs font-medium text-[var(--color-text)] bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2">
              {label}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">参数</div>
            <pre className="text-[10px] text-[var(--color-text)] font-mono bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all">
              {argsDisplay}
            </pre>
          </div>
          <div className="text-[10px] text-amber-600 bg-amber-500/5 rounded-lg px-3 py-2">
            此操作可能修改系统或文件，请确认后再执行。
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          <button
            onClick={() => confirmTool(false)}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            拒绝
          </button>
          <button
            onClick={() => confirmTool(true)}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            允许执行
          </button>
        </div>
      </div>
    </div>
  )
}
