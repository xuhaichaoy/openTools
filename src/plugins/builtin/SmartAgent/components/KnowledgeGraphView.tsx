/**
 * KnowledgeGraphView — 知识图谱力导向可视化组件
 *
 * 灵感来源：Yuxi-Know 的 G6/Sigma/D3 知识图谱可视化
 *
 * 基于 Canvas 2D 实现力导向布局（无外部依赖），支持：
 * 1. 节点拖拽
 * 2. 缩放平移
 * 3. 节点悬停高亮
 * 4. 实体类型筛选
 * 5. 搜索定位
 * 6. 自适应标签显示
 */

import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import {
  Search,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Filter,
  RefreshCw,
} from "lucide-react";
import type {
  GraphVisualizationData,
  GraphNode,
  GraphEdge,
  EntityType,
} from "@/core/knowledge/knowledge-graph";

// ── Force Simulation ──

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
}

interface SimState {
  nodes: SimNode[];
  edges: GraphEdge[];
  alpha: number;
}

function initSimulation(data: GraphVisualizationData, width: number, height: number): SimState {
  const nodes: SimNode[] = data.nodes.map((n, i) => ({
    ...n,
    x: width / 2 + (Math.random() - 0.5) * width * 0.6,
    y: height / 2 + (Math.random() - 0.5) * height * 0.6,
    vx: 0,
    vy: 0,
  }));

  return { nodes, edges: data.edges, alpha: 1.0 };
}

function tickSimulation(state: SimState, width: number, height: number): void {
  const { nodes, edges } = state;
  if (state.alpha < 0.001) return;

  state.alpha *= 0.995;

  // Center gravity
  const cx = width / 2;
  const cy = height / 2;

  for (const n of nodes) {
    if (n.fx != null) { n.x = n.fx; n.y = n.fy!; n.vx = 0; n.vy = 0; continue; }
    n.vx += (cx - n.x) * 0.001;
    n.vy += (cy - n.y) * 0.001;
  }

  // Repulsion (Barnes-Hut simplified: pairwise for small graphs)
  const repulsion = 800;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = repulsion / (dist * dist);
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      if (a.fx == null) { a.vx -= dx; a.vy -= dy; }
      if (b.fx == null) { b.vx += dx; b.vy += dy; }
    }
  }

  // Attraction (springs)
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const spring = 0.05;
  const idealLength = 120;
  for (const edge of edges) {
    const a = nodeMap.get(edge.source);
    const b = nodeMap.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (dist - idealLength) * spring;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (a.fx == null) { a.vx += fx; a.vy += fy; }
    if (b.fx == null) { b.vx -= fx; b.vy -= fy; }
  }

  // Velocity damping and position update
  const damping = 0.6;
  for (const n of nodes) {
    if (n.fx != null) continue;
    n.vx *= damping;
    n.vy *= damping;
    n.x += n.vx;
    n.y += n.vy;
    // Boundary
    n.x = Math.max(20, Math.min(width - 20, n.x));
    n.y = Math.max(20, Math.min(height - 20, n.y));
  }
}

// ── Rendering ──

