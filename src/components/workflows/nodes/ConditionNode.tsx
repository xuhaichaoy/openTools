import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

interface ConditionData {
  label: string
  configSummary?: string
  [key: string]: unknown
}

/** 条件分支节点 — 菱形样式，两个输出端口 (True/False) */
export const ConditionNode = memo(({ data, selected }: NodeProps) => {
  const d = data as ConditionData
  const color = '#eab308'

  return (
    <div className="relative flex flex-col items-center">
      {/* 输入端口 */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !border-2"
        style={{ background: color, borderColor: `${color}80` }}
      />

      {/* 菱形容器 */}
      <div
        className={`w-[160px] rounded-xl border-2 transition-all bg-[var(--color-bg)] ${
          selected ? 'shadow-lg' : 'hover:shadow-md'
        }`}
        style={{
          borderColor: selected ? color : `${color}60`,
          boxShadow: selected ? `0 0 16px ${color}30` : undefined,
        }}
      >
        <div className="h-1 rounded-t-[10px]" style={{ background: color }} />
        <div className="px-3 py-2 text-center">
          <div className="text-base leading-none mb-1">❓</div>
          <div className="text-[11px] font-semibold text-[var(--color-text)] truncate">
            {d.label || '条件判断'}
          </div>
          {d.configSummary && (
            <div className="mt-1 text-[9px] text-[var(--color-text-secondary)] truncate font-mono opacity-50">
              {d.configSummary}
            </div>
          )}
        </div>
      </div>

      {/* True/False 两个输出端口 */}
      <div className="relative w-[160px] h-0">
        <Handle
          type="source"
          position={Position.Bottom}
          id="true"
          className="!w-2.5 !h-2.5 !border-2 !-translate-x-1/2"
          style={{ background: '#22c55e', borderColor: '#22c55e80', left: '30%' }}
        />
        <span className="absolute text-[8px] text-green-400 font-medium" style={{ left: '18%', top: '4px' }}>
          True
        </span>

        <Handle
          type="source"
          position={Position.Bottom}
          id="false"
          className="!w-2.5 !h-2.5 !border-2 !-translate-x-1/2"
          style={{ background: '#ef4444', borderColor: '#ef444480', left: '70%' }}
        />
        <span className="absolute text-[8px] text-red-400 font-medium" style={{ left: '60%', top: '4px' }}>
          False
        </span>
      </div>
    </div>
  )
})
ConditionNode.displayName = 'ConditionNode'
