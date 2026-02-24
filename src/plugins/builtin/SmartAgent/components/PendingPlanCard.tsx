import React from "react";
import type { PendingPlanState } from "../core/ui-state";

interface PendingPlanCardProps {
  pendingPlan: PendingPlanState | null;
  pendingDraftFollowup?: string;
  busy: boolean;
  onExecute: () => void;
  onCancel: () => void;
}

export function PendingPlanCard({
  pendingPlan,
  pendingDraftFollowup,
  busy,
  onExecute,
  onCancel,
}: PendingPlanCardProps) {
  if (!pendingPlan) return null;

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-emerald-500/5 space-y-2">
      <div className="text-xs font-semibold text-emerald-500">Plan Mode 已生成执行计划</div>
      <div className="text-[10px] text-[var(--color-text-secondary)]">
        v{pendingPlan.version}
        {pendingPlan.sourceTaskId
          ? ` · 关联来源任务 ${pendingPlan.sourceTaskId.slice(-6)}`
          : " · 新建线程"}
        {pendingPlan.recentFollowup ? ` · 最近追问：${pendingPlan.recentFollowup}` : ""}
      </div>
      {pendingDraftFollowup && (
        <div className="text-[10px] text-[var(--color-text-secondary)]">
          当前线程追问：{pendingDraftFollowup}
        </div>
      )}
      <div className="text-xs whitespace-pre-wrap max-h-32 overflow-auto rounded border border-emerald-500/20 bg-[var(--color-bg)] px-2 py-1.5">
        {pendingPlan.plan}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onExecute}
          disabled={busy}
          className="px-2.5 py-1.5 text-xs rounded bg-emerald-500/20 text-emerald-500 disabled:opacity-50"
        >
          执行计划
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-2.5 py-1.5 text-xs rounded bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
        >
          取消
        </button>
      </div>
    </div>
  );
}
