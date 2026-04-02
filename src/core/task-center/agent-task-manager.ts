import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import { createLogger } from "@/core/logger";
import {
  buildAgentTaskOutputFile,
  buildAgentTaskOutputSummary,
  buildAgentTaskProgressFromSpawnedTask,
  deriveAgentTaskStatusFromSpawnedTask,
  describeAgentTaskLifecycle,
} from "./agent-task-progress";
import { buildAgentTaskNotification } from "./agent-task-notification";
import { AgentTaskOutputSink } from "./agent-task-output-sink";
import type {
  AgentTask,
  AgentTaskActivity,
  AgentTaskBackend,
  DeferredAgentTaskRecord,
  AgentTaskEvent,
  AgentTaskEventHandler,
  AgentTaskFilter,
  AgentTaskNotification,
  AgentTaskOutputEntry,
  AgentTaskSource,
} from "./agent-task-types";
import {
  resolveAgentTaskIdFromRunId,
  resolveDeferredAgentTaskIdFromQueueId,
} from "./agent-task-types";

const log = createLogger("AgentTaskManager");
const STORAGE_KEY = "mtools_agent_task_center";
const MAX_PERSISTED_TASKS = 300;
const MAX_NOTIFICATIONS = 400;
const MAX_RECENT_ACTIVITY = 12;

type PersistedAgentTaskState = {
  tasks: AgentTask[];
  notifications: AgentTaskNotification[];
  outputs: Record<string, AgentTaskOutputEntry[]>;
};

function canUseStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function matchText(task: AgentTask, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    task.title,
    task.description,
    task.targetName,
    task.spawnerName,
    task.outputSummary,
    task.outputFile,
    task.error,
    task.result,
  ].some((value) => String(value ?? "").toLowerCase().includes(normalized));
}

function createActivityId(taskId: string, timestamp: number, kind: AgentTaskActivity["kind"]): string {
  return `${taskId}:${kind}:${timestamp}`;
}

function buildTaskFromSpawnedTask(params: {
  sessionId: string;
  record: SpawnedTaskRecord;
  previous?: AgentTask;
  spawnerName?: string;
  targetName?: string;
  source?: AgentTaskSource;
  backend?: AgentTaskBackend;
  pendingMessageCount?: number;
}): AgentTask {
  const { sessionId, record, previous } = params;
  const taskId = resolveAgentTaskIdFromRunId(record.runId);
  const status = deriveAgentTaskStatusFromSpawnedTask(record);
  const progress = buildAgentTaskProgressFromSpawnedTask(record);
  const outputSummary = buildAgentTaskOutputSummary(record);
  const outputFile = buildAgentTaskOutputFile(record) ?? previous?.outputFile;
  const description = record.task.trim();
  const title = record.label?.trim() || description.slice(0, 48) || params.targetName || record.targetActorId;
  const result = record.runtime?.terminalResult ?? record.result ?? previous?.result;
  const error = record.runtime?.terminalError ?? record.error ?? previous?.error;
  const lastActiveAt = record.lastActiveAt ?? record.completedAt ?? record.spawnedAt;
  const recentActivitySummary = progress?.summary ?? describeAgentTaskLifecycle(record);

  return {
    taskId,
    sessionId,
    source: params.source ?? "spawned",
    backend: params.backend ?? "in_process",
    runId: record.runId,
    mode: record.mode,
    status,
    title,
    description,
    createdAt: previous?.createdAt ?? record.spawnedAt,
    startedAt: record.spawnedAt,
    completedAt: record.completedAt,
    lastActiveAt,
    spawnerActorId: record.spawnerActorId,
    spawnerName: params.spawnerName ?? previous?.spawnerName,
    targetActorId: record.targetActorId,
    targetName: params.targetName ?? previous?.targetName,
    roleBoundary: record.roleBoundary,
    workerProfileId: record.workerProfileId,
    executionIntent: record.executionIntent,
    progress,
    recentActivity: previous?.recentActivity ? [...previous.recentActivity] : [],
    recentActivitySummary,
    latestNotificationId: previous?.latestNotificationId,
    outputSummary,
    outputFile,
    result,
    error,
    sessionOpen: record.sessionOpen,
    attachState: record.mode === "session" && record.sessionOpen ? "attached" : "detached",
    resumable: record.mode === "session" ? record.sessionOpen !== false : false,
    pendingMessageCount: params.pendingMessageCount ?? previous?.pendingMessageCount ?? 0,
    metadata: {
      contractId: record.contractId,
      plannedDelegationId: record.plannedDelegationId,
      dispatchSource: record.dispatchSource,
      cleanup: record.cleanup,
      expectsCompletionMessage: record.expectsCompletionMessage,
      rootRunId: record.rootRunId,
      parentRunId: record.parentRunId,
    },
  };
}

