import React from "react";
import {
  buildAskContextNarrative,
  hasAskContextSnapshotContent,
  type AskContextSnapshot,
} from "@/core/ai/ask-context-snapshot";

interface AskContextStripProps {
  snapshot?: AskContextSnapshot | null;
}

export function AskContextStrip({ snapshot }: AskContextStripProps) {
  if (!hasAskContextSnapshotContent(snapshot)) return null;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-[var(--color-text)]">
          当前上下文
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          Ask 对话
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
        {snapshot && snapshot.messageCount > 0 && (
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
            消息 {snapshot.messageCount}
          </span>
        )}
        {snapshot && snapshot.recalledMemoryCount > 0 && (
          <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-700">
            记忆 {snapshot.recalledMemoryCount}
          </span>
        )}
        {snapshot?.lastRunStatus && (
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700">
            最近运行 {snapshot.lastRunStatus === "success" ? "成功" : snapshot.lastRunStatus === "error" ? "失败" : "中断"}
          </span>
        )}
        {snapshot && snapshot.draftAttachmentCount > 0 && (
          <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-700">
            草稿附件 {snapshot.draftAttachmentCount}
          </span>
        )}
        {snapshot && snapshot.draftImageCount > 0 && (
          <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-700">
            草稿图片 {snapshot.draftImageCount}
          </span>
        )}
        {snapshot?.isStreaming && (
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700">
            生成中
          </span>
        )}
      </div>
      <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
        {buildAskContextNarrative(snapshot)}
      </div>
    </div>
  );
}
