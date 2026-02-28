import React, { useMemo } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
} from "lucide-react";
import { topologicalSortIds } from "@/core/agent/cluster/cluster-plan";
import type { ClusterPlan, AgentInstance } from "@/core/agent/cluster/types";

interface ClusterDAGViewProps {
  plan: ClusterPlan;
  instances: AgentInstance[];
}

const ROLE_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  planner: { border: "border-purple-400", bg: "bg-purple-500/10", text: "text-purple-600" },
  researcher: { border: "border-blue-400", bg: "bg-blue-500/10", text: "text-blue-600" },
  coder: { border: "border-green-400", bg: "bg-green-500/10", text: "text-green-600" },
  reviewer: { border: "border-amber-400", bg: "bg-amber-500/10", text: "text-amber-600" },
  executor: { border: "border-red-400", bg: "bg-red-500/10", text: "text-red-600" },
};

const DEFAULT_COLORS = { border: "border-gray-400", bg: "bg-gray-500/10", text: "text-gray-600" };

interface DAGNode {
  step: { id: string; role: string; task: string; dependencies: string[] };
  layer: number;
  indexInLayer: number;
}

function StatusIcon({ status }: { status?: string }) {
  const size = "w-3.5 h-3.5";
  switch (status) {
    case "done":
      return <CheckCircle2 className={`${size} text-green-500`} />;
    case "error":
      return <XCircle className={`${size} text-red-500`} />;
    case "running":
      return <Loader2 className={`${size} text-blue-500 animate-spin`} />;
    default:
      return <Circle className={`${size} text-gray-400`} />;
  }
}

export function ClusterDAGView({ plan, instances }: ClusterDAGViewProps) {
  const instanceByStep = useMemo(() => {
    const map = new Map<string, AgentInstance>();
    for (const inst of instances) {
      if (inst.stepId) map.set(inst.stepId, inst);
    }
    return map;
  }, [instances]);

  const { layers, nodeMap } = useMemo(() => {
    const stepMap = new Map(plan.steps.map((s) => [s.id, s]));
    const sortedLayers = topologicalSortIds(plan.steps);
    const nMap = new Map<string, DAGNode>();

    sortedLayers.forEach((layer, layerIdx) => {
      layer.forEach((id, i) => {
        const step = stepMap.get(id);
        if (step) {
          nMap.set(id, { step: step as DAGNode["step"], layer: layerIdx, indexInLayer: i });
        }
      });
    });

    return { layers: sortedLayers, nodeMap: nMap };
  }, [plan]);

  const NODE_W = 180;
  const NODE_H = 64;
  const GAP_X = 40;
  const GAP_Y = 24;
  const PADDING = 16;

  const maxLayerSize = Math.max(...layers.map((l) => l.length), 1);
  const svgWidth = layers.length * (NODE_W + GAP_X) - GAP_X + PADDING * 2;
  const svgHeight = maxLayerSize * (NODE_H + GAP_Y) - GAP_Y + PADDING * 2;

  function getNodePos(layerIdx: number, indexInLayer: number, layerSize: number) {
    const x = PADDING + layerIdx * (NODE_W + GAP_X);
    const totalHeight = layerSize * NODE_H + (layerSize - 1) * GAP_Y;
    const offsetY = (svgHeight - totalHeight) / 2;
    const y = offsetY + indexInLayer * (NODE_H + GAP_Y);
    return { x, y };
  }

  const edges: { from: string; to: string }[] = [];
  for (const step of plan.steps) {
    for (const dep of step.dependencies) {
      if (nodeMap.has(dep)) {
        edges.push({ from: dep, to: step.id });
      }
    }
  }

  return (
    <div className="overflow-auto">
      <svg width={svgWidth} height={svgHeight} className="block">
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
            <polygon
              points="0 0, 8 3, 0 6"
              className="fill-gray-400"
            />
          </marker>
        </defs>

        {edges.map((edge, i) => {
          const fromNode = nodeMap.get(edge.from);
          const toNode = nodeMap.get(edge.to);
          if (!fromNode || !toNode) return null;

          const fromLayer = layers[fromNode.layer];
          const toLayer = layers[toNode.layer];
          const fromPos = getNodePos(fromNode.layer, fromNode.indexInLayer, fromLayer.length);
          const toPos = getNodePos(toNode.layer, toNode.indexInLayer, toLayer.length);

          const x1 = fromPos.x + NODE_W;
          const y1 = fromPos.y + NODE_H / 2;
          const x2 = toPos.x;
          const y2 = toPos.y + NODE_H / 2;

          const midX = (x1 + x2) / 2;

          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
              fill="none"
              className="stroke-gray-400"
              strokeWidth={1.5}
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {layers.map((layer, layerIdx) =>
          layer.map((stepId, indexInLayer) => {
            const node = nodeMap.get(stepId);
            if (!node) return null;
            const pos = getNodePos(layerIdx, indexInLayer, layer.length);
            const inst = instanceByStep.get(stepId);
            const colors = ROLE_COLORS[node.step.role] ?? DEFAULT_COLORS;

            return (
              <g key={stepId} transform={`translate(${pos.x}, ${pos.y})`}>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  className={`fill-[var(--color-bg)] stroke-1 ${
                    inst?.status === "running"
                      ? "stroke-blue-400"
                      : inst?.status === "done"
                        ? "stroke-green-400"
                        : inst?.status === "error"
                          ? "stroke-red-400"
                          : "stroke-gray-300"
                  }`}
                />
                <foreignObject width={NODE_W} height={NODE_H}>
                  <div className="flex flex-col justify-center h-full px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <StatusIcon status={inst?.status} />
                      <span className={`text-[11px] font-medium ${colors.text}`}>
                        {node.step.role}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {node.step.id}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-500 line-clamp-2 mt-0.5 leading-tight">
                      {node.step.task}
                    </p>
                  </div>
                </foreignObject>
              </g>
            );
          }),
        )}
      </svg>
    </div>
  );
}
