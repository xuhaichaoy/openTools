import { create } from "zustand";
import { ActorSystem, type ActorSystemOptions } from "@/core/agent/actor/actor-system";
import type { AgentActor } from "@/core/agent/actor/agent-actor";
import { DIALOG_FULL_ROLE } from "@/core/agent/actor/agent-actor";
import { spawnDefaultDialogActors } from "@/core/agent/actor/default-dialog-actors";
import type { AICenterHandoff } from "@/store/app-store";
import type {
  AgentCapabilities,
  ActorConfig,
  ActorStatus,
  DialogArtifactRecord,
  DialogRoomCompactionState,
  DialogQueuedFollowUp,
  DialogExecutionPlan,
  DialogMessage,
  ExecutionPolicy,
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
import { getChannelManager, loadSavedChannels } from "@/core/channels";
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
import { resolvePersistedDialogActorMaxIterations } from "@/core/agent/actor/dialog-actor-persistence";
import { buildExecutionContractFromLegacyDialogExecutionPlan } from "@/core/agent/actor/dialog-execution-plan-compat";
import {
  compactMiddlewareOverridesForPersistence,
  type NormalizedExecutionPolicy,
} from "@/core/agent/actor/execution-policy";
import {
  buildDialogContextSnapshot,
  cloneDialogContextSnapshot,
  type DialogContextSnapshot,
} from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";
import { cloneDialogRoomCompaction } from "@/core/agent/actor/dialog-room-compaction";
import { ensureDialogRoomCompaction } from "@/core/agent/actor/dialog-context-pressure";
import { useAISessionRuntimeStore } from "@/store/ai-session-runtime-store";
import { useSessionControlPlaneStore } from "@/store/session-control-plane-store";
import { resolveRecoveredDialogRoomCompaction } from "@/core/session-control-plane/recovery";
import {
  registerRuntimeAbortHandler,
  unregisterRuntimeAbortHandler,
  useRuntimeStateStore,
} from "@/core/agent/context-runtime/runtime-state";
import { buildRuntimeSessionCompactionPreview } from "@/core/agent/context-runtime/runtime-session-compaction";
import { CollaborationSessionController } from "@/core/collaboration/session-controller";
import {
  cloneCollaborationSnapshot,
  cloneCollaborationSnapshotForPersistence,
  createEmptyCollaborationSnapshot,
} from "@/core/collaboration/persistence";
import {
  cloneExecutionContract,
  sealExecutionContract,
} from "@/core/collaboration/execution-contract";
import type {
  CollaborationActorRosterEntry,
  CollaborationDispatchInput,
  CollaborationDispatchResult,
  CollaborationPresentationState,
  CollaborationSessionSnapshot,
  ExecutionContract,
  ExecutionContractDraft,
} from "@/core/collaboration/types";

const log = createLogger("ActorStore");

// ── Session 持久化 ──

const LEGACY_STORAGE_KEY = "dialog_session";
const ACTIVE_SESSION_POINTER_KEY = "dialog_session_pointer";
const SCHEMA_VERSION = 9;

interface PersistedSpawnedTask {
  runId: string;
  spawnerActorId: string;
  targetActorId: string;
  contractId?: string;
  plannedDelegationId?: string;
  dispatchSource?: SpawnedTaskRecord["dispatchSource"];
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
    maxIterations?: number;
    systemPrompt?: string;
    capabilities?: AgentCapabilities;
    toolPolicy?: ToolPolicy;
    executionPolicy?: ExecutionPolicy;
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
  executionContract?: ExecutionContract | null;
  /** @deprecated 仅用于旧快照恢复兼容，新的持久化仅保存 executionContract。 */
  dialogExecutionPlan?: DialogExecutionPlan | null;
  approvalCache?: Record<string, "always-allow" | "ask-every-time" | "deny">;
  sourceHandoff?: AICenterHandoff | null;
  contextSnapshot?: DialogContextSnapshot | null;
  dialogRoomCompaction?: DialogRoomCompactionState | null;
  collaborationSnapshot?: CollaborationSessionSnapshot | null;
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
  executionContract?: ExecutionContract | null,
  approvalCache?: Record<string, "always-allow" | "ask-every-time" | "deny">,
  sourceHandoff?: AICenterHandoff | null,
  contextSnapshot?: DialogContextSnapshot | null,
  dialogRoomCompaction?: DialogRoomCompactionState | null,
  collaborationSnapshot?: CollaborationSessionSnapshot | null,
  sessionId?: string,
): PersistedSession {
  const persistedTasks: PersistedSpawnedTask[] = [];
  if (spawnedTasks) {
    for (const r of spawnedTasks.values()) {
      persistedTasks.push({
        runId: r.runId,
        spawnerActorId: r.spawnerActorId,
        targetActorId: r.targetActorId,
        contractId: r.contractId,
        plannedDelegationId: r.plannedDelegationId,
        dispatchSource: r.dispatchSource,
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
      maxIterations: a.hasExplicitMaxIterationsConfig ? a.configuredMaxIterations : undefined,
      systemPrompt: a.getSystemPromptOverride(),
      capabilities: a.capabilities,
      toolPolicy: a.toolPolicyConfig,
      executionPolicy: a.normalizedExecutionPolicy,
      workspace: a.workspace,
      timeoutSeconds: a.timeoutSeconds,
      contextTokens: a.contextTokens,
      thinkingLevel: a.thinkingLevel,
      middlewareOverrides: compactMiddlewareOverridesForPersistence(a.middlewareOverrides),
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
    executionContract: executionContract ? cloneExecutionContract(executionContract) : null,
    approvalCache,
    sourceHandoff: cloneAICenterHandoff(sourceHandoff),
    contextSnapshot: cloneDialogContextSnapshot(contextSnapshot),
    dialogRoomCompaction: cloneDialogRoomCompaction(dialogRoomCompaction),
    collaborationSnapshot: collaborationSnapshot
      ? cloneCollaborationSnapshotForPersistence(collaborationSnapshot)
      : null,
    sessionId,
    savedAt: Date.now(),
  };
}

function buildCollaborationActorRoster(
  actors: readonly ActorSnapshot[],
): CollaborationActorRosterEntry[] {
  return actors.map((actor) => ({
    actorId: actor.id,
    roleName: actor.roleName,
    capabilities: actor.capabilities?.tags,
    executionPolicy: actor.normalizedExecutionPolicy,
    workspace: actor.workspace,
  }));
}

function mapCollaborationQueuedFollowUps(
  snapshot: CollaborationSessionSnapshot | null,
): DialogQueuedFollowUp[] {
  if (!snapshot) return [];
  return snapshot.queuedFollowUps.map((item) => ({
    id: item.id,
    displayText: item.displayText,
    content: item.content,
    briefContent: item.briefContent,
    images: item.images ? [...item.images] : undefined,
    attachmentPaths: item.attachmentPaths ? [...item.attachmentPaths] : undefined,
    uploadRecords: item.uploadRecords ? item.uploadRecords.map((record) => ({ ...record })) : undefined,
    routingMode: item.contract?.executionStrategy ?? "coordinator",
    createdAt: item.createdAt,
    contractState:
      item.contractStatus === "needs_reapproval"
        ? "needs_reapproval"
        : item.contractStatus === "ready"
          ? "sealed"
          : "none",
    contractStatus:
      item.contractStatus === "needs_reapproval"
        ? "needs_reapproval"
        : item.contractStatus === "ready"
          ? "ready"
          : "missing",
  }));
}

function buildPersistedExecutionContract(params: {
  persisted: PersistedSession;
}): ExecutionContract | null {
  const { persisted } = params;
  if (persisted.executionContract) {
    return cloneExecutionContract(persisted.executionContract);
  }
  if (!persisted.dialogExecutionPlan) {
    return null;
  }
  return buildExecutionContractFromLegacyDialogExecutionPlan({
    surface: "local_dialog",
    plan: persisted.dialogExecutionPlan,
  }).contract;
}

function buildLegacyCollaborationSnapshot(
  system: ActorSystem,
  persisted: PersistedSession,
): CollaborationSessionSnapshot {
  const base = createEmptyCollaborationSnapshot("local_dialog");
  const legacyContract = buildPersistedExecutionContract({ persisted });

  return {
    ...base,
    activeContract: legacyContract ? cloneExecutionContract(legacyContract) : null,
    queuedFollowUps: (persisted.queuedFollowUps ?? []).map((item) => ({
      id: item.id,
      displayText: item.displayText,
      content: item.content,
      briefContent: item.briefContent,
      images: item.images ? [...item.images] : undefined,
      attachmentPaths: item.attachmentPaths ? [...item.attachmentPaths] : undefined,
      uploadRecords: item.uploadRecords ? item.uploadRecords.map((record) => ({ ...record })) : undefined,
      createdAt: item.createdAt,
      executionStrategy: item.routingMode,
      policy: "queue",
      contract: legacyContract ? cloneExecutionContract(legacyContract) : null,
      contractStatus: legacyContract ? "ready" : "missing",
    })),
    focusedChildSessionId: persisted.focusedSpawnedSessionRunId ?? null,
    dialogMessages: persisted.dialogHistory.map((message) => ({ ...message })),
    updatedAt: persisted.savedAt ?? 0,
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
  dialogRoomCompaction?: DialogRoomCompactionState | null;
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
    dialogRoomCompaction: params.dialogRoomCompaction,
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

const DIALOG_ROOM_COMPACTION_DEBOUNCE_MS = 1200;
let _dialogRoomCompactionTimer: ReturnType<typeof setTimeout> | null = null;
let _dialogRoomCompactionScheduledKey: string | null = null;

function buildDialogRoomCompactionScheduleKey(params: {
  sessionId: string;
  dialogHistoryCount: number;
  artifactsCount: number;
  spawnedTaskCount: number;
  sourceHandoff?: AICenterHandoff | null;
}): string {
  return [
    params.sessionId,
    params.dialogHistoryCount,
    params.artifactsCount,
    params.spawnedTaskCount,
    params.sourceHandoff?.goal ?? "",
    params.sourceHandoff?.summary ?? "",
  ].join("::");
}

function scheduleDialogRoomCompaction(params: {
  system: ActorSystem;
  dialogHistory: readonly DialogMessage[];
  artifacts: readonly DialogArtifactRecord[];
  spawnedTasks: readonly SpawnedTaskRecord[];
  sourceHandoff?: AICenterHandoff | null;
}): void {
  const scheduleKey = buildDialogRoomCompactionScheduleKey({
    sessionId: params.system.sessionId,
    dialogHistoryCount: params.dialogHistory.length,
    artifactsCount: params.artifacts.length,
    spawnedTaskCount: params.spawnedTasks.length,
    sourceHandoff: params.sourceHandoff,
  });
  if (_dialogRoomCompactionScheduledKey === scheduleKey) {
    return;
  }
  _dialogRoomCompactionScheduledKey = scheduleKey;
  if (_dialogRoomCompactionTimer) clearTimeout(_dialogRoomCompactionTimer);
  _dialogRoomCompactionTimer = setTimeout(() => {
    _dialogRoomCompactionTimer = null;
    void runDialogRoomCompaction(params).catch((error) => {
      log.warn("runDialogRoomCompaction failed", error);
    });
  }, DIALOG_ROOM_COMPACTION_DEBOUNCE_MS);
}

async function runDialogRoomCompaction(params: {
  system: ActorSystem;
}): Promise<void> {
  const currentStore = useActorSystemStore.getState();
  if (currentStore._system !== params.system || currentStore._system?.sessionId !== params.system.sessionId) {
    return;
  }

  const ensured = await ensureDialogRoomCompaction(params.system);
  if (!ensured?.changed) {
    return;
  }
  const persisted = ensured.state;

  const latestStore = useActorSystemStore.getState();
  if (latestStore._system !== params.system || latestStore._system?.sessionId !== params.system.sessionId) {
    return;
  }

  const dialogHistory = [...params.system.getDialogHistory()];
  const spawnedTasks = params.system.getSpawnedTasksSnapshot().map((task) => ({ ...task }));
  const artifacts = params.system.getArtifactRecordsSnapshot().map((artifact) => ({ ...artifact }));
  const sessionUploads = params.system.getSessionUploadsSnapshot().map((upload) => ({ ...upload }));
  const collaborationSnapshot = latestStore.controller?.syncFromSystem() ?? latestStore.collaborationSnapshot;
  const pendingUserInteractions = buildRecoveredPendingUserInteractions(
    dialogHistory,
    params.system.getPendingUserInteractions(),
  );
  const queuedFollowUps = collaborationSnapshot
    ? mapCollaborationQueuedFollowUps(collaborationSnapshot)
    : latestStore.queuedFollowUps;
  const focusedSpawnedSessionRunId = collaborationSnapshot?.focusedChildSessionId
    ?? params.system.getFocusedSpawnedSessionRunId();
  const contextSnapshot = buildPersistableDialogContextSnapshot({
    sessionId: params.system.sessionId,
    actors: params.system.getAll().map(snapshotActor),
    dialogHistory,
    artifacts,
    sessionUploads,
    spawnedTasks,
    pendingUserInteractions,
    queuedFollowUps,
    focusedSpawnedSessionRunId,
    coordinatorActorId: params.system.getCoordinatorId(),
    sourceHandoff: latestStore.sourceHandoff,
    dialogRoomCompaction: persisted,
  });

  useActorSystemStore.setState({
    dialogRoomCompaction: cloneDialogRoomCompaction(persisted),
    contextSnapshot,
  });

  syncDialogRuntimeSession(params.system.sessionId, {
    dialogHistory,
    spawnedTasks,
    pendingUserInteractions,
    actors: params.system.getAll().map(snapshotActor),
    coordinatorActorId: params.system.getCoordinatorId(),
    sourceHandoff: latestStore.sourceHandoff,
  });
  syncDialogRuntimeState({
    sessionId: params.system.sessionId,
    system: params.system,
    actors: params.system.getAll().map(snapshotActor),
    coordinatorActorId: params.system.getCoordinatorId(),
    dialogHistory,
    spawnedTasks,
    pendingUserInteractions,
    queuedFollowUps,
    collaborationSnapshot,
    sourceHandoff: latestStore.sourceHandoff,
  });
  debouncedSave(params.system);
}

/** Max session age: discard sessions older than 7 days */
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getImChannelDisplayLabel(channelType?: DialogMessage["externalChannelType"]): string | undefined {
  switch (channelType) {
    case "dingtalk":
      return "钉钉会话";
    case "feishu":
      return "飞书会话";
    default:
      return undefined;
  }
}

function getImConversationDisplayDetail(
  channelType?: DialogMessage["externalChannelType"],
  conversationType?: DialogMessage["externalConversationType"],
): string | undefined {
  const platform = channelType === "dingtalk"
    ? "钉钉"
    : channelType === "feishu"
      ? "飞书"
      : "";
  const conversation = conversationType === "group"
    ? "群聊"
    : conversationType === "private"
      ? "私聊"
      : "";
  if (platform && conversation) return `${platform} · ${conversation}`;
  return platform || conversation || undefined;
}

function extractDialogRuntimeDisplay(
  dialogHistory?: readonly DialogMessage[],
): { label?: string; detail?: string } | null {
  if (!dialogHistory?.length) return null;
  for (let index = dialogHistory.length - 1; index >= 0; index -= 1) {
    const message = dialogHistory[index];
    if (message.from !== "user") continue;
    const label = message.runtimeDisplayLabel?.trim() || getImChannelDisplayLabel(message.externalChannelType);
    const detail = message.runtimeDisplayDetail?.trim()
      || getImConversationDisplayDetail(message.externalChannelType, message.externalConversationType);
    return label || detail ? { label, detail } : null;
  }
  return null;
}

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

async function bootstrapSavedIMChannels(): Promise<void> {
  const channelMgr = getChannelManager();
  const savedChannels = loadSavedChannels();
  for (const { config } of savedChannels) {
    if (config.enabled === false || config.autoConnect === false) {
      continue;
    }
    try {
      await channelMgr.register(config);
    } catch (error) {
      log.warn(`Failed to auto-connect IM channel: ${config.name}`, error);
    }
  }
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
    actors?: readonly Pick<ActorSnapshot, "id" | "workspace">[];
    coordinatorActorId?: string | null;
    sourceHandoff?: AICenterHandoff | null;
    updatedAt?: number;
  },
): void {
  const runtimeStore = useAISessionRuntimeStore.getState();
  const display = extractDialogRuntimeDisplay(options?.dialogHistory);
  const title = display?.label || extractDialogRuntimeTitle(options?.dialogHistory);
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

  const workspaceRoot = resolveDialogRuntimeWorkspaceRoot(
    options?.actors,
    options?.coordinatorActorId,
  );
  runtimeStore.ensureSession({
    mode: "dialog",
    externalSessionId: sessionId,
    title: title || "Dialog 房间",
    summary,
    updatedAt,
    sessionIdentity: {
      surface: "local_dialog",
      sessionKind: "collaboration_room",
      workspaceId: workspaceRoot,
      runtimeSessionId: sessionId,
    },
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

function resolveLiveDialogRoomCompaction(
  system?: ActorSystem | null,
  fallback?: DialogRoomCompactionState | null,
): DialogRoomCompactionState | null {
  return system?.getDialogRoomCompaction() ?? fallback ?? null;
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
  collaborationSnapshot?: CollaborationSessionSnapshot | null;
  sourceHandoff?: AICenterHandoff | null;
  updatedAt?: number;
}): void {
  const display = extractDialogRuntimeDisplay(params.dialogHistory);
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
    || display?.label
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
  const activeCompaction = params.system.getDialogRoomCompaction();
  const controlPlaneSessionId = useAISessionRuntimeStore
    .getState()
    .getSessionByExternal("dialog", params.sessionId)
    ?.identity?.id;
  const openChildSessionCount = params.collaborationSnapshot
    ? params.collaborationSnapshot.childSessions.filter((session) =>
      session.status === "pending"
      || session.status === "running"
      || session.status === "waiting",
    ).length
    : params.spawnedTasks?.filter((task) =>
      task.status === "running"
      || (task.mode === "session" && task.sessionOpen),
    ).length ?? 0;
  if (controlPlaneSessionId) {
    useSessionControlPlaneStore.getState().patchSessionContinuityState(controlPlaneSessionId, {
      source: "local_dialog",
      updatedAt: params.updatedAt ?? Date.now(),
      executionStrategy: params.collaborationSnapshot?.presentationState.executionStrategy ?? undefined,
      contractState: params.collaborationSnapshot?.presentationState.contractState ?? undefined,
      pendingInteractionCount: params.collaborationSnapshot?.presentationState.pendingInteractionCount
        ?? params.pendingUserInteractions?.length,
      queuedFollowUpCount: params.collaborationSnapshot?.presentationState.queuedFollowUpCount
        ?? params.queuedFollowUps?.length,
      childSessionCount: params.collaborationSnapshot?.childSessions.length ?? params.spawnedTasks?.length,
      openChildSessionCount,
      roomCompactionSummary: activeCompaction?.summary,
      ...buildRuntimeSessionCompactionPreview(activeCompaction),
      roomCompactionTriggerReasons: activeCompaction?.triggerReasons,
      roomCompactionMemoryFlushNoteId: activeCompaction?.memoryFlushNoteId,
      roomCompactionMemoryConfirmedCount: activeCompaction?.memoryConfirmedCount,
      roomCompactionMemoryQueuedCount: activeCompaction?.memoryQueuedCount,
    });
  }

  useRuntimeStateStore.getState().upsertSession({
    mode: "dialog",
    sessionId: params.sessionId,
    query,
    displayLabel: display?.label ?? "",
    displayDetail: display?.detail ?? "",
    startedAt,
    updatedAt: params.updatedAt,
    workspaceRoot,
    waitingStage,
    status,
    sessionIdentity: {
      surface: "local_dialog",
      sessionKey: params.sessionId,
      sessionKind: "collaboration_room",
      workspaceId: workspaceRoot,
      runtimeSessionId: params.sessionId,
    },
    ...buildRuntimeSessionCompactionPreview(activeCompaction),
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
    collaborationSnapshot?: CollaborationSessionSnapshot | null;
    actorSessionHistoryById?: ReadonlyMap<string, Array<{ role: "user" | "assistant"; content: string; timestamp: number }>>;
    actorTodosById?: Readonly<Record<string, TodoItem[]>>;
    dialogHistory?: readonly DialogMessage[];
    artifacts?: readonly DialogArtifactRecord[];
  },
): string | undefined {
  const targetName = actorNameById.get(record.targetActorId) ?? record.targetActorId;
  const projectedChildSession = options?.collaborationSnapshot?.childSessions.find((session) => session.runId === record.runId);
  const projectedDelegation = options?.collaborationSnapshot?.contractDelegations.find((delegation) => delegation.runId === record.runId);
  const projectedSummary = summarizeAISessionRuntimeText(
    [
      projectedChildSession?.statusSummary,
      projectedChildSession?.nextStepHint ? `下一步：${projectedChildSession.nextStepHint}` : "",
      !projectedChildSession?.statusSummary && projectedDelegation?.statusSummary ? projectedDelegation.statusSummary : "",
      !projectedChildSession?.nextStepHint && projectedDelegation?.nextStepHint ? `下一步：${projectedDelegation.nextStepHint}` : "",
    ].filter(Boolean).join(" · "),
    180,
  );
  if (projectedSummary) {
    return projectedSummary;
  }
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
    collaborationSnapshot?: CollaborationSessionSnapshot | null;
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
      sessionIdentity: {
        surface: "child_session",
        sessionKind: kind,
        parentSessionId: rootRuntime?.identity?.id,
        runtimeSessionId: record.runId,
      },
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
    if (data.version !== undefined && data.version !== SCHEMA_VERSION && data.version !== SCHEMA_VERSION - 1) {
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
  const controller = useActorSystemStore.getState().controller;
  const collaborationSnapshot = controller?.syncFromSystem() ?? useActorSystemStore.getState().collaborationSnapshot;
  const activeContractForPersistence = collaborationSnapshot?.activeContract
    ?? system.getActiveExecutionContract();
  const queuedFollowUps = collaborationSnapshot
    ? mapCollaborationQueuedFollowUps(collaborationSnapshot)
    : useActorSystemStore.getState().queuedFollowUps;
  const focusedSpawnedSessionRunId = collaborationSnapshot?.focusedChildSessionId
    ?? system.getFocusedSpawnedSessionRunId();
  const snapshot = buildSessionSnapshot(
    [...system.getDialogHistory()],
    system.getAll(),
    system.getSpawnedTasksMap(),
    system.getArtifactRecordsSnapshot(),
    system.getSessionUploadsSnapshot(),
    queuedFollowUps,
    focusedSpawnedSessionRunId,
    system.getCoordinatorId(),
    activeContractForPersistence,
    getSessionApprovalsSnapshot(),
    useActorSystemStore.getState().sourceHandoff,
    useActorSystemStore.getState().contextSnapshot,
    resolveLiveDialogRoomCompaction(system, useActorSystemStore.getState().dialogRoomCompaction),
    collaborationSnapshot,
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
      maxIterations: actor.maxIterations,
      systemPrompt: actor.systemPrompt,
      capabilities: actor.capabilities,
      toolPolicy: actor.toolPolicy,
      executionPolicy: actor.executionPolicy,
      workspace: actor.workspace,
      thinkingLevel: actor.thinkingLevel,
      middlewareOverrides: actor.middlewareOverrides,
      timeoutSeconds: actor.timeoutSeconds,
      contextTokens: actor.contextTokens,
    })),
    snapshot: snapshot as unknown as Record<string, unknown>,
  };
  await saveSessionToDisk(session);
  saveActiveSessionPointer(system.sessionId);
}

interface RestoreSnapshotResult {
  dialogRoomCompaction: DialogRoomCompactionState | null;
}

function restoreSnapshot(system: ActorSystem, persisted: PersistedSession): RestoreSnapshotResult {
  if (persisted.dialogHistory.length) {
    system.restoreDialogHistory(persisted.dialogHistory);
  }
  const actorCount = persisted.actorConfigs.length;
  for (const config of persisted.actorConfigs) {
    system.spawn({
      id: config.id,
      role: {
        ...DIALOG_FULL_ROLE,
        name: config.roleName,
        systemPrompt: config.systemPrompt ?? DIALOG_FULL_ROLE.systemPrompt,
      },
      modelOverride: config.model,
      maxIterations: resolvePersistedDialogActorMaxIterations(config, actorCount),
      systemPromptOverride: config.systemPrompt,
      capabilities: config.capabilities,
      toolPolicy: config.toolPolicy,
      executionPolicy: config.executionPolicy,
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
  const restoredContract = !persisted.collaborationSnapshot
    ? buildPersistedExecutionContract({
        persisted,
      })
    : null;
  if (restoredContract) {
    system.restoreExecutionContract(restoredContract);
  }
  restoreSessionApprovals(persisted.approvalCache);
  if (persisted.artifacts?.length) {
    system.restoreArtifactRecords(persisted.artifacts);
  }
  if (persisted.sessionUploads?.length) {
    system.restoreSessionUploads(persisted.sessionUploads);
  }
  const recoveredCompaction = resolveRecoveredDialogRoomCompaction({
    persisted: persisted.dialogRoomCompaction,
    continuity: useSessionControlPlaneStore.getState()
      .findSessionByRuntimeSessionId(system.sessionId)
      ?.continuityState,
  });
  if (recoveredCompaction) {
    system.setDialogRoomCompaction(recoveredCompaction);
  }
  // 恢复子任务记录（UI 展示用，不会恢复运行态）
  if (persisted.spawnedTasks?.length) {
    system.restoreSpawnedTasks(
      persisted.spawnedTasks.map((t) => ({
        runId: t.runId,
        spawnerActorId: t.spawnerActorId,
        targetActorId: t.targetActorId,
        contractId: t.contractId,
        plannedDelegationId: t.plannedDelegationId,
        dispatchSource: t.dispatchSource ?? "manual",
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
  if (!persisted.collaborationSnapshot && persisted.focusedSpawnedSessionRunId) {
    try {
      system.focusSpawnedSession(persisted.focusedSpawnedSessionRunId);
    } catch {
      // ignore stale focus pointer
    }
  }

  return {
    dialogRoomCompaction: recoveredCompaction,
  };
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

// ── Actor snapshot for UI ──

export interface ActorSnapshot {
  id: string;
  roleName: string;
  roleId: string;
  persistent: boolean;
  modelOverride?: string;
  systemPromptOverride?: string;
  toolPolicy?: ToolPolicy;
  executionPolicy?: ExecutionPolicy;
  normalizedExecutionPolicy: NormalizedExecutionPolicy;
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
  /** 当前房间级上下文压缩状态 */
  dialogRoomCompaction: DialogRoomCompactionState | null;
  /** 协作控制器 */
  controller: CollaborationSessionController | null;
  /** 协作快照 */
  collaborationSnapshot: CollaborationSessionSnapshot | null;
  /** 协作展示态 */
  presentationState: CollaborationPresentationState | null;
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
  broadcastAndResolve: (
    from: string,
    content: string,
    opts?: {
      _briefContent?: string;
      images?: string[];
      externalChannelType?: DialogMessage["externalChannelType"];
      externalConversationType?: DialogMessage["externalConversationType"];
      runtimeDisplayLabel?: string;
      runtimeDisplayDetail?: string;
    },
  ) => void;
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
  abortSpawnedSession: (runId: string) => void;
  resetSession: (summary?: string) => void;
  enqueueFollowUp: (payload: Omit<DialogQueuedFollowUp, "id" | "createdAt">) => string;
  removeFollowUp: (id: string) => void;
  clearFollowUps: () => void;
  dispatchDialogInput: (
    input: CollaborationDispatchInput,
    options?: Parameters<CollaborationSessionController["dispatchUserInput"]>[1],
  ) => CollaborationDispatchResult | null;
  replyToPendingInteraction: (
    interactionId: string,
    input: CollaborationDispatchInput,
  ) => CollaborationDispatchResult | null;
  applyDraftExecutionContract: (
    draft: ExecutionContractDraft | null,
    input?: Pick<CollaborationDispatchInput, "content" | "briefContent" | "images" | "attachmentPaths">,
  ) => ExecutionContract | null;
  setFocusedChildSession: (childSessionId: string | null) => void;
  runQueuedFollowUp: (id: string) => CollaborationDispatchResult | null;
  clearQueuedFollowUps: () => void;
  setSourceHandoff: (handoff: AICenterHandoff | null) => void;
  /** 等待用户回复的交互列表 */
  pendingUserInteractions: PendingInteraction[];
  /** 从 ActorSystem 同步最新状态到 store（供 UI 使用） */
  sync: () => void;
  /** 设置默认发送 Agent（coordinator） */
  setCoordinator: (actorId: string) => void;
  /** 重排 Agent 顺序 */
  reorderActors: (orderedIds: string[]) => void;
  /** 热更新单个 Agent 配置 */
  updateActorConfig: (actorId: string, patch: {
    name?: string;
    modelOverride?: string;
    workspace?: string;
    thinkingLevel?: ThinkingLevel;
    toolPolicy?: ToolPolicy;
    executionPolicy?: ExecutionPolicy;
    middlewareOverrides?: MiddlewareOverrides;
    capabilities?: AgentCapabilities;
  }) => void;
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
    executionPolicy: actor.executionPolicy,
    normalizedExecutionPolicy: actor.normalizedExecutionPolicy,
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
  dialogRoomCompaction: null,
  controller: null,
  collaborationSnapshot: null,
  presentationState: null,
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
              sessionIdentity: {
                surface: "local_dialog",
                sessionKind: "collaboration_room",
                runtimeSessionId: detail.sessionId,
              },
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

    const controller = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => buildCollaborationActorRoster(system.getAll().map(snapshotActor)),
    });

    set({ _system: system, controller, active: true });
    void (async () => {
      const persisted = await loadPersistedSessionSnapshot();
      if (persisted?.sessionId) {
        (system as unknown as { sessionId: string }).sessionId = persisted.sessionId;
      }
      if (persisted) {
        const restored = restoreSnapshot(system, persisted);
        if (persisted.collaborationSnapshot) {
          controller.restore(persisted.collaborationSnapshot);
        } else {
          controller.restore(buildLegacyCollaborationSnapshot(system, persisted));
        }
        const collaborationSnapshot = controller.syncFromSystem();
        set({
          queuedFollowUps: mapCollaborationQueuedFollowUps(collaborationSnapshot),
          sourceHandoff: cloneAICenterHandoff(persisted.sourceHandoff),
          contextSnapshot: cloneDialogContextSnapshot(persisted.contextSnapshot),
          dialogRoomCompaction: cloneDialogRoomCompaction(
            restored.dialogRoomCompaction ?? persisted.dialogRoomCompaction,
          ),
          collaborationSnapshot,
          presentationState: { ...collaborationSnapshot.presentationState },
        });
      } else if (system.getAll().length === 0) {
        spawnDefaultDialogActors(system, {
          productMode: options?.defaultProductMode ?? "dialog",
        });
      }
      await bootstrapSavedIMChannels();
      saveActiveSessionPointer(system.sessionId);
      syncDialogRuntimeSession(system.sessionId, {
        sourceHandoff: persisted?.sourceHandoff,
        actors: system.getAll().map(snapshotActor),
        coordinatorActorId: system.getCoordinatorId(),
      });
      get().sync();
    })().catch(async (err) => {
      log.warn("Failed to hydrate dialog session snapshot", err);
      if (system.getAll().length === 0) {
        spawnDefaultDialogActors(system, {
          productMode: options?.defaultProductMode ?? "dialog",
        });
      }
      const collaborationSnapshot = controller.syncFromSystem();
      set({
        queuedFollowUps: [],
        sourceHandoff: null,
        contextSnapshot: null,
        dialogRoomCompaction: null,
        collaborationSnapshot,
        presentationState: { ...collaborationSnapshot.presentationState },
      });
      await bootstrapSavedIMChannels();
      saveActiveSessionPointer(system.sessionId);
      syncDialogRuntimeSession(system.sessionId, {
        actors: system.getAll().map(snapshotActor),
        coordinatorActorId: system.getCoordinatorId(),
      });
      get().sync();
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

  setCoordinator: (actorId) => {
    const system = get()._system;
    if (!system) return;
    system.setCoordinator(actorId);
    get().sync();
  },

  reorderActors: (orderedIds) => {
    const system = get()._system;
    if (!system) return;
    system.reorderActors(orderedIds);
    get().sync();
  },

  updateActorConfig: (actorId, patch) => {
    const system = get()._system;
    if (!system) return;
    const actor = system.get(actorId);
    if (!actor) return;
    actor.updateConfig(patch);
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
    get().controller?.dispose();
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
      dialogRoomCompaction: null,
      controller: null,
      collaborationSnapshot: null,
      presentationState: null,
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
    const controller = get().controller;
    if (controller) {
      controller.setFocusedChildSession(runId);
    } else {
      const system = get()._system;
      if (!system) return;
      system.focusSpawnedSession(runId);
    }
    get().sync();
  },

  setFocusedChildSession: (childSessionId) => {
    const controller = get().controller;
    if (!controller) return;
    controller.setFocusedChildSession(childSessionId);
    get().sync();
  },

  closeSpawnedSession: (runId) => {
    const system = get()._system;
    if (!system) return;
    system.closeSpawnedSession(runId);
    get().sync();
  },

  abortSpawnedSession: (runId) => {
    const system = get()._system;
    if (!system) return;
    system.abortSpawnedTask(runId, {
      error: "子会话已由用户终止",
    });
    get().sync();
  },

  resetSession: (summary) => {
    const system = get()._system;
    if (!system) return;
    system.resetSession(summary);
    get().controller?.restore(null);
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
      dialogRoomCompaction: null,
      collaborationSnapshot: null,
      presentationState: null,
    });
    get().sync();
  },

  enqueueFollowUp: (payload) => {
    const controller = get().controller;
    const id = controller?.enqueueFollowUp({
      content: payload.content,
      displayText: payload.displayText,
      briefContent: payload.briefContent,
      images: payload.images,
      attachmentPaths: payload.attachmentPaths,
      uploadRecords: payload.uploadRecords,
      executionStrategy: payload.routingMode,
    }, "queue");
    if (controller || get()._system) {
      get().sync();
    }
    return id ?? `dialog-follow-up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  },

  removeFollowUp: (id) => {
    const controller = get().controller;
    if (controller) {
      controller.removeQueuedFollowUp(id);
    }
    if (controller || get()._system) {
      get().sync();
    }
  },

  clearFollowUps: () => {
    get().controller?.clearQueuedFollowUps();
    if (get().controller || get()._system) {
      get().sync();
    }
  },

  dispatchDialogInput: (input, options) => {
    const controller = get().controller;
    if (!controller) return null;
    const result = controller.dispatchUserInput(input, options);
    get().sync();
    return result;
  },

  replyToPendingInteraction: (interactionId, input) => {
    const controller = get().controller;
    if (!controller) return null;
    const result = controller.replyToInteraction(interactionId, input);
    get().sync();
    return result;
  },

  applyDraftExecutionContract: (draft, input) => {
    const controller = get().controller;
    if (!controller) return null;
    if (!draft) {
      controller.applyExecutionContract(null);
      get().sync();
      return null;
    }
    const liveActors = get()._system?.getAll().map(snapshotActor) ?? get().actors;
    const contract = sealExecutionContract(
      draft,
      buildCollaborationActorRoster(liveActors),
      {
        content: input?.content ?? draft.summary ?? "",
        briefContent: input?.briefContent,
        images: input?.images,
        attachmentPaths: input?.attachmentPaths,
      },
    );
    controller.applyExecutionContract(contract);
    get().sync();
    return contract;
  },

  runQueuedFollowUp: (id) => {
    const controller = get().controller;
    if (!controller) return null;
    const result = controller.runQueuedFollowUp(id);
    get().sync();
    return result;
  },

  clearQueuedFollowUps: () => {
    get().controller?.clearQueuedFollowUps();
    get().sync();
  },

  setSourceHandoff: (handoff) => {
    const nextHandoff = cloneAICenterHandoff(handoff);
    set({ sourceHandoff: nextHandoff });
    const system = get()._system;
    if (system) {
      const dialogHistory = system.getDialogHistory();
      const spawnedTasks = system.getSpawnedTasksSnapshot();
      const collaborationSnapshot = get().controller?.syncFromSystem() ?? get().collaborationSnapshot;
      const pendingUserInteractions = buildRecoveredPendingUserInteractions(
        dialogHistory,
        system.getPendingUserInteractions(),
      );
      const queuedFollowUps = collaborationSnapshot
        ? mapCollaborationQueuedFollowUps(collaborationSnapshot)
        : get().queuedFollowUps;
      const focusedSpawnedSessionRunId = collaborationSnapshot?.focusedChildSessionId
        ?? system.getFocusedSpawnedSessionRunId();
      const dialogRoomCompaction = resolveLiveDialogRoomCompaction(system, get().dialogRoomCompaction);
      const contextSnapshot = buildPersistableDialogContextSnapshot({
        sessionId: system.sessionId,
        actors: system.getAll().map(snapshotActor),
        dialogHistory,
        artifacts: system.getArtifactRecordsSnapshot(),
        sessionUploads: system.getSessionUploadsSnapshot(),
        spawnedTasks,
        pendingUserInteractions,
        queuedFollowUps,
        focusedSpawnedSessionRunId,
        coordinatorActorId: system.getCoordinatorId(),
        sourceHandoff: nextHandoff,
        dialogRoomCompaction,
      });
      set({ contextSnapshot, dialogRoomCompaction: cloneDialogRoomCompaction(dialogRoomCompaction) });
      syncDialogRuntimeSession(system.sessionId, {
        dialogHistory,
        spawnedTasks,
        pendingUserInteractions,
        actors: system.getAll().map(snapshotActor),
        coordinatorActorId: system.getCoordinatorId(),
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
        queuedFollowUps,
        collaborationSnapshot,
        sourceHandoff: nextHandoff,
      });
      scheduleDialogRoomCompaction({
        system,
        dialogHistory,
        artifacts: system.getArtifactRecordsSnapshot(),
        spawnedTasks,
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
        dialogRoomCompaction: null,
        collaborationSnapshot: null,
        presentationState: null,
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
    const coordinatorActorId = system.getCoordinatorId();
    const actorTodos = Object.fromEntries(
      liveActors.map((actor) => [
        actor.id,
        getActorTodoList(actor.id).map((todo) => ({ ...todo })),
      ] satisfies [string, TodoItem[]]),
    );
    const collaborationSnapshot = get().controller?.syncFromSystem() ?? null;
    const pendingUserInteractions = buildRecoveredPendingUserInteractions(
      dialogHistory,
      system.getPendingUserInteractions(),
    );
    const queuedFollowUps = collaborationSnapshot
      ? mapCollaborationQueuedFollowUps(collaborationSnapshot)
      : get().queuedFollowUps;
    const focusedSpawnedSessionRunId = collaborationSnapshot?.focusedChildSessionId
      ?? system.getFocusedSpawnedSessionRunId();
    const sourceHandoff = get().sourceHandoff;
    const dialogRoomCompaction = resolveLiveDialogRoomCompaction(system, get().dialogRoomCompaction);
    const contextSnapshot = buildPersistableDialogContextSnapshot({
      sessionId: system.sessionId,
      actors,
      dialogHistory,
      artifacts,
      sessionUploads,
      spawnedTasks,
      pendingUserInteractions,
      queuedFollowUps,
      focusedSpawnedSessionRunId,
      coordinatorActorId,
      sourceHandoff,
      dialogRoomCompaction,
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
      queuedFollowUps,
      contextSnapshot,
      dialogRoomCompaction: cloneDialogRoomCompaction(dialogRoomCompaction),
      collaborationSnapshot: collaborationSnapshot ? cloneCollaborationSnapshot(collaborationSnapshot) : null,
      presentationState: collaborationSnapshot ? { ...collaborationSnapshot.presentationState } : null,
      pendingUserInteractions,
    });
    syncDialogRuntimeSession(system.sessionId, {
      dialogHistory,
      spawnedTasks,
      pendingUserInteractions,
      actors,
      coordinatorActorId,
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
      queuedFollowUps,
      collaborationSnapshot,
      sourceHandoff,
    });
    syncDialogSpawnedRuntimeSessions(system.sessionId, spawnedTasks, actors, {
      collaborationSnapshot,
      actorSessionHistoryById: new Map(
        liveActors.map((actor) => [actor.id, actor.getSessionHistory()]),
      ),
      actorTodosById: actorTodos,
      dialogHistory,
      artifacts,
    });

    scheduleDialogRoomCompaction({
      system,
      dialogHistory,
      artifacts,
      spawnedTasks,
      sourceHandoff,
    });

    debouncedSave(system);
  },
}));