function buildTaskFromDeferredSpawn(params: {
  record: DeferredAgentTaskRecord;
  previous?: AgentTask;
}): AgentTask {
  const { record, previous } = params;
  const taskId = resolveDeferredAgentTaskIdFromQueueId(record.queueId);
  const description = record.task.trim();
  const title = record.label?.trim() || description.slice(0, 48) || record.targetName || record.targetActorId;
  const status = record.error?.trim()
    ? "failed"
    : record.status ?? "queued";
  const recentActivitySummary = record.summary?.trim()
    || (record.error?.trim()
      ? `${title} 派发失败：${record.error.trim()}`
      : status === "running"
        ? `${title} 已派发，等待后续状态回流`
        : `${title} 等待派发`);

  return {
    taskId,
    sessionId: record.sessionId,
    source: record.source ?? "spawned",
    backend: record.backend ?? "in_process",
    mode: record.mode,
    status,
    title,
    description,
    createdAt: previous?.createdAt ?? record.queuedAt,
    lastActiveAt: record.queuedAt,
    spawnerActorId: record.spawnerActorId,
    spawnerName: record.spawnerName ?? previous?.spawnerName,
    targetActorId: record.targetActorId,
    targetName: record.targetName ?? previous?.targetName,
    roleBoundary: record.roleBoundary,
    workerProfileId: record.workerProfileId,
    executionIntent: record.executionIntent,
    progress: {
      summary: recentActivitySummary,
      updatedAt: record.queuedAt,
    },
    recentActivity: previous?.recentActivity ? [...previous.recentActivity] : [],
    recentActivitySummary,
    latestNotificationId: previous?.latestNotificationId,
    outputSummary: previous?.outputSummary,
    outputFile: previous?.outputFile,
    result: previous?.result,
    error: record.error?.trim() || previous?.error,
    sessionOpen: previous?.sessionOpen,
    attachState: previous?.attachState,
    resumable: previous?.resumable,
    pendingMessageCount: previous?.pendingMessageCount ?? 0,
    metadata: {
      queueId: record.queueId,
      ...(record.metadata ?? {}),
    },
  };
}

function maybeAppendActivity(params: {
  task: AgentTask;
  previous?: AgentTask;
}): AgentTask {
  const { task, previous } = params;
  const activities = [...task.recentActivity];
  const timestamp = task.completedAt ?? task.lastActiveAt ?? task.startedAt ?? task.createdAt;
  const lifecycleSummary = task.recentActivitySummary ?? task.description;
  const lastActivity = activities[activities.length - 1];

  if (!previous || previous.status !== task.status) {
    if (!lastActivity || lastActivity.summary !== lifecycleSummary || lastActivity.kind !== "lifecycle") {
      activities.push({
        id: createActivityId(task.taskId, timestamp, "lifecycle"),
        kind: "lifecycle",
        summary: lifecycleSummary,
        timestamp,
      });
    }
  }

  if (
    previous
    && previous.status === task.status
    && task.progress?.summary
    && task.progress.summary !== previous.progress?.summary
  ) {
    activities.push({
      id: createActivityId(task.taskId, task.progress.updatedAt, "progress"),
      kind: "progress",
      summary: task.progress.summary,
      timestamp: task.progress.updatedAt,
    });
  }

  if (
    previous
    && task.progress?.toolUseCount !== previous.progress?.toolUseCount
    && task.progress?.latestToolName
  ) {
    const toolTimestamp = task.progress.latestToolAt ?? task.progress.updatedAt;
    activities.push({
      id: createActivityId(task.taskId, toolTimestamp, "tool"),
      kind: "tool",
      summary: `调用工具 ${task.progress.latestToolName}`,
      timestamp: toolTimestamp,
    });
  }

  if (previous && task.pendingMessageCount !== previous.pendingMessageCount) {
    activities.push({
      id: createActivityId(task.taskId, timestamp, "message"),
      kind: "message",
      summary: task.pendingMessageCount > 0
        ? `待处理消息 ${task.pendingMessageCount} 条`
        : "待处理消息已清空",
      timestamp,
    });
  }

  return {
    ...task,
    recentActivity: activities.slice(-MAX_RECENT_ACTIVITY),
  };
}

