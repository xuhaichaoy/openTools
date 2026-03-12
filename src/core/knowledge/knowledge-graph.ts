/**
 * KnowledgeGraph — 知识图谱引擎与可视化数据模型
 *
 * 灵感来源：
 * - Yuxi-Know 的 LightRAG 知识图谱 + G6/Sigma/D3 可视化
 * - 支持 content / graph / both 三种检索模式
 *
 * 核心能力：
 * 1. 实体-关系三元组管理
 * 2. 图遍历与子图查询
 * 3. 从 Memory/文档自动构建图谱
 * 4. 输出 G6/D3 兼容的可视化数据
 * 5. 与 RAG 结合的混合检索
 */

export interface GraphEntity {
  id: string;
  name: string;
  type: EntityType;
  properties: Record<string, unknown>;
  /** Source document or memory ID */
  sourceId?: string;
  createdAt: number;
}

export type EntityType =
  | "person" | "organization" | "project" | "technology"
  | "concept" | "tool" | "file" | "agent" | "memory"
  | "document" | "custom";

export interface GraphRelation {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationType;
  label: string;
  weight: number;
  properties?: Record<string, unknown>;
  createdAt: number;
}

export type RelationType =
  | "uses" | "depends_on" | "related_to" | "contains"
  | "part_of" | "created_by" | "collaborates_with"
  | "spawned" | "communicates_with" | "references"
  | "custom";

/** G6/D3 compatible visualization data */
export interface GraphVisualizationData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: EntityType;
  size: number;
  color: string;
  properties?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  weight: number;
  type: RelationType;
}

export type RetrievalMode = "content" | "graph" | "both";

const ENTITY_COLORS: Record<EntityType, string> = {
  person: "#4F46E5",
  organization: "#7C3AED",
  project: "#2563EB",
  technology: "#059669",
  concept: "#D97706",
  tool: "#DC2626",
  file: "#6B7280",
  agent: "#EC4899",
  memory: "#8B5CF6",
  document: "#0891B2",
  custom: "#6B7280",
};

