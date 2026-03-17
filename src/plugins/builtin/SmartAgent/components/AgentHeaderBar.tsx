import React from "react";
import { Bot, LayoutPanelLeft, Plus, Trash2, Wrench } from "lucide-react";

interface AgentHeaderBarProps {
  onBack?: () => void;
  sessionsCount: number;
  availableToolsCount: number;
  scheduledTasksCount: number;
  queuedFollowUpsCount: number;
  currentSessionTitle?: string | null;
  busy: boolean;
  showReviewWorkbench: boolean;
  showToolsWorkbench: boolean;
  showOrchestratorWorkbench: boolean;
  hasAnySteps: boolean;
  canRevert: boolean;
  onShowHistory: () => void;
  onNewSession: () => void;
  onRevert: () => void;
  onToggleReviewWorkbench: () => void;
  onToggleToolsWorkbench: () => void;
  onToggleOrchestratorWorkbench: () => void;
  onClear: () => void;
}

export function AgentHeaderBar({
  onBack,
  sessionsCount,
  availableToolsCount,
  scheduledTasksCount,
  queuedFollowUpsCount,
  currentSessionTitle,
  busy,
  showReviewWorkbench,
  showToolsWorkbench,
  showOrchestratorWorkbench,
  hasAnySteps,
  canRevert,
  onShowHistory,
  onNewSession,
  onRevert,
  onToggleReviewWorkbench,
  onToggleToolsWorkbench,
  onToggleOrchestratorWorkbench,
  onClear,
}: AgentHeaderBarProps) {
  return (
    <div className="border-b border-[var(--color-border)] bg-linear-to-b from-[var(--color-bg)] to-[var(--color-bg-secondary)]/35 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-2.5">
          {onBack && (
            <button
              onClick={onBack}
              className="mt-0.5 rounded-md p-1 hover:bg-[var(--color-bg-secondary)] transition-colors"
            >
              ←
            </button>
          )}
          <div className="mt-0.5 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2 text-emerald-600">
            <Bot className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-[15px]">单 Agent 持续执行</h2>
              <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                ReAct
              </span>
              {busy && (
                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600">
                  运行中
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-secondary)]">
              <span>适合读代码、改文件、跑命令、验证结果</span>
              {currentSessionTitle ? (
                <span className="truncate max-w-[320px]">当前会话：{currentSessionTitle}</span>
              ) : (
                <span>当前会话：新任务</span>
              )}
              {queuedFollowUpsCount > 0 && <span>排队跟进：{queuedFollowUpsCount}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <button
            onClick={onNewSession}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 px-2.5 py-1 text-[11px] text-emerald-600 hover:bg-emerald-500/10"
          >
            <Plus className="w-3.5 h-3.5" />
            新会话
          </button>
        <button
          onClick={onShowHistory}
          className="text-xs px-2 py-1 rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] relative"
        >
          历史
          {sessionsCount > 1 && (
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-500 text-white text-[7px] rounded-full flex items-center justify-center font-medium">
              {sessionsCount}
            </span>
          )}
        </button>
        <button
          onClick={onRevert}
          disabled={!canRevert}
          className="text-xs px-2 py-1 rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          回退
        </button>
        <button
          onClick={onToggleReviewWorkbench}
          className={`text-xs px-2 py-1 rounded-full border ${
            showReviewWorkbench
              ? "border-sky-500/20 bg-sky-500/15 text-sky-700"
              : "border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-bg-tertiary)]"
          }`}
        >
          <LayoutPanelLeft className="w-3 h-3 inline mr-1" />
          工作台 {queuedFollowUpsCount > 0 ? `(${queuedFollowUpsCount})` : ""}
        </button>
        <button
          onClick={onToggleToolsWorkbench}
          className={`text-xs px-2 py-1 rounded-full border ${
            showToolsWorkbench
              ? "border-emerald-500/20 bg-emerald-500/15 text-emerald-600"
              : "border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-bg-tertiary)]"
          }`}
        >
          <Wrench className="w-3 h-3 inline mr-1" />
          {availableToolsCount} 工具
        </button>
        <button
          onClick={onToggleOrchestratorWorkbench}
          className={`text-xs px-2 py-1 rounded-full border ${
            showOrchestratorWorkbench
              ? "border-amber-500/20 bg-amber-500/15 text-amber-700"
              : "border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-bg-tertiary)]"
          }`}
        >
          编排 {scheduledTasksCount > 0 ? `(${scheduledTasksCount})` : ""}
        </button>
        {hasAnySteps && (
          <button onClick={onClear} className="rounded-full p-1.5 hover:bg-[var(--color-bg-secondary)]">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
