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
  DialogFlowTraceEvent,
  DialogMessage,
  SpawnedTaskLifecycleEvent,
  SpawnedTaskLifecycleEventType,
  SpawnedTaskRecord,
  SpawnedTaskRoleBoundary,
  SpawnedTaskStatus,
} from "@/core/agent/actor/types";
import { formatDurationSeconds } from "@/core/agent/actor/timeout-policy";
import type {
  LocalDialogHostMilestone,
  LocalDialogLiveContinuationState,
} from "./local-dialog-projection";
import {
  buildLocalDialogHostMilestonesFromTraceEvents,
  mergeLocalDialogHostMilestones,
} from "./local-dialog-projection";

const GROUP_JOIN_WINDOW_MS = 6000;
const GROUP_CONTRACT_MAX_GAP_MS = 120000;
const MILESTONE_EVENT_LIMIT = 12;
const INTERIM_PARENT_REPLY_PATTERNS = [
  /(现在|正在|继续|准备).*(验证|整理|汇总|整合|输出|收尾)/u,
  /我开始.*(汇总|整合|整理|收尾)/u,
  /任务产物已存在.*现在.*最终结果/u,
  /已收到.*(?:反馈|结果).*(?:现在|正在).*(汇总|验证|输出)/u,
  /稍后.*(汇总|输出)|继续.*(整理|汇总|验证)/u,
];
const CONCRETE_PARENT_REPLY_PATTERNS = [
  /最终产物|文件路径|保存到|导出为|已创建|已生成|已修改|验证通过|测试通过|构建通过|真实缺口|阻塞原因|无法完成/u,
  /\/[^\s"'`]+\.(?:tsx?|jsx?|vue|html|css|scss|less|json|rs|py|go|java|kt|swift|md|docx?|pdf|xlsx?|csv|pptx?)/i,
];
const REPAIR_PARENT_REPLY_PATTERNS = [
  /纠偏|修复|repair|quality gate|blocker|未通过结果校验/u,
  /补派|重新导出|再导出|重新尝试导出/u,
] as const;
const HOST_EXPORT_SUCCESS_PARENT_REPLY_PATTERNS = [
  /导出(?:成功|完成|到了?)|保存到|导出为|文件路径|产物位置|工作簿|已创建|已生成/u,
  /\/[^\s"'`]+\.(?:xlsx?|csv|docx?|pdf|pptx?)/i,
] as const;

type GroupPhase = "dispatching" | "running" | "aggregating" | "repairing" | "awaiting_aggregation" | "aggregated";

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
    case "aggregating":
      return {
        label: "汇总中",
        className: "bg-amber-500/10 text-amber-700",
      };
    case "repairing":
      return {
        label: "修复中",
        className: "bg-rose-500/10 text-rose-700",
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

function buildGroupTitle(workerCount: number): string {
  return `并行协作 · ${workerCount} 个子任务`;
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

function listParentRepliesAfter(
  dialogHistory: readonly DialogMessage[],
  actorId: string,
  afterTimestamp: number,
  beforeTimestamp?: number,
): DialogMessage[] {
  return dialogHistory.filter((message) =>
    message.from === actorId
    && message.from !== "user"
    && message.timestamp >= afterTimestamp
    && (typeof beforeTimestamp !== "number" || message.timestamp < beforeTimestamp)
    && (!message.to || message.to === "user")
    && (message.kind === "agent_message" || message.kind === "agent_result"),
  );
}

function isLikelyInterimParentReply(content: string | undefined): boolean {
  const normalized = String(content ?? "").trim();
  if (!normalized) return false;
  if (CONCRETE_PARENT_REPLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return INTERIM_PARENT_REPLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isLikelyRepairParentReply(content: string | undefined): boolean {
  const normalized = String(content ?? "").trim();
  if (!normalized) return false;
  if (CONCRETE_PARENT_REPLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return REPAIR_PARENT_REPLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isLikelySettledParentReply(content: string | undefined): boolean {
  const normalized = String(content ?? "").trim();
  if (!normalized) return false;
  return !isLikelyRepairParentReply(normalized) && !isLikelyInterimParentReply(normalized);
}

function isLikelyHostExportSuccessParentReply(content: string | undefined): boolean {
  const normalized = String(content ?? "").trim();
  if (!normalized) return false;
  if (!isLikelySettledParentReply(normalized)) return false;
  return HOST_EXPORT_SUCCESS_PARENT_REPLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildHostRepairMilestone(params: {
  spawnerName: string;
  latestGroupForSpawner: boolean;
  directParentReply: DialogMessage | null;
  parentActivity?: LocalDialogLiveContinuationState;
}): LocalCollaborationTimelineMilestone | null {
  const directRepairReply = params.directParentReply && isLikelyRepairParentReply(params.directParentReply.content)
    ? params.directParentReply
    : null;
  if (directRepairReply) {
    return {
      id: `repair-reply-${directRepairReply.id}`,
      timestamp: directRepairReply.timestamp,
      tone: "neutral",
      text: `${params.spawnerName} 进入修复轮：${compactText(directRepairReply.content, 120) ?? "正在修复缺口并准备重新导出。"}`,
    };
  }
  if (
    params.latestGroupForSpawner
    && params.parentActivity?.phase === "repairing"
    && params.parentActivity.latestContinuationTimestamp
    && params.parentActivity.latestContinuationPreview
  ) {
    return {
      id: `repair-live-${params.spawnerName}-${params.parentActivity.latestContinuationTimestamp}`,
      timestamp: params.parentActivity.latestContinuationTimestamp,
      tone: "neutral",
      text: `${params.spawnerName} 进入修复轮：${compactText(params.parentActivity.latestContinuationPreview, 120) ?? "正在修复缺口并准备重新导出。"}`,
    };
  }
  return null;
}

function buildHostSuccessMilestone(params: {
  spawnerName: string;
  latestGroupForSpawner: boolean;
  settledParentReply: DialogMessage | null;
  parentActivity?: LocalDialogLiveContinuationState;
  hadRepairContext: boolean;
}): LocalCollaborationTimelineMilestone | null {
  const successPrefix = params.hadRepairContext ? "重试导出成功" : "导出成功";
  const directSuccessReply = params.settledParentReply && isLikelyHostExportSuccessParentReply(params.settledParentReply.content)
    ? params.settledParentReply
    : null;
  if (directSuccessReply) {
    return {
      id: `publish-reply-${directSuccessReply.id}`,
      timestamp: directSuccessReply.timestamp,
      tone: "success",
      text: `${params.spawnerName} ${successPrefix}：${compactText(directSuccessReply.content, 120) ?? "已输出最终交付产物。"}`,
    };
  }
  if (
    params.latestGroupForSpawner
    && params.parentActivity?.phase === "published"
    && params.parentActivity.latestContinuationTimestamp
    && isLikelyHostExportSuccessParentReply(params.parentActivity.latestContinuationPreview)
  ) {
    return {
      id: `publish-live-${params.spawnerName}-${params.parentActivity.latestContinuationTimestamp}`,
      timestamp: params.parentActivity.latestContinuationTimestamp,
      tone: "success",
      text: `${params.spawnerName} ${successPrefix}：${compactText(params.parentActivity.latestContinuationPreview, 120) ?? "已输出最终交付产物。"}`,
    };
  }
  return null;
}

function buildProjectedHostMilestones(params: {
  spawnerName: string;
  latestGroupForSpawner: boolean;
  completedAt?: number;
  nextSiblingGroupStartedAt?: number;
  parentActivity?: LocalDialogLiveContinuationState;
  hostTraceEvents?: readonly DialogFlowTraceEvent[];
}): Array<LocalCollaborationTimelineMilestone & { hostKind: LocalDialogHostMilestone["kind"] }> {
  if (!params.completedAt) return [];
  const traceHostMilestones = buildLocalDialogHostMilestonesFromTraceEvents(
    (params.hostTraceEvents ?? []).filter((event) =>
      event.timestamp >= params.completedAt!
      && (typeof params.nextSiblingGroupStartedAt !== "number" || event.timestamp < params.nextSiblingGroupStartedAt)
    ),
  );
  const liveHostMilestones = params.latestGroupForSpawner
    ? (params.parentActivity?.hostMilestones ?? []).filter((milestone) =>
        milestone.timestamp >= params.completedAt!
        && (typeof params.nextSiblingGroupStartedAt !== "number" || milestone.timestamp < params.nextSiblingGroupStartedAt)
      )
    : [];
  const hostMilestones = mergeLocalDialogHostMilestones(liveHostMilestones, traceHostMilestones);
  return hostMilestones
    .filter((milestone) => !params.completedAt || milestone.timestamp >= params.completedAt)
    .map((milestone, index) => ({
      id: `projected-${milestone.id}-${index}`,
      timestamp: milestone.timestamp,
      tone: milestone.kind === "export_succeeded"
        ? "success" as const
        : milestone.kind === "export_blocked"
          ? "danger" as const
          : "neutral" as const,
      text: `${params.spawnerName} ${milestone.summary}`,
      hostKind: milestone.kind,
    }));
}

function hasEventualProjectedHostSuccess(params: {
  completedAt?: number;
  hostTraceEvents?: readonly DialogFlowTraceEvent[];
}): boolean {
  if (!params.completedAt || !params.hostTraceEvents?.length) return false;
  return buildLocalDialogHostMilestonesFromTraceEvents(
    params.hostTraceEvents.filter((event) => event.timestamp >= params.completedAt!),
  ).some((milestone) => milestone.kind === "export_succeeded");
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
    event.eventType === "spawned_task_running" && compactText(event.progressSummary ?? event.message),
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
  const runtimeProgress = compactText(task?.runtime?.progressSummary, 140);
  const runtimeResult = compactText(task?.runtime?.terminalResult, 140);
  const runtimeError = compactText(task?.runtime?.terminalError, 140);
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
    startedAt: task?.runtime?.startedAt ?? startedAt,
    updatedAt,
    completedAt: task?.runtime?.completedAt ?? terminalEvent?.timestamp ?? task?.completedAt,
    latestMessage: runtimeProgress
      ?? compactText(
        latestProgressEvent?.progressSummary
          ?? latestProgressEvent?.message
          ?? latestEvent?.progressSummary
          ?? latestEvent?.message,
        140,
      ),
    resultPreview: runtimeResult ?? compactText(task?.result ?? terminalEvent?.terminalResult ?? terminalEvent?.result, 140),
    errorMessage: runtimeError ?? compactText(task?.error ?? terminalEvent?.terminalError ?? terminalEvent?.error, 140),
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
  parentActivityByActorId?: ReadonlyMap<string, LocalDialogLiveContinuationState>;
  hostTraceEventsByActorId?: ReadonlyMap<string, readonly DialogFlowTraceEvent[]>;
}): LocalCollaborationTimelineGroup[] {
  const { events, spawnedTasks, dialogHistory, actorNameById, parentActivityByActorId, hostTraceEventsByActorId } = params;
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

  const latestGroupStartedAtBySpawnerActorId = new Map<string, number>();
  groupedWorkers.forEach((group) => {
    const previous = latestGroupStartedAtBySpawnerActorId.get(group.spawnerActorId) ?? 0;
    if (group.startedAt >= previous) {
      latestGroupStartedAtBySpawnerActorId.set(group.spawnerActorId, group.startedAt);
    }
  });

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
    const nextSiblingGroup = groupedWorkers.find((candidate) =>
      candidate.startedAt > group.startedAt
      && candidate.spawnerActorId === group.spawnerActorId,
    );
    const parentRepliesInWindow = completedAt
      ? listParentRepliesAfter(
          dialogHistory,
          group.spawnerActorId,
          completedAt,
          nextSiblingGroup?.startedAt,
        )
      : [];
    const allParentRepliesAfterCompletion = completedAt
      ? listParentRepliesAfter(
          dialogHistory,
          group.spawnerActorId,
          completedAt,
        )
      : [];
    const directParentReply = parentRepliesInWindow[0] ?? null;
    const windowSettledParentReply = parentRepliesInWindow.find((reply) => isLikelySettledParentReply(reply.content)) ?? null;
    const eventualSettledParentReply = windowSettledParentReply
      ?? allParentRepliesAfterCompletion.find((reply) => isLikelySettledParentReply(reply.content))
      ?? null;
    const directParentReplyIsRepairing = isLikelyRepairParentReply(directParentReply?.content);
    const directParentReplyIsInterim = isLikelyInterimParentReply(directParentReply?.content);
    const hasConcreteParentReply = Boolean(
      eventualSettledParentReply,
    );
    const parentActivity = parentActivityByActorId?.get(group.spawnerActorId);
    const hostTraceEvents = hostTraceEventsByActorId?.get(group.spawnerActorId) ?? [];
    const isLatestGroupForSpawner = (latestGroupStartedAtBySpawnerActorId.get(group.spawnerActorId) ?? group.startedAt) === group.startedAt;
    const projectedHostMilestones = buildProjectedHostMilestones({
      spawnerName: group.spawnerName,
      latestGroupForSpawner: isLatestGroupForSpawner,
      completedAt,
      nextSiblingGroupStartedAt: nextSiblingGroup?.startedAt,
      parentActivity,
      hostTraceEvents,
    });
    const eventualTraceSuccess = hasEventualProjectedHostSuccess({
      completedAt,
      hostTraceEvents,
    });
    const latestProjectedHostMilestone = projectedHostMilestones[projectedHostMilestones.length - 1];
    const hasProjectedRepairMilestone = projectedHostMilestones.some((milestone) => milestone.hostKind === "repair_started");
    const hasProjectedAggregationMilestone = projectedHostMilestones.some((milestone) => milestone.hostKind === "aggregation_started");
    const hasProjectedBlockedMilestone = projectedHostMilestones.some((milestone) => milestone.hostKind === "export_blocked");
    const hasProjectedSuccessMilestone = projectedHostMilestones.some((milestone) => milestone.hostKind === "export_succeeded");
    const hasActiveParentRepair = Boolean(
      parentActivity?.phase === "repairing"
      && completedAt
      && (parentActivity.latestContinuationTimestamp ?? 0) >= completedAt,
    );
    const hasActiveParentPublished = Boolean(
      parentActivity?.phase === "published"
      && completedAt
      && (parentActivity.latestContinuationTimestamp ?? 0) >= completedAt,
    );
    const hasActiveParentAggregation = Boolean(
      (parentActivity?.phase === "aggregating"
      || parentActivity?.isContinuingAfterOrchestration)
      && !hasActiveParentPublished
      && completedAt
      && (parentActivity.latestContinuationTimestamp ?? 0) >= completedAt,
    );
    const dispatchOnly = runningCount > 0 && sortedWorkers.every((worker) =>
      worker.events.length === 0 || worker.events.every((event) => event.eventType === "spawned_task_started"),
    );
    const phase: GroupPhase = runningCount > 0
      ? dispatchOnly ? "dispatching" : "running"
      : hasConcreteParentReply || hasActiveParentPublished || hasProjectedSuccessMilestone || eventualTraceSuccess
        ? "aggregated"
        : directParentReplyIsRepairing || hasActiveParentRepair || hasProjectedRepairMilestone
          ? "repairing"
        : directParentReplyIsInterim || hasActiveParentAggregation || hasProjectedAggregationMilestone || hasProjectedBlockedMilestone
          ? "aggregating"
          : "awaiting_aggregation";
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
        if (windowSettledParentReply) {
          return compactText(windowSettledParentReply.content, 160)
            ?? `全部 ${sortedWorkers.length} 个 worker 已返回，${group.spawnerName} 已回流汇总结果。`;
        }
        if (latestProjectedHostMilestone?.hostKind === "export_succeeded") {
          return latestProjectedHostMilestone.text;
        }
        if (isLatestGroupForSpawner && hasActiveParentPublished && parentActivity?.latestContinuationPreview) {
          return parentActivity.latestContinuationPreview;
        }
        return `全部 ${sortedWorkers.length} 个 worker 已返回，${group.spawnerName} 已在后续消息中完成统一汇总。`;
      }
      if (phase === "repairing" && directParentReply) {
        return compactText(directParentReply.content, 160)
          ?? `全部 ${sortedWorkers.length} 个 worker 已返回，${group.spawnerName} 正在修复缺口并准备重新导出。`;
      }
      if (phase === "repairing" && isLatestGroupForSpawner && parentActivity?.latestContinuationPreview) {
        return parentActivity.latestContinuationPreview;
      }
      if (
        phase === "repairing"
        && latestProjectedHostMilestone
        && (latestProjectedHostMilestone.hostKind === "repair_started" || latestProjectedHostMilestone.hostKind === "repair_completed")
      ) {
        return latestProjectedHostMilestone.text;
      }
      if (phase === "aggregating" && directParentReply) {
        return compactText(directParentReply.content, 160)
          ?? `全部 ${sortedWorkers.length} 个 worker 已返回，${group.spawnerName} 正在继续综合最终结果。`;
      }
      if (phase === "aggregating" && isLatestGroupForSpawner && parentActivity?.latestContinuationPreview) {
        return parentActivity.latestContinuationPreview;
      }
      if (
        phase === "aggregating"
        && latestProjectedHostMilestone
        && (
          latestProjectedHostMilestone.hostKind === "aggregation_started"
          || latestProjectedHostMilestone.hostKind === "export_blocked"
          || latestProjectedHostMilestone.hostKind === "export_started"
        )
      ) {
        return latestProjectedHostMilestone.text;
      }
      if (failedCount > 0) {
        return `全部 ${sortedWorkers.length} 个 worker 已返回，其中 ${failedCount} 个失败，等待 ${group.spawnerName} 汇总。`;
      }
      return `全部 ${sortedWorkers.length} 个 worker 已返回，等待 ${group.spawnerName} 汇总。`;
    })();

    const workerMilestones = sortedWorkers
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
    const hostRepairMilestone = buildHostRepairMilestone({
      spawnerName: group.spawnerName,
      latestGroupForSpawner: isLatestGroupForSpawner,
      directParentReply,
      parentActivity,
    });
    const hostSuccessMilestone = buildHostSuccessMilestone({
      spawnerName: group.spawnerName,
      latestGroupForSpawner: isLatestGroupForSpawner,
      settledParentReply: windowSettledParentReply,
      parentActivity,
      hadRepairContext: Boolean(hostRepairMilestone || directParentReplyIsRepairing || hasActiveParentRepair),
    });
    const milestones = [
      ...workerMilestones,
      ...projectedHostMilestones.map((milestone) => ({
        id: milestone.id,
        timestamp: milestone.timestamp,
        tone: milestone.tone,
        text: milestone.text,
      })),
      ...(!hasProjectedRepairMilestone && hostRepairMilestone ? [hostRepairMilestone] : []),
      ...(!hasProjectedSuccessMilestone && hostSuccessMilestone ? [hostSuccessMilestone] : []),
    ]
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
      title: buildGroupTitle(sortedWorkers.length),
      summary,
      totalWorkers: sortedWorkers.length,
      runningCount,
      completedCount,
      failedCount,
      activeWorkerNames,
      latestParentReply: compactText(windowSettledParentReply?.content ?? directParentReply?.content, 160),
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
          ) : group.phase === "repairing" ? (
            <Sparkles className="h-4 w-4" />
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