function buildTerminalOutputEntry(params: {
  task: AgentTask;
  previous?: AgentTask;
}): AgentTaskOutputEntry | null {
  const { task, previous } = params;
  if (task.status === "running" || task.status === "queued") return null;
  if (
    previous?.status === task.status
    && previous.result === task.result
    && previous.error === task.error
  ) {
    return null;
  }

  const content = task.result ?? task.error ?? task.outputSummary ?? task.description;
  const normalized = String(content ?? "").trim();
  if (!normalized) return null;

  return {
    id: `${task.taskId}:${task.status}:${task.completedAt ?? task.lastActiveAt ?? task.createdAt}`,
    taskId: task.taskId,
    kind: task.status === "completed" ? "result" : "error",
    content: normalized,
    createdAt: task.completedAt ?? task.lastActiveAt ?? task.createdAt,
    truncated: normalized.length > 600,
  };
}

export class AgentTaskManager {
  private tasks = new Map<string, AgentTask>();
  private notifications: AgentTaskNotification[] = [];
  private readonly outputSink = new AgentTaskOutputSink();
  private eventHandlers: AgentTaskEventHandler[] = [];

  constructor() {
    this.loadFromStorage();
  }

  static getInstance(): AgentTaskManager {
    return getAgentTaskManager();
  }

  registerTask(task: AgentTask | { toJSON?: () => Record<string, unknown> }): AgentTask | undefined {
    if ("sessionId" in task && "backend" in task && "source" in task) {
      return this.upsertTask(task);
    }

    const raw = typeof task.toJSON === "function" ? task.toJSON() : undefined;
    const taskId = String(raw?.taskId ?? "");
    if (!taskId) return undefined;
    return this.upsertTask({
      taskId,
      sessionId: String(raw?.sessionId ?? "legacy"),
      source: "background",
      backend: "in_process",
      status: (raw?.status as AgentTask["status"]) ?? "queued",
      title: String(raw?.agentName ?? raw?.title ?? taskId),
      description: String(raw?.prompt ?? raw?.description ?? ""),
      createdAt: Number(raw?.createdAt ?? Date.now()),
      lastActiveAt: Date.now(),
      targetActorId: typeof raw?.agentId === "string" ? raw.agentId : undefined,
      targetName: typeof raw?.agentName === "string" ? raw.agentName : undefined,
      recentActivity: [],
      recentActivitySummary: typeof raw?.progress === "string" ? raw.progress : undefined,
      outputFile: typeof raw?.outputFile === "string" ? raw.outputFile : undefined,
      result: typeof raw?.result === "string" ? raw.result : undefined,
      error: typeof raw?.error === "string" ? raw.error : undefined,
      pendingMessageCount: 0,
      resumable: true,
      metadata: raw ?? undefined,
    });
  }

  upsertTask(task: AgentTask): AgentTask {
    const previous = this.tasks.get(task.taskId);
    const nextTask = maybeAppendActivity({
      task: {
        ...task,
        recentActivity: [...task.recentActivity],
      },
      previous,
    });
    const notification = buildAgentTaskNotification({ task: nextTask, previous });
    const next = notification
      ? {
          ...nextTask,
          latestNotificationId: notification.id,
        }
      : nextTask;

    this.tasks.set(task.taskId, next);
    this.emit({ type: "task_upserted", task: next, previous });

    const outputEntry = buildTerminalOutputEntry({ task: next, previous });
    if (outputEntry) {
      this.outputSink.append(outputEntry);
      this.emit({ type: "output_appended", entry: outputEntry });
    }

    if (notification) {
      this.notifications = [...this.notifications, notification].slice(-MAX_NOTIFICATIONS);
      this.emit({ type: "notification_added", notification });
    }

    this.persist();
    return next;
  }

