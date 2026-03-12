/**
 * TaskCenterPanel — 任务中心 UI 面板
 *
 * 显示任务队列、状态、进度、过滤和操作。
 */

import React, { useEffect, useMemo, useCallback, useState } from "react";
import {
  ListChecks,
  Clock,
  Play,
  CheckCircle2,
  XCircle,
  Pause,
  Trash2,
  Filter,
  BarChart3,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { useTaskCenterStore } from "@/store/task-center-store";
import type { TaskRecord, TaskStatus, TaskPriority } from "@/core/task-center/types";

const STATUS_ICONS: Record<TaskStatus, React.ReactNode> = {
  pending: <Clock className="w-3.5 h-3.5 text-gray-400" />,
  queued: <Play className="w-3.5 h-3.5 text-blue-400" />,
  running: <RefreshCw className="w-3.5 h-3.5 text-blue-500 animate-spin" />,
  paused: <Pause className="w-3.5 h-3.5 text-yellow-500" />,
  completed: <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />,
  failed: <XCircle className="w-3.5 h-3.5 text-red-500" />,
  cancelled: <XCircle className="w-3.5 h-3.5 text-gray-400" />,
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "待执行",
  queued: "排队中",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  urgent: "text-red-500 bg-red-500/10",
  high: "text-orange-500 bg-orange-500/10",
  normal: "text-blue-500 bg-blue-500/10",
  low: "text-gray-400 bg-gray-400/10",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "紧急",
  high: "高",
  normal: "普通",
  low: "低",
};

function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const TaskRow: React.FC<{
  task: TaskRecord;
  selected: boolean;
  onSelect: () => void;
  onCancel: () => void;
}> = ({ task, selected, onSelect, onCancel }) => {
  const elapsed = task.startedAt
    ? (task.completedAt ?? Date.now()) - task.startedAt
    : 0;

  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors rounded-lg ${
        selected
          ? "bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/30"
          : "hover:bg-[var(--color-bg-secondary)]"
      }`}
    >
      <div className="shrink-0">{STATUS_ICONS[task.status]}</div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{task.title}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${PRIORITY_COLORS[task.priority]}`}>
            {PRIORITY_LABELS[task.priority]}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-[var(--color-text-secondary)]">
            {STATUS_LABELS[task.status]}
          </span>
          {elapsed > 0 && (
            <span className="text-xs text-[var(--color-text-secondary)]">
              {formatTime(elapsed)}
            </span>
          )}
          <span className="text-xs text-[var(--color-text-secondary)]">
            {formatDate(task.createdAt)}
          </span>
        </div>
        {task.status === "running" && task.progress != null && (
          <div className="mt-1.5">
            <div className="w-full h-1.5 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${task.progress}%` }}
              />
            </div>
            {task.progressLabel && (
              <span className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                {task.progressLabel}
              </span>
            )}
          </div>
        )}
      </div>

      {(task.status === "pending" || task.status === "queued" || task.status === "running") && (
        <button
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          className="shrink-0 p-1 rounded hover:bg-red-500/10 hover:text-red-500 transition-colors"
          title="取消任务"
        >
          <XCircle className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};

const TaskCenterPanel: React.FC = () => {
  const { tasks, stats, filter, selectedTaskId, refresh, cancelTask, cleanup, setFilter, selectTask, subscribe } =
    useTaskCenterStore();

  const [showStats, setShowStats] = useState(false);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");

  useEffect(() => {
    const unsub = subscribe();
    refresh();
    return unsub;
  }, [subscribe, refresh]);

  const handleStatusFilter = useCallback(
    (status: TaskStatus | "all") => {
      setStatusFilter(status);
      if (status === "all") {
        setFilter({});
      } else {
        setFilter({ ...filter, status: [status] });
      }
    },
    [filter, setFilter],
  );

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null),
    [tasks, selectedTaskId],
  );

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <ListChecks className="w-5 h-5 text-blue-500" />
          <h2 className="font-semibold text-sm">任务中心</h2>
          <span className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] px-2 py-0.5 rounded-full">
            {stats.total} 个任务
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowStats(!showStats)}
            className={`p-1.5 rounded transition-colors ${showStats ? "bg-blue-500/10 text-blue-500" : "hover:bg-[var(--color-bg-secondary)]"}`}
            title="统计"
          >
            <BarChart3 className="w-4 h-4" />
          </button>
          <button
            onClick={refresh}
            className="p-1.5 rounded hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="刷新"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => cleanup()}
            className="p-1.5 rounded hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="清理旧任务"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats */}
      {showStats && (
        <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <div className="text-lg font-bold text-blue-500">{stats.byStatus.running}</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">执行中</div>
            </div>
            <div>
              <div className="text-lg font-bold text-yellow-500">{stats.byStatus.pending + stats.byStatus.queued}</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">待执行</div>
            </div>
            <div>
              <div className="text-lg font-bold text-green-500">{stats.byStatus.completed}</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">已完成</div>
            </div>
            <div>
              <div className="text-lg font-bold text-red-500">{stats.byStatus.failed}</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">失败</div>
            </div>
          </div>
          {stats.avgCompletionTimeMs > 0 && (
            <div className="text-xs text-[var(--color-text-secondary)] text-center mt-2">
              平均完成时间: {formatTime(stats.avgCompletionTimeMs)} | 失败率: {(stats.failureRate * 100).toFixed(1)}%
            </div>
          )}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-[var(--color-border)] overflow-x-auto">
        <Filter className="w-3.5 h-3.5 text-[var(--color-text-secondary)] shrink-0" />
        {(["all", "running", "pending", "completed", "failed"] as const).map((s) => (
          <button
            key={s}
            onClick={() => handleStatusFilter(s)}
            className={`text-xs px-2 py-1 rounded-md whitespace-nowrap transition-colors ${
              statusFilter === s
                ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)] font-medium"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
            }`}
          >
            {s === "all" ? "全部" : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-auto px-2 py-1">
        {tasks.length === 0 ? (
          <div className="text-center py-12 text-[var(--color-text-secondary)]">
            <ListChecks className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p className="text-sm">暂无任务</p>
            <p className="text-xs mt-1 opacity-60">Agent 执行的任务会自动出现在这里</p>
          </div>
        ) : (
          <div className="space-y-1">
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                selected={task.id === selectedTaskId}
                onSelect={() => selectTask(task.id === selectedTaskId ? null : task.id)}
                onCancel={() => cancelTask(task.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Task detail */}
      {selectedTask && (
        <div className="border-t border-[var(--color-border)] px-4 py-3 bg-[var(--color-bg-secondary)] max-h-48 overflow-auto">
          <div className="flex items-center gap-2 mb-2">
            {STATUS_ICONS[selectedTask.status]}
            <span className="text-sm font-medium">{selectedTask.title}</span>
          </div>
          {selectedTask.description && (
            <p className="text-xs text-[var(--color-text-secondary)] mb-2">{selectedTask.description}</p>
          )}
          {selectedTask.result && (
            <div className="text-xs bg-[var(--color-bg)] p-2 rounded mt-1 max-h-20 overflow-auto whitespace-pre-wrap">
              {selectedTask.result}
            </div>
          )}
          {selectedTask.error && (
            <div className="text-xs text-red-500 bg-red-500/10 p-2 rounded mt-1">
              {selectedTask.error}
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-[var(--color-text-secondary)]">
            <span>类型: {selectedTask.type}</span>
            <span>创建: {formatDate(selectedTask.createdAt)}</span>
            {selectedTask.assignee && <span>执行者: {selectedTask.assignee}</span>}
            {selectedTask.tags?.length ? <span>标签: {selectedTask.tags.join(", ")}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskCenterPanel;
