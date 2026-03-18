import React from "react";
import {
  buildDialogContextNarrative,
  hasDialogContextSnapshotContent,
  type DialogContextSnapshot,
} from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";

interface DialogContextStripProps {
  snapshot?: DialogContextSnapshot | null;
}

export function DialogContextStrip({ snapshot }: DialogContextStripProps) {
  if (!hasDialogContextSnapshotContent(snapshot)) return null;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-[var(--color-text)]">
          当前上下文
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          Dialog 房间
        </span>
        {snapshot?.workspaceRoot && (
          <span
            className="max-w-[240px] truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
            title={snapshot.workspaceRoot}
          >
            工作区 {snapshot.workspaceRoot}
          </span>
        )}
        {snapshot?.sourceModeLabel && (
          <span className="max-w-[220px] truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700">
            接力 {snapshot.sourceModeLabel}
          </span>
        )}
        {snapshot && snapshot.summarizedMessageCount > 0 && (
          <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-700">
            摘要 {snapshot.summarizedMessageCount}
          </span>
        )}
        {snapshot && snapshot.summarizedMessageCount === 0 && snapshot.dialogHistoryCount > 0 && (
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
            近期消息 {snapshot.dialogHistoryCount}
          </span>
        )}
        {snapshot?.focusedSessionLabel && (
          <span
            className="max-w-[220px] truncate rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-700"
            title={snapshot.focusedSessionLabel}
          >
            聚焦 {snapshot.focusedSessionLabel}
          </span>
        )}
        {snapshot && snapshot.pendingInteractionCount > 0 && (
          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
            待回复 {snapshot.pendingInteractionCount}
          </span>
        )}
        {snapshot && snapshot.queuedFollowUpCount > 0 && (
          <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-700">
            排队 {snapshot.queuedFollowUpCount}
          </span>
        )}
        {snapshot && snapshot.runningActorCount > 0 && (
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700">
            运行中 {snapshot.runningActorCount}
          </span>
        )}
        {snapshot && snapshot.memoryHitCount > 0 && (
          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
            记忆 {snapshot.memoryHitCount}
          </span>
        )}
        {snapshot && snapshot.memoryRecallAttempted && snapshot.memoryHitCount === 0 && (
          <span className="rounded-full border border-amber-500/20 bg-amber-500/5 px-2 py-0.5 text-[10px] text-amber-700">
            记忆已检索
          </span>
        )}
        {snapshot && snapshot.transcriptRecallHitCount > 0 && (
          <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-700">
            轨迹 {snapshot.transcriptRecallHitCount}
          </span>
        )}
        {snapshot && snapshot.transcriptRecallAttempted && snapshot.transcriptRecallHitCount === 0 && (
          <span className="rounded-full border border-violet-500/20 bg-violet-500/5 px-2 py-0.5 text-[10px] text-violet-700">
            轨迹已检索
          </span>
        )}
      </div>
      <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
        {buildDialogContextNarrative(snapshot)}
      </div>
      {snapshot?.summaryPreview && (
        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
          摘要提示：{snapshot.summaryPreview}
        </div>
      )}
      {snapshot && snapshot.memoryPreview.length > 0 && (
        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
          记忆命中：{snapshot.memoryPreview.join("；")}
        </div>
      )}
      {snapshot && snapshot.transcriptPreview.length > 0 && (
        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
          轨迹回补：{snapshot.transcriptPreview.join("；")}
        </div>
      )}
    </div>
  );
}