  updateTask(taskId: string, patch: Partial<AgentTask>): AgentTask | undefined {
    const previous = this.tasks.get(taskId);
    if (!previous) return undefined;
    return this.upsertTask({
      ...previous,
      ...patch,
      taskId: previous.taskId,
      sessionId: patch.sessionId ?? previous.sessionId,
      source: patch.source ?? previous.source,
      backend: patch.backend ?? previous.backend,
      recentActivity: patch.recentActivity ? [...patch.recentActivity] : [...previous.recentActivity],
      metadata: patch.metadata
        ? { ...(previous.metadata ?? {}), ...patch.metadata }
        : previous.metadata,
    });
  }

  removeTask(taskId: string): boolean {
    const existed = this.tasks.delete(taskId);
    if (!existed) return false;
    this.outputSink.remove(taskId);
    this.notifications = this.notifications.filter((notification) => notification.taskId !== taskId);
    this.emit({ type: "task_removed", taskId });
    this.persist();
    return true;
  }

  appendOutput(entry: AgentTaskOutputEntry): void {
    this.outputSink.append(entry);
    this.emit({ type: "output_appended", entry });
    this.persist();
  }

  syncSpawnedTask(params: {
    sessionId: string;
    record: SpawnedTaskRecord;
    spawnerName?: string;
    targetName?: string;
    source?: AgentTaskSource;
    backend?: AgentTaskBackend;
    pendingMessageCount?: number;
  }): AgentTask {
    const taskId = resolveAgentTaskIdFromRunId(params.record.runId);
    const previous = this.tasks.get(taskId);
    const nextTask = maybeAppendActivity({
      task: buildTaskFromSpawnedTask({
        ...params,
        previous,
      }),
      previous,
    });
    const notification = buildAgentTaskNotification({ task: nextTask, previous });
    const next = notification
      ? {
          ...nextTask,
          latestNotificationId: notification.id,
        }
      : nextTask;
    this.tasks.set(taskId, next);
    this.emit({ type: "task_upserted", task: next, previous });

    const outputEntry = buildTerminalOutputEntry({ task: next, previous });
    if (outputEntry) {
      this.outputSink.append(outputEntry);
      this.emit({ type: "output_appended", entry: outputEntry });
    }

    if (notification) {
      this.notifications = [...this.notifications, notification].slice(-MAX_NOTIFICATIONS);
      this.emit({ type: "notification_added", notification });
    }

    this.persist();
    return next;
  }

  syncDeferredTask(record: DeferredAgentTaskRecord): AgentTask {
    const taskId = resolveDeferredAgentTaskIdFromQueueId(record.queueId);
    const previous = this.tasks.get(taskId);
    const nextTask = maybeAppendActivity({
      task: buildTaskFromDeferredSpawn({ record, previous }),
      previous,
    });
    const notification = buildAgentTaskNotification({ task: nextTask, previous });
    const next = notification
      ? {
          ...nextTask,
          latestNotificationId: notification.id,
        }
      : nextTask;

    this.tasks.set(taskId, next);
    this.emit({ type: "task_upserted", task: next, previous });

    if (notification) {
      this.notifications = [...this.notifications, notification].slice(-MAX_NOTIFICATIONS);
      this.emit({ type: "notification_added", notification });
    }

    this.persist();
    return next;
  }

  failDeferredTask(params: DeferredAgentTaskRecord & { error: string }): AgentTask {
    return this.syncDeferredTask({
      ...params,
      error: params.error,
    });
  }

  removeDeferredTask(queueId: string): boolean {
    const taskId = resolveDeferredAgentTaskIdFromQueueId(queueId);
    const existed = this.tasks.delete(taskId);
    if (!existed) return false;
    this.outputSink.remove(taskId);
    this.notifications = this.notifications.filter((notification) => notification.taskId !== taskId);
    this.emit({ type: "task_removed", taskId });
    this.persist();
    return true;
  }

  get(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.get(taskId);
  }

  getByRunId(runId: string): AgentTask | undefined {
    return this.tasks.get(resolveAgentTaskIdFromRunId(runId));
  }

