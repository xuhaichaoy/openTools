import { create } from "zustand";
import { ActorSystem, type ActorSystemOptions } from "@/core/agent/actor/actor-system";
import type { AgentActor } from "@/core/agent/actor/agent-actor";
import { DIALOG_FULL_ROLE } from "@/core/agent/actor/agent-actor";
import type { AICenterHandoff } from "@/store/app-store";
import type {
  AgentCapabilities,
  ActorConfig,
  ActorStatus,
  DialogArtifactRecord,
  DialogQueuedFollowUp,
  DialogExecutionPlan,
  DialogMessage,
  MiddlewareOverrides,
  PendingInteraction,
  SessionUploadRecord,
  SpawnedTaskRecord,
  SpawnedTaskEventDetail,
  ThinkingLevel,
  ToolPolicy,
} from "@/core/agent/actor/types";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { createLogger } from "@/core/logger";
import { getChannelManager } from "@/core/channels/channel-manager";
import { getTaskQueue, createActorSystemExecutor } from "@/core/task-center";
import {
  getLatestActiveSessionId,
  loadSession as loadSessionFromDisk,
  saveSession as saveSessionToDisk,
  type TranscriptSession,
} from "@/core/agent/actor/session-persistence";
import {
  clearAllTodos,
  clearSessionApprovals,
  getSessionApprovalsSnapshot,
  getActorTodoList,
  replaceActorTodoList,
  restoreSessionApprovals,
  type TodoItem,
} from "@/core/agent/actor/middlewares";
import {
  buildAISessionRuntimeChildExternalId,
  summarizeAISessionRuntimeText,
} from "@/core/ai/ai-session-runtime";
import { buildDialogContextSummary } from "@/core/agent/actor/dialog-session-summary";
import { buildSpawnedTaskCheckpoint } from "@/core/agent/actor/spawned-task-checkpoint";
import {
  buildDialogContextSnapshot,
  cloneDialogContextSnapshot,
  type DialogContextSnapshot,
} from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";
import { useAISessionRuntimeStore } from "@/store/ai-session-runtime-store";
import {
  registerRuntimeAbortHandler,
  unregisterRuntimeAbortHandler,
  useRuntimeStateStore,
} from "@/core/agent/context-runtime/runtime-state";

const log = createLogger("ActorStore");

// ── Session 持久化 ──

const LEGACY_STORAGE_KEY = "dialog_session";
const ACTIVE_SESSION_POINTER_KEY = "dialog_session_pointer";
const SCHEMA_VERSION = 3;

interface PersistedSpawnedTask {
  runId: string;
  spawnerActorId: string;
  targetActorId: string;
  parentRunId?: string;
  rootRunId?: string;
  roleBoundary?: SpawnedTaskRecord["roleBoundary"];
  task: string;
  label?: string;
  status: string;
  spawnedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  sessionHistoryStartIndex?: number;
  sessionHistoryEndIndex?: number;
  mode?: SpawnedTaskRecord["mode"];
  expectsCompletionMessage?: boolean;
  cleanup?: SpawnedTaskRecord["cleanup"];
  sessionOpen?: boolean;
  lastActiveAt?: number;
  sessionClosedAt?: number;
}

interface PersistedSession {
  version?: number;
  dialogHistory: DialogMessage[];
  actorConfigs: Array<{
    id: string;
    roleName: string;
    model?: string;
    systemPrompt?: string;
    capabilities?: AgentCapabilities;
    toolPolicy?: ToolPolicy;
    workspace?: string;
    timeoutSeconds?: number;
    contextTokens?: number;
    thinkingLevel?: ThinkingLevel;
    middlewareOverrides?: MiddlewareOverrides;
    sessionHistory?: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
  }>;
  actorTodos?: Record<string, TodoItem[]>;
  spawnedTasks?: PersistedSpawnedTask[];
  artifacts?: DialogArtifactRecord[];
  sessionUploads?: SessionUploadRecord[];
  queuedFollowUps?: DialogQueuedFollowUp[];
  focusedSpawnedSessionRunId?: string | null;
  coordinatorActorId?: string | null;
  dialogExecutionPlan?: DialogExecutionPlan | null;
  approvalCache?: Record<string, "always-allow" | "ask-every-time" | "deny">;
  sourceHandoff?: AICenterHandoff | null;
  contextSnapshot?: DialogContextSnapshot | null;
  sessionId?: string;
  savedAt: number;
}

function cloneAICenterHandoff(handoff?: AICenterHandoff | null): AICenterHandoff | null {
  if (!handoff) return null;
  return {
    ...handoff,
    ...(handoff.attachmentPaths ? { attachmentPaths: [...handoff.attachmentPaths] } : {}),
    ...(handoff.visualAttachmentPaths ? { visualAttachmentPaths: [...handoff.visualAttachmentPaths] } : {}),
    ...(handoff.keyPoints ? { keyPoints: [...handoff.keyPoints] } : {}),
    ...(handoff.nextSteps ? { nextSteps: [...handoff.nextSteps] } : {}),
    ...(handoff.contextSections
      ? {
          contextSections: handoff.contextSections.map((section) => ({
            ...section,
            items: [...section.items],
          })),
        }
      : {}),
    ...(handoff.files
      ? { files: handoff.files.map((file) => ({ ...file })) }
      : {}),
  };
}

