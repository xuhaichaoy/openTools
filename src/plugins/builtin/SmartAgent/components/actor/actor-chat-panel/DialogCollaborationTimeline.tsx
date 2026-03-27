import React, { useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Loader2,
  Sparkles,
} from "lucide-react";

import { getSpawnedTaskRoleBoundaryMeta } from "@/core/agent/actor/spawned-task-role-boundary";
import type {
  DialogMessage,
  SpawnedTaskLifecycleEvent,
  SpawnedTaskLifecycleEventType,
  SpawnedTaskRecord,
  SpawnedTaskRoleBoundary,
  SpawnedTaskStatus,
} from "@/core/agent/actor/types";
import { formatDurationSeconds } from "@/core/agent/actor/timeout-policy";

const GROUP_JOIN_WINDOW_MS = 6000;
const GROUP_CONTRACT_MAX_GAP_MS = 120000;
const MILESTONE_EVENT_LIMIT = 12;

type GroupPhase = "dispatching" | "running" | "awaiting_aggregation" | "aggregated";

export interface LocalCollaborationTimelineWorker {
  runId: string;
  spawnerActorId: string;
  spawnerName: string;
  targetActorId: string;
  targetName: string;
  contractId?: string;
  plannedDelegationId?: string;
  dispatchSource?: SpawnedTaskRecord["dispatchSource"];
  parentRunId?: string;
  rootRunId?: string;
  mode?: SpawnedTaskRecord["mode"];
  roleBoundary?: SpawnedTaskRoleBoundary;
  label: string;
  task: string;
  status: SpawnedTaskStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  latestMessage?: string;
  resultPreview?: string;
  errorMessage?: string;
  timeoutReason?: SpawnedTaskRecord["timeoutReason"];
  budgetSeconds?: number;
  idleLeaseSeconds?: number;
  events: SpawnedTaskLifecycleEvent[];
}

export interface LocalCollaborationTimelineMilestone {
  id: string;
  timestamp: number;
  tone: "neutral" | "success" | "danger";
  text: string;
}

export interface LocalCollaborationTimelineGroup {
  id: string;
  spawnerActorId: string;
  spawnerName: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  phase: GroupPhase;
  title: string;
  summary: string;
  totalWorkers: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  activeWorkerNames: string[];
  latestParentReply?: string;
  workers: LocalCollaborationTimelineWorker[];
  milestones: LocalCollaborationTimelineMilestone[];
}

export type LocalDialogTranscriptItem =
  | {
      kind: "message";
      id: string;
      timestamp: number;
      message: DialogMessage;
    }
  | {
      kind: "collaboration_group";
      id: string;
      timestamp: number;
      group: LocalCollaborationTimelineGroup;
    };

