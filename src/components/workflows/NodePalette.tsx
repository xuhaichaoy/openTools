import type { StepType } from '@/core/workflows/types'
import { stepTypeInfo } from '@/core/workflows/types'

interface NodePaletteProps {
  onAddNode: (type: StepType) => void
}

const nodeGroups: { label: string; types: StepType[] }[] = [
  { label: 'AI', types: ['ai_chat'] },
  { label: '数据', types: ['clipboard_read', 'clipboard_write', 'file_read', 'file_write', 'http'] },
  { label: '逻辑', types: ['condition', 'transform', 'script'] },
  { label: '交互', types: ['user_input', 'notification'] },
]

export function NodePalette({ onAddNode }: NodePaletteProps) {
  const onDragStart = (e: React.DragEvent, type: StepType) => {
    e.dataTransfer.setData('application/workflow-node-type', type)
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className="w-[140px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg)] overflow-y-auto">
      <div className="px-2 py-2">
        <div className="text-[10px] font-medium text-[var(--color-text-secondary)] mb-2 px-1">节点</div>
        {nodeGroups.map((group) => (
          <div key={group.label} className="mb-2">
            <div className="text-[9px] text-[var(--color-text-secondary)] opacity-50 px-1 mb-1">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.types.map((type) => {
                const info = stepTypeInfo[type]
                return (
                  <button
                    key={type}
                    draggable
                    onDragStart={(e) => onDragStart(e, type)}
                    onClick={() => onAddNode(type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left rounded-lg
                      hover:bg-[var(--color-bg-hover)] transition-colors cursor-grab active:cursor-grabbing
                      border border-transparent hover:border-[var(--color-border)]"
                  >
                    <span className="text-sm leading-none">{info.icon}</span>
                    <span className="text-[10px] text-[var(--color-text)] truncate">{info.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