function collectUniquePreviewItems(items: readonly string[], limit = 4): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = String(item || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function getPendingInteractionTypeFromMessage(message: DialogMessage): PendingInteraction["type"] | null {
  if (message.interactionType) return message.interactionType;
  switch (message.kind) {
    case "approval_request":
      return "approval";
    case "clarification_request":
      return "clarification";
    default:
      return message.expectReply ? "question" : null;
  }
}

function buildRecoveredPendingUserInteractions(
  dialogHistory: readonly DialogMessage[],
  livePendingInteractions: readonly PendingInteraction[],
): PendingInteraction[] {
  const pendingByMessageId = new Map<string, PendingInteraction>();
  livePendingInteractions.forEach((interaction) => {
    if (interaction.status === "pending") {
      pendingByMessageId.set(interaction.messageId, interaction);
    }
  });

  for (const message of dialogHistory) {
    if (!message.expectReply || message.from === "user" || message.interactionStatus !== "pending") {
      continue;
    }
    if (pendingByMessageId.has(message.id)) continue;

    const interactionType = getPendingInteractionTypeFromMessage(message);
    if (!interactionType) continue;

    pendingByMessageId.set(message.id, {
      id: message.interactionId ?? `restored-${message.id}`,
      fromActorId: message.from,
      messageId: message.id,
      question: message.content,
      type: interactionType,
      replyMode: "single",
      status: "pending",
      createdAt: message.timestamp,
      options: message.options,
      approvalRequest: message.approvalRequest,
      resolve: () => {},
    });
  }

  return [...pendingByMessageId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function buildSessionSnapshot(
  dialogHistory: DialogMessage[],
  actors: AgentActor[],
  spawnedTasks?: Map<string, SpawnedTaskRecord>,
  artifacts?: readonly DialogArtifactRecord[],
  sessionUploads?: readonly SessionUploadRecord[],
  queuedFollowUps?: readonly DialogQueuedFollowUp[],
  focusedSpawnedSessionRunId?: string | null,
  coordinatorActorId?: string | null,
  dialogExecutionPlan?: DialogExecutionPlan | null,
  approvalCache?: Record<string, "always-allow" | "ask-every-time" | "deny">,
  sourceHandoff?: AICenterHandoff | null,
  contextSnapshot?: DialogContextSnapshot | null,
  sessionId?: string,
): PersistedSession {
  const persistedTasks: PersistedSpawnedTask[] = [];
  if (spawnedTasks) {
    for (const r of spawnedTasks.values()) {
      persistedTasks.push({
        runId: r.runId,
        spawnerActorId: r.spawnerActorId,
        targetActorId: r.targetActorId,
        parentRunId: r.parentRunId,
        rootRunId: r.rootRunId,
        roleBoundary: r.roleBoundary,
        task: r.task.slice(0, 500),
        label: r.label,
        status: r.status,
        spawnedAt: r.spawnedAt,
        completedAt: r.completedAt,
        result: r.result?.slice(0, 1000),
        error: r.error,
        sessionHistoryStartIndex: r.sessionHistoryStartIndex,
        sessionHistoryEndIndex: r.sessionHistoryEndIndex,
        mode: r.mode,
        expectsCompletionMessage: r.expectsCompletionMessage,
        cleanup: r.cleanup,
        sessionOpen: r.sessionOpen,
        lastActiveAt: r.lastActiveAt,
        sessionClosedAt: r.sessionClosedAt,
      });
    }
  }

  return {
    version: SCHEMA_VERSION,
    dialogHistory: dialogHistory.slice(-200),
    actorConfigs: actors.map((a) => ({
      id: a.id,
      roleName: a.role.name,
      model: a.modelOverride,
      systemPrompt: a.getSystemPromptOverride(),
      capabilities: a.capabilities,
      toolPolicy: a.toolPolicyConfig,
      workspace: a.workspace,
      timeoutSeconds: a.timeoutSeconds,
      contextTokens: a.contextTokens,
      thinkingLevel: a.thinkingLevel,
      middlewareOverrides: a.middlewareOverrides,
      sessionHistory: a.getSessionHistory(),
    })),
    actorTodos: Object.fromEntries(
      actors
        .map((actor) => [
          actor.id,
          getActorTodoList(actor.id).map((todo) => ({ ...todo })),
        ] satisfies [string, TodoItem[]])
        .filter(([, todos]) => todos.length > 0),
    ),
    spawnedTasks: persistedTasks,
    artifacts: artifacts ? artifacts.map((artifact) => ({ ...artifact })) : undefined,
    sessionUploads: sessionUploads ? sessionUploads.map((upload) => ({ ...upload })) : undefined,
    queuedFollowUps: queuedFollowUps
      ? queuedFollowUps.map((item) => ({
          ...item,
          ...(item.images ? { images: [...item.images] } : {}),
          ...(item.attachmentPaths ? { attachmentPaths: [...item.attachmentPaths] } : {}),
          ...(item.uploadRecords
            ? { uploadRecords: item.uploadRecords.map((record) => ({ ...record })) }
            : {}),
        }))
      : undefined,
    focusedSpawnedSessionRunId,
    coordinatorActorId,
    dialogExecutionPlan,
    approvalCache,
    sourceHandoff: cloneAICenterHandoff(sourceHandoff),
    contextSnapshot: cloneDialogContextSnapshot(contextSnapshot),
    sessionId,
    savedAt: Date.now(),
  };
}

function buildPersistableDialogContextSnapshot(params: {
  sessionId: string;
  actors: readonly {
    id: string;
    roleName: string;
    workspace?: string;
    status: ActorStatus;
    lastMemoryRecallAttempted?: boolean;
    lastMemoryRecallPreview?: string[];
    lastTranscriptRecallAttempted?: boolean;
    lastTranscriptRecallHitCount?: number;
    lastTranscriptRecallPreview?: string[];
  }[];
  dialogHistory: readonly DialogMessage[];
  artifacts: readonly DialogArtifactRecord[];
  sessionUploads: readonly SessionUploadRecord[];
  spawnedTasks: readonly SpawnedTaskRecord[];
  pendingUserInteractions: readonly PendingInteraction[];
  queuedFollowUps: readonly DialogQueuedFollowUp[];
  focusedSpawnedSessionRunId?: string | null;
  coordinatorActorId?: string | null;
  sourceHandoff?: AICenterHandoff | null;
}): DialogContextSnapshot | null {
  const actorById = new Map(params.actors.map((actor) => [actor.id, actor] as const));
  const workspaceRoot = (
    (params.coordinatorActorId ? actorById.get(params.coordinatorActorId)?.workspace : undefined)
    ?? params.actors.find((actor) => typeof actor.workspace === "string" && actor.workspace.trim().length > 0)?.workspace
  );
  const actorNameById = new Map(params.actors.map((actor) => [actor.id, actor.roleName] as const));
  const memoryPreview = collectUniquePreviewItems(
    params.actors.flatMap((actor) => actor.lastMemoryRecallPreview ?? []),
  );
  const transcriptPreview = collectUniquePreviewItems(
    params.actors.flatMap((actor) => actor.lastTranscriptRecallPreview ?? []),
  );
  const transcriptRecallHitCount = params.actors.reduce(
    (sum, actor) => sum + Math.max(0, actor.lastTranscriptRecallHitCount ?? 0),
    0,
  );
  const dialogContextSummary = buildDialogContextSummary({
    dialogHistory: params.dialogHistory,
    artifacts: params.artifacts,
    sessionUploads: params.sessionUploads,
    spawnedTasks: params.spawnedTasks,
    actorNameById,
  });
  const focusedTask = params.focusedSpawnedSessionRunId
    ? params.spawnedTasks.find(
        (task) => task.runId === params.focusedSpawnedSessionRunId && task.mode === "session" && task.sessionOpen,
      )
    : undefined;
  const focusedSessionLabel = focusedTask
    ? focusedTask.label || actorById.get(focusedTask.targetActorId)?.roleName || focusedTask.targetActorId
    : undefined;
  const snapshot = buildDialogContextSnapshot({
    sessionId: params.sessionId,
    workspaceRoot,
    sourceHandoff: params.sourceHandoff,
    dialogContextSummary,
    dialogHistoryCount: params.dialogHistory.length,
    sessionUploads: params.sessionUploads,
    artifacts: params.artifacts,
    spawnedTasks: params.spawnedTasks,
    actorCount: params.actors.length,
    runningActorCount: params.actors.filter((actor) => actor.status === "running").length,
    pendingUserInteractions: params.pendingUserInteractions,
    queuedFollowUpCount: params.queuedFollowUps.length,
    focusedSessionRunId: params.focusedSpawnedSessionRunId,
    focusedSessionLabel,
    memoryRecallAttempted: params.actors.some((actor) => actor.lastMemoryRecallAttempted === true),
    memoryHitCount: memoryPreview.length,
    memoryPreview,
    transcriptRecallAttempted: params.actors.some(
      (actor) => actor.lastTranscriptRecallAttempted === true,
    ),
    transcriptRecallHitCount,
    transcriptPreview,
  });
  return snapshot.contextLines.length > 0 ? snapshot : null;
}

/** Max session age: discard sessions older than 7 days */
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function extractDialogRuntimeTitle(dialogHistory?: readonly DialogMessage[]): string | undefined {
  if (!dialogHistory?.length) return undefined;
  for (const message of dialogHistory) {
    if (message.from !== "user") continue;
    const preview = summarizeAISessionRuntimeText(
      message._briefContent ?? message.content,
      48,
    );
    if (preview) return preview;
  }
  return undefined;
}

function buildDialogRuntimeSummary(
  dialogHistory?: readonly DialogMessage[],
  spawnedTasks?: readonly SpawnedTaskRecord[],
  pendingUserInteractions?: readonly PendingInteraction[],
): string | undefined {
  const pendingApprovals = pendingUserInteractions?.filter(
    (interaction) => interaction.status === "pending" && interaction.type === "approval",
  ).length ?? 0;
  if (pendingApprovals > 0) {
    return `等待 ${pendingApprovals} 个审批确认`;
  }

  const pendingReplies = pendingUserInteractions?.filter(
    (interaction) => interaction.status === "pending" && interaction.type !== "approval",
  ).length ?? 0;
  if (pendingReplies > 0) {
    return `等待 ${pendingReplies} 个用户回复`;
  }

  const runningTasks = spawnedTasks?.filter((task) => task.status === "running").length ?? 0;
  const openSessions = spawnedTasks?.filter(
    (task) => task.mode === "session" && task.sessionOpen,
  ).length ?? 0;
  if (runningTasks > 0 || openSessions > 0) {
    if (runningTasks > 0 && openSessions > 0) {
      return `运行中：${runningTasks} 个子任务，${openSessions} 个开放子会话`;
    }
    if (runningTasks > 0) {
      return `运行中：${runningTasks} 个子任务`;
    }
    return `保留 ${openSessions} 个开放子会话`;
  }

  const latestMessage = dialogHistory?.[dialogHistory.length - 1];
  return summarizeAISessionRuntimeText(
    latestMessage?._briefContent ?? latestMessage?.content,
    140,
  );
}

function getDialogRuntimeUpdatedAt(
  dialogHistory?: readonly DialogMessage[],
  spawnedTasks?: readonly SpawnedTaskRecord[],
  pendingUserInteractions?: readonly PendingInteraction[],
): number | undefined {
  const timestamps: number[] = [];
  const lastMessageTimestamp = dialogHistory?.[dialogHistory.length - 1]?.timestamp;
  if (typeof lastMessageTimestamp === "number") {
    timestamps.push(lastMessageTimestamp);
  }
  for (const task of spawnedTasks ?? []) {
    if (typeof task.lastActiveAt === "number") timestamps.push(task.lastActiveAt);
    if (typeof task.completedAt === "number") timestamps.push(task.completedAt);
    if (typeof task.spawnedAt === "number") timestamps.push(task.spawnedAt);
  }
  for (const interaction of pendingUserInteractions ?? []) {
    if (typeof interaction.createdAt === "number") timestamps.push(interaction.createdAt);
  }
  return timestamps.length ? Math.max(...timestamps) : undefined;
}

function syncDialogRuntimeSession(
  sessionId: string,
  options?: {
    dialogHistory?: readonly DialogMessage[];
    spawnedTasks?: readonly SpawnedTaskRecord[];
    pendingUserInteractions?: readonly PendingInteraction[];
    sourceHandoff?: AICenterHandoff | null;
    updatedAt?: number;
  },
): void {
  const runtimeStore = useAISessionRuntimeStore.getState();
  const title = extractDialogRuntimeTitle(options?.dialogHistory);
  const summary = buildDialogRuntimeSummary(
    options?.dialogHistory,
    options?.spawnedTasks,
    options?.pendingUserInteractions,
  );
  const existing = runtimeStore.getSessionByExternal("dialog", sessionId);
  const activityAt =
    options?.updatedAt
    ?? getDialogRuntimeUpdatedAt(
      options?.dialogHistory,
      options?.spawnedTasks,
      options?.pendingUserInteractions,
    )
    ?? Date.now();
  const shouldRefreshTimestamp = Boolean(
    (title && title !== existing?.title)
      || summary !== existing?.summary,
  );
  const updatedAt = shouldRefreshTimestamp
    ? Math.max(activityAt, Date.now())
    : activityAt;

  if (
    existing
    && existing.lastActiveAt >= updatedAt
    && (!title || title === existing.title)
    && summary === existing.summary
  ) {
    return;
  }

  runtimeStore.ensureSession({
    mode: "dialog",
    externalSessionId: sessionId,
    title: title || "Dialog 房间",
    summary,
    updatedAt,
    ...(options?.sourceHandoff?.sourceMode
      ? {
          source: {
            sourceMode: options.sourceHandoff.sourceMode,
            ...(options.sourceHandoff.sourceSessionId
              ? { sourceSessionId: options.sourceHandoff.sourceSessionId }
              : {}),
            ...(options.sourceHandoff.sourceLabel
              ? { sourceLabel: options.sourceHandoff.sourceLabel }
              : {}),
            ...(options.sourceHandoff.summary
              ? { summary: options.sourceHandoff.summary }
              : {}),
          },
        }
      : {}),
    });
}

function resolveDialogRuntimeWorkspaceRoot(
  actors?: readonly Pick<ActorSnapshot, "id" | "workspace">[],
  coordinatorActorId?: string | null,
): string | undefined {
  if (!actors?.length) return undefined;
  const coordinatorWorkspace = coordinatorActorId
    ? actors.find((actor) => actor.id === coordinatorActorId)?.workspace
    : undefined;
  const fallbackWorkspace = actors.find(
    (actor) => typeof actor.workspace === "string" && actor.workspace.trim().length > 0,
  )?.workspace;
  const workspaceRoot = coordinatorWorkspace || fallbackWorkspace;
  return workspaceRoot?.trim() ? workspaceRoot : undefined;
}

function syncDialogRuntimeState(params: {
  sessionId: string;
  system: ActorSystem;
  actors?: readonly Pick<ActorSnapshot, "id" | "workspace">[];
  coordinatorActorId?: string | null;
  dialogHistory?: readonly DialogMessage[];
  spawnedTasks?: readonly SpawnedTaskRecord[];
  pendingUserInteractions?: readonly PendingInteraction[];
  queuedFollowUps?: readonly DialogQueuedFollowUp[];
  sourceHandoff?: AICenterHandoff | null;
  updatedAt?: number;
}): void {
  const pendingApprovals = params.pendingUserInteractions?.filter(
    (interaction) => interaction.status === "pending" && interaction.type === "approval",
  ).length ?? 0;
  const pendingReplies = params.pendingUserInteractions?.filter(
    (interaction) => interaction.status === "pending" && interaction.type !== "approval",
  ).length ?? 0;
  const runningTasks = params.spawnedTasks?.filter((task) => task.status === "running").length ?? 0;
  const queuedFollowUps = params.queuedFollowUps?.length ?? 0;
  const shouldKeepRuntime =
    pendingApprovals > 0
    || pendingReplies > 0
    || runningTasks > 0
    || queuedFollowUps > 0;

  if (!shouldKeepRuntime) {
    unregisterRuntimeAbortHandler("dialog", params.sessionId);
    useRuntimeStateStore.getState().removeSession("dialog", params.sessionId);
    return;
  }

  registerRuntimeAbortHandler("dialog", params.sessionId, () => {
    params.system.abortAll();
  });

  const waitingStage =
    pendingApprovals > 0
      ? "user_confirm"
      : pendingReplies > 0
        ? "user_reply"
        : queuedFollowUps > 0 && runningTasks === 0
          ? "follow_up_queue"
          : "dialog_running";
  const status =
    pendingApprovals > 0
      ? "awaiting_approval"
      : pendingReplies > 0
        ? "awaiting_reply"
        : queuedFollowUps > 0 && runningTasks === 0
          ? "queued"
          : "running";
  const query =
    extractDialogRuntimeTitle(params.dialogHistory)
    || summarizeAISessionRuntimeText(params.sourceHandoff?.query || "", 96)
    || "Dialog 房间";
  const startedAt =
    params.dialogHistory?.[0]?.timestamp
    ?? params.spawnedTasks?.[0]?.spawnedAt
    ?? params.updatedAt
    ?? Date.now();
  const workspaceRoot = resolveDialogRuntimeWorkspaceRoot(
    params.actors,
    params.coordinatorActorId,
  );

  useRuntimeStateStore.getState().upsertSession({
    mode: "dialog",
    sessionId: params.sessionId,
    query,
    startedAt,
    updatedAt: params.updatedAt,
    workspaceRoot,
    waitingStage,
    status,
  });
}

function buildDialogSpawnedRuntimeExternalSessionId(
  sessionId: string,
  record: Pick<SpawnedTaskRecord, "runId" | "mode">,
): string {
  return buildAISessionRuntimeChildExternalId(
    sessionId,
    record.mode === "session" ? "spawn_session" : "spawn_run",
    record.runId,
  );
}

function buildDialogSpawnedRuntimeTitle(
  record: SpawnedTaskRecord,
  actorNameById: ReadonlyMap<string, string>,
): string {
  const targetName = actorNameById.get(record.targetActorId) ?? "子代理";
  const label = summarizeAISessionRuntimeText(record.label ?? record.task, 40);
  if (record.mode === "session") {
    return label ? `${targetName} · ${label}` : `${targetName} 子会话`;
  }
  return label ? `${targetName} · ${label}` : `${targetName} 子任务`;
}

function buildDialogSpawnedRuntimeSummary(
  record: SpawnedTaskRecord,
  actorNameById: ReadonlyMap<string, string>,
  options?: {
    actorSessionHistoryById?: ReadonlyMap<string, Array<{ role: "user" | "assistant"; content: string; timestamp: number }>>;
    actorTodosById?: Readonly<Record<string, TodoItem[]>>;
    dialogHistory?: readonly DialogMessage[];
    artifacts?: readonly DialogArtifactRecord[];
  },
): string | undefined {
  const targetName = actorNameById.get(record.targetActorId) ?? record.targetActorId;
  const checkpoint = buildSpawnedTaskCheckpoint({
    task: record,
    targetActor: {
      roleName: targetName,
      sessionHistory: options?.actorSessionHistoryById?.get(record.targetActorId) ?? [],
    },
    actorTodos: options?.actorTodosById?.[record.targetActorId] ?? [],
    dialogHistory: options?.dialogHistory,
    artifacts: options?.artifacts,
    actorNameById,
  });
  if (checkpoint) {
    const parts = [
      checkpoint.stageLabel,
      targetName,
      checkpoint.summary,
      checkpoint.nextStep ? `下一步：${checkpoint.nextStep}` : "",
    ].filter(Boolean);
    const checkpointSummary = summarizeAISessionRuntimeText(parts.join(" · "), 180);
    if (checkpointSummary) return checkpointSummary;
  }
  const taskPreview = summarizeAISessionRuntimeText(record.task, 110);
  if (typeof record.error === "string" && record.error.trim()) {
    const errorPreview = summarizeAISessionRuntimeText(record.error, 120);
    return errorPreview ? `失败 · ${targetName} · ${errorPreview}` : `失败 · ${targetName}`;
  }
  if (typeof record.result === "string" && record.result.trim()) {
    const resultPreview = summarizeAISessionRuntimeText(record.result, 140);
    return resultPreview ? `完成 · ${targetName} · ${resultPreview}` : `完成 · ${targetName}`;
  }
  if (record.mode === "session" && record.sessionOpen) {
    return taskPreview
      ? `开放子会话 · ${targetName} · ${taskPreview}`
      : `开放子会话 · ${targetName}`;
  }
  switch (record.status) {
    case "running":
      return taskPreview
        ? `运行中 · ${targetName} · ${taskPreview}`
        : `运行中 · ${targetName}`;
    case "completed":
      return taskPreview
        ? `已完成 · ${targetName} · ${taskPreview}`
        : `已完成 · ${targetName}`;
    case "aborted":
      return taskPreview
        ? `已中止 · ${targetName} · ${taskPreview}`
        : `已中止 · ${targetName}`;
    case "error":
      return taskPreview
        ? `执行失败 · ${targetName} · ${taskPreview}`
        : `执行失败 · ${targetName}`;
    default:
      return taskPreview;
  }
}

function syncDialogSpawnedRuntimeSessions(
  sessionId: string,
  spawnedTasks: readonly SpawnedTaskRecord[],
  actors?: ReadonlyArray<{ id: string; roleName: string }>,
  options?: {
    actorSessionHistoryById?: ReadonlyMap<string, Array<{ role: "user" | "assistant"; content: string; timestamp: number }>>;
    actorTodosById?: Readonly<Record<string, TodoItem[]>>;
    dialogHistory?: readonly DialogMessage[];
    artifacts?: readonly DialogArtifactRecord[];
  },
): void {
  if (spawnedTasks.length === 0) return;

  const runtimeStore = useAISessionRuntimeStore.getState();
  const rootRuntime = runtimeStore.getSessionByExternal("dialog", sessionId);
  const actorNameById = new Map(actors?.map((actor) => [actor.id, actor.roleName]) ?? []);

  for (const record of spawnedTasks) {
    const externalSessionId = buildDialogSpawnedRuntimeExternalSessionId(sessionId, record);
    const title = buildDialogSpawnedRuntimeTitle(record, actorNameById);
    const summary = buildDialogSpawnedRuntimeSummary(record, actorNameById, options);
    const updatedAt = record.lastActiveAt ?? record.completedAt ?? record.spawnedAt;
    const kind = record.mode === "session" ? "collaboration_room" : "task_session";
    const existing = runtimeStore.getSessionByExternal("dialog", externalSessionId);

    if (
      existing
      && existing.lastActiveAt >= updatedAt
      && existing.title === title
      && existing.summary === summary
      && existing.kind === kind
    ) {
      continue;
    }

    runtimeStore.ensureSession({
      mode: "dialog",
      externalSessionId,
      kind,
      title,
      summary,
      createdAt: record.spawnedAt,
      updatedAt,
      source: {
        sourceMode: "dialog",
        sourceSessionId: sessionId,
        sourceLabel: rootRuntime?.title ?? "Dialog 房间",
        summary: rootRuntime?.summary,
      },
      linkType: "derived",
    });
  }
}

function loadLegacySession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedSession;

    // Schema version check: discard incompatible data
    if (data.version !== undefined && data.version !== SCHEMA_VERSION) {
      log.info(`Discarding session with outdated schema v${data.version} (current: v${SCHEMA_VERSION})`);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return null;
    }

    // Staleness check
    if (data.savedAt && Date.now() - data.savedAt > MAX_SESSION_AGE_MS) {
      log.info("Discarding stale session", { savedAt: data.savedAt, ageMs: Date.now() - data.savedAt });
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return null;
    }

    // Basic structural validation
    if (!Array.isArray(data.dialogHistory) || !Array.isArray(data.actorConfigs)) {
      log.warn("loadSession: invalid structure, clearing");
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return null;
    }

    return data;
  } catch (err) {
    log.warn("loadSession parse failed, clearing corrupted data", err);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return null;
  }
}

function clearPersistedSession(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function clearActiveSessionPointer(): void {
  try {
    localStorage.removeItem(ACTIVE_SESSION_POINTER_KEY);
  } catch {
    /* ignore */
  }
}

function saveActiveSessionPointer(sessionId: string): void {
  try {
    localStorage.setItem(ACTIVE_SESSION_POINTER_KEY, sessionId);
  } catch {
    /* ignore */
  }
}

function loadActiveSessionPointer(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_POINTER_KEY);
  } catch {
    return null;
  }
}

