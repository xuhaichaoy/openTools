import React from "react";
import type { AgentPromptContextSnapshot } from "../core/prompt-context";
import type { AgentSession } from "@/store/agent-store";

interface AgentSessionContextStripProps {
  session: AgentSession;
  snapshot?: AgentPromptContextSnapshot | null;
  hiddenTaskCount: number;
  onRedo: () => void;
  onRestore: () => void;
  onFork: () => void;
}

function describeContinuityStrategy(strategy?: string): string {
  switch (strategy) {
    case "inherit_full":
      return "延续完整历史";
    case "inherit_summary_only":
      return "仅继承历史摘要";
    case "inherit_recent_only":
      return "仅继承最近步骤";
    case "soft_reset":
      return "软重置上下文";
    case "fork_session":
      return "新分支会话";
    default:
      return "自动继承";
  }
}

function describeContinuityReason(reason?: string): string | null {
  switch (reason) {
    case "same_workspace":
      return "同一工作区";
    case "workspace_switch":
      return "工作区切换";
    case "query_topic_switch":
      return "任务主题切换";
    case "explicit_new_task":
      return "明确要求新任务";
    case "force_new_session":
      return "手动新建会话";
    default:
      return null;
  }
}

export function AgentSessionContextStrip({
  session,
  snapshot,
  hiddenTaskCount,
  onRedo,
  onRestore,
  onFork,
}: AgentSessionContextStripProps) {
  const hasRevertedContext = hiddenTaskCount > 0;
  const hasForkMeta = Boolean(session.forkMeta);
  const hasCompaction = Boolean(session.compaction?.summary);
  const compactionIdentifiers =
    session.compaction?.preservedIdentifiers?.slice(0, 6) ?? [];
  const compactionRules =
    session.compaction?.bootstrapReinjectionPreview?.slice(0, 2) ?? [];
  const workspaceRoot = snapshot?.workspaceRoot ?? session.workspaceRoot;
  const continuityStrategy =
    snapshot?.continuityStrategy ?? session.lastContinuityStrategy;
  const continuityReason =
    snapshot?.continuityReason ?? session.lastContinuityReason;
  const workspaceReset =
    snapshot?.workspaceReset ?? Boolean(session.lastContextResetAt);
  const memoryItemCount =
    snapshot?.memoryItemCount ?? session.lastMemoryItemCount ?? 0;
  const hasContextSummary =
    Boolean(workspaceRoot)
    || Boolean(continuityStrategy)
    || workspaceReset
    || memoryItemCount > 0;

  if (!hasRevertedContext && !hasForkMeta && !hasCompaction && !hasContextSummary) {
    return null;
  }

  return (
    <div className="mx-4 mt-2 mb-1 space-y-2">
      {hasContextSummary && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-[var(--color-text)]">
              当前上下文
            </span>
            {workspaceRoot && (
              <span
                className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                title={workspaceRoot}
              >
                工作区 {workspaceRoot}
              </span>
            )}
            {continuityStrategy && (
              <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700">
                {describeContinuityStrategy(continuityStrategy)}
              </span>
            )}
            {memoryItemCount > 0 && (
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700">
                记忆 {memoryItemCount}
              </span>
            )}
            {hasCompaction && (
              <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
                摘要 {session.compaction?.compactedTaskCount}
              </span>
            )}
          </div>
          <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            {workspaceReset
              ? `这轮已按${workspaceRoot ? "新工作区" : "新任务"}重置历史继承${describeContinuityReason(continuityReason) ? `，原因：${describeContinuityReason(continuityReason)}` : ""}。`
              : `${continuityStrategy ? describeContinuityStrategy(continuityStrategy) : "自动继承"}${describeContinuityReason(continuityReason) ? `，原因：${describeContinuityReason(continuityReason)}` : ""}${memoryItemCount > 0 ? `；同时召回了 ${memoryItemCount} 条长期记忆。` : "。"}`
            }
          </div>
        </div>
      )}
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
          {compactionIdentifiers.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {compactionIdentifiers.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-emerald-500/20 bg-white/70 px-2 py-0.5 text-[10px] text-emerald-700"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
          {compactionRules.length > 0 && (
            <div className="mt-2 text-[11px] leading-5 text-emerald-700/90">
              规则回注：{compactionRules.join("；")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
