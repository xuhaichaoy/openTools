import { useState, useCallback, useRef, useEffect } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeTypes,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { StartNode, EndNode } from './nodes/StartEndNode'
import { StepNode } from './nodes/StepNode'
import { ConditionNode } from './nodes/ConditionNode'
import { NodePalette } from './NodePalette'
import { NodeConfigPanel } from './NodeConfigPanel'

import type { WorkflowNode, WorkflowEdge, StepType } from '@/core/workflows/types'
import { stepTypeInfo } from '@/core/workflows/types'
import { generateNodeId, autoLayout } from '@/core/workflows/graph-utils'

// ── React Flow 节点类型映射 ──

const nodeTypes: NodeTypes = {
  start: StartNode,
  end: EndNode,
  // 所有 step 类型都用 StepNode
  ai_chat: StepNode,
  script: StepNode,
  transform: StepNode,
  http: StepNode,
  clipboard_read: StepNode,
  clipboard_write: StepNode,
  file_read: StepNode,
  file_write: StepNode,
  user_input: StepNode,
  notification: StepNode,
  condition: ConditionNode,
}

// ── 数据转换：WorkflowNode/Edge <-> React Flow Node/Edge ──

function toRFNodes(wfNodes: WorkflowNode[]): RFNode[] {
  return wfNodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: {
      label: n.label,
      stepType: n.type,
      output_var: n.output_var,
      configSummary: getConfigSummary(n),
    },
    selected: false,
  }))
}

function toRFEdges(wfEdges: WorkflowEdge[]): RFEdge[] {
  return wfEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    type: 'smoothstep',
    animated: false,
    style: { stroke: 'var(--color-border)', strokeWidth: 2 },
  }))
}

function fromRFNodes(rfNodes: RFNode[], wfNodesMap: Map<string, WorkflowNode>): WorkflowNode[] {
  return rfNodes.map((rfn) => {
    const existing = wfNodesMap.get(rfn.id)
    return {
      id: rfn.id,
      type: (rfn.type || 'ai_chat') as WorkflowNode['type'],
      label: (rfn.data as { label?: string })?.label || existing?.label || '',
      config: existing?.config || {},
      output_var: existing?.output_var,
      on_error: existing?.on_error,
      position: rfn.position,
    }
  })
}

function fromRFEdges(rfEdges: RFEdge[]): WorkflowEdge[] {
  return rfEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle || undefined,
  }))
}

function getConfigSummary(node: WorkflowNode): string {
  const c = node.config
  switch (node.type) {
    case 'ai_chat': return (c.prompt as string)?.slice(0, 30) || ''
    case 'script': return `${(c.type as string) || 'shell'}: ${((c.script as string) || '').slice(0, 20)}`
    case 'http': return `${(c.method as string) || 'GET'} ${((c.url as string) || '').slice(0, 25)}`
    case 'condition': return (c.expression as string)?.slice(0, 30) || ''
    case 'notification': return (c.message as string)?.slice(0, 30) || ''
    case 'clipboard_write': return (c.text as string)?.slice(0, 30) || ''
    case 'file_read':
    case 'file_write': return (c.path as string)?.slice(0, 30) || ''
    default: return ''
  }
}

// ── 默认配置 ──

const defaultStepConfig: Record<string, Record<string, unknown>> = {
  ai_chat: { prompt: '', system_prompt: '', temperature: 0.7 },
  script: { type: 'shell', script: '' },
  transform: { type: 'template', input: '{{prev.output}}', template: '' },
  http: { method: 'GET', url: '' },
  clipboard_read: {},
  clipboard_write: { text: '{{prev.output}}' },
  file_read: { path: '' },
  file_write: { path: '', content: '{{prev.output}}' },
  user_input: { variable: 'input' },
  notification: { message: '' },
  condition: { expression: '' },
  start: {},
  end: {},
}

// ── 主画布组件 ──

interface WorkflowCanvasProps {
  initialNodes: WorkflowNode[]
  initialEdges: WorkflowEdge[]
  onChange: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void
}