async function saveSessionSnapshot(system: ActorSystem): Promise<void> {
  const snapshot = buildSessionSnapshot(
    [...system.getDialogHistory()],
    system.getAll(),
    system.getSpawnedTasksMap(),
    system.getArtifactRecordsSnapshot(),
    system.getSessionUploadsSnapshot(),
    useActorSystemStore.getState().queuedFollowUps,
    system.getFocusedSpawnedSessionRunId(),
    system.getCoordinatorId(),
    system.getDialogExecutionPlan(),
    getSessionApprovalsSnapshot(),
    useActorSystemStore.getState().sourceHandoff,
    useActorSystemStore.getState().contextSnapshot,
    system.sessionId,
  );

  const existing = await loadSessionFromDisk(system.sessionId);
  const session: TranscriptSession = {
    sessionId: system.sessionId,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    entries: existing?.entries ?? [],
    actorConfigs: snapshot.actorConfigs.map((actor) => ({
      id: actor.id,
      name: actor.roleName,
      model: actor.model,
    })),
    snapshot: snapshot as unknown as Record<string, unknown>,
  };
  await saveSessionToDisk(session);
  saveActiveSessionPointer(system.sessionId);
}

function restoreSnapshot(system: ActorSystem, persisted: PersistedSession): void {
  if (persisted.dialogHistory.length) {
    system.restoreDialogHistory(persisted.dialogHistory);
  }
  for (const config of persisted.actorConfigs) {
    system.spawn({
      id: config.id,
      role: {
        ...DIALOG_FULL_ROLE,
        name: config.roleName,
        systemPrompt: config.systemPrompt ?? DIALOG_FULL_ROLE.systemPrompt,
      },
      modelOverride: config.model,
      systemPromptOverride: config.systemPrompt,
      capabilities: config.capabilities,
      toolPolicy: config.toolPolicy,
      workspace: config.workspace,
      timeoutSeconds: config.timeoutSeconds,
      contextTokens: config.contextTokens,
      thinkingLevel: config.thinkingLevel,
      middlewareOverrides: config.middlewareOverrides,
    });
    if (config.sessionHistory?.length) {
      system.restoreActorSessionHistory(config.id, config.sessionHistory);
    }
  }
  if (persisted.actorTodos) {
    for (const [actorId, todos] of Object.entries(persisted.actorTodos)) {
      replaceActorTodoList(actorId, todos);
    }
  }
  if (persisted.coordinatorActorId && system.get(persisted.coordinatorActorId)) {
    system.setCoordinator(persisted.coordinatorActorId);
  }
  if (persisted.dialogExecutionPlan) {
    system.restoreDialogExecutionPlan(persisted.dialogExecutionPlan);
  }
  restoreSessionApprovals(persisted.approvalCache);
  if (persisted.artifacts?.length) {
    system.restoreArtifactRecords(persisted.artifacts);
  }
  if (persisted.sessionUploads?.length) {
    system.restoreSessionUploads(persisted.sessionUploads);
  }
  // 恢复子任务记录（UI 展示用，不会恢复运行态）
  if (persisted.spawnedTasks?.length) {
    system.restoreSpawnedTasks(
      persisted.spawnedTasks.map((t) => ({
        runId: t.runId,
        spawnerActorId: t.spawnerActorId,
        targetActorId: t.targetActorId,
        parentRunId: t.parentRunId,
        rootRunId: t.rootRunId,
        roleBoundary: t.roleBoundary,
        task: t.task,
        label: t.label,
        status: t.status as SpawnedTaskRecord["status"],
        mode: t.mode ?? "run",
        expectsCompletionMessage: t.expectsCompletionMessage ?? false,
        cleanup: t.cleanup ?? "keep",
        spawnedAt: t.spawnedAt,
        completedAt: t.completedAt,
        result: t.result,
        error: t.error,
        sessionHistoryStartIndex: t.sessionHistoryStartIndex,
        sessionHistoryEndIndex: t.sessionHistoryEndIndex,
        sessionOpen: t.sessionOpen,
        lastActiveAt: t.lastActiveAt,
        sessionClosedAt: t.sessionClosedAt,
      })),
    );
  }
  if (persisted.focusedSpawnedSessionRunId) {
    try {
      system.focusSpawnedSession(persisted.focusedSpawnedSessionRunId);
    } catch {
      // ignore stale focus pointer
    }
  }
}

