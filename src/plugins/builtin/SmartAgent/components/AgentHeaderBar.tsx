import React from "react";
import { Bot, Trash2, Wrench } from "lucide-react";

interface AgentHeaderBarProps {
  onBack?: () => void;
  sessionsCount: number;
  availableToolsCount: number;
  scheduledTasksCount: number;
  showToolsWorkbench: boolean;
  showOrchestratorWorkbench: boolean;
  planMode: boolean;
  hasAnySteps: boolean;
  onShowHistory: () => void;
  onToggleToolsWorkbench: () => void;
  onToggleOrchestratorWorkbench: () => void;
  onTogglePlanMode: () => void;
  onClear: () => void;
}

export function AgentHeaderBar({
  onBack,
  sessionsCount,
  availableToolsCount,
  scheduledTasksCount,
  showToolsWorkbench,
  showOrchestratorWorkbench,
  planMode,
  hasAnySteps,
  onShowHistory,
  onToggleToolsWorkbench,
  onToggleOrchestratorWorkbench,
  onTogglePlanMode,
  onClear,
}: AgentHeaderBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
      <div className="flex items-center gap-2">
        {onBack && (
          <button
            onClick={onBack}
            className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
          >
            ←
          </button>
        )}
        <Bot className="w-5 h-5 text-emerald-500" />
        <h2 className="font-semibold">智能 Agent</h2>
        <span className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] px-2 py-0.5 rounded-full">
          ReAct
        </span>
      </div>
      <div className="flex gap-1">
        <button
          onClick={onShowHistory}
          className="text-xs px-2 py-1 rounded bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] relative"
        >
          历史
          {sessionsCount > 1 && (
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-500 text-white text-[7px] rounded-full flex items-center justify-center font-medium">
              {sessionsCount}
            </span>
          )}
        </button>
        <button
          onClick={onToggleToolsWorkbench}
          className={`text-xs px-2 py-1 rounded ${
            showToolsWorkbench
              ? "bg-emerald-500/15 text-emerald-600"
              : "bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          }`}
        >
          <Wrench className="w-3 h-3 inline mr-1" />
          {availableToolsCount} 工具
        </button>
        <button
          onClick={onToggleOrchestratorWorkbench}
          className={`text-xs px-2 py-1 rounded ${
            showOrchestratorWorkbench
              ? "bg-amber-500/15 text-amber-700"
              : "bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          }`}
        >
          编排 {scheduledTasksCount > 0 ? `(${scheduledTasksCount})` : ""}
        </button>
        <button
          onClick={onTogglePlanMode}
          className={`text-xs px-2 py-1 rounded ${
            planMode
              ? "bg-emerald-500/15 text-emerald-500"
              : "bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          }`}
          title="Plan Mode：先输出计划，确认后执行"
        >
          Plan {planMode ? "On" : "Off"}
        </button>
        {hasAnySteps && (
          <button onClick={onClear} className="p-1 rounded hover:bg-[var(--color-bg-secondary)]">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
