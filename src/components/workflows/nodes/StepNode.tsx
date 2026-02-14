import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { StepType } from '@/core/workflows/types'
import { stepTypeInfo } from '@/core/workflows/types'

interface StepData {
  label: string
  stepType: StepType
  output_var?: string
  configSummary?: string
  [key: string]: unknown
}

/** 通用步骤节点 — 显示图标、名称、类型标签、输出变量 */
export const StepNode = memo(({ data, selected }: NodeProps) => {
  const d = data as StepData
  const info = stepTypeInfo[d.stepType]
  const color = info?.color || '#6366f1'

  return (
    <div
      className={`relative min-w-[180px] max-w-[220px] rounded-xl border-2 transition-all bg-[var(--color-bg)] ${
        selected
          ? 'shadow-lg'
          : 'hover:shadow-md'
      }`}
      style={{
        borderColor: selected ? color : `${color}60`,
        boxShadow: selected ? `0 0 16px ${color}30` : undefined,
      }}
    >
      {/* 输入端口 */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !border-2"
        style={{ background: color, borderColor: `${color}80` }}
      />

      {/* 头部色条 */}
      <div className="h-1 rounded-t-[10px]" style={{ background: color }} />

      {/* 内容 */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-base leading-none">{info?.icon || '📦'}</span>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-semibold text-[var(--color-text)] truncate">
              {d.label}
            </div>
            <div className="text-[9px] text-[var(--color-text-secondary)] opacity-60">
              {info?.label || d.stepType}
            </div>
          </div>
        </div>
        {/* 配置摘要 */}
        {d.configSummary && (
          <div className="mt-1.5 text-[9px] text-[var(--color-text-secondary)] truncate font-mono opacity-50">
            {d.configSummary}
          </div>
        )}
        {/* 输出变量 */}
        {d.output_var && (
          <div className="mt-1 flex items-center gap-1">
            <span
              className="text-[8px] px-1.5 py-0.5 rounded font-mono"
              style={{ background: `${color}15`, color }}
            >
              → {d.output_var}
            </span>
          </div>
        )}
      </div>

      {/* 输出端口 */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !border-2"
        style={{ background: color, borderColor: `${color}80` }}
      />
    </div>
  )
})
StepNode.displayName = 'StepNode'