async function loadPersistedSessionSnapshot(): Promise<PersistedSession | null> {
  const pointer = loadActiveSessionPointer() ?? await getLatestActiveSessionId();
  if (pointer) {
    const diskSession = await loadSessionFromDisk(pointer);
    const snapshot = diskSession?.snapshot as PersistedSession | undefined;
    if (snapshot?.dialogHistory && snapshot?.actorConfigs) {
      saveActiveSessionPointer(pointer);
      return snapshot;
    }
  }
  return loadLegacySession();
}

function spawnDefaultActors(system: ActorSystem): void {
  const makeId = () => Math.random().toString(36).substring(2, 8);
  system.spawn({
    id: `agent-${makeId()}`,
    role: { ...DIALOG_FULL_ROLE, name: "Coordinator" },
    capabilities: {
      tags: ["coordinator", "synthesis", "code_analysis"],
      description: "默认协调者，负责理解任务、分配讨论方向并收束结论。",
    },
    middlewareOverrides: { approvalLevel: "permissive" },
  });
  system.spawn({
    id: `agent-${makeId()}`,
    role: { ...DIALOG_FULL_ROLE, name: "Specialist" },
    capabilities: {
      tags: ["code_analysis", "code_write", "debugging"],
      description: "默认执行者，负责深入分析、修复建议和具体实现细节。",
    },
  });
}