function compactText(value: string | undefined, maxLength = 120): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function formatShortTime(timestamp?: number): string {
  if (!timestamp) return "--";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatElapsed(ms?: number): string | null {
  if (!ms || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function buildWorkerStatusMeta(worker: Pick<LocalCollaborationTimelineWorker, "status" | "timeoutReason">): {
  label: string;
  badgeClassName: string;
  dotClassName: string;
} {
  if (worker.status === "aborted" && worker.timeoutReason === "idle") {
    return {
      label: "空闲超时",
      badgeClassName: "bg-amber-500/10 text-amber-700",
      dotClassName: "bg-amber-500",
    };
  }
  if (worker.status === "aborted" && worker.timeoutReason === "budget") {
    return {
      label: "预算耗尽",
      badgeClassName: "bg-orange-500/10 text-orange-700",
      dotClassName: "bg-orange-500",
    };
  }
  switch (worker.status) {
    case "completed":
      return {
        label: "已完成",
        badgeClassName: "bg-emerald-500/10 text-emerald-700",
        dotClassName: "bg-emerald-500",
      };
    case "error":
      return {
        label: "失败",
        badgeClassName: "bg-red-500/10 text-red-700",
        dotClassName: "bg-red-500",
      };
    case "aborted":
      return {
        label: "已中止",
        badgeClassName: "bg-amber-500/10 text-amber-700",
        dotClassName: "bg-amber-500",
      };
    default:
      return {
        label: "运行中",
        badgeClassName: "bg-sky-500/10 text-sky-700",
        dotClassName: "bg-sky-500",
      };
  }
}

function buildGroupPhaseMeta(phase: GroupPhase): {
  label: string;
  className: string;
} {
  switch (phase) {
    case "aggregated":
      return {
        label: "已回流",
        className: "bg-emerald-500/10 text-emerald-700",
      };
    case "awaiting_aggregation":
      return {
        label: "等待汇总",
        className: "bg-violet-500/10 text-violet-700",
      };
    case "dispatching":
      return {
        label: "派发中",
        className: "bg-cyan-500/10 text-cyan-700",
      };
    default:
      return {
        label: "进行中",
        className: "bg-sky-500/10 text-sky-700",
      };
  }
}

function eventTypePriority(eventType: SpawnedTaskLifecycleEventType): number {
  switch (eventType) {
    case "spawned_task_started":
      return 0;
    case "spawned_task_running":
      return 1;
    case "spawned_task_completed":
      return 2;
    case "spawned_task_failed":
      return 3;
    case "spawned_task_timeout":
      return 4;
    default:
      return 9;
  }
}

function buildMilestoneText(worker: LocalCollaborationTimelineWorker, event: SpawnedTaskLifecycleEvent): string | null {
  switch (event.eventType) {
    case "spawned_task_started":
      return `Created ${worker.targetName} (${worker.label})`;
    case "spawned_task_completed":
      return `${worker.targetName} 已完成`;
    case "spawned_task_failed":
      return `${worker.targetName} 失败：${compactText(event.error, 72) ?? "未知错误"}`;
    case "spawned_task_timeout":
      return `${worker.targetName} ${
        event.timeoutReason === "idle" ? "空闲超时" : "预算耗尽"
      }：${compactText(event.error, 72) ?? "未知错误"}`;
    default:
      return null;
  }
}

function findParentReplyAfter(dialogHistory: readonly DialogMessage[], actorId: string, afterTimestamp: number): DialogMessage | null {
  return dialogHistory.find((message) =>
    message.from === actorId
    && message.from !== "user"
    && message.timestamp >= afterTimestamp
    && (!message.to || message.to === "user")
    && (message.kind === "agent_message" || message.kind === "agent_result"),
  ) ?? null;
}

function buildWorkerDetail(worker: LocalCollaborationTimelineWorker): string {
  const roleBoundaryMeta = getSpawnedTaskRoleBoundaryMeta(worker.roleBoundary);
  const taskPreview = compactText(worker.task, 96);

  if (worker.status === "completed") {
    return worker.resultPreview
      ?? worker.latestMessage
      ?? taskPreview
      ?? `该 worker（${roleBoundaryMeta.label}）已完成。`;
  }
  if (worker.status === "error" || worker.status === "aborted") {
    const timeoutPrefix = worker.timeoutReason === "idle"
      ? "该 worker 长时间无进展，已按空闲租约收敛。"
      : worker.timeoutReason === "budget"
        ? "该 worker 已超过总预算，已停止当前执行。"
        : null;
    return worker.errorMessage
      ?? timeoutPrefix
      ?? worker.latestMessage
      ?? taskPreview
      ?? `该 worker（${roleBoundaryMeta.label}）执行失败。`;
  }
  return worker.latestMessage
    ?? taskPreview
    ?? `该 worker 正在继续处理 ${roleBoundaryMeta.label} 任务。`;
}

function canJoinGroup(
  worker: LocalCollaborationTimelineWorker,
  group: {
    spawnerActorId: string;
    contractId?: string;
    parentRunId?: string;
    startedAt: number;
    latestStartedAt: number;
  },
): boolean {
  if (worker.spawnerActorId !== group.spawnerActorId) return false;

  if (worker.contractId && group.contractId) {
    return worker.contractId === group.contractId
      && worker.startedAt - group.startedAt <= GROUP_CONTRACT_MAX_GAP_MS;
  }

  if (worker.parentRunId && group.parentRunId) {
    return worker.parentRunId === group.parentRunId
      && worker.startedAt - group.startedAt <= GROUP_CONTRACT_MAX_GAP_MS;
  }

  return Math.abs(worker.startedAt - group.latestStartedAt) <= GROUP_JOIN_WINDOW_MS;
}

function buildWorkerFromSources(params: {
  runId: string;
  task?: SpawnedTaskRecord;
  events: SpawnedTaskLifecycleEvent[];
  actorNameById?: ReadonlyMap<string, string>;
}): LocalCollaborationTimelineWorker | null {
  const { runId, task, actorNameById } = params;
  const events = [...params.events].sort((left, right) =>
    left.timestamp - right.timestamp || eventTypePriority(left.eventType) - eventTypePriority(right.eventType),
  );
  const firstEvent = events[0];
  const startEvent = events.find((event) => event.eventType === "spawned_task_started") ?? firstEvent;
  const latestEvent = events[events.length - 1];
  const latestProgressEvent = [...events].reverse().find((event) =>
    event.eventType === "spawned_task_running" && compactText(event.message),
  );
  const terminalEvent = [...events].reverse().find((event) =>
    event.eventType === "spawned_task_completed"
    || event.eventType === "spawned_task_failed"
    || event.eventType === "spawned_task_timeout",
  );

  const targetActorId = task?.targetActorId ?? startEvent?.targetActorId;
  const spawnerActorId = task?.spawnerActorId ?? startEvent?.spawnerActorId;
  if (!targetActorId || !spawnerActorId) return null;

  const targetName = actorNameById?.get(targetActorId)
    ?? latestEvent?.targetName
    ?? startEvent?.targetName
    ?? targetActorId;
  const spawnerName = actorNameById?.get(spawnerActorId)
    ?? latestEvent?.spawnerName
    ?? startEvent?.spawnerName
    ?? spawnerActorId;
  const startedAt = startEvent?.timestamp ?? task?.spawnedAt ?? 0;
  const updatedAt = latestEvent?.timestamp
    ?? task?.lastActiveAt
    ?? task?.completedAt
    ?? task?.spawnedAt
    ?? startedAt;
  const status = task?.status
    ?? terminalEvent?.status
    ?? latestEvent?.status
    ?? "running";

  return {
    runId,
    spawnerActorId,
    spawnerName,
    targetActorId,
    targetName,
    contractId: task?.contractId ?? latestEvent?.contractId ?? startEvent?.contractId,
    plannedDelegationId: task?.plannedDelegationId ?? latestEvent?.plannedDelegationId ?? startEvent?.plannedDelegationId,
    dispatchSource: task?.dispatchSource ?? latestEvent?.dispatchSource ?? startEvent?.dispatchSource,
    parentRunId: task?.parentRunId ?? latestEvent?.parentRunId ?? startEvent?.parentRunId,
    rootRunId: task?.rootRunId ?? latestEvent?.rootRunId ?? startEvent?.rootRunId,
    mode: task?.mode ?? latestEvent?.mode ?? startEvent?.mode,
    roleBoundary: task?.roleBoundary ?? latestEvent?.roleBoundary ?? startEvent?.roleBoundary,
    label: task?.label ?? compactText(latestEvent?.label, 72) ?? targetName,
    task: task?.task ?? latestEvent?.task ?? startEvent?.task ?? targetName,
    status,
    startedAt,
    updatedAt,
    completedAt: terminalEvent?.timestamp ?? task?.completedAt,
    latestMessage: compactText(latestProgressEvent?.message ?? latestEvent?.message, 140),
    resultPreview: compactText(task?.result ?? terminalEvent?.result, 140),
    errorMessage: compactText(task?.error ?? terminalEvent?.error, 140),
    timeoutReason: task?.timeoutReason ?? terminalEvent?.timeoutReason,
    budgetSeconds: task?.budgetSeconds ?? latestEvent?.budgetSeconds ?? startEvent?.budgetSeconds,
    idleLeaseSeconds: task?.idleLeaseSeconds ?? latestEvent?.idleLeaseSeconds ?? startEvent?.idleLeaseSeconds,
    events,
  };
}

export function buildLocalCollaborationTimelineGroups(params: {
  events: readonly SpawnedTaskLifecycleEvent[];
  spawnedTasks: readonly SpawnedTaskRecord[];
  dialogHistory: readonly DialogMessage[];
  actorNameById?: ReadonlyMap<string, string>;
}): LocalCollaborationTimelineGroup[] {
  const { events, spawnedTasks, dialogHistory, actorNameById } = params;
  const taskByRunId = new Map(spawnedTasks.map((task) => [task.runId, task] as const));
  const eventsByRunId = new Map<string, SpawnedTaskLifecycleEvent[]>();

  for (const event of events) {
    const list = eventsByRunId.get(event.runId) ?? [];
    list.push(event);
    eventsByRunId.set(event.runId, list);
  }

  const runIds = new Set<string>([
    ...taskByRunId.keys(),
    ...eventsByRunId.keys(),
  ]);

  const workers = [...runIds]
    .map((runId) => buildWorkerFromSources({
      runId,
      task: taskByRunId.get(runId),
      events: eventsByRunId.get(runId) ?? [],
      actorNameById,
    }))
    .filter((worker): worker is LocalCollaborationTimelineWorker => Boolean(worker))
    .sort((left, right) => left.startedAt - right.startedAt || left.updatedAt - right.updatedAt);

  const groupedWorkers: Array<{
    id: string;
    spawnerActorId: string;
    spawnerName: string;
    contractId?: string;
    parentRunId?: string;
    startedAt: number;
    latestStartedAt: number;
    workers: LocalCollaborationTimelineWorker[];
  }> = [];

  for (const worker of workers) {
    const currentGroup = groupedWorkers[groupedWorkers.length - 1];
    if (currentGroup && canJoinGroup(worker, currentGroup)) {
      currentGroup.workers.push(worker);
      currentGroup.latestStartedAt = Math.max(currentGroup.latestStartedAt, worker.startedAt);
      continue;
    }

    groupedWorkers.push({
      id: worker.contractId
        ? `contract-${worker.contractId}`
        : worker.parentRunId
          ? `parent-${worker.parentRunId}`
          : `spawn-${worker.spawnerActorId}-${worker.startedAt}-${worker.runId}`,
      spawnerActorId: worker.spawnerActorId,
      spawnerName: worker.spawnerName,
      contractId: worker.contractId,
      parentRunId: worker.parentRunId,
      startedAt: worker.startedAt,
      latestStartedAt: worker.startedAt,
      workers: [worker],
    });
  }

  return groupedWorkers.map((group) => {
    const sortedWorkers = [...group.workers].sort((left, right) =>
      left.startedAt - right.startedAt || left.updatedAt - right.updatedAt,
    );
    const completedCount = sortedWorkers.filter((worker) => worker.status === "completed").length;
    const failedCount = sortedWorkers.filter((worker) => worker.status === "error" || worker.status === "aborted").length;
    const runningCount = sortedWorkers.length - completedCount - failedCount;
    const updatedAt = sortedWorkers.reduce((max, worker) => Math.max(max, worker.updatedAt), group.startedAt);
    const completedAt = runningCount === 0
      ? sortedWorkers.reduce((max, worker) => Math.max(max, worker.completedAt ?? worker.updatedAt), group.startedAt)
      : undefined;
    const latestParentReply = completedAt
      ? findParentReplyAfter(dialogHistory, group.spawnerActorId, completedAt)
      : null;
    const dispatchOnly = runningCount > 0 && sortedWorkers.every((worker) =>
      worker.events.length === 0 || worker.events.every((event) => event.eventType === "spawned_task_started"),
    );
    const phase: GroupPhase = runningCount > 0
      ? dispatchOnly ? "dispatching" : "running"
      : latestParentReply ? "aggregated" : "awaiting_aggregation";
    const activeWorkerNames = sortedWorkers
      .filter((worker) => worker.status === "running")
      .map((worker) => worker.targetName)
      .slice(0, 3);

    const summary = (() => {
      if (phase === "dispatching") {
        return `由 ${group.spawnerName} 派出，正在建立 ${sortedWorkers.length} 个 worker 的分工。`;
      }
      if (phase === "running") {
        if (completedCount > 0 && activeWorkerNames.length > 0) {
          return `已完成 ${completedCount}/${sortedWorkers.length}，继续等待 ${activeWorkerNames.join("、")}。`;
        }
        if (activeWorkerNames.length > 0) {
          return `并行处理中：${activeWorkerNames.join("、")}。`;
        }
        return `正在继续处理 ${sortedWorkers.length} 个 worker 的协作任务。`;
      }
      if (phase === "aggregated") {
        return compactText(latestParentReply?.content, 160)
          ?? `全部 ${sortedWorkers.length} 个 worker 已返回，${group.spawnerName} 已回流汇总结果。`;
      }
      if (failedCount > 0) {
        return `全部 ${sortedWorkers.length} 个 worker 已返回，其中 ${failedCount} 个失败，等待 ${group.spawnerName} 汇总。`;
      }
      return `全部 ${sortedWorkers.length} 个 worker 已返回，等待 ${group.spawnerName} 汇总。`;
    })();

    const milestones = sortedWorkers
      .flatMap((worker) => worker.events
        .map((event) => {
          const text = buildMilestoneText(worker, event);
          if (!text) return null;
          return {
            id: `${worker.runId}-${event.eventType}-${event.timestamp}`,
            timestamp: event.timestamp,
            tone: event.eventType === "spawned_task_completed"
              ? "success" as const
              : event.eventType === "spawned_task_failed" || event.eventType === "spawned_task_timeout"
                ? "danger" as const
                : "neutral" as const,
            text,
          };
        })
        .filter((event): event is LocalCollaborationTimelineMilestone => Boolean(event)))
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-MILESTONE_EVENT_LIMIT);

    return {
      id: group.id,
      spawnerActorId: group.spawnerActorId,
      spawnerName: group.spawnerName,
      startedAt: group.startedAt,
      updatedAt,
      completedAt,
      phase,
      title: `Spawning ${sortedWorkers.length} ${sortedWorkers.length === 1 ? "worker" : "workers"}`,
      summary,
      totalWorkers: sortedWorkers.length,
      runningCount,
      completedCount,
      failedCount,
      activeWorkerNames,
      latestParentReply: compactText(latestParentReply?.content, 160),
      workers: sortedWorkers,
      milestones,
    } satisfies LocalCollaborationTimelineGroup;
  });
}

export function mergeLocalDialogTranscriptItems(params: {
  messages: readonly DialogMessage[];
  groups: readonly LocalCollaborationTimelineGroup[];
}): LocalDialogTranscriptItem[] {
  const messageItems: Array<LocalDialogTranscriptItem & { order: number }> = params.messages.map((message, index) => ({
    kind: "message",
    id: message.id,
    timestamp: message.timestamp,
    message,
    order: index,
  }));
  const groupItems: Array<LocalDialogTranscriptItem & { order: number }> = params.groups.map((group, index) => ({
    kind: "collaboration_group",
    id: `collab-${group.id}`,
    timestamp: group.startedAt,
    group,
    order: params.messages.length + index,
  }));

  const sortedItems = [...messageItems, ...groupItems]
    .sort((left, right) =>
      left.timestamp - right.timestamp
      || (left.kind === right.kind ? 0 : (left.kind === "message" ? -1 : 1))
      || left.order - right.order,
    );

  return sortedItems.map((item) => {
    const nextItem = { ...item };
    delete (nextItem as { order?: number }).order;
    return nextItem;
  });
}

export function DialogCollaborationTimelineCard({
  group,
}: {
  group: LocalCollaborationTimelineGroup;
}) {
  const [expanded, setExpanded] = useState(group.phase !== "aggregated");
  const phaseMeta = buildGroupPhaseMeta(group.phase);

  const counters = useMemo(() => {
    const items = [`${group.totalWorkers} 个 worker`];
    if (group.completedCount > 0) items.push(`完成 ${group.completedCount}`);
    if (group.runningCount > 0) items.push(`运行中 ${group.runningCount}`);
    if (group.failedCount > 0) items.push(`失败 ${group.failedCount}`);
    return items;
  }, [group.completedCount, group.failedCount, group.runningCount, group.totalWorkers]);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]/90 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.35)]">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-700">
          {group.phase === "aggregated" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : group.phase === "awaiting_aggregation" ? (
            <Clock3 className="h-4 w-4" />
          ) : (
            <Loader2 className={`h-4 w-4 ${group.phase === "dispatching" ? "" : "animate-spin"}`} />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-[var(--color-text)]">
              {group.title}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${phaseMeta.className}`}>
              {phaseMeta.label}
            </span>
            <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
              {group.spawnerName}
            </span>
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-[var(--color-text)]">
            {group.summary}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
            {counters.map((item) => (
              <span
                key={item}
                className="rounded-full border border-[var(--color-border)]/80 bg-[var(--color-bg-secondary)]/60 px-2 py-0.5"
              >
                {item}
              </span>
            ))}
            <span className="ml-auto">
              {formatShortTime(group.updatedAt)}
            </span>
          </div>
        </div>

        <span className="mt-1 shrink-0 text-[var(--color-text-tertiary)]">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-[var(--color-border)] px-3 py-3">
          {group.milestones.length > 0 && (
            <div className="rounded-2xl border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/45 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
                <Sparkles className="h-3.5 w-3.5" />
                协作轨迹
              </div>
              <div className="mt-2 space-y-1.5">
                {group.milestones.map((milestone) => (
                  <div key={milestone.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                      milestone.tone === "success"
                        ? "bg-emerald-500"
                        : milestone.tone === "danger"
                          ? "bg-red-500"
                          : "bg-sky-500"
                    }`} />
                    <span className="min-w-0 flex-1 text-[var(--color-text)]">
                      {milestone.text}
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
                      {formatShortTime(milestone.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-2">
            {group.workers.map((worker) => {
              const statusMeta = buildWorkerStatusMeta(worker);
              const roleMeta = getSpawnedTaskRoleBoundaryMeta(worker.roleBoundary);
              const workerDetail = buildWorkerDetail(worker);
              const latestElapsed = formatElapsed(
                worker.completedAt && worker.startedAt
                  ? worker.completedAt - worker.startedAt
                  : worker.updatedAt - worker.startedAt,
              );

              return (
                <div
                  key={worker.runId}
                  className="rounded-2xl border border-[var(--color-border)]/80 bg-[var(--color-bg)] px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${statusMeta.dotClassName}`} />
                    <span className="text-[11px] font-semibold text-[var(--color-text)]">
                      {worker.targetName}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]">
                      {worker.label}
                    </span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${statusMeta.badgeClassName}`}>
                      {statusMeta.label}
                    </span>
                    <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                      {roleMeta.label}
                    </span>
                    {latestElapsed && (
                      <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">
                        {latestElapsed}
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text)]">
                    {workerDetail}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
                    <span className="inline-flex items-center gap-1">
                      <Bot className="h-3 w-3" />
                      {worker.mode === "session" ? "session worker" : "run worker"}
                    </span>
                    {worker.budgetSeconds ? (
                      <span>预算 {formatDurationSeconds(worker.budgetSeconds) ?? `${worker.budgetSeconds}s`}</span>
                    ) : null}
                    {worker.idleLeaseSeconds ? (
                      <span>租约 {formatDurationSeconds(worker.idleLeaseSeconds) ?? `${worker.idleLeaseSeconds}s`}</span>
                    ) : null}
                    <span>开始于 {formatShortTime(worker.startedAt)}</span>
                    <span>更新于 {formatShortTime(worker.updatedAt)}</span>
                    {worker.dispatchSource === "contract_suggestion" && (
                      <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-violet-700">
                        contract
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default DialogCollaborationTimelineCard;
