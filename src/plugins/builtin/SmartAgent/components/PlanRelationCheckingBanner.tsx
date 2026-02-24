import React from "react";
import type { PlanRelationCheckingState } from "../core/ui-state";

interface PlanRelationCheckingBannerProps {
  state: PlanRelationCheckingState | null;
}

export function PlanRelationCheckingBanner({ state }: PlanRelationCheckingBannerProps) {
  if (!state) return null;

  return (
    <div className="px-3 py-2 border-b border-[var(--color-border)] bg-amber-500/[0.04] space-y-1.5">
      <div className="text-[11px] font-medium text-amber-700">
        正在判断追问是否关联当前计划...
      </div>
      {state.streaming && (
        <div className="text-[10px] text-[var(--color-text-secondary)]">分析中，请稍候</div>
      )}
      <div className="text-[10px] text-[var(--color-text-secondary)] whitespace-pre-wrap max-h-20 overflow-auto">
        {state.content}
      </div>
    </div>
  );
}