// ── Actor snapshot for UI ──

export interface ActorSnapshot {
  id: string;
  roleName: string;
  roleId: string;
  persistent: boolean;
  modelOverride?: string;
  systemPromptOverride?: string;
  toolPolicy?: ToolPolicy;
  workspace?: string;
  timeoutSeconds?: number;
  contextTokens?: number;
  thinkingLevel?: ThinkingLevel;
  middlewareOverrides?: MiddlewareOverrides;
  status: ActorStatus;
  pendingInbox: number;
  capabilities?: AgentCapabilities;
  sessionHistory: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
  lastMemoryRecallAttempted?: boolean;
  lastMemoryRecallPreview?: string[];
  lastTranscriptRecallAttempted?: boolean;
  lastTranscriptRecallHitCount?: number;
  lastTranscriptRecallPreview?: string[];
  currentTask?: {
    id: string;
    query: string;
    status: string;
    steps: AgentStep[];
  };
}

// ── Store State ──

interface ActorSystemState {
  /** 是否有活跃的 dialog session */
  active: boolean;
  /** 所有 Actor 的快照（UI 用） */
  actors: ActorSnapshot[];
  /** 对话历史 */
  dialogHistory: DialogMessage[];
  /** 当前子任务快照 */
  spawnedTasks: SpawnedTaskRecord[];
  /** 结构化产物工作区 */
  artifacts: DialogArtifactRecord[];
  /** 历史上传文件工作区 */
  sessionUploads: SessionUploadRecord[];
  /** 当前聚焦的子会话 runId */
  focusedSpawnedSessionRunId: string | null;
  /** 当前 coordinator 的 actor id */
  coordinatorActorId: string | null;
  /** 子任务生命周期事件流（UI 用于展示中间过程） */
  spawnedTaskEvents: SpawnedTaskEventDetail[];
  /** 当前待办快照 */
  actorTodos: Record<string, TodoItem[]>;
  /** 当前排队等待发送的新消息 */
  queuedFollowUps: DialogQueuedFollowUp[];
  /** 当前跨模式带入的接力上下文 */
  sourceHandoff: AICenterHandoff | null;
  /** 当前结构化上下文快照 */
  contextSnapshot: DialogContextSnapshot | null;
  /** 当前 ActorSystem 实例引用（不序列化） */
  _system: ActorSystem | null;

