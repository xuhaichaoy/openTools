// graph-utils.ts — steps <-> nodes/edges 互转 + 自动布局
import Dagre from '@dagrejs/dagre'
import type { WorkflowStep, WorkflowNode, WorkflowEdge, StepType } from './types'
import { stepTypeInfo } from './types'

// ── steps → graph ──────────────────────────────────────────

/** 将线性 steps 转为 nodes + edges（加载旧数据 / 内置工作流时使用） */
export function stepsToGraph(steps: WorkflowStep[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []

  // 开始节点
  nodes.push({
    id: '__start__',
    type: 'start',
    label: '开始',
    config: {},
    position: { x: 0, y: 0 },
  })

  // 步骤节点
  steps.forEach((step, i) => {
    const info = stepTypeInfo[step.type]
    nodes.push({
      id: step.id,
      type: step.type as StepType,
      label: step.name || info?.label || step.type,
      config: { ...step.config },
      output_var: step.output_var,
      on_error: step.on_error,
      position: { x: 0, y: 0 },
    })
  })

  // 结束节点
  nodes.push({
    id: '__end__',
    type: 'end',
    label: '结束',
    config: {},
    position: { x: 0, y: 0 },
  })

  // 边：start → step[0] → step[1] → ... → end
  const orderedIds = ['__start__', ...steps.map((s) => s.id), '__end__']
  for (let i = 0; i < orderedIds.length - 1; i++) {
    edges.push({
      id: `e-${orderedIds[i]}-${orderedIds[i + 1]}`,
      source: orderedIds[i],
      target: orderedIds[i + 1],
    })
  }

  // 自动布局
  return autoLayout(nodes, edges)
}

// ── graph → steps ──────────────────────────────────────────

/** 将 DAG 拓扑排序后转为 steps（保存时发给后端） */
export function graphToSteps(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowStep[] {
  // 过滤掉 start/end 节点
  const stepNodes = nodes.filter((n) => n.type !== 'start' && n.type !== 'end')

  // 构建邻接表（只考虑 step 节点间的关系）
  const adj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()

  for (const n of stepNodes) {
    adj.set(n.id, [])
    inDegree.set(n.id, 0)
  }

  // 从边中解析关系，跳过 start/end
  for (const edge of edges) {
    const src = edge.source
    const tgt = edge.target

    // 找到实际的 step 节点（跳过 start → 直接算作入度0，end 被忽略）
    if (src === '__start__' || tgt === '__end__') continue
    if (!inDegree.has(src) || !inDegree.has(tgt)) continue

    adj.get(src)!.push(tgt)
    inDegree.set(tgt, (inDegree.get(tgt) || 0) + 1)
  }

  // Kahn 拓扑排序
  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const sorted: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    sorted.push(current)
    for (const neighbor of (adj.get(current) || [])) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    }
  }

  // 转为 WorkflowStep
  const nodeMap = new Map(stepNodes.map((n) => [n.id, n]))
  return sorted
    .map((id) => nodeMap.get(id))
    .filter(Boolean)
    .map((node) => ({
      id: node!.id,
      name: node!.label,
      type: node!.type as StepType,
      config: { ...node!.config },
      output_var: node!.output_var,
      on_error: node!.on_error,
    }))
}

// ── 自动布局 ────────────────────────────────────────────────

/** 用 dagre 自动计算节点位置 */
export function autoLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  direction: 'TB' | 'LR' = 'TB',
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: direction,
    nodesep: 60,
    ranksep: 80,
    marginx: 40,
    marginy: 40,
  })

  const nodeWidth = 200
  const nodeHeight = 60

  for (const node of nodes) {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  Dagre.layout(g)

  const layoutNodes = nodes.map((node) => {
    const pos = g.node(node.id)
    return {
      ...node,
      position: {
        x: pos.x - nodeWidth / 2,
        y: pos.y - nodeHeight / 2,
      },
    }
  })

  return { nodes: layoutNodes, edges }
}

// ── 工具函数 ────────────────────────────────────────────────

let _counter = 0
export function generateNodeId(prefix = 'node') {
  return `${prefix}-${(++_counter).toString(36)}${Date.now().toString(36).slice(-4)}`
}
