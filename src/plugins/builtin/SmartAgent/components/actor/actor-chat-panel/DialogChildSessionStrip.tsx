import React, { useMemo } from "react";
import { Network } from "lucide-react";

import type { CollaborationChildSession } from "@/core/collaboration/types";

interface DialogChildSessionStripProps {
  sessions: CollaborationChildSession[];
  actorNameById?: ReadonlyMap<string, string>;
  pendingSteerSessionRunId?: string | null;
  focusedSessionRunId?: string | null;
  onFocusSession?: (runId: string) => void;
  onOpenWorkspace?: () => void;
}

function summarizeText(value: string | undefined, maxLength = 88): string | null {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function getChildSessionStatusMeta(status: CollaborationChildSession["status"]): {
  label: string;
  className: string;
} {
  switch (status) {
    case "running":
      return {
        label: "运行中",
        className: "bg-emerald-500/10 text-emerald-700",
      };
    case "waiting":
      return {
        label: "已暂停",
        className: "bg-blue-500/10 text-blue-700",
      };
    case "completed":
      return {
        label: "已结束",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
      };
    case "failed":
      return {
        label: "失败",
        className: "bg-red-500/10 text-red-700",
      };
    case "aborted":
      return {
        label: "已中止",
        className: "bg-amber-500/10 text-amber-700",
      };
    default:
      return {
        label: "待启动",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
      };
  }
}

export function DialogChildSessionStrip({
  sessions,
  actorNameById,
  pendingSteerSessionRunId = null,
  focusedSessionRunId = null,
  onFocusSession,
  onOpenWorkspace,
}: DialogChildSessionStripProps) {
  const activeSessions = useMemo(
    () =>
      sessions.filter((session) =>
        session.mode === "session"
        && (
          session.status === "running"
          || session.resumable
          || session.focusable
          || session.runId === pendingSteerSessionRunId
        ),
      ),
    [pendingSteerSessionRunId, sessions],
  );

  if (activeSessions.length === 0) return null;

  const visibleSessions = activeSessions.slice(0, 3);
  const hiddenCount = activeSessions.length - visibleSessions.length;

  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/45 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-700">
          <Network className="h-3 w-3" />
          后台线程 {activeSessions.length}
        </span>
        <span className="text-[10px] text-[var(--color-text-secondary)]">
          这些线程由主 Agent 在后台保留，是否复用由它自动判断。
        </span>
        {onOpenWorkspace && (
          <button
            type="button"
            onClick={onOpenWorkspace}
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            查看全部
          </button>
        )}
      </div>

      <div className="mt-2 grid gap-2">
        {visibleSessions.map((session) => {
          const actorLabel = actorNameById?.get(session.targetActorId) ?? session.targetActorId;
          const statusMeta = getChildSessionStatusMeta(session.status);
          const detail = summarizeText(
            session.statusSummary
            ?? session.nextStepHint
            ?? session.lastError
            ?? session.lastResultSummary,
          ) ?? "主 Agent 保留中的专项上下文";
          const isPendingSteer = pendingSteerSessionRunId === session.runId;
          const isFocused = focusedSessionRunId === session.runId;
          const canFocus = Boolean(onFocusSession && session.focusable);

          return (
            <div
              key={session.id}
              className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-xl border px-2.5 py-1.5 ${
                isFocused
                  ? "border-[var(--color-accent)]/30 bg-[var(--color-accent)]/8"
                  : "border-[var(--color-border)]/80 bg-[var(--color-bg)]"
              }`}
            >
              <div className="min-w-0 overflow-hidden">
                <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                  <div className="truncate text-[11px] font-medium text-[var(--color-text)]">
                    {session.label}
                  </div>
                  <div className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
                    {actorLabel}
                  </div>
                </div>
                <div className="mt-1 truncate text-[10px] text-[var(--color-text-secondary)]">
                  {detail}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <div className={`rounded-full px-1.5 py-0.5 text-[10px] ${statusMeta.className}`}>
                  {statusMeta.label}
                </div>
                {isFocused && (
                  <div className="rounded-full bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]">
                    当前对话中
                  </div>
                )}
                {isPendingSteer && (
                  <div className="rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700">
                    主 Agent 正在接管
                  </div>
                )}
                {canFocus && !isFocused && (
                  <button
                    type="button"
                    onClick={() => onFocusSession?.(session.runId)}
                    className="rounded-full bg-[var(--color-accent)]/10 px-2 py-1 text-[10px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/15"
                  >
                    接管对话
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {hiddenCount > 0 && (
          <div className="text-[10px] text-[var(--color-text-secondary)]">
            还有 {hiddenCount} 个后台线程，去工作台查看全部。
          </div>
        )}
      </div>
    </div>
  );
}