  // Actions
  init: (options?: ActorSystemOptions) => ActorSystem;
  getSystem: () => ActorSystem | null;
  spawnActor: (config: ActorConfig) => AgentActor;
  killActor: (actorId: string) => void;
  destroyAll: () => void;
  sendMessage: (from: string, to: string, content: string, opts?: { expectReply?: boolean; replyTo?: string; _briefContent?: string; images?: string[] }) => void;
  broadcastMessage: (from: string, content: string, opts?: { _briefContent?: string; images?: string[] }) => void;
  broadcastAndResolve: (from: string, content: string, opts?: { _briefContent?: string; images?: string[] }) => void;
  /** 智能路由：根据内容自动选择合适的 Agent */
  routeTask: (content: string, preferredCapabilities?: string[]) => { agentId: string; reason: string }[];
  assignTask: (actorId: string, query: string, images?: string[]) => void;
  abortAll: () => void;
  replyToMessage: (
    messageId: string,
    content: string,
    opts?: { _briefContent?: string; images?: string[] },
  ) => void;
  steer: (actorId: string, directive: string) => void;
  focusSpawnedSession: (runId: string | null) => void;
  closeSpawnedSession: (runId: string) => void;
  resetSession: (summary?: string) => void;
  enqueueFollowUp: (payload: Omit<DialogQueuedFollowUp, "id" | "createdAt">) => string;
  removeFollowUp: (id: string) => void;
  clearFollowUps: () => void;
  setSourceHandoff: (handoff: AICenterHandoff | null) => void;
  /** 等待用户回复的交互列表 */
  pendingUserInteractions: PendingInteraction[];
  /** 从 ActorSystem 同步最新状态到 store（供 UI 使用） */
  sync: () => void;
}

function snapshotActor(actor: AgentActor): ActorSnapshot {
  const current = actor.currentTask;
  return {
    id: actor.id,
    roleName: actor.role.name,
    roleId: actor.role.id,
    persistent: actor.persistent,
    modelOverride: actor.modelOverride,
    systemPromptOverride: actor.getSystemPromptOverride(),
    toolPolicy: actor.toolPolicyConfig,
    workspace: actor.workspace,
    timeoutSeconds: actor.timeoutSeconds,
    contextTokens: actor.contextTokens,
    thinkingLevel: actor.thinkingLevel,
    middlewareOverrides: actor.middlewareOverrides,
    status: actor.status,
    pendingInbox: actor.pendingInboxCount,
    capabilities: actor.capabilities,
    sessionHistory: actor.getSessionHistory(),
    lastMemoryRecallAttempted: actor.lastMemoryRecallAttempted,
    lastMemoryRecallPreview: actor.lastMemoryRecallPreview,
    lastTranscriptRecallAttempted: actor.lastTranscriptRecallAttempted,
    lastTranscriptRecallHitCount: actor.lastTranscriptRecallHitCount,
    lastTranscriptRecallPreview: actor.lastTranscriptRecallPreview,
    currentTask: current
      ? {
          id: current.id,
          query: current.query,
          status: current.status,
          steps: [...current.steps],
        }
      : undefined,
  };
}

