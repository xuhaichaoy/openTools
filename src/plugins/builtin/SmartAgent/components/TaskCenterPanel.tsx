/**
 * TaskCenterPanel — 任务中心
 *
 * 展示长期定时任务，并附带最近的 Agent 协作任务状态概览。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Filter,
  ListChecks,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useAgentStore } from "@/store/agent-store";
import type {
  AgentScheduledTask,
  AgentTaskOriginMode,
  AgentTaskResultStatus,
  AgentTaskStatus,
} from "@/core/ai/types";
import {
  hasPersistentSchedule,
  isScheduledTaskActive,
  isScheduledTaskDone,
  parsePersistentScheduledQuery,
} from "@/core/agent/scheduled-task-utils";
import { useActorSystemStore } from "@/store/actor-system-store";
import { useTaskCenterStore } from "@/store/task-center-store";

type ScheduledFilter = "all" | "active" | "paused" | "attention" | "done";
type ScheduledSourceFilter = "all" | AgentTaskOriginMode;

const FILTER_LABELS: Record<ScheduledFilter, string> = {
  all: "全部",
  active: "已启用",
  paused: "已暂停",
  attention: "需关注",
  done: "已结束",
};

const STATUS_LABELS: Record<AgentTaskStatus, string> = {
  pending: "等待下次执行",
  running: "执行中",
  success: "最近成功",
  error: "最近失败",
  paused: "已暂停",
  cancelled: "已取消",
};

const RESULT_LABELS: Record<AgentTaskResultStatus, string> = {
  success: "成功",
  error: "失败",
  skipped: "跳过",
};

const ORIGIN_LABELS: Record<AgentTaskOriginMode, string> = {
  local: "本机",
  dingtalk: "钉钉",
  feishu: "飞书",
};

const ORIGIN_BADGE_STYLES: Record<AgentTaskOriginMode, string> = {
  local: "bg-slate-500/10 text-slate-700",
  dingtalk: "bg-emerald-500/10 text-emerald-700",
  feishu: "bg-blue-500/10 text-blue-700",
};

const STATUS_BADGE_STYLES: Record<AgentTaskStatus, string> = {
  pending: "bg-sky-500/10 text-sky-700",
  running: "bg-blue-500/10 text-blue-700",
  success: "bg-emerald-500/10 text-emerald-700",
  error: "bg-red-500/10 text-red-700",
  paused: "bg-amber-500/10 text-amber-700",
  cancelled: "bg-slate-500/10 text-slate-600",
};

const AGENT_TASK_STATUS_LABELS = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
} as const;

const AGENT_TASK_STATUS_BADGE_STYLES = {
  queued: "bg-slate-500/10 text-slate-700",
  running: "bg-blue-500/10 text-blue-700",
  completed: "bg-emerald-500/10 text-emerald-700",
  failed: "bg-red-500/10 text-red-700",
  aborted: "bg-amber-500/10 text-amber-700",
} as const;

function formatDate(timestamp?: number): string {
  if (!timestamp) return "-";
  const value = new Date(timestamp);
  const now = new Date();
  const sameDay = value.toDateString() === now.toDateString();
  if (sameDay) {
    return value.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return value.toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(durationMs?: number): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "-";
  }
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${(durationMs / 60_000).toFixed(1)}min`;
}

function formatCompactPath(filePath?: string): string | null {
  const normalized = String(filePath ?? "").trim();
  if (!normalized) return null;
  const segments = normalized.split("/");
  return segments.slice(-2).join("/") || normalized;
}

function formatScheduledValue(task: AgentScheduledTask): string {
  if (!task.schedule_type) return "未配置";
  if (task.schedule_type === "once") {
    const value = Number(task.schedule_value);
    return Number.isFinite(value)
      ? `一次性 · ${formatDate(value)}`
      : `一次性 · ${task.schedule_value || "-"}`;
  }
  if (task.schedule_type === "interval") {
    const intervalMs = Number(task.schedule_value);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return `循环间隔 · ${task.schedule_value || "-"}`;
    }
    if (intervalMs < 60_000) {
      return `每 ${(intervalMs / 1000).toFixed(intervalMs % 1000 === 0 ? 0 : 1)} 秒`;
    }
    if (intervalMs < 3_600_000) {
      return `每 ${(intervalMs / 60_000).toFixed(intervalMs % 60_000 === 0 ? 0 : 1)} 分钟`;
    }
    return `每 ${(intervalMs / 3_600_000).toFixed(intervalMs % 3_600_000 === 0 ? 0 : 1)} 小时`;
  }
  return `Cron · ${task.schedule_value || "-"}`;
}

function getStatusIcon(status: AgentTaskStatus): React.ReactNode {
  switch (status) {
    case "running":
      return <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />;
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "error":
      return <XCircle className="h-4 w-4 text-red-500" />;
    case "paused":
      return <Pause className="h-4 w-4 text-amber-500" />;
    case "cancelled":
      return <XCircle className="h-4 w-4 text-slate-400" />;
    default:
      return <Clock className="h-4 w-4 text-sky-500" />;
  }
}

function getTaskOriginMode(task: AgentScheduledTask): AgentTaskOriginMode {
  return task.origin_mode ?? "local";
}

function getTaskOriginLabel(task: AgentScheduledTask): string {
  if (task.origin_label?.trim()) return task.origin_label.trim();
  return ORIGIN_LABELS[getTaskOriginMode(task)];
}

function matchesFilter(task: AgentScheduledTask, filter: ScheduledFilter): boolean {
  switch (filter) {
    case "active":
      return isScheduledTaskActive(task);
    case "paused":
      return task.status === "paused";
    case "attention":
      return task.status === "error" || task.last_result_status === "skipped";
    case "done":
      return isScheduledTaskDone(task);
    default:
      return true;
  }
}

function summarizeLastResult(task: AgentScheduledTask): string | null {
  if (!task.last_result_status) return null;
  const base = RESULT_LABELS[task.last_result_status];
  return task.last_skip_reason ? `${base} (${task.last_skip_reason})` : base;
}

const ScheduledTaskRow: React.FC<{
  task: AgentScheduledTask;
  selected: boolean;
  dense?: boolean;
  onSelect: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDelete: () => void;
}> = ({ task, selected, dense = false, onSelect, onPause, onResume, onCancel, onDelete }) => {
  const display = parsePersistentScheduledQuery(task.query);
  const originMode = getTaskOriginMode(task);
  const taskActive = isScheduledTaskActive(task);
  const taskDone = isScheduledTaskDone(task);
  const canResume = task.status === "paused";
  const canPause = taskActive && task.status !== "paused";
  const canCancel = !taskDone;
  const lastResult = summarizeLastResult(task);
  const metaLine = [display.agentName ? `执行者 ${display.agentName}` : null, formatScheduledValue(task), `下次 ${formatDate(task.next_run_at)}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`w-full rounded-lg border text-left transition-colors ${
        dense ? "h-[72px] px-2 py-1.5" : "px-2.5 py-2"
      } ${
        selected
          ? "border-sky-500/35 bg-sky-500/10 shadow-[0_0_0_1px_rgba(14,165,233,0.08)]"
          : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 hover:bg-[var(--color-bg-secondary)]"
      }`}
    >
      <div className={`flex ${dense ? "h-full items-center gap-1.5" : "items-start gap-2"}`}>
        <div className={`${dense ? "shrink-0" : "mt-0.5 shrink-0"}`}>{getStatusIcon(task.status)}</div>

        <div className={`min-w-0 flex-1 ${dense ? "flex flex-col justify-center" : ""}`}>
          <div className={`min-w-0 ${dense ? "flex items-center gap-1" : "flex flex-wrap items-center gap-1.5"}`}>
            <span className={`min-w-0 flex-1 truncate font-semibold text-[var(--color-text)] ${dense ? "text-[12px]" : "text-[13px]"}`}>
              {display.title}
            </span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-medium ${dense ? "text-[9px]" : "text-[10px]"} ${ORIGIN_BADGE_STYLES[originMode]}`}>
              {getTaskOriginLabel(task)}
            </span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-medium ${dense ? "text-[9px]" : "text-[10px]"} ${STATUS_BADGE_STYLES[task.status]}`}>
              {STATUS_LABELS[task.status]}
            </span>
          </div>

          <div className={`mt-0.5 flex items-center gap-1 text-[var(--color-text-secondary)] ${dense ? "text-[9px]" : "text-[10px]"}`}>
            <span className="min-w-0 flex-1 truncate">{metaLine}</span>
            {lastResult && (
              <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-secondary)]">
                {lastResult}
              </span>
            )}
          </div>

          {!dense && task.last_error && (
            <div className="mt-0.5 truncate text-[10px] text-red-500/80">
              {task.last_error}
            </div>
          )}
        </div>

        <div className={`flex shrink-0 items-center ${dense ? "gap-0" : "gap-0.5"}`}>
          {canResume && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onResume();
              }}
              className={`rounded-md text-[var(--color-text-secondary)] hover:bg-emerald-500/10 hover:text-emerald-600 transition-colors ${dense ? "p-0.5" : "p-1"}`}
              title="恢复任务"
            >
              <Play className={dense ? "h-3.5 w-3.5" : "h-4 w-4"} />
            </button>
          )}
          {canPause && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onPause();
              }}
              className={`rounded-md text-[var(--color-text-secondary)] hover:bg-amber-500/10 hover:text-amber-600 transition-colors ${dense ? "p-0.5" : "p-1"}`}
              title="暂停任务"
            >
              <Pause className={dense ? "h-3.5 w-3.5" : "h-4 w-4"} />
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCancel();
              }}
              className={`rounded-md text-[var(--color-text-secondary)] hover:bg-red-500/10 hover:text-red-500 transition-colors ${dense ? "p-0.5" : "p-1"}`}
              title="取消任务"
            >
              <XCircle className={dense ? "h-3.5 w-3.5" : "h-4 w-4"} />
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            className={`rounded-md text-[var(--color-text-secondary)] hover:bg-red-500/10 hover:text-red-600 transition-colors ${dense ? "p-0.5" : "p-1"}`}
            title="删除任务"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

const TaskCenterPanel: React.FC = () => {
  const scheduledTasks = useAgentStore((state) => state.scheduledTasks);
  const loadScheduledTasks = useAgentStore((state) => state.loadScheduledTasks);
  const pauseScheduledTask = useAgentStore((state) => state.pauseScheduledTask);
  const resumeScheduledTask = useAgentStore((state) => state.resumeScheduledTask);
  const cancelScheduledTask = useAgentStore((state) => state.cancelScheduledTask);
  const deleteScheduledTask = useAgentStore((state) => state.deleteScheduledTask);
  const currentDialogSessionId = useActorSystemStore((state) => state.getSystem()?.sessionId ?? null);
  const agentTasks = useTaskCenterStore((state) => state.agentTasks);
  const setAgentFilter = useTaskCenterStore((state) => state.setAgentFilter);
  const subscribeTaskCenter = useTaskCenterStore((state) => state.subscribe);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [scheduledFilter, setScheduledFilter] = useState<ScheduledFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<ScheduledSourceFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);

  useEffect(() => {
    void loadScheduledTasks();
  }, [loadScheduledTasks]);

  useEffect(() => subscribeTaskCenter(), [subscribeTaskCenter]);

  useEffect(() => {
    setAgentFilter(currentDialogSessionId ? { sessionId: currentDialogSessionId } : {});
  }, [currentDialogSessionId, setAgentFilter]);

  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;

    const updateWidth = (width: number) => {
      setPanelWidth((current) => (Math.abs(current - width) > 1 ? width : current));
    };

    updateWidth(element.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateWidth(entry.contentRect.width);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const persistentTasks = useMemo(
    () => scheduledTasks.filter((task) => hasPersistentSchedule(task)),
    [scheduledTasks],
  );

  const filteredTasks = useMemo(() => {
    return [...persistentTasks]
      .filter((task) => matchesFilter(task, scheduledFilter))
      .filter((task) => sourceFilter === "all" || getTaskOriginMode(task) === sourceFilter)
      .sort((a, b) => {
        const nextA = a.next_run_at ?? Number.MAX_SAFE_INTEGER;
        const nextB = b.next_run_at ?? Number.MAX_SAFE_INTEGER;
        if (nextA !== nextB) return nextA - nextB;
        return b.updated_at - a.updated_at;
      });
  }, [persistentTasks, scheduledFilter, sourceFilter]);

  useEffect(() => {
    if (filteredTasks.length === 0) {
      setSelectedTaskId(null);
      return;
    }
    setSelectedTaskId((current) => {
      if (current && filteredTasks.some((task) => task.id === current)) {
        return current;
      }
      return filteredTasks[0]?.id ?? null;
    });
  }, [filteredTasks]);

  const selectedTask = useMemo(
    () => (selectedTaskId ? persistentTasks.find((task) => task.id === selectedTaskId) ?? null : null),
    [persistentTasks, selectedTaskId],
  );
  const selectedDisplay = useMemo(
    () => (selectedTask ? parsePersistentScheduledQuery(selectedTask.query) : null),
    [selectedTask],
  );
  const selectedDetailItems = useMemo(() => {
    if (!selectedTask || !selectedDisplay) return [];
    return [
      { key: "agent", label: "执行者", value: selectedDisplay.agentName ?? "-" },
      { key: "schedule", label: "调度方式", value: formatScheduledValue(selectedTask) },
      { key: "next", label: "下次执行", value: formatDate(selectedTask.next_run_at) },
      { key: "result", label: "最近结果", value: summarizeLastResult(selectedTask) ?? "-" },
      { key: "started", label: "最近开始", value: formatDate(selectedTask.last_started_at) },
      { key: "finished", label: "最近结束", value: formatDate(selectedTask.last_finished_at) },
      { key: "duration", label: "最近耗时", value: formatDuration(selectedTask.last_duration_ms) },
    ];
  }, [selectedDisplay, selectedTask]);

  const stats = useMemo(() => {
    const active = persistentTasks.filter((task) => isScheduledTaskActive(task)).length;
    const running = persistentTasks.filter((task) => task.status === "running").length;
    const paused = persistentTasks.filter((task) => task.status === "paused").length;
    const attention = persistentTasks.filter((task) => task.status === "error" || task.last_result_status === "skipped").length;
    const done = persistentTasks.filter((task) => isScheduledTaskDone(task)).length;
    return {
      total: persistentTasks.length,
      active,
      running,
      paused,
      attention,
      done,
    };
  }, [persistentTasks]);

  const recentAgentTasks = useMemo(() => {
    return agentTasks.slice(0, 5);
  }, [agentTasks]);

  const agentTaskStats = useMemo(() => {
    const running = agentTasks.filter((task) => task.status === "running").length;
    const failed = agentTasks.filter((task) => task.status === "failed" || task.status === "aborted").length;
    return {
      total: agentTasks.length,
      running,
      failed,
    };
  }, [agentTasks]);

  const refreshTasks = useCallback(() => {
    void loadScheduledTasks();
  }, [loadScheduledTasks]);

  const isCompactLayout = panelWidth > 0 && panelWidth < 780;
  const isDenseLayout = panelWidth > 0 && panelWidth < 620;
  const statsBadges = [
    {
      key: "total",
      label: `共 ${stats.total} 个任务`,
      className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
    },
    {
      key: "active",
      label: `已启用 ${stats.active}`,
      className: "bg-sky-500/10 text-sky-700",
    },
    {
      key: "running",
      label: `执行中 ${stats.running}`,
      className: "bg-blue-500/10 text-blue-700",
    },
    {
      key: "paused",
      label: `已暂停 ${stats.paused}`,
      className: "bg-amber-500/10 text-amber-700",
    },
    {
      key: "attention",
      label: `需关注 ${stats.attention}`,
      className: "bg-red-500/10 text-red-700",
    },
    {
      key: "agent",
      label: `协作任务 ${agentTaskStats.total}`,
      className: "bg-violet-500/10 text-violet-700",
    },
  ];

  return (
    <div
      ref={panelRef}
      className="mx-auto flex h-full min-h-0 w-full max-w-[760px] flex-col bg-[var(--color-bg)] text-[var(--color-text)]"
    >
      <div className={`shrink-0 border-b border-[var(--color-border)] ${isDenseLayout ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="-mb-1 flex flex-1 items-center gap-1 overflow-x-auto pb-1">
            {statsBadges.map((badge) => (
              <span
                key={badge.key}
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${badge.className}`}
              >
                {badge.label}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={refreshTasks}
            className="rounded-md border border-[var(--color-border)] p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] transition-colors"
            title="刷新任务"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className={`mt-2 ${isDenseLayout ? "space-y-1.5" : "space-y-2"}`}>
          <div className={`flex ${isDenseLayout ? "flex-col items-start gap-1" : "flex-wrap items-start gap-2"}`}>
            <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
              <Filter className="h-3.5 w-3.5" />
              <span>状态</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {(Object.entries(FILTER_LABELS) as Array<[ScheduledFilter, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScheduledFilter(value)}
                  className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                    scheduledFilter === value
                      ? "bg-sky-500/10 text-sky-700"
                      : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className={`flex ${isDenseLayout ? "flex-col items-start gap-1" : "flex-wrap items-start gap-2"}`}>
            <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
              <Filter className="h-3.5 w-3.5" />
              <span>来源</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {(["all", "local", "dingtalk", "feishu"] as const).map((origin) => (
                <button
                  key={origin}
                  type="button"
                  onClick={() => setSourceFilter(origin)}
                  className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                    sourceFilter === origin
                      ? "bg-emerald-500/10 text-emerald-700"
                      : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                  }`}
                >
                  {origin === "all" ? "全部来源" : ORIGIN_LABELS[origin]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={`min-h-0 flex-1 ${isDenseLayout ? "p-1.5" : "p-2"}`}>
        <div className="flex h-full min-h-0 flex-col gap-2">
          {recentAgentTasks.length > 0 && (
            <div className="shrink-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20">
              <div className={`flex items-center justify-between border-b border-[var(--color-border)] ${isDenseLayout ? "px-2.5 py-1.5" : "px-3 py-2"}`}>
                <div>
                  <div className="text-[12px] font-semibold text-[var(--color-text)]">Agent 协作任务</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    最近同步的 child / background / remote agent 生命周期
                  </div>
                </div>
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-blue-700">运行中 {agentTaskStats.running}</span>
                  <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-700">异常 {agentTaskStats.failed}</span>
                </div>
              </div>

              <div className={`${isDenseLayout ? "space-y-1 p-1.5" : "space-y-1.5 p-2"}`}>
                {recentAgentTasks.map((task) => {
                  const actorLabel = task.targetName ?? task.title;
                  const secondaryLine = [
                    task.spawnerName ? `派发者 ${task.spawnerName}` : null,
                    task.mode === "session" ? "会话模式" : "运行模式",
                    task.pendingMessageCount > 0 ? `待处理消息 ${task.pendingMessageCount}` : null,
                    task.progress?.toolUseCount ? `工具 ${task.progress.toolUseCount}` : null,
                    formatDate(task.lastActiveAt ?? task.completedAt ?? task.startedAt ?? task.createdAt),
                  ].filter(Boolean).join(" · ");
                  const detailBadges = [
                    task.progress?.latestToolName ? `最近工具 ${task.progress.latestToolName}` : null,
                    task.outputFile ? `产物 ${formatCompactPath(task.outputFile)}` : null,
                    task.progress?.eventCount ? `事件 ${task.progress.eventCount}` : null,
                  ].filter(Boolean);
                  return (
                    <div
                      key={task.taskId}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2.5 py-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[12px] font-semibold text-[var(--color-text)]">
                              {actorLabel}
                            </span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${AGENT_TASK_STATUS_BADGE_STYLES[task.status]}`}>
                              {AGENT_TASK_STATUS_LABELS[task.status]}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                            {secondaryLine}
                          </div>
                          <div className="mt-1 line-clamp-2 text-[11px] text-[var(--color-text)]">
                            {task.recentActivitySummary ?? task.outputSummary ?? task.description}
                          </div>
                          {detailBadges.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {detailBadges.map((badge) => (
                                <span
                                  key={`${task.taskId}-${badge}`}
                                  className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                                >
                                  {badge}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {filteredTasks.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/25 px-6 text-center">
              <div className="max-w-sm">
                <ListChecks className="mx-auto mb-3 h-10 w-10 text-[var(--color-text-tertiary)] opacity-40" />
                <div className="text-[15px] font-medium text-[var(--color-text)]">当前没有匹配的定时任务</div>
                <p className="mt-2 text-[12px] leading-6 text-[var(--color-text-secondary)]">
                  这里会统一展示 Agent 创建的 once、interval、cron 任务，也会在上方显示最近的协作 AgentTask 状态。
                </p>
              </div>
            </div>
          ) : (
            <div className={isCompactLayout ? "grid min-h-0 flex-1 gap-2 grid-rows-[minmax(180px,0.95fr)_minmax(240px,1.1fr)]" : "grid min-h-0 flex-1 gap-2 grid-cols-[minmax(0,1fr)_260px]"}>
              <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20">
                <div className={`shrink-0 border-b border-[var(--color-border)] ${isDenseLayout ? "px-2.5 py-1.5 text-[10px]" : "px-3 py-1.5 text-[11px]"} text-[var(--color-text-secondary)]`}>
                  当前列表 {filteredTasks.length} 项
                </div>
                <div className={`min-h-0 flex-1 overflow-y-auto ${isDenseLayout ? "space-y-1 p-1.5" : "space-y-1.5 p-2"}`}>
                  {filteredTasks.map((task) => (
                    <ScheduledTaskRow
                      key={task.id}
                      task={task}
                      selected={task.id === selectedTaskId}
                      dense
                      onSelect={() => setSelectedTaskId(task.id)}
                      onPause={() => void pauseScheduledTask(task.id)}
                      onResume={() => void resumeScheduledTask(task.id)}
                      onCancel={() => void cancelScheduledTask(task.id)}
                      onDelete={() => void deleteScheduledTask(task.id)}
                    />
                  ))}
                </div>
              </div>

              <div
                className={`flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 ${
                  "h-full"
                }`}
              >
                {selectedTask && selectedDisplay ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className={`shrink-0 border-b border-[var(--color-border)] ${isDenseLayout ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            {getStatusIcon(selectedTask.status)}
                            <h3 className={`${isDenseLayout ? "text-[13px]" : "text-[14px]"} min-w-0 flex-1 truncate whitespace-nowrap font-semibold text-[var(--color-text)]`}>
                              {selectedDisplay.title}
                            </h3>
                          </div>
                          <div className="mt-1 flex items-center gap-1 overflow-x-auto whitespace-nowrap pb-0.5">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${ORIGIN_BADGE_STYLES[getTaskOriginMode(selectedTask)]}`}>
                              {getTaskOriginLabel(selectedTask)}
                            </span>
                            {isScheduledTaskActive(selectedTask) && selectedTask.status !== "running" && (
                              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                                已启用
                              </span>
                            )}
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_BADGE_STYLES[selectedTask.status]}`}>
                              {STATUS_LABELS[selectedTask.status]}
                            </span>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1 self-start">
                          {selectedTask.status === "paused" && (
                            <button
                              type="button"
                              onClick={() => void resumeScheduledTask(selectedTask.id)}
                              className={isCompactLayout
                                ? "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-emerald-500/10 hover:text-emerald-700 transition-colors"
                                : "shrink-0 whitespace-nowrap rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-emerald-500/10 hover:text-emerald-700 transition-colors"}
                              title="恢复"
                            >
                              {isCompactLayout ? <Play className="h-3.5 w-3.5" /> : "恢复"}
                            </button>
                          )}
                          {isScheduledTaskActive(selectedTask) && selectedTask.status !== "paused" && (
                            <button
                              type="button"
                              onClick={() => void pauseScheduledTask(selectedTask.id)}
                              className={isCompactLayout
                                ? "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-amber-500/10 hover:text-amber-700 transition-colors"
                                : "shrink-0 whitespace-nowrap rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-amber-500/10 hover:text-amber-700 transition-colors"}
                              title="暂停"
                            >
                              {isCompactLayout ? <Pause className="h-3.5 w-3.5" /> : "暂停"}
                            </button>
                          )}
                          {!isScheduledTaskDone(selectedTask) && (
                            <button
                              type="button"
                              onClick={() => void cancelScheduledTask(selectedTask.id)}
                              className={isCompactLayout
                                ? "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-red-500/10 hover:text-red-600 transition-colors"
                                : "shrink-0 whitespace-nowrap rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-red-500/10 hover:text-red-600 transition-colors"}
                              title="取消"
                            >
                              {isCompactLayout ? <XCircle className="h-3.5 w-3.5" /> : "取消"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void deleteScheduledTask(selectedTask.id)}
                            className={isCompactLayout
                              ? "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-red-500/10 hover:text-red-600 transition-colors"
                              : "shrink-0 whitespace-nowrap rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-red-500/10 hover:text-red-600 transition-colors"}
                            title="删除"
                          >
                            {isCompactLayout ? <Trash2 className="h-3.5 w-3.5" /> : "删除"}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className={isCompactLayout ? "min-h-0 flex-1 overflow-y-auto px-3 py-2" : `min-h-0 flex-1 overflow-y-auto ${isDenseLayout ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
                      <div className={`grid ${isCompactLayout ? "grid-cols-3 gap-2" : "grid-cols-1 gap-1.5"} text-[10px] text-[var(--color-text-secondary)]`}>
                        {selectedDetailItems.map((item) => (
                          <div
                            key={item.key}
                            className="min-w-0 rounded-lg bg-[var(--color-bg)]/70 px-2.5 py-1.5"
                          >
                            <div className="truncate text-[10px] text-[var(--color-text-tertiary)]">
                              {item.label}
                            </div>
                            <div
                              className={`mt-0.5 truncate font-medium text-[var(--color-text)] ${isCompactLayout ? "text-[12px]" : "text-[12px]"}`}
                              title={item.value}
                            >
                              {item.value}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-2 rounded-lg bg-[var(--color-bg)]/60 px-2.5 py-1.5 text-[10px] text-[var(--color-text-secondary)]">
                        <div className="text-[10px] text-[var(--color-text-tertiary)]">关联会话</div>
                        <div className="mt-0.5 truncate text-[12px] text-[var(--color-text)]" title={selectedTask.session_id ?? "-"}>
                          {selectedTask.session_id ?? "-"}
                        </div>
                      </div>

                      {selectedTask.last_error && (
                        <div className="mt-3 rounded-lg bg-red-500/8 px-2.5 py-2 text-[10px] text-red-600">
                          最近错误: {selectedTask.last_error}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center">
                    <div className="max-w-xs">
                      <Clock className="mx-auto mb-3 h-10 w-10 text-[var(--color-text-tertiary)] opacity-35" />
                      <div className="text-[14px] font-medium text-[var(--color-text)]">选择一条任务查看详情</div>
                      <p className="mt-2 text-[12px] leading-6 text-[var(--color-text-secondary)]">
                        右侧会展示执行者、调度方式、最近结果和错误信息。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TaskCenterPanel;