const ENTITY_SIZES: Record<EntityType, number> = {
  person: 40,
  organization: 50,
  project: 45,
  technology: 35,
  concept: 30,
  tool: 30,
  file: 25,
  agent: 45,
  memory: 30,
  document: 35,
  custom: 30,
};

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class KnowledgeGraph {
  private entities = new Map<string, GraphEntity>();
  private relations: GraphRelation[] = [];

  // ── Entity Management ──

  addEntity(name: string, type: EntityType, properties: Record<string, unknown> = {}, sourceId?: string): GraphEntity {
    // Dedup by name + type
    const existing = [...this.entities.values()].find(
      (e) => e.name.toLowerCase() === name.toLowerCase() && e.type === type,
    );
    if (existing) {
      existing.properties = { ...existing.properties, ...properties };
      return existing;
    }

    const entity: GraphEntity = {
      id: `entity-${generateId()}`,
      name,
      type,
      properties,
      sourceId,
      createdAt: Date.now(),
    };
    this.entities.set(entity.id, entity);
    return entity;
  }

  getEntity(id: string): GraphEntity | undefined {
    return this.entities.get(id);
  }

  findEntitiesByName(name: string): GraphEntity[] {
    const lower = name.toLowerCase();
    return [...this.entities.values()].filter((e) => e.name.toLowerCase().includes(lower));
  }

  findEntitiesByType(type: EntityType): GraphEntity[] {
    return [...this.entities.values()].filter((e) => e.type === type);
  }

  // ── Relation Management ──

  addRelation(sourceId: string, targetId: string, type: RelationType, label: string, weight = 1.0): GraphRelation {
    // Dedup
    const existing = this.relations.find(
      (r) => r.sourceId === sourceId && r.targetId === targetId && r.type === type,
    );
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      return existing;
    }

    const relation: GraphRelation = {
      id: `rel-${generateId()}`,
      sourceId,
      targetId,
      type,
      label,
      weight,
      createdAt: Date.now(),
    };
    this.relations.push(relation);
    return relation;
  }

  getRelationsFor(entityId: string): GraphRelation[] {
    return this.relations.filter((r) => r.sourceId === entityId || r.targetId === entityId);
  }

  getNeighbors(entityId: string, depth = 1): Set<string> {
    const visited = new Set<string>();
    const queue: Array<{ id: string; d: number }> = [{ id: entityId, d: 0 }];

    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      if (d < depth) {
        const relations = this.getRelationsFor(id);
        for (const rel of relations) {
          const neighborId = rel.sourceId === id ? rel.targetId : rel.sourceId;
          if (!visited.has(neighborId)) {
            queue.push({ id: neighborId, d: d + 1 });
          }
        }
      }
    }

    return visited;
  }

  // ── Subgraph Extraction ──

  getSubgraph(entityIds: Set<string>): { entities: GraphEntity[]; relations: GraphRelation[] } {
    const entities = [...entityIds]
      .map((id) => this.entities.get(id))
      .filter(Boolean) as GraphEntity[];

    const relations = this.relations.filter(
      (r) => entityIds.has(r.sourceId) && entityIds.has(r.targetId),
    );

    return { entities, relations };
  }

  // ── Visualization Data (G6/D3 compatible) ──

  toVisualizationData(entityFilter?: (e: GraphEntity) => boolean): GraphVisualizationData {
    const filteredEntities = entityFilter
      ? [...this.entities.values()].filter(entityFilter)
      : [...this.entities.values()];

    const entityIds = new Set(filteredEntities.map((e) => e.id));

    const nodes: GraphNode[] = filteredEntities.map((e) => ({
      id: e.id,
      label: e.name,
      type: e.type,
      size: ENTITY_SIZES[e.type] ?? 30,
      color: ENTITY_COLORS[e.type] ?? "#6B7280",
      properties: e.properties,
    }));

    const edges: GraphEdge[] = this.relations
      .filter((r) => entityIds.has(r.sourceId) && entityIds.has(r.targetId))
      .map((r) => ({
        id: r.id,
        source: r.sourceId,
        target: r.targetId,
        label: r.label,
        weight: r.weight,
        type: r.type,
      }));

    return { nodes, edges };
  }

  /** Generate visualization for the Agent actor topology */
  static fromActorSystem(
    actors: Array<{ id: string; name: string; status: string; capabilities?: string[] }>,
    spawnedTasks: Array<{ spawner: string; target: string; label: string; status: string }>,
    dialogHistory: Array<{ from: string; to?: string }>,
  ): GraphVisualizationData {
    const nodes: GraphNode[] = actors.map((a) => ({
      id: a.id,
      label: a.name,
      type: "agent" as EntityType,
      size: 45,
      color: a.status === "running" ? "#22C55E" : a.status === "idle" ? "#4F46E5" : "#6B7280",
      properties: { status: a.status, capabilities: a.capabilities },
    }));

    // Add user node
    nodes.push({
      id: "user",
      label: "用户",
      type: "person",
      size: 50,
      color: "#F59E0B",
    });

    const edges: GraphEdge[] = [];

    // Spawn edges
    for (const task of spawnedTasks) {
      edges.push({
        id: `spawn-${task.spawner}-${task.target}`,
        source: task.spawner,
        target: task.target,
        label: task.label || "子任务",
        weight: task.status === "running" ? 2 : 1,
        type: "spawned",
      });
    }

    // Communication edges (aggregate from dialog history)
    const commCount = new Map<string, number>();
    for (const msg of dialogHistory) {
      if (!msg.to) continue;
      const key = `${msg.from}->${msg.to}`;
      commCount.set(key, (commCount.get(key) ?? 0) + 1);
    }
    for (const [key, count] of commCount) {
      const [from, to] = key.split("->");
      if (!nodes.find((n) => n.id === from) || !nodes.find((n) => n.id === to)) continue;
      edges.push({
        id: `comm-${key}`,
        source: from,
        target: to,
        label: `${count} 条消息`,
        weight: Math.min(count / 5, 3),
        type: "communicates_with",
      });
    }

    return { nodes, edges };
  }

  // ── Auto-build from Memory ──

  async buildFromMemories(
    memories: Array<{ id: string; content: string; kind: string; tags: string[] }>,
  ): Promise<{ entities: number; relations: number }> {
    let entityCount = 0;
    let relationCount = 0;

    for (const mem of memories) {
      // Create memory entity
      const memEntity = this.addEntity(
        mem.content.slice(0, 60),
        "memory",
        { kind: mem.kind, fullContent: mem.content },
        mem.id,
      );
      entityCount++;

      // Extract entities from memory content via simple NER heuristics
      const techMatches = mem.content.match(/(?:React|Vue|Python|Rust|TypeScript|JavaScript|Node\.js|Docker|Kubernetes|PostgreSQL|MongoDB|Redis|Git|Tauri|FastAPI|LangChain|Next\.js|Vite)\b/gi);
      if (techMatches) {
        for (const tech of new Set(techMatches.map((t) => t.toLowerCase()))) {
          const techEntity = this.addEntity(tech, "technology");
          this.addRelation(memEntity.id, techEntity.id, "references", "涉及");
          entityCount++;
          relationCount++;
        }
      }

      // Link by tags
      for (const tag of mem.tags) {
        const tagEntity = this.addEntity(tag, "concept");
        this.addRelation(memEntity.id, tagEntity.id, "related_to", "标签");
        entityCount++;
        relationCount++;
      }
    }

    return { entities: entityCount, relations: relationCount };
  }

  // ── Stats ──

  get stats(): { entities: number; relations: number; types: Record<string, number> } {
    const types: Record<string, number> = {};
    for (const e of this.entities.values()) {
      types[e.type] = (types[e.type] ?? 0) + 1;
    }
    return {
      entities: this.entities.size,
      relations: this.relations.length,
      types,
    };
  }

  clear(): void {
    this.entities.clear();
    this.relations.length = 0;
  }
}

// ── Singleton ──
export const globalKnowledgeGraph = new KnowledgeGraph();
