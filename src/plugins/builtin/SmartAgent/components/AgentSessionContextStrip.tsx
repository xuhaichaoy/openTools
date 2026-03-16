import React from "react";
import type { AgentSession } from "@/store/agent-store";

interface AgentSessionContextStripProps {
  session: AgentSession;
  hiddenTaskCount: number;
  onRedo: () => void;
  onRestore: () => void;
  onFork: () => void;
}

export function AgentSessionContextStrip({
  session,
  hiddenTaskCount,
  onRedo,
  onRestore,
  onFork,
}: AgentSessionContextStripProps) {
  const hasRevertedContext = hiddenTaskCount > 0;
  const hasForkMeta = Boolean(session.forkMeta);
  const hasCompaction = Boolean(session.compaction?.summary);

  if (!hasRevertedContext && !hasForkMeta && !hasCompaction) {
    return null;
  }

  return (
    <div className="mx-4 mt-2 mb-1 space-y-2">
      {hasRevertedContext && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/25 bg-amber-500/8 px-3 py-2">
          <div className="text-[12px] text-amber-700">
            当前只显示前面的任务版本，后面还有 {hiddenTaskCount} 个任务被收起。继续提问会自动创建分支，避免把两条线索混在一起。
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={onRedo}
              className="rounded-full border border-amber-500/30 px-2 py-1 text-[11px] text-amber-700 hover:bg-amber-500/10"
            >
              前进一步
            </button>
            <button
              type="button"
              onClick={onRestore}
              className="rounded-full border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            >
              恢复全部
            </button>
            <button
              type="button"
              onClick={onFork}
              className="rounded-full border border-emerald-500/25 px-2 py-1 text-[11px] text-emerald-600 hover:bg-emerald-500/10"
            >
              另开分支
            </button>
          </div>
        </div>
      )}
      {hasForkMeta && (
        <div className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.07] px-3 py-2 text-[12px] text-sky-700">
          当前会话是一个分支，继承了上一条会话的前 {session.forkMeta?.parentVisibleTaskCount} 个任务作为上下文。
        </div>
      )}
      {hasCompaction && (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.07] px-3 py-2 text-[12px] text-emerald-700">
          为了减小大项目上下文压力，早期 {session.compaction?.compactedTaskCount} 个任务已被整理成摘要，后续执行仍会保留这些结论。
        </div>
      )}
    </div>
  );
}
