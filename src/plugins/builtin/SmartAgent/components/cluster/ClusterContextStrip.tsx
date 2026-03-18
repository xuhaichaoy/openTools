import React from "react";
import {
  buildClusterContextNarrative,
  hasClusterContextSnapshotContent,
  type ClusterContextSnapshot,
} from "@/plugins/builtin/SmartAgent/core/cluster-context-snapshot";

interface ClusterContextStripProps {
  snapshot?: ClusterContextSnapshot | null;
}

export function ClusterContextStrip({ snapshot }: ClusterContextStripProps) {
  if (!hasClusterContextSnapshotContent(snapshot)) return null;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-[var(--color-text)]">
          当前上下文
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          Cluster 会话
        </span>
        {snapshot?.workspaceRoot && (
          <span
            className="max-w-[240px] truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
            title={snapshot.workspaceRoot}
          >
            工作区 {snapshot.workspaceRoot}
          </span>
        )}
        {snapshot?.modeLabel && (
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
            {snapshot.modeLabel}
          </span>
        )}
        {snapshot?.sourceModeLabel && (
          <span className="max-w-[220px] truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700">
            接力 {snapshot.sourceModeLabel}
          </span>
        )}
        {snapshot && snapshot.imageCount > 0 && (
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
            图片 {snapshot.imageCount}
          </span>
        )}
        {snapshot && snapshot.planStepCount > 0 && (
          <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-700">
            计划 {snapshot.planStepCount}
          </span>
        )}
        {snapshot && snapshot.status === "awaiting_approval" && (
          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
            待审批
          </span>
        )}
        {snapshot && snapshot.runningInstanceCount > 0 && (
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700">
            运行中 {snapshot.runningInstanceCount}
          </span>
        )}
        {snapshot?.lastRunStatus && (
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700">
            最近运行 {snapshot.lastRunStatus === "success" ? "成功" : snapshot.lastRunStatus === "error" ? "失败" : "中断"}
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
        {snapshot?.reportPreview && (
          <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-700">
            已汇总
          </span>
        )}
      </div>
      <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
        {buildClusterContextNarrative(snapshot)}
      </div>
      {snapshot?.reportPreview && (
        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
          结果摘要：{snapshot.reportPreview}
        </div>
      )}
      {snapshot?.lastSessionNotePreview && (
        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
          最近会话笔记：{snapshot.lastSessionNotePreview}
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