  list(filter?: AgentTaskFilter): AgentTask[] {
    let tasks = [...this.tasks.values()];

    if (filter?.sessionId) {
      tasks = tasks.filter((task) => task.sessionId === filter.sessionId);
    }
    if (filter?.status?.length) {
      tasks = tasks.filter((task) => filter.status!.includes(task.status));
    }
    if (filter?.source?.length) {
      tasks = tasks.filter((task) => filter.source!.includes(task.source));
    }
    if (filter?.backend?.length) {
      tasks = tasks.filter((task) => filter.backend!.includes(task.backend));
    }
    if (filter?.actorId) {
      tasks = tasks.filter((task) =>
        task.targetActorId === filter.actorId || task.spawnerActorId === filter.actorId,
      );
    }
    if (filter?.text?.trim()) {
      tasks = tasks.filter((task) => matchText(task, filter.text!));
    }
    if (filter?.includeCompleted === false) {
      tasks = tasks.filter((task) => task.status === "running" || task.status === "queued");
    }

    return tasks.sort((left, right) => {
      const leftAt = left.lastActiveAt ?? left.completedAt ?? left.startedAt ?? left.createdAt;
      const rightAt = right.lastActiveAt ?? right.completedAt ?? right.startedAt ?? right.createdAt;
      return rightAt - leftAt;
    });
  }

  getAllTasks(): AgentTask[] {
    return this.list();
  }

  listNotifications(filter?: {
    taskId?: string;
    unreadOnly?: boolean;
  }): AgentTaskNotification[] {
    return [...this.notifications]
      .filter((notification) => {
        if (filter?.taskId && notification.taskId !== filter.taskId) return false;
        if (filter?.unreadOnly && notification.read) return false;
        return true;
      })
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  listOutputs(taskId: string): AgentTaskOutputEntry[] {
    return this.outputSink.list(taskId);
  }

  markNotificationRead(notificationId: string): void {
    let changed = false;
    this.notifications = this.notifications.map((notification) => {
      if (notification.id !== notificationId || notification.read) return notification;
      changed = true;
      return {
        ...notification,
        read: true,
      };
    });
    if (changed) {
      this.persist();
    }
  }

  clearSession(sessionId: string): void {
    let changed = false;
    const removedTaskIds = new Set<string>();
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.sessionId !== sessionId) continue;
      this.tasks.delete(taskId);
      this.outputSink.remove(taskId);
      removedTaskIds.add(taskId);
      changed = true;
      this.emit({ type: "task_removed", taskId });
    }
    if (!changed) return;
    this.notifications = this.notifications.filter((notification) => !removedTaskIds.has(notification.taskId));
    this.persist();
  }

  reset(): void {
    this.tasks.clear();
    this.notifications = [];
    this.outputSink.clear();
    this.persist();
  }

  onEvent(handler: AgentTaskEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((item) => item !== handler);
    };
  }

  private emit(event: AgentTaskEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        log.warn("agent task event handler failed", error);
      }
    }
  }

  private persist(): void {
    if (!canUseStorage()) return;
    try {
      const tasks = this.list().slice(0, MAX_PERSISTED_TASKS);
      const notifications = this.listNotifications().slice(0, MAX_NOTIFICATIONS);
      const outputs = this.outputSink.snapshot();
      const payload: PersistedAgentTaskState = {
        tasks,
        notifications,
        outputs,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      log.warn("persist agent tasks failed", error);
    }
  }

  private loadFromStorage(): void {
    if (!canUseStorage()) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const payload = JSON.parse(raw) as PersistedAgentTaskState;
      if (Array.isArray(payload?.tasks)) {
        for (const task of payload.tasks) {
          if (!task.taskId || !task.title) continue;
          this.tasks.set(task.taskId, task);
        }
      }
      if (Array.isArray(payload?.notifications)) {
        this.notifications = payload.notifications.slice(-MAX_NOTIFICATIONS);
      }
      this.outputSink.restore(payload?.outputs);
    } catch (error) {
      log.warn("load agent tasks failed", error);
    }
  }
}

let instance: AgentTaskManager | null = null;

export function getAgentTaskManager(): AgentTaskManager {
  if (!instance) {
    instance = new AgentTaskManager();
  }
  return instance;
}

export function resetAgentTaskManager(): void {
  instance?.reset();
  instance = null;
}