// Debounced save: batch session snapshot writes to avoid I/O on every sync
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(system: ActorSystem): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    void saveSessionSnapshot(system).catch((err) => {
      log.warn("saveSessionSnapshot failed", err);
    });
  }, 2000);
}

export const useActorSystemStore = create<ActorSystemState>((set, get) => ({
  active: false,
  actors: [],
  dialogHistory: [],
  spawnedTasks: [],
  artifacts: [],
  sessionUploads: [],
  focusedSpawnedSessionRunId: null,
  coordinatorActorId: null,
  spawnedTaskEvents: [],
  actorTodos: {},
  queuedFollowUps: [],
  sourceHandoff: null,
  contextSnapshot: null,
  pendingUserInteractions: [],
  _system: null,

  init: (options) => {
    const existing = get()._system;
    if (existing) return existing;

    const system = new ActorSystem(options);
    clearSessionApprovals();

    // Capture spawned task lifecycle events for the UI
    const SPAWNED_TASK_EVENT_TYPES = new Set([
      "spawned_task_started", "spawned_task_running",
      "spawned_task_completed", "spawned_task_failed", "spawned_task_timeout",
    ]);
    const MAX_TASK_EVENTS = 100;

    // RAF-based debounce: coalesce rapid events into a single sync per frame
    let syncRAF = 0;
    system.onEvent((ev) => {
      if ("type" in ev) {
        const event = ev as { type: string; detail?: unknown };
        if (SPAWNED_TASK_EVENT_TYPES.has(event.type) && event.detail) {
          const detail = event.detail as SpawnedTaskEventDetail;
          set((state) => {
            const events = [...state.spawnedTaskEvents, detail];
            return { spawnedTaskEvents: events.slice(-MAX_TASK_EVENTS) };
          });
        }
        if (event.type === "session_title_updated" && event.detail) {
          const detail = event.detail as { sessionId?: string; title?: string };
          if (detail.sessionId && detail.title?.trim()) {
            useAISessionRuntimeStore.getState().ensureSession({
              mode: "dialog",
              externalSessionId: detail.sessionId,
              title: detail.title,
              updatedAt: Date.now(),
            });
          }
        }
      }
      if (!syncRAF) {
        syncRAF = requestAnimationFrame(() => {
          syncRAF = 0;
          get().sync();
        });
      }
    });

    // 连接 IM 通道管理器，实现 IM ↔ Agent 双向通信
    const channelMgr = getChannelManager();
    channelMgr.connectToActorSystem({
      broadcastAndResolve: (from, content, opts) => system.broadcastAndResolve(from, content, opts),
      getAll: () => system.getAll().map((a) => ({ id: a.id })),
      onEvent: (handler) => system.onEvent((ev) => handler(ev as unknown as Record<string, unknown>)),
    });
    channelMgr.listenForCallbacks().catch((err) =>
      log.warn("Failed to start IM callback listener (expected outside Tauri)", err),
    );

    // 连接任务队列执行器，使通用任务可委派给 Agent
    getTaskQueue().setExecutor(createActorSystemExecutor(system));

    set({ _system: system, active: true });
    void (async () => {
      const persisted = await loadPersistedSessionSnapshot();
      if (persisted?.sessionId) {
        (system as unknown as { sessionId: string }).sessionId = persisted.sessionId;
      }
      if (persisted) {
        restoreSnapshot(system, persisted);
        set({
          queuedFollowUps: persisted.queuedFollowUps?.map((item) => ({
            ...item,
            ...(item.images ? { images: [...item.images] } : {}),
            ...(item.attachmentPaths ? { attachmentPaths: [...item.attachmentPaths] } : {}),
            ...(item.uploadRecords
              ? { uploadRecords: item.uploadRecords.map((record) => ({ ...record })) }
              : {}),
          })) ?? [],
          sourceHandoff: cloneAICenterHandoff(persisted.sourceHandoff),
          contextSnapshot: cloneDialogContextSnapshot(persisted.contextSnapshot),
        });
      } else if (system.getAll().length === 0) {
        spawnDefaultActors(system);
      }
      saveActiveSessionPointer(system.sessionId);
      syncDialogRuntimeSession(system.sessionId, {
        sourceHandoff: persisted?.sourceHandoff,
      });
      get().sync();
    })().catch((err) => {
      log.warn("Failed to hydrate dialog session snapshot", err);
      if (system.getAll().length === 0) {
        spawnDefaultActors(system);
        get().sync();
      }
      set({ queuedFollowUps: [], sourceHandoff: null, contextSnapshot: null });
      syncDialogRuntimeSession(system.sessionId);
    });
    return system;
  },

  getSystem: () => get()._system,

  spawnActor: (config) => {
    const system = get()._system;
    if (!system) throw new Error("ActorSystem not initialized");
    const actor = system.spawn(config);
    get().sync();
    return actor;
  },

  killActor: (actorId) => {
    const system = get()._system;
    if (!system) return;
    system.kill(actorId);
    get().sync();
  },

  destroyAll: () => {
    const system = get()._system;
    if (system) {
      system.killAll();
      unregisterRuntimeAbortHandler("dialog", system.sessionId);
      useRuntimeStateStore.getState().removeSession("dialog", system.sessionId);
    }
    clearAllTodos();
    clearSessionApprovals();
    clearPersistedSession();
    clearActiveSessionPointer();
    set({
      _system: null,
      active: false,
      actors: [],
      dialogHistory: [],
      spawnedTasks: [],
      artifacts: [],
      sessionUploads: [],
      focusedSpawnedSessionRunId: null,
      coordinatorActorId: null,
      spawnedTaskEvents: [],
      actorTodos: {},
      queuedFollowUps: [],
      sourceHandoff: null,
      contextSnapshot: null,
      pendingUserInteractions: [],
    });
  },

  sendMessage: (from, to, content, opts) => {
    const system = get()._system;
    if (!system) return;
    system.send(from, to, content, opts);
    get().sync();
  },

  broadcastMessage: (from, content, opts) => {
    const system = get()._system;
    if (!system) return;
    system.broadcast(from, content, opts);
    get().sync();
  },

  broadcastAndResolve: (from, content, opts) => {
    const system = get()._system;
    if (!system) {
      log.warn("broadcastAndResolve: no system!");
      return;
    }
    system.broadcastAndResolve(from, content, opts);
    get().sync();
  },

  routeTask: (content: string, preferredCapabilities?: string[]) => {
    const system = get()._system;
    if (!system) return [];
    return system.routeTask(content, preferredCapabilities);
  },

  assignTask: (actorId, query, images) => {
    const system = get()._system;
    if (!system) return;
    system.assignTask(actorId, query, images);
    // sync will be triggered by actor events
  },

  abortAll: () => {
    const system = get()._system;
    if (!system) return;
    system.abortAll();
  },

  replyToMessage: (messageId, content, opts) => {
    const system = get()._system;
    if (!system) return;
    system.replyToMessage(messageId, content, opts);
    get().sync();
  },

  steer: (actorId, directive) => {
    const system = get()._system;
    if (!system) return;
    system.steer(actorId, directive);
    get().sync();
  },

  focusSpawnedSession: (runId) => {
    const system = get()._system;
    if (!system) return;
    system.focusSpawnedSession(runId);
    get().sync();
  },

  closeSpawnedSession: (runId) => {
    const system = get()._system;
    if (!system) return;
    system.closeSpawnedSession(runId);
    get().sync();
  },

  resetSession: (summary) => {
    const system = get()._system;
    if (!system) return;
    system.resetSession(summary);
    saveActiveSessionPointer(system.sessionId);
    syncDialogRuntimeSession(system.sessionId);
    unregisterRuntimeAbortHandler("dialog", system.sessionId);
    useRuntimeStateStore.getState().removeSession("dialog", system.sessionId);
    clearPersistedSession();
    set({
      spawnedTasks: [],
      artifacts: [],
      sessionUploads: [],
      focusedSpawnedSessionRunId: null,
      spawnedTaskEvents: [],
      actorTodos: {},
      queuedFollowUps: [],
      sourceHandoff: null,
      contextSnapshot: null,
    });
    get().sync();
  },

  enqueueFollowUp: (payload) => {
    const id = `dialog-follow-up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({
      queuedFollowUps: [
        ...state.queuedFollowUps,
        {
          ...payload,
          id,
          createdAt: Date.now(),
        },
      ],
    }));
    const system = get()._system;
    if (system) {
      get().sync();
    }
    return id;
  },

  removeFollowUp: (id) => {
    set((state) => ({
      queuedFollowUps: state.queuedFollowUps.filter((item) => item.id !== id),
    }));
    const system = get()._system;
    if (system) {
      get().sync();
    }
  },

  clearFollowUps: () => {
    set({ queuedFollowUps: [] });
    const system = get()._system;
    if (system) {
      get().sync();
    }
  },

  setSourceHandoff: (handoff) => {
    const nextHandoff = cloneAICenterHandoff(handoff);
    set({ sourceHandoff: nextHandoff });
    const system = get()._system;
    if (system) {
      const dialogHistory = system.getDialogHistory();
      const spawnedTasks = system.getSpawnedTasksSnapshot();
      const pendingUserInteractions = buildRecoveredPendingUserInteractions(
        dialogHistory,
        system.getPendingUserInteractions(),
      );
      const contextSnapshot = buildPersistableDialogContextSnapshot({
        sessionId: system.sessionId,
        actors: system.getAll().map(snapshotActor),
        dialogHistory,
        artifacts: system.getArtifactRecordsSnapshot(),
        sessionUploads: system.getSessionUploadsSnapshot(),
        spawnedTasks,
        pendingUserInteractions,
        queuedFollowUps: get().queuedFollowUps,
        focusedSpawnedSessionRunId: system.getFocusedSpawnedSessionRunId(),
        coordinatorActorId: system.getCoordinatorId(),
        sourceHandoff: nextHandoff,
      });
      set({ contextSnapshot });
      syncDialogRuntimeSession(system.sessionId, {
        dialogHistory,
        spawnedTasks,
        pendingUserInteractions,
        sourceHandoff: nextHandoff,
      });
      syncDialogRuntimeState({
        sessionId: system.sessionId,
        system,
        actors: system.getAll().map(snapshotActor),
        coordinatorActorId: system.getCoordinatorId(),
        dialogHistory,
        spawnedTasks,
        pendingUserInteractions,
        queuedFollowUps: get().queuedFollowUps,
        sourceHandoff: nextHandoff,
      });
      debouncedSave(system);
    }
  },

  sync: () => {
    const system = get()._system;
    if (!system) {
      const previousSessionId = get()._system?.sessionId;
      if (previousSessionId) {
        unregisterRuntimeAbortHandler("dialog", previousSessionId);
        useRuntimeStateStore.getState().removeSession("dialog", previousSessionId);
      }
      set({
        actors: [],
        dialogHistory: [],
        spawnedTasks: [],
        artifacts: [],
        sessionUploads: [],
        focusedSpawnedSessionRunId: null,
        coordinatorActorId: null,
        spawnedTaskEvents: [],
        actorTodos: {},
        queuedFollowUps: [],
        sourceHandoff: null,
        contextSnapshot: null,
        pendingUserInteractions: [],
      });
      return;
    }
    const liveActors = system.getAll();
    const actors = liveActors.map(snapshotActor);
    const dialogHistory = [...system.getDialogHistory()];
    const spawnedTasks = system.getSpawnedTasksSnapshot().map((task) => ({ ...task }));
    const artifacts = system.getArtifactRecordsSnapshot().map((artifact) => ({ ...artifact }));
    const sessionUploads = system.getSessionUploadsSnapshot().map((upload) => ({ ...upload }));
    const focusedSpawnedSessionRunId = system.getFocusedSpawnedSessionRunId();
    const coordinatorActorId = system.getCoordinatorId();
    const actorTodos = Object.fromEntries(
      liveActors.map((actor) => [
        actor.id,
        getActorTodoList(actor.id).map((todo) => ({ ...todo })),
      ] satisfies [string, TodoItem[]]),
    );
    const livePendingUserInteractions = system.getPendingUserInteractions();
    const pendingUserInteractions = buildRecoveredPendingUserInteractions(
      dialogHistory,
      livePendingUserInteractions,
    );
    const sourceHandoff = get().sourceHandoff;
    const contextSnapshot = buildPersistableDialogContextSnapshot({
      sessionId: system.sessionId,
      actors,
      dialogHistory,
      artifacts,
      sessionUploads,
      spawnedTasks,
      pendingUserInteractions,
      queuedFollowUps: get().queuedFollowUps,
      focusedSpawnedSessionRunId,
      coordinatorActorId,
      sourceHandoff,
    });
    set({
      actors,
      dialogHistory,
      spawnedTasks,
      artifacts,
      sessionUploads,
      focusedSpawnedSessionRunId,
      coordinatorActorId,
      actorTodos,
      contextSnapshot,
      pendingUserInteractions,
    });
    syncDialogRuntimeSession(system.sessionId, {
      dialogHistory,
      spawnedTasks,
      pendingUserInteractions,
      sourceHandoff,
    });
    syncDialogRuntimeState({
      sessionId: system.sessionId,
      system,
      actors,
      coordinatorActorId,
      dialogHistory,
      spawnedTasks,
      pendingUserInteractions,
      queuedFollowUps: get().queuedFollowUps,
      sourceHandoff,
    });
    syncDialogSpawnedRuntimeSessions(system.sessionId, spawnedTasks, actors, {
      actorSessionHistoryById: new Map(
        liveActors.map((actor) => [actor.id, actor.getSessionHistory()]),
      ),
      actorTodosById: actorTodos,
      dialogHistory,
      artifacts,
    });

    debouncedSave(system);
  },
}));