function CanvasInner({ initialNodes, initialEdges, onChange }: WorkflowCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition } = useReactFlow()

  // 内部维护的 WorkflowNode 数据（config 等）
  const wfNodesRef = useRef(new Map<string, WorkflowNode>(initialNodes.map((n) => [n.id, n])))

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(toRFNodes(initialNodes))
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(toRFEdges(initialEdges))

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const selectedWfNode = selectedNodeId ? wfNodesRef.current.get(selectedNodeId) || null : null

  // 稳定引用 onChange，避免 useEffect 无限循环
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // 跳过首次渲染的标记
  const isInitialMount = useRef(true)

  // 自动同步：rfNodes/rfEdges 变化时通知父组件
  // 这里用 useEffect 保证读到的一定是最新的 state，彻底避免闭包旧值问题
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      return
    }
    const nodes = fromRFNodes(rfNodes, wfNodesRef.current)
    const edges = fromRFEdges(rfEdges)
    // 同步位置回 wfNodesRef
    for (const n of nodes) {
      const existing = wfNodesRef.current.get(n.id)
      if (existing) {
        existing.position = n.position
      }
    }
    onChangeRef.current(
      Array.from(wfNodesRef.current.values()).map((n) => ({
        ...n,
        position: nodes.find((rn) => rn.id === n.id)?.position || n.position,
      })),
      edges,
    )
  }, [rfNodes, rfEdges])

  // 连线
  const onConnect = useCallback(
    (connection: Connection) => {
      setRfEdges((eds) => addEdge({ ...connection, type: 'smoothstep', style: { stroke: 'var(--color-border)', strokeWidth: 2 } }, eds))
    },
    [setRfEdges],
  )

  // 选中节点
  const onNodeClick = useCallback((_: React.MouseEvent, node: RFNode) => {
    if (node.type === 'start' || node.type === 'end') {
      setSelectedNodeId(null)
      return
    }
    setSelectedNodeId(node.id)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null)
  }, [])

  // 添加节点（从面板点击或拖拽）
  const addNode = useCallback(
    (type: StepType, position?: { x: number; y: number }) => {
      const info = stepTypeInfo[type]
      const id = generateNodeId(type)
      const pos = position || { x: 250, y: rfNodes.length * 100 }

      const wfNode: WorkflowNode = {
        id,
        type,
        label: info.label,
        config: { ...defaultStepConfig[type] },
        output_var: ['ai_chat', 'script', 'http', 'clipboard_read', 'file_read', 'transform'].includes(type)
          ? `var_${id.slice(-4)}`
          : undefined,
        position: pos,
      }

      wfNodesRef.current.set(id, wfNode)

      setRfNodes((nds) => [
        ...nds,
        {
          id,
          type,
          position: pos,
          data: {
            label: wfNode.label,
            stepType: type,
            output_var: wfNode.output_var,
            configSummary: '',
          },
        },
      ])

      setSelectedNodeId(id)
    },
    [rfNodes, setRfNodes],
  )

  // 拖拽放置
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('application/workflow-node-type') as StepType
      if (!type) return

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      addNode(type, position)
    },
    [addNode, screenToFlowPosition],
  )

  // 删除选中节点 (keyboard)
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // 在输入框/文本域中按键时不要误删节点
      const tag = (event.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNodeId) {
        if (selectedNodeId === '__start__' || selectedNodeId === '__end__') return
        wfNodesRef.current.delete(selectedNodeId)
        setRfNodes((nds) => nds.filter((n) => n.id !== selectedNodeId))
        setRfEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId))
        setSelectedNodeId(null)
      }
    },
    [selectedNodeId, setRfNodes, setRfEdges],
  )

  // 更新选中节点的配置
  const updateSelectedNode = useCallback(
    (updates: Partial<WorkflowNode>) => {
      if (!selectedNodeId) return
      const existing = wfNodesRef.current.get(selectedNodeId)
      if (!existing) return

      const updated = { ...existing, ...updates }
      wfNodesRef.current.set(selectedNodeId, updated)

      // 同步到 React Flow 节点的 data
      setRfNodes((nds) =>
        nds.map((n) =>
          n.id === selectedNodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  label: updated.label,
                  output_var: updated.output_var,
                  configSummary: getConfigSummary(updated),
                },
              }
            : n,
        ),
      )
    },
    [selectedNodeId, setRfNodes],
  )

  // 自动布局
  const doAutoLayout = useCallback(() => {
    const currentWfNodes = Array.from(wfNodesRef.current.values())
    const currentWfEdges = fromRFEdges(rfEdges)
    const { nodes: layoutNodes } = autoLayout(currentWfNodes, currentWfEdges)

    for (const n of layoutNodes) {
      const existing = wfNodesRef.current.get(n.id)
      if (existing) existing.position = n.position
    }

    setRfNodes(toRFNodes(layoutNodes))
  }, [rfEdges, setRfNodes])

  return (
    <div className="flex flex-1 h-full overflow-hidden" onKeyDown={onKeyDown} tabIndex={0}>
      {/* 左侧节点面板 */}
      <NodePalette onAddNode={addNode} />

      {/* 中间画布 */}
      <div ref={reactFlowWrapper} className="flex-1 h-full" onDragOver={onDragOver} onDrop={onDrop}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          snapToGrid
          snapGrid={[10, 10]}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          className="workflow-canvas"
        >
          <Background gap={20} size={1} color="var(--color-border)" style={{ opacity: 0.3 }} />
          <Controls showInteractive={false} className="!bg-[var(--color-bg)] !border-[var(--color-border)] !shadow-lg [&>button]:!bg-[var(--color-bg)] [&>button]:!border-[var(--color-border)] [&>button]:!text-[var(--color-text-secondary)] [&>button:hover]:!bg-[var(--color-bg-hover)]" />
          <MiniMap
            nodeStrokeWidth={3}
            className="!bg-[var(--color-bg-secondary)] !border-[var(--color-border)]"
            maskColor="rgba(0,0,0,0.15)"
          />
        </ReactFlow>

        {/* 自动布局按钮 */}
        <button
          onClick={doAutoLayout}
          className="absolute bottom-3 left-[152px] z-10 px-2.5 py-1 text-[10px] rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] shadow-sm transition-colors"
        >
          自动排列
        </button>
      </div>

      {/* 右侧配置面板 */}
      {selectedWfNode && (
        <NodeConfigPanel
          node={selectedWfNode}
          onUpdate={updateSelectedNode}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  )
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
