import { JsonCollection } from "@/core/database/index";

export interface MemoryGraphNode {
  id: string;
  label: string;
  type: "entity" | "concept" | "memory";
  memoryId?: string;
  properties: Record<string, string>;
  created_at: number;
}

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
  created_at: number;
}

export interface MemoryGraph {
  id: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  updated_at: number;
}

const graphDb = new JsonCollection<MemoryGraph>("memory_graph");

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadGraph(): Promise<MemoryGraph> {
  const all = await graphDb.getAll();
  if (all.length > 0) return all[0];
  return { id: "memory-graph", nodes: [], edges: [], updated_at: Date.now() };
}

export async function saveGraph(graph: MemoryGraph): Promise<void> {
  graph.id = graph.id || "memory-graph";
  graph.updated_at = Date.now();
  await graphDb.setAll([graph]);
}

export async function addEntity(
  label: string,
  type: MemoryGraphNode["type"] = "entity",
  properties: Record<string, string> = {},
  memoryId?: string,
): Promise<MemoryGraphNode> {
  const graph = await loadGraph();

  const existing = graph.nodes.find(
    (n) => n.label.toLowerCase() === label.toLowerCase() && n.type === type,
  );
  if (existing) {
    existing.properties = { ...existing.properties, ...properties };
    if (memoryId) existing.memoryId = memoryId;
    await saveGraph(graph);
    return existing;
  }

  const node: MemoryGraphNode = {
    id: createId("gn"),
    label,
    type,
    memoryId,
    properties,
    created_at: Date.now(),
  };
  graph.nodes.push(node);
  await saveGraph(graph);
  return node;
}

export async function addRelation(
  sourceId: string,
  targetId: string,
  relation: string,
  weight: number = 1,
): Promise<MemoryGraphEdge> {
  const graph = await loadGraph();

  const existing = graph.edges.find(
    (e) => e.source === sourceId && e.target === targetId && e.relation === relation,
  );
  if (existing) {
    existing.weight += weight;
    await saveGraph(graph);
    return existing;
  }

  const edge: MemoryGraphEdge = {
    id: createId("ge"),
    source: sourceId,
    target: targetId,
    relation,
    weight,
    created_at: Date.now(),
  };
  graph.edges.push(edge);
  await saveGraph(graph);
  return edge;
}

export async function queryRelatedNodes(
  entityLabel: string,
  maxDepth: number = 2,
): Promise<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }> {
  const graph = await loadGraph();
  const startNodes = graph.nodes.filter(
    (n) => n.label.toLowerCase().includes(entityLabel.toLowerCase()),
  );

  if (startNodes.length === 0) return { nodes: [], edges: [] };

  const visitedIds = new Set<string>();
  const resultNodes: MemoryGraphNode[] = [];
  const resultEdges: MemoryGraphEdge[] = [];
  const queue: Array<{ nodeId: string; depth: number }> = [];

  for (const n of startNodes) {
    visitedIds.add(n.id);
    resultNodes.push(n);
    queue.push({ nodeId: n.id, depth: 0 });
  }

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const connected = graph.edges.filter(
      (e) => e.source === nodeId || e.target === nodeId,
    );

    for (const edge of connected) {
      resultEdges.push(edge);
      const neighborId = edge.source === nodeId ? edge.target : edge.source;
      if (!visitedIds.has(neighborId)) {
        visitedIds.add(neighborId);
        const neighbor = graph.nodes.find((n) => n.id === neighborId);
        if (neighbor) {
          resultNodes.push(neighbor);
          queue.push({ nodeId: neighborId, depth: depth + 1 });
        }
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges };
}

export async function extractEntitiesFromText(
  text: string,
  memoryId?: string,
): Promise<MemoryGraphNode[]> {
  // Simple entity extraction using regex patterns
  const entities: Array<{ label: string; type: MemoryGraphNode["type"] }> = [];

  // Extract quoted terms
  const quoted = text.match(/「([^」]+)」|"([^"]+)"|'([^']+)'/g);
  if (quoted) {
    for (const q of quoted) {
      const clean = q.replace(/[「」""'']/g, "");
      if (clean.length >= 2 && clean.length <= 50) {
        entities.push({ label: clean, type: "entity" });
      }
    }
  }

  // Extract CamelCase/PascalCase identifiers
  const camelCase = text.match(/\b[A-Z][a-zA-Z]{2,30}\b/g);
  if (camelCase) {
    for (const c of camelCase) {
      entities.push({ label: c, type: "concept" });
    }
  }

  // Extract Chinese key terms (nouns following common patterns)
  const cnTerms = text.match(/([\u4e00-\u9fa5]{2,8}(?:工具|模块|服务|系统|插件|功能|组件|接口|方法|模型|数据|配置))/g);
  if (cnTerms) {
    for (const t of cnTerms) {
      entities.push({ label: t, type: "concept" });
    }
  }

  const nodes: MemoryGraphNode[] = [];
  for (const entity of entities.slice(0, 10)) {
    const node = await addEntity(entity.label, entity.type, {}, memoryId);
    nodes.push(node);
  }

  return nodes;
}

export async function getGraphStats(): Promise<{
  nodeCount: number;
  edgeCount: number;
  topEntities: Array<{ label: string; connections: number }>;
}> {
  const graph = await loadGraph();
  const connectionCount = new Map<string, number>();

  for (const edge of graph.edges) {
    connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1);
    connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1);
  }

  const topEntities = graph.nodes
    .map((n) => ({
      label: n.label,
      connections: connectionCount.get(n.id) || 0,
    }))
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 10);

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    topEntities,
  };
}
