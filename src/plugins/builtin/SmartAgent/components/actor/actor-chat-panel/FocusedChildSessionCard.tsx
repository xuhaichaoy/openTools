import React, { useMemo, useState } from "react";
import {
  ArrowRightCircle,
  ChevronDown,
  ChevronUp,
  Crosshair,
  FolderOpen,
  Network,
  Send,
  Square,
} from "lucide-react";

import {
  buildSpawnedTaskCheckpoint,
  collectSpawnedTaskTranscriptEntries,
} from "@/core/agent/actor/spawned-task-checkpoint";
import type {
  DialogArtifactRecord,
  DialogMessage,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import type { TodoItem } from "@/core/agent/actor/middlewares";
import type { CollaborationChildSession } from "@/core/collaboration/types";
import type { ActorSnapshot } from "@/store/actor-system-store";

function formatShortTime(timestamp?: number): string {
  if (!timestamp) return "刚刚";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summarizeText(value: string | undefined, maxLength = 180): string | null {
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

interface FocusedChildSessionCardProps {
  task: SpawnedTaskRecord | null;
  childSession?: CollaborationChildSession | null;
  targetActor?: ActorSnapshot | null;
  actorNameById?: ReadonlyMap<string, string>;
  actorTodos?: readonly TodoItem[];
  dialogHistory?: readonly DialogMessage[];
  artifacts?: readonly DialogArtifactRecord[];
  isPendingSteer?: boolean;
  onResume: () => void;
  onUnfocus: () => void;
  onSteer: () => void;
  onKill: () => void;
  onOpenWorkspace?: () => void;
}

export function FocusedChildSessionCard({
  task,
  childSession,
  targetActor,
  actorNameById,
  actorTodos,
  dialogHistory,
  artifacts,
  isPendingSteer = false,
  onResume,
  onUnfocus,
  onSteer,
  onKill,
  onOpenWorkspace,
}: FocusedChildSessionCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const checkpoint = useMemo(
    () => buildSpawnedTaskCheckpoint({
      task,
      targetActor: targetActor
        ? {
            roleName: targetActor.roleName,
            sessionHistory: targetActor.sessionHistory,
          }
        : undefined,
      actorTodos,
      dialogHistory,
      artifacts,
      actorNameById,
    }),
    [actorNameById, actorTodos, artifacts, dialogHistory, targetActor, task],
  );

  const fullTranscript = useMemo(
    () =>
      collectSpawnedTaskTranscriptEntries({
        task,
        targetActor: targetActor
          ? {
              roleName: targetActor.roleName,
            sessionHistory: targetActor.sessionHistory,
          }
        : undefined,
        actorNameById,
        dialogHistory,
      }),
    [actorNameById, dialogHistory, targetActor, task],
  );

  if (!task) return null;

  const statusMeta = getStatusMeta(childSession?.status ?? task.status);
  const actorLabel = targetActor?.roleName ?? actorNameById?.get(task.targetActorId) ?? task.targetActorId;
  const canResume = Boolean(childSession?.resumable ?? task.sessionOpen);
  const canSteer = Boolean(childSession?.resumable ?? task.sessionOpen);
  const canKill = Boolean(task.sessionOpen || task.status === "running");
  const previewText = summarizeText(childSession?.lastError ?? childSession?.lastResultSummary ?? task.result ?? task.error);
  const transcript = expanded ? fullTranscript : fullTranscript.slice(-4);
  const relatedArtifacts = checkpoint?.relatedArtifactPaths ?? [];
  const hasExpandedView = fullTranscript.length > 4 || relatedArtifacts.length > 0 || (checkpoint?.activeTodos.length ?? 0) > 3;
  const hasDetails = Boolean(checkpoint || transcript.length > 0);

  return (
    <div className="rounded-xl border border-blue-500/15 bg-[linear-gradient(135deg,rgba(59,130,246,0.08),rgba(255,255,255,0.65)_60%)] px-3 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="inline-flex h-8 w-8 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-700">
          <Network className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[12px] font-semibold text-[var(--color-text)]">
              当前后台线程：{childSession?.label || task.label || actorLabel}
            </div>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${statusMeta.className}`}>
              {statusMeta.label}
            </span>
            {isPendingSteer && (
              <span className="rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700">
                Steer 中
              </span>
            )}
          </div>
          <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
            主 Agent 正在后台保留这个线程。当前输入默认会直接发给 {actorLabel}；如需回到主房间，点“回主房间”。
          </div>
          {previewText && (
            <div className="mt-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
              {previewText}
            </div>
          )}
        </div>
        <div className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">
          {formatShortTime(childSession?.updatedAt ?? task.lastActiveAt ?? task.spawnedAt)}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {canResume && (
          <button
            type="button"
            onClick={onResume}
            className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-1 text-[10px] text-blue-700 hover:bg-blue-500/15"
          >
            <ArrowRightCircle className="h-3 w-3" />
            继续对话
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
        {canSteer && (
          <button
            type="button"
            onClick={onSteer}
            className="inline-flex items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/8 px-2.5 py-1 text-[10px] text-sky-700 hover:bg-sky-500/12"
          >
            <Send className="h-3 w-3" />
            发送 steer
          </button>
        )}
        {onOpenWorkspace && (
          <button
            type="button"
            onClick={onOpenWorkspace}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            <FolderOpen className="h-3 w-3" />
            打开工作台
          </button>
        )}
        {canKill && (
          <button
            type="button"
            onClick={onKill}
            className="inline-flex items-center gap-1 rounded-full border border-red-500/25 bg-red-500/8 px-2.5 py-1 text-[10px] text-red-700 hover:bg-red-500/12"
          >
            <Square className="h-3 w-3" />
            中止线程
          </button>
        )}
        {hasDetails && (
          <button
            type="button"
            onClick={() => setShowDetails((value) => !value)}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showDetails ? "收起线程详情" : "查看线程详情"}
          </button>
        )}
        {showDetails && hasExpandedView && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? "收起线程视图" : "展开完整线程"}
          </button>
        )}
      </div>

      {showDetails && hasDetails && (
        <div className="mt-3 max-h-[32vh] overflow-y-auto overscroll-contain pr-1">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          {checkpoint && (
            <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)]/85 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                  {checkpoint.stageLabel}
                </span>
                <span className="text-[10px] text-[var(--color-text-tertiary)]">
                  更新于 {formatShortTime(checkpoint.updatedAt)}
                </span>
              </div>
              <div className="mt-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                {checkpoint.summary}
              </div>
              {checkpoint.nextStep && (
                <div className="mt-2 text-[10px] text-[var(--color-text-secondary)]">
                  下一步：{checkpoint.nextStep}
                </div>
              )}
              {checkpoint.activeTodos.length > 0 && (
                <div className="mt-2">
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    待办：{(expanded ? checkpoint.activeTodos : checkpoint.activeTodos.slice(0, 3)).join("；")}
                  </div>
                  {!expanded && checkpoint.activeTodos.length > 3 && (
                    <div className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">
                      还有 {checkpoint.activeTodos.length - 3} 项待办，展开后可查看完整线程。
                    </div>
                  )}
                </div>
              )}
              {relatedArtifacts.length > 0 && (
                <div className="mt-2">
                  <div className="text-[10px] text-[var(--color-text-secondary)]">关联产物</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(expanded ? relatedArtifacts : relatedArtifacts.slice(0, 3)).map((artifactPath) => (
                      <span
                        key={artifactPath}
                        className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                        title={artifactPath}
                      >
                        {artifactPath.split("/").pop() || artifactPath}
                      </span>
                    ))}
                    {!expanded && relatedArtifacts.length > 3 && (
                      <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                        +{relatedArtifacts.length - 3}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {transcript.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)]/85 px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                {expanded ? "完整线程上下文" : "最近线程上下文"}
              </div>
              <div className={`mt-2 space-y-2 ${expanded ? "max-h-[360px] overflow-auto pr-1" : ""}`}>
                {transcript.map((entry) => (
                  <div
                    key={entry.id}
                    className={`rounded-lg px-2.5 py-2 ${
                      entry.source === "dialog"
                        ? "border border-blue-500/15 bg-blue-500/5"
                        : "bg-[var(--color-bg-secondary)]/70"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-tertiary)]">
                      <span>{entry.label}</span>
                      {entry.kindLabel && (
                        <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                          {entry.kindLabel}
                        </span>
                      )}
                      <span>{formatShortTime(entry.timestamp)}</span>
                    </div>
                    <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                      {entry.content}
                    </div>
                  </div>
                ))}
              </div>
              {!expanded && fullTranscript.length > transcript.length && (
                <div className="mt-2 text-[10px] text-[var(--color-text-tertiary)]">
                  还有 {fullTranscript.length - transcript.length} 条更早上下文，展开后可查看完整线程。
                </div>
              )}
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
