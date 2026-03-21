import React, { useMemo, useState } from "react";
import {
  buildDialogContextNarrative,
  hasDialogContextSnapshotContent,
  type DialogContextSnapshot,
} from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";

interface DialogContextStripProps {
  snapshot?: DialogContextSnapshot | null;
}

function summarizeText(value: string | undefined, maxLength = 180): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function buildCompactContextHint(snapshot?: DialogContextSnapshot | null): string {
  if (!snapshot) return "房间上下文已接入。";
  if (snapshot.roomCompactionMessageCount > 0) {
    return `房间上下文已接入，较早的 ${snapshot.roomCompactionMessageCount} 条消息已压缩整理，发送时会自动复用房间摘要。`;
  }
  if (snapshot.focusedSessionLabel) {
    return `房间上下文已接入，当前会优先沿用 ${snapshot.focusedSessionLabel} 的后台线程。`;
  }
  if (snapshot.pendingInteractionCount > 0) {
    return `房间上下文已接入，当前还有 ${snapshot.pendingInteractionCount} 条待回复交互。`;
  }
  if (snapshot.summarizedMessageCount > 0 || snapshot.dialogHistoryCount > 0) {
    return "房间上下文已接入，发送时会自动复用近期摘要。";
  }
  if (snapshot.workspaceRoot) {
    return `将沿用工作区 ${snapshot.workspaceRoot} 继续协作。`;
  }
  return "房间上下文已接入。";
}

export function DialogContextStrip({ snapshot }: DialogContextStripProps) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = hasDialogContextSnapshotContent(snapshot);
  const narrative = useMemo(() => buildDialogContextNarrative(snapshot), [snapshot]);
  const compactNarrative = useMemo(
    () => summarizeText(buildCompactContextHint(snapshot), 96),
    [snapshot],
  );
  const hasExtraDetail = Boolean(
    snapshot?.summaryPreview
    || snapshot?.memoryPreview.length
    || snapshot?.transcriptPreview.length
    || narrative.length > compactNarrative.length,
  );

  if (!hasContent) return null;

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
        {snapshot && snapshot.roomCompactionMessageCount > 0 && (
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700">
            压缩 {snapshot.roomCompactionMessageCount}
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
        {hasExtraDetail && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="ml-auto rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            {expanded ? "收起详情" : "查看详情"}
          </button>
        )}
      </div>
      <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
        {expanded ? narrative : compactNarrative}
      </div>
      {expanded && snapshot?.summaryPreview && (
        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
          摘要提示：{snapshot.summaryPreview}
        </div>
      )}
      {expanded && snapshot && snapshot.memoryPreview.length > 0 && (
        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
          记忆命中：{snapshot.memoryPreview.join("；")}
        </div>
      )}
      {expanded && snapshot && snapshot.transcriptPreview.length > 0 && (
        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
          轨迹回补：{snapshot.transcriptPreview.join("；")}
        </div>
      )}
    </div>
  );
}
