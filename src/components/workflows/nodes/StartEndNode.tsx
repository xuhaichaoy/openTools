import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

interface StartEndData {
  label: string
  [key: string]: unknown
}

export const StartNode = memo(({ data, selected }: NodeProps) => {
  const d = data as StartEndData
  return (
    <div
      className={`flex items-center justify-center w-[100px] h-[40px] rounded-full border-2 transition-all ${
        selected
          ? 'border-green-400 shadow-lg shadow-green-500/20'
          : 'border-green-500/50 hover:border-green-400'
      } bg-green-500/10`}
    >
      <span className="text-xs font-medium text-green-400">▶ {d.label || '开始'}</span>
      <Handle type="source" position={Position.Bottom} className="!w-2.5 !h-2.5 !bg-green-500 !border-2 !border-green-300" />
    </div>
  )
})
StartNode.displayName = 'StartNode'

export const EndNode = memo(({ data, selected }: NodeProps) => {
  const d = data as StartEndData
  return (
    <div
      className={`flex items-center justify-center w-[100px] h-[40px] rounded-full border-2 transition-all ${
        selected
          ? 'border-red-400 shadow-lg shadow-red-500/20'
          : 'border-red-500/50 hover:border-red-400'
      } bg-red-500/10`}
    >
      <Handle type="target" position={Position.Top} className="!w-2.5 !h-2.5 !bg-red-500 !border-2 !border-red-300" />
      <span className="text-xs font-medium text-red-400">⏹ {d.label || '结束'}</span>
    </div>
  )
})
EndNode.displayName = 'EndNode'
