import React from "react";
import type { PendingPlanLinkDecisionState } from "../core/ui-state";

interface PlanLinkDecisionBannerProps {
  decision: PendingPlanLinkDecisionState | null;
  busy: boolean;
  onResolveRelated: () => void;
  onResolveUnrelated: () => void;
}

export function PlanLinkDecisionBanner({
  decision,
  busy,
  onResolveRelated,
  onResolveUnrelated,
}: PlanLinkDecisionBannerProps) {
  if (!decision) return null;

  return (
    <div className="px-3 py-2 border-b border-[var(--color-border)] bg-amber-500/[0.06] space-y-2">
      <div className="text-xs font-semibold text-amber-600">追问与当前计划关联不明确</div>
      <div className="text-[11px] text-[var(--color-text-secondary)]">
        {decision.reason || "请选择本次输入的处理方式。"}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onResolveRelated}
          disabled={busy}
          className="px-2.5 py-1.5 text-xs rounded bg-amber-500/20 text-amber-700 disabled:opacity-50"
        >
          关联当前计划
        </button>
        <button
          onClick={onResolveUnrelated}
          disabled={busy}
          className="px-2.5 py-1.5 text-xs rounded bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
        >
          新建计划
        </button>
      </div>
    </div>
  );
}
