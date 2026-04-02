import React, { useMemo } from "react";
import { FileText, ListChecks, MessagesSquare } from "lucide-react";

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

interface FocusedChildTranscriptPanelProps {
  task: SpawnedTaskRecord | null;
  childSession?: CollaborationChildSession | null;
  targetActor?: ActorSnapshot | null;
  actorNameById?: ReadonlyMap<string, string>;
  actorTodos?: readonly TodoItem[];
  dialogHistory?: readonly DialogMessage[];
  artifacts?: readonly DialogArtifactRecord[];
}

export function FocusedChildTranscriptPanel({
  task,
  childSession,
  targetActor,
  actorNameById,
  actorTodos,
  dialogHistory,
  artifacts,
}: FocusedChildTranscriptPanelProps) {
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

  const transcript = useMemo(
    () => collectSpawnedTaskTranscriptEntries({
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

  const actorLabel = targetActor?.roleName ?? actorNameById?.get(task.targetActorId) ?? task.targetActorId;
  const title = childSession?.label || task.label || actorLabel;
  const statusSummary = summarizeText(
    childSession?.statusSummary
    ?? checkpoint?.summary
    ?? task.result
    ?? task.error,
  );

  return (
    <div className="rounded-2xl border border-blue-500/15 bg-[linear-gradient(135deg,rgba(59,130,246,0.06),rgba(255,255,255,0.74)_68%)] px-3 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-700">
          <MessagesSquare className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-[var(--color-text)]">
              正在查看后台线程
            </span>
            <span className="truncate text-[12px] font-medium text-[var(--color-text)]">
              {title}
            </span>
            <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-700">
              {actorLabel}
            </span>
          </div>

          <div className="mt-1 text-[10px] leading-5 text-[var(--color-text-secondary)]">
            主房间时间线已折叠；下面只显示该子线程相关的会话轨迹、回传消息和产物线索。
          </div>

          {statusSummary && (
            <div className="mt-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
              {statusSummary}
            </div>
          )}
        </div>
      </div>

      {checkpoint && (
        <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)]/90 px-3 py-2.5">
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
              <div className="mt-2 text-[10px] leading-5 text-[var(--color-text-tertiary)]">
                下一步：{checkpoint.nextStep}
              </div>
            )}
          </div>

          {(checkpoint.activeTodoCount > 0 || checkpoint.relatedArtifactPaths.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {checkpoint.activeTodoCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700">
                  <ListChecks className="h-3 w-3" />
                  活跃待办 {checkpoint.activeTodoCount}
                </span>
              )}
              {checkpoint.relatedArtifactPaths.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-700">
                  <FileText className="h-3 w-3" />
                  相关产物 {checkpoint.relatedArtifactPaths.length}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 space-y-2">
        {transcript.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)]/80 px-3 py-4 text-[11px] text-[var(--color-text-secondary)]">
            这个子线程还没有可展示的会话轨迹；后续对子线程的输入和结果会出现在这里。
          </div>
        ) : (
          transcript.map((entry) => (
            <div
              key={entry.id}
              className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)]/90 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-tertiary)]">
                <span className="font-medium text-[var(--color-text-secondary)]">{entry.label}</span>
                {entry.kindLabel && (
                  <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 py-0.5">
                    {entry.kindLabel}
                  </span>
                )}
                <span className={`rounded-full px-1.5 py-0.5 ${
                  entry.source === "dialog"
                    ? "bg-sky-500/10 text-sky-700"
                    : "bg-violet-500/10 text-violet-700"
                }`}
                >
                  {entry.source === "dialog" ? "Dialog" : "会话轨迹"}
                </span>
                <span className="ml-auto">{formatShortTime(entry.timestamp)}</span>
              </div>
              <div className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-6 text-[var(--color-text)]">
                {entry.content}
              </div>
            </div>
          ))
        )}
      </div>

      {checkpoint && checkpoint.relatedArtifactPaths.length > 0 && (
        <div className="mt-3 rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)]/90 px-3 py-2.5">
          <div className="text-[10px] font-medium text-[var(--color-text-secondary)]">
            相关产物
          </div>
          <div className="mt-2 space-y-1.5">
            {checkpoint.relatedArtifactPaths.map((path) => (
              <div
                key={path}
                className="break-all rounded-lg bg-[var(--color-bg-secondary)]/70 px-2.5 py-1.5 text-[10px] text-[var(--color-text-secondary)]"
              >
                {path}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
