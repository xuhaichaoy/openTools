import React from "react";
import type { PlanThreadState } from "../core/plan-mode";

interface PlanModeToolbarProps {
  visible: boolean;
  busy: boolean;
  forceNewPlanNextRun: boolean;
  planKnowledgeEnabled: boolean;
  planKBKeywordHit: boolean;
  currentPlanThread: PlanThreadState | null;
  onToggleForceNewPlan: () => void;
  onTogglePlanKnowledge: () => void;
}

export function PlanModeToolbar({
  visible,
  busy,
  forceNewPlanNextRun,
  planKnowledgeEnabled,
  planKBKeywordHit,
  currentPlanThread,
  onToggleForceNewPlan,
  onTogglePlanKnowledge,
}: PlanModeToolbarProps) {
  if (!visible) return null;

  return (
    <div className="px-3 pb-1 border-t border-[var(--color-border)]/70">
      <div className="flex items-center gap-1.5 pt-1.5">
        <button
          onClick={onToggleForceNewPlan}
          disabled={busy}
          className={`px-2 py-0.5 rounded text-[10px] border transition-colors disabled:opacity-50 ${
            forceNewPlanNextRun
              ? "border-amber-500/40 bg-amber-500/15 text-amber-700"
              : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 text-[var(--color-text-secondary)]"
          }`}
          title="开启后，本次发送将强制新建计划线程"
        >
          本次新建计划
        </button>
        <button
          onClick={onTogglePlanKnowledge}
          disabled={busy}
          className={`px-2 py-0.5 rounded text-[10px] border transition-colors disabled:opacity-50 ${
            planKnowledgeEnabled
              ? "border-sky-500/35 bg-sky-500/15 text-sky-700"
              : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 text-[var(--color-text-secondary)]"
          }`}
          title="Plan 阶段显式启用知识库检索"
        >
          基于知识库
        </button>
        {planKBKeywordHit && (
          <span className="text-[10px] text-sky-600">检测到关键词，将启用知识库</span>
        )}
        {currentPlanThread && currentPlanThread.phase !== "archived" && (
          <span className="ml-auto text-[10px] text-[var(--color-text-secondary)]">
            当前线程 v{currentPlanThread.planVersion}
          </span>
        )}
      </div>
    </div>
  );
}
