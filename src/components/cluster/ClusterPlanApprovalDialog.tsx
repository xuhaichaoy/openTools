import { useEffect, useRef } from "react";
import { CheckCircle, ShieldCheck, XCircle } from "lucide-react";
import type { ClusterPlan } from "@/core/agent/cluster/types";

interface ClusterPlanApprovalDialogProps {
  plan: ClusterPlan;
  onApprove: () => void;
  onReject: () => void;
}

export function ClusterPlanApprovalDialog({
  plan,
  onApprove,
  onReject,
}: ClusterPlanApprovalDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const approveButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const id = requestAnimationFrame(() => {
      if (approveButtonRef.current) {
        approveButtonRef.current.focus();
      } else {
        dialogRef.current?.focus();
      }
    });

    return () => {
      cancelAnimationFrame(id);
      previousFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onReject();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onApprove();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onApprove, onReject]);

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden focus:outline-none"
      >
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[var(--color-accent)]" />
            <h3 className="text-sm font-semibold">审批执行计划</h3>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            请确认以下计划是否可以执行（Enter 批准，Esc 拒绝）
          </p>
        </div>

        <div className="px-5 py-4 max-h-80 overflow-auto space-y-2">
          <div className="text-xs text-[var(--color-text-secondary)]">
            模式: {plan.mode === "multi_role" ? "多角色协作" : "并行分治"} · {plan.steps.length} 个步骤
          </div>
          {plan.steps.map((step) => (
            <div key={step.id} className="border border-[var(--color-border)] rounded-lg px-3 py-2 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-[var(--color-accent)]">{step.role}</span>
                <span className="text-[var(--color-text-tertiary)]">{step.id}</span>
                {step.reviewAfter && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">自动审查</span>
                )}
              </div>
              <p className="text-[var(--color-text-secondary)]">{step.task}</p>
              {step.dependencies.length > 0 && (
                <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1">
                  依赖: {step.dependencies.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">
          <button
            className="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
            onClick={onReject}
          >
            <XCircle className="w-3.5 h-3.5" />
            拒绝
          </button>
          <button
            ref={approveButtonRef}
            className="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
            onClick={onApprove}
          >
            <CheckCircle className="w-3.5 h-3.5" />
            批准执行
          </button>
        </div>
      </div>
    </div>
  );
}