function renderGraph(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  width: number,
  height: number,
  transform: { x: number; y: number; scale: number },
  hoveredNodeId: string | null,
  highlightedIds: Set<string>,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.scale, transform.scale);

  const { nodes, edges } = state;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Edges
  for (const edge of edges) {
    const a = nodeMap.get(edge.source);
    const b = nodeMap.get(edge.target);
    if (!a || !b) continue;

    const isHighlighted = highlightedIds.has(edge.source) && highlightedIds.has(edge.target);
    const alpha = isHighlighted ? 0.8 : (hoveredNodeId ? 0.15 : 0.4);

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = isHighlighted ? "#3B82F6" : "#9CA3AF";
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(0.5, edge.weight * 0.8);
    ctx.stroke();

    // Edge label
    if (transform.scale > 0.6 && (isHighlighted || !hoveredNodeId)) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.globalAlpha = isHighlighted ? 0.9 : 0.5;
      ctx.font = `${10 / transform.scale}px system-ui`;
      ctx.fillStyle = "#9CA3AF";
      ctx.textAlign = "center";
      ctx.fillText(edge.label, mx, my - 4);
    }
  }

  ctx.globalAlpha = 1;

  // Nodes
  for (const node of nodes) {
    const isHovered = node.id === hoveredNodeId;
    const isHighlighted = highlightedIds.has(node.id);
    const dimmed = hoveredNodeId && !isHighlighted && !isHovered;

    const radius = (node.size / 2) * (isHovered ? 1.3 : 1);

    // Glow for hovered
    if (isHovered) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 6, 0, Math.PI * 2);
      ctx.fillStyle = node.color + "33";
      ctx.fill();
    }

    // Circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = dimmed ? node.color + "44" : node.color;
    ctx.globalAlpha = dimmed ? 0.4 : 1;
    ctx.fill();

    // Border
    ctx.strokeStyle = isHovered ? "#FFFFFF" : node.color + "88";
    ctx.lineWidth = isHovered ? 2.5 : 1;
    ctx.stroke();

    // Label
    if (transform.scale > 0.4 || isHovered || isHighlighted) {
      ctx.globalAlpha = dimmed ? 0.3 : 1;
      const fontSize = Math.max(10, 12 / transform.scale);
      ctx.font = `${isHovered ? "bold " : ""}${fontSize}px system-ui`;
      ctx.textAlign = "center";
      ctx.fillStyle = dimmed ? "#6B7280" : "#E5E7EB";
      ctx.fillText(
        node.label.length > 12 ? node.label.slice(0, 11) + "…" : node.label,
        node.x,
        node.y + radius + fontSize + 2,
      );
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Component ──

const TYPE_LABELS: Partial<Record<EntityType, string>> = {
  person: "人物",
  organization: "组织",
  project: "项目",
  technology: "技术",
  concept: "概念",
  tool: "工具",
  file: "文件",
  agent: "Agent",
  memory: "记忆",
  document: "文档",
};

interface KnowledgeGraphViewProps {
  data: GraphVisualizationData;
  className?: string;
  onNodeClick?: (nodeId: string) => void;
}

const KnowledgeGraphView: React.FC<KnowledgeGraphViewProps> = ({
  data,
  className = "",
  onNodeClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<SimState | null>(null);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);
  const animRef = useRef<number>(0);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<Set<EntityType>>(new Set());
  const [showFilter, setShowFilter] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Filter data
  const filteredData = useMemo((): GraphVisualizationData => {
    if (typeFilter.size === 0 && !search) return data;
    let nodes = data.nodes;
    if (typeFilter.size > 0) {
      nodes = nodes.filter((n) => typeFilter.has(n.type));
    }
    if (search) {
      const q = search.toLowerCase();
      nodes = nodes.filter((n) => n.label.toLowerCase().includes(q));
    }
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
    return { nodes, edges };
  }, [data, typeFilter, search]);

  // Available types
  const availableTypes = useMemo(() => {
    const types = new Set<EntityType>();
    for (const n of data.nodes) types.add(n.type);
    return [...types].sort();
  }, [data]);

  // Initialize simulation
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * window.devicePixelRatio;
    canvas.height = h * window.devicePixelRatio;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    simRef.current = initSimulation(filteredData, w, h);
    transformRef.current = { x: 0, y: 0, scale: 1 };

    const animate = () => {
      if (!simRef.current) return;
      tickSimulation(simRef.current, w, h);

      const highlightedIds = new Set<string>();
      if (hoveredRef.current) {
        highlightedIds.add(hoveredRef.current);
        for (const e of simRef.current.edges) {
          if (e.source === hoveredRef.current) highlightedIds.add(e.target);
          if (e.target === hoveredRef.current) highlightedIds.add(e.source);
        }
      }

      renderGraph(ctx, simRef.current, w, h, transformRef.current, hoveredRef.current, highlightedIds);
      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [filteredData]);

  // Hit test
  const hitTest = useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current;
    if (!canvas || !simRef.current) return null;
    const rect = canvas.getBoundingClientRect();
    const t = transformRef.current;
    const x = (clientX - rect.left - t.x) / t.scale;
    const y = (clientY - rect.top - t.y) / t.scale;

    for (let i = simRef.current.nodes.length - 1; i >= 0; i--) {
      const n = simRef.current.nodes[i];
      const r = n.size / 2;
      if ((x - n.x) ** 2 + (y - n.y) ** 2 <= (r + 5) ** 2) {
        return n;
      }
    }
    return null;
  }, []);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const node = hitTest(e.clientX, e.clientY);
    if (node) {
      const t = transformRef.current;
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      dragRef.current = {
        nodeId: node.id,
        offsetX: (e.clientX - rect.left - t.x) / t.scale - node.x,
        offsetY: (e.clientY - rect.top - t.y) / t.scale - node.y,
      };
      node.fx = node.x;
      node.fy = node.y;
    } else {
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        tx: transformRef.current.x,
        ty: transformRef.current.y,
      };
    }
  }, [hitTest]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current && simRef.current) {
      const t = transformRef.current;
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - t.x) / t.scale - dragRef.current.offsetX;
      const y = (e.clientY - rect.top - t.y) / t.scale - dragRef.current.offsetY;
      const node = simRef.current.nodes.find((n) => n.id === dragRef.current!.nodeId);
      if (node) {
        node.fx = x;
        node.fy = y;
        simRef.current.alpha = 0.3;
      }
      return;
    }

    if (panRef.current) {
      transformRef.current.x = panRef.current.tx + (e.clientX - panRef.current.startX);
      transformRef.current.y = panRef.current.ty + (e.clientY - panRef.current.startY);
      return;
    }

    const node = hitTest(e.clientX, e.clientY);
    const newId = node?.id ?? null;
    if (newId !== hoveredRef.current) {
      hoveredRef.current = newId;
      setHoveredNodeId(newId);
    }
  }, [hitTest]);

  const handleMouseUp = useCallback(() => {
    if (dragRef.current && simRef.current) {
      const node = simRef.current.nodes.find((n) => n.id === dragRef.current!.nodeId);
      if (node) {
        node.fx = undefined;
        node.fy = undefined;
        simRef.current.alpha = 0.3;
      }
    }
    dragRef.current = null;
    panRef.current = null;
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const node = hitTest(e.clientX, e.clientY);
    if (node && onNodeClick) onNodeClick(node.id);
  }, [hitTest, onNodeClick]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const t = transformRef.current;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.min(5, Math.max(0.1, t.scale * factor));

    t.x = mouseX - (mouseX - t.x) * (newScale / t.scale);
    t.y = mouseY - (mouseY - t.y) * (newScale / t.scale);
    t.scale = newScale;
  }, []);

  const resetView = useCallback(() => {
    transformRef.current = { x: 0, y: 0, scale: 1 };
    if (simRef.current) simRef.current.alpha = 1;
  }, []);

  const zoomIn = useCallback(() => {
    transformRef.current.scale = Math.min(5, transformRef.current.scale * 1.3);
  }, []);

  const zoomOut = useCallback(() => {
    transformRef.current.scale = Math.max(0.1, transformRef.current.scale * 0.7);
  }, []);

  const toggleType = useCallback((type: EntityType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, []);

  return (
    <div className={`flex flex-col bg-[var(--color-bg)] rounded-lg overflow-hidden ${className}`} ref={containerRef}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-1 flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-[var(--color-text-secondary)] shrink-0" />
          <input
            type="text"
            placeholder="搜索节点…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-0 text-xs bg-transparent border-none outline-none text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]"
          />
        </div>

        <div className="flex items-center gap-0.5">
          <button onClick={() => setShowFilter(!showFilter)} className={`p-1 rounded transition-colors ${showFilter ? "bg-blue-500/10 text-blue-500" : "hover:bg-[var(--color-bg-tertiary)]"}`} title="筛选">
            <Filter className="w-3.5 h-3.5" />
          </button>
          <button onClick={zoomIn} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] transition-colors" title="放大">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button onClick={zoomOut} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] transition-colors" title="缩小">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button onClick={resetView} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] transition-colors" title="重置视图">
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Type filter */}
      {showFilter && (
        <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-[var(--color-border)]">
          {availableTypes.map((type) => (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                typeFilter.size === 0 || typeFilter.has(type)
                  ? "bg-blue-500/20 text-blue-400 font-medium"
                  : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
              }`}
            >
              {TYPE_LABELS[type] ?? type}
            </button>
          ))}
          {typeFilter.size > 0 && (
            <button
              onClick={() => setTypeFilter(new Set())}
              className="text-[10px] px-2 py-0.5 rounded-full text-red-400 hover:bg-red-500/10"
            >
              清除筛选
            </button>
          )}
        </div>
      )}

      {/* Canvas */}
      <div className="flex-1 relative" style={{ minHeight: 300 }}>
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
          onWheel={handleWheel}
        />

        {/* Node tooltip */}
        {hoveredNodeId && simRef.current && (() => {
          const node = simRef.current.nodes.find((n) => n.id === hoveredNodeId);
          if (!node) return null;
          const t = transformRef.current;
          const x = node.x * t.scale + t.x;
          const y = node.y * t.scale + t.y;
          return (
            <div
              className="absolute pointer-events-none bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg px-3 py-2 text-xs z-10"
              style={{ left: x + 20, top: y - 10, maxWidth: 200 }}
            >
              <div className="font-semibold">{node.label}</div>
              <div className="text-[var(--color-text-secondary)]">{TYPE_LABELS[node.type] ?? node.type}</div>
              {node.properties && Object.keys(node.properties).length > 0 && (
                <div className="mt-1 text-[var(--color-text-secondary)]">
                  {Object.entries(node.properties).slice(0, 3).map(([k, v]) => (
                    <div key={k}>{k}: {String(v).slice(0, 30)}</div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Stats badge */}
        <div className="absolute bottom-2 left-2 text-[10px] text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]/80 px-2 py-1 rounded">
          {filteredData.nodes.length} 节点 · {filteredData.edges.length} 边
        </div>
      </div>
    </div>
  );
};

export default KnowledgeGraphView;
