import { useState, useRef, useCallback } from 'react'
import { ArrowLeft, Save, Play } from 'lucide-react'
import type { Workflow, WorkflowNode, WorkflowEdge, WorkflowTrigger } from '@/core/workflows/types'
import { stepsToGraph, graphToSteps } from '@/core/workflows/graph-utils'
import { WorkflowCanvas } from './WorkflowCanvas'
import { useDragWindow } from '@/hooks/useDragWindow'

interface WorkflowEditorProps {
  workflow?: Workflow | null
  onSave: (data: Omit<Workflow, 'id' | 'builtin' | 'created_at'>) => void
  onTest?: (workflow: Omit<Workflow, 'id' | 'builtin' | 'created_at'>) => void
  onBack: () => void
}

export function WorkflowEditor({ workflow, onSave, onTest, onBack }: WorkflowEditorProps) {
  const [name, setName] = useState(workflow?.name || '')
  const [icon, setIcon] = useState(workflow?.icon || '⚡')
  const [description, setDescription] = useState(workflow?.description || '')
  const [category, setCategory] = useState(workflow?.category || '自定义')
  const [triggerType, setTriggerType] = useState<string>(workflow?.trigger.type || 'manual')
  const [triggerKeyword, setTriggerKeyword] = useState(workflow?.trigger.keyword || '')
  const [triggerCron, setTriggerCron] = useState(workflow?.trigger.cron || '')
  const [triggerInterval, setTriggerInterval] = useState(workflow?.trigger.intervalSeconds?.toString() || '3600')
  const [triggerOnceAt, setTriggerOnceAt] = useState(workflow?.trigger.onceAt || '')
  const [triggerEnabled, setTriggerEnabled] = useState(workflow?.trigger.enabled !== false)
  const { onMouseDown } = useDragWindow()

  // 初始化节点和边：优先用 nodes/edges，否则从 steps 转换
  const getInitialGraph = () => {
    if (workflow?.nodes && workflow.nodes.length > 0) {
      return { nodes: workflow.nodes, edges: workflow.edges || [] }
    }
    if (workflow?.steps && workflow.steps.length > 0) {
      return stepsToGraph(workflow.steps)
    }
    // 新建：只有开始和结束节点
    return {
      nodes: [
        { id: '__start__', type: 'start' as const, label: '开始', config: {}, position: { x: 200, y: 50 } },
        { id: '__end__', type: 'end' as const, label: '结束', config: {}, position: { x: 200, y: 250 } },
      ],
      edges: [{ id: 'e-start-end', source: '__start__', target: '__end__' }],
    }
  }

  const initialGraph = useRef(getInitialGraph())
  const currentNodesRef = useRef<WorkflowNode[]>(initialGraph.current.nodes)
  const currentEdgesRef = useRef<WorkflowEdge[]>(initialGraph.current.edges)

  const handleCanvasChange = useCallback((nodes: WorkflowNode[], edges: WorkflowEdge[]) => {
    currentNodesRef.current = nodes
    currentEdgesRef.current = edges
  }, [])

  const buildWorkflowData = (): Omit<Workflow, 'id' | 'builtin' | 'created_at'> => {
    const nodes = currentNodesRef.current
    const edges = currentEdgesRef.current
    const steps = graphToSteps(nodes, edges)

    return {
      name: name.trim(),
      icon,
      description: description.trim(),
      category,
      trigger: {
        type: triggerType as WorkflowTrigger['type'],
        ...(triggerKeyword && { keyword: triggerKeyword }),
        ...(triggerType === 'cron' && { cron: triggerCron, enabled: triggerEnabled }),
        ...(triggerType === 'interval' && { intervalSeconds: parseInt(triggerInterval) || 3600, enabled: triggerEnabled }),
        ...(triggerType === 'once' && { onceAt: triggerOnceAt, enabled: triggerEnabled }),
      },
      steps,
      nodes,
      edges,
    }
  }

  const handleSave = () => {
    if (!name.trim()) return
    const stepNodes = currentNodesRef.current.filter((n) => n.type !== 'start' && n.type !== 'end')
    if (stepNodes.length === 0) return
    onSave(buildWorkflowData())
  }

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* 头部 */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing shrink-0"
        onMouseDown={onMouseDown}
      >
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
            <ArrowLeft className="w-4 h-4" />
          </button>

          {/* 图标 */}
          <input
            type="text"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            className="w-8 text-center bg-[var(--color-bg-secondary)] text-sm rounded-lg px-0.5 py-1 border border-[var(--color-border)] outline-none"
          />

          {/* 名称 */}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="工作流名称"
            className="w-40 bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text)] rounded-lg px-2.5 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50"
          />

          {/* 描述 */}
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述"
            className="w-36 bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text-secondary)] rounded-lg px-2.5 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50"
          />

          {/* 触发方式 */}
          <select
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value)}
            className="bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text)] rounded-lg px-2 py-1.5 border border-[var(--color-border)] outline-none"
          >
            <option value="manual">手动触发</option>
            <option value="keyword">关键词</option>
            <option value="cron">Cron 定时</option>
            <option value="interval">固定间隔</option>
            <option value="once">一次性定时</option>
          </select>
          {triggerType === 'keyword' && (
            <input
              type="text"
              value={triggerKeyword}
              onChange={(e) => setTriggerKeyword(e.target.value)}
              placeholder="关键词"
              className="w-20 bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text)] rounded-lg px-2 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50"
            />
          )}
          {triggerType === 'cron' && (
            <input
              type="text"
              value={triggerCron}
              onChange={(e) => setTriggerCron(e.target.value)}
              placeholder="分 时 日 月 周 (如 0 9 * * 1-5)"
              title="Cron 表达式：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-7, 0和7=周日)"
              className="w-44 bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text)] rounded-lg px-2 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50 font-mono"
            />
          )}
          {triggerType === 'interval' && (
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={triggerInterval}
                onChange={(e) => setTriggerInterval(e.target.value)}
                min="60"
                step="60"
                className="w-16 bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text)] rounded-lg px-2 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50"
              />
              <span className="text-[10px] text-[var(--color-text-secondary)]">秒</span>
            </div>
          )}
          {triggerType === 'once' && (
            <input
              type="datetime-local"
              value={triggerOnceAt ? triggerOnceAt.slice(0, 16) : ''}
              onChange={(e) => setTriggerOnceAt(e.target.value ? new Date(e.target.value).toISOString() : '')}
              className="bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text)] rounded-lg px-2 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50"
            />
          )}
          {(triggerType === 'cron' || triggerType === 'interval' || triggerType === 'once') && (
            <label className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={triggerEnabled}
                onChange={(e) => setTriggerEnabled(e.target.checked)}
                className="rounded w-3 h-3"
              />
              启用
            </label>
          )}

          {/* 分类 */}
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="分类"
            className="w-16 bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text)] rounded-lg px-2 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50"
          />
        </div>

        <div className="flex items-center gap-1.5">
          {onTest && (
            <button
              onClick={() => onTest(buildWorkflowData())}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors"
            >
              <Play className="w-3 h-3" />
              测试
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            <Save className="w-3 h-3" />
            保存
          </button>
        </div>
      </div>

      {/* 画布区域 */}
      <div className="flex-1 overflow-hidden relative">
        <WorkflowCanvas
          initialNodes={initialGraph.current.nodes}
          initialEdges={initialGraph.current.edges}
          onChange={handleCanvasChange}
        />
      </div>
    </div>
  )
}
