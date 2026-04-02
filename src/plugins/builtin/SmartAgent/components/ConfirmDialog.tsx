import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import type { ToolApprovalRisk } from "@/core/agent/actor/tool-approval-policy";
import { buildToolApprovalDialogModel } from "../core/tool-approval-dialog";
import { useToolTrustStore } from "@/store/command-allowlist-store";

export interface ConfirmResult {
  confirmed: boolean;
}

interface ConfirmDialogProps {
  toolName: string;
  params: Record<string, unknown>;
  risk?: ToolApprovalRisk;
  reason?: string;
  reviewedByModel?: boolean;
  onResult: (result: ConfirmResult) => void;
}

export function ConfirmDialog({
  toolName,
  params,
  risk,
  reason,
  reviewedByModel = false,
  onResult,
}: ConfirmDialogProps) {
  const [showRawDetail, setShowRawDetail] = useState(false);
  const model = useMemo(
    () => buildToolApprovalDialogModel({
      toolName,
      toolParams: params,
      risk,
      reason,
      reviewedByModel,
    }),
    [params, reason, reviewedByModel, risk, toolName],
  );

  const handleAllowSession = () => {
    if (model.sessionAction) {
      useToolTrustStore.getState().rememberSessionDecision(
        toolName,
        params,
        model.sessionAction.scope,
      );
    }
    onResult({ confirmed: true });
  };

  const dialog = (
    <div className="fixed inset-0 z-9999 overflow-y-auto bg-black/40 px-4 py-6 backdrop-blur-sm sm:flex sm:items-center sm:justify-center sm:py-8">
      <div className="mx-auto flex w-[min(560px,100%)] max-h-[calc(100vh-3rem)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl sm:max-h-[calc(100vh-4rem)]">
        <div className="border-b border-[var(--color-border)] px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-600">
              <AlertCircle className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[15px] font-semibold text-[var(--color-text)]">
                  {model.title}
                </h3>
                <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                  {model.toolTag}
                </span>
                {model.riskLabel && (
                  <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    {model.riskLabel}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                {model.subtitle}
              </p>
            </div>
          </div>
        </div>

        <div className="min-h-0 space-y-3 overflow-y-auto px-5 py-4">
          {model.warning && (
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-3.5 py-3 text-[12px] leading-5 text-amber-800">
              {model.warning}
            </div>
          )}

          {model.preview && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 px-3.5 py-3">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                {model.previewLabel ?? "内容"}
              </div>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[12px] leading-5 text-[var(--color-text)]">
                {model.preview}
              </pre>
            </div>
          )}

          {model.details.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {model.details.map((detail) => (
                <div
                  key={`${detail.label}-${detail.value}`}
                  className="min-w-0 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-3 py-2.5"
                >
                  <div className="text-[10px] text-[var(--color-text-tertiary)]">
                    {detail.label}
                  </div>
                  <div className={`mt-1 break-all text-[12px] text-[var(--color-text)] ${detail.mono ? "font-mono" : ""}`}>
                    {detail.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {model.reason && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-3.5 py-3 text-[12px] leading-5 text-[var(--color-text-secondary)]">
              {model.reason}
            </div>
          )}

          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 p-2">
            <button
              onClick={() => setShowRawDetail((value) => !value)}
              className="flex w-full items-center gap-1 px-1.5 py-1 text-left text-[12px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
            >
              {showRawDetail ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              原始参数
            </button>
            {showRawDetail && (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[11px] leading-5 text-[var(--color-text-secondary)]">
                {JSON.stringify(params, null, 2)}
              </pre>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 px-5 py-4">
          <div className="grid gap-2">
            <button
              onClick={() => onResult({ confirmed: true })}
              className="rounded-2xl bg-[var(--color-accent)] px-4 py-2.5 text-left text-[13px] font-medium text-white transition-colors hover:opacity-90"
            >
              允许一次
            </button>

            {model.sessionAction && (
              <button
                onClick={handleAllowSession}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
              >
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  {model.sessionAction.label}
                </div>
                <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                  {model.sessionAction.description}
                </div>
              </button>
            )}

            <button
              onClick={() => onResult({ confirmed: false })}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2.5 text-left text-[13px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
            >
              拒绝
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
