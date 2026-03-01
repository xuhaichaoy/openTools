import React, { useMemo } from "react";
import {
  GitBranch,
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  ArrowRight,
} from "lucide-react";
import { topologicalSortIds } from "@/core/agent/cluster/cluster-plan";
import type { ClusterPlan, AgentInstance } from "@/core/agent/cluster/types";

interface ClusterPlanViewProps {
  plan: ClusterPlan;
  instances: AgentInstance[];
}

const ROLE_COLORS: Record<string, string> = {
  planner: "text-purple-500",
  researcher: "text-blue-500",
  coder: "text-green-500",
  reviewer: "text-amber-500",
  executor: "text-red-500",
};

const ROLE_BG: Record<string, string> = {
  planner: "bg-purple-500/10 border-purple-500/30",
  researcher: "bg-blue-500/10 border-blue-500/30",
  coder: "bg-green-500/10 border-green-500/30",
  reviewer: "bg-amber-500/10 border-amber-500/30",
  executor: "bg-red-500/10 border-red-500/30",
};

function StepStatusIcon({ status }: { status?: string }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "error":
      return <XCircle className="w-4 h-4 text-red-500" />;
    case "running":
      return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
    default:
      return <Circle className="w-4 h-4 text-[var(--color-text-tertiary)]" />;
  }
}

export function ClusterPlanView({ plan, instances }: ClusterPlanViewProps) {
  const instanceByStep = useMemo(() => {
    const map = new Map<string, AgentInstance>();
    for (const inst of instances) {
      if (inst.stepId) map.set(inst.stepId, inst);
    }
    return map;
  }, [instances]);

  const depLayers = useMemo(() => topologicalSortIds(plan.steps), [plan.steps]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
        <GitBranch className="w-3.5 h-3.5" />
        <span>
          执行计划 · {plan.mode === "multi_role" ? "多角色协作" : "并行分治"} ·{" "}
          {plan.steps.length} 步骤
        </span>
      </div>

      <div className="space-y-1.5">
        {depLayers.map((layer, layerIdx) => (
          <React.Fragment key={layerIdx}>
            {layerIdx > 0 && (
              <div className="flex items-center gap-1 px-1 text-[var(--color-text-tertiary)]">
                <ArrowRight className="w-3 h-3 rotate-90" />
              </div>
            )}
            <div
              className="grid gap-1.5"
              style={{
                gridTemplateColumns: `repeat(${Math.min(layer.length, 2)}, minmax(0, 1fr))`,
              }}
            >
              {layer.map((stepId) => {
                const step = plan.steps.find((s) => s.id === stepId);
                if (!step) return null;
                const inst = instanceByStep.get(step.id);
                const roleBg = ROLE_BG[step.role] ?? "bg-gray-500/10 border-gray-500/30";
                const roleColor = ROLE_COLORS[step.role] ?? "text-gray-500";
                const durationSec = inst?.startedAt && inst?.finishedAt
                  ? ((inst.finishedAt - inst.startedAt) / 1000).toFixed(1)
                  : null;

                return (
                  <div
                    key={step.id}
                    className={`border rounded-lg px-2.5 py-1.5 text-[11px] overflow-hidden ${roleBg}`}
                  >
                    <div className="flex items-center gap-1 mb-0.5">
                      <StepStatusIcon status={inst?.status} />
                      <span className={`font-medium ${roleColor} truncate`}>
                        {step.role}
                      </span>
                      <span className="text-[var(--color-text-tertiary)] shrink-0 text-[10px]">
                        {step.id}
                      </span>
                      {durationSec && (
                        <span className="text-[var(--color-text-tertiary)] text-[10px] ml-auto shrink-0">
                          {durationSec}s
                        </span>
                      )}
                    </div>
                    <p className="text-[var(--color-text-secondary)] line-clamp-2 text-[10px] leading-tight" title={step.task}>
                      {step.task}
                    </p>
                    {inst?.error && (
                      <p className="text-red-500 text-[10px] mt-0.5 line-clamp-2" title={inst.error}>
                        {inst.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

