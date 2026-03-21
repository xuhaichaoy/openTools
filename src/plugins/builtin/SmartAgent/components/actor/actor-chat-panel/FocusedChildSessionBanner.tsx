import React from "react";
import { ArrowRightCircle, Crosshair, FolderOpen, Network } from "lucide-react";

import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import type { CollaborationChildSession } from "@/core/collaboration/types";
import type { ActorSnapshot } from "@/store/actor-system-store";

function summarizeText(value: string | undefined, maxLength = 160): string | null {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function getStatusMeta(
  status: CollaborationChildSession["status"] | SpawnedTaskRecord["status"] | undefined,
): {
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
        label: "等待继续",
        className: "bg-blue-500/10 text-blue-700",
      };
    case "completed":
      return {
        label: "已完成",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
      };
    case "failed":
    case "error":
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

interface FocusedChildSessionBannerProps {
  task: SpawnedTaskRecord | null;
  childSession?: CollaborationChildSession | null;
  targetActor?: ActorSnapshot | null;
  actorNameById?: ReadonlyMap<string, string>;
  isPendingSteer?: boolean;
  onResume: () => void;
  onUnfocus: () => void;
  onOpenWorkspace?: () => void;
}

export function FocusedChildSessionBanner({
  task,
  childSession,
  targetActor,
  actorNameById,
  isPendingSteer = false,
  onResume,
  onUnfocus,
  onOpenWorkspace,
}: FocusedChildSessionBannerProps) {
  if (!task) return null;

  const actorLabel = targetActor?.roleName ?? actorNameById?.get(task.targetActorId) ?? task.targetActorId;
  const statusMeta = getStatusMeta(childSession?.status ?? task.status);
  const canResume = Boolean(childSession?.resumable ?? task.sessionOpen);
  const previewText = summarizeText(childSession?.lastError ?? childSession?.lastResultSummary ?? task.result ?? task.error)
    ?? `主 Agent 正在后台保留 ${actorLabel} 的持续线程，需要时再进入处理。`;

  return (
    <div className="rounded-xl border border-blue-500/15 bg-[linear-gradient(135deg,rgba(59,130,246,0.06),rgba(255,255,255,0.72)_68%)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-700">
          <Network className="h-3.5 w-3.5" />
        </span>

        <div className="min-w-0 flex flex-1 items-center gap-2">
          <span className="shrink-0 text-[12px] font-semibold text-[var(--color-text)]">
            当前后台线程
          </span>
          <span className="truncate text-[11px] font-medium text-[var(--color-text)]">
            {childSession?.label || task.label || actorLabel}
          </span>
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${statusMeta.className}`}>
            {statusMeta.label}
          </span>
          {isPendingSteer && (
            <span className="shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700">
              Steer 中
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]">
            {previewText}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {canResume && (
            <button
              type="button"
              onClick={onResume}
              className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-1 text-[10px] text-blue-700 hover:bg-blue-500/15"
            >
              <ArrowRightCircle className="h-3 w-3" />
              继续
            </button>
          )}
          <button
            type="button"
            onClick={onUnfocus}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            <Crosshair className="h-3 w-3" />
            回主房间
          </button>
          {onOpenWorkspace && (
            <button
              type="button"
              onClick={onOpenWorkspace}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            >
              <FolderOpen className="h-3 w-3" />
              线程详情
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
