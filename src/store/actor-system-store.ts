import { create } from "zustand";
import { ActorSystem, type ActorSystemOptions } from "@/core/agent/actor/actor-system";
import type { AgentActor } from "@/core/agent/actor/agent-actor";
import { DIALOG_FULL_ROLE } from "@/core/agent/actor/agent-actor";
import type {
  AgentCapabilities,
  ActorConfig,
  ActorStatus,
  DialogArtifactRecord,
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

const log = createLogger("ActorStore");

// ── Session 持久化 ──

const LEGACY_STORAGE_KEY = "dialog_session";
const ACTIVE_SESSION_POINTER_KEY = "dialog_session_pointer";
const SCHEMA_VERSION = 3;

interface PersistedSpawnedTask {
  runId: string;
  spawnerActorId: string;
  targetActorId: string;
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
  focusedSpawnedSessionRunId?: string | null;
  coordinatorActorId?: string | null;
  dialogExecutionPlan?: DialogExecutionPlan | null;
  approvalCache?: Record<string, "always-allow" | "ask-every-time" | "deny">;
  sessionId?: string;
  savedAt: number;
}

function buildSessionSnapshot(
  dialogHistory: DialogMessage[],
  actors: AgentActor[],
  spawnedTasks?: Map<string, SpawnedTaskRecord>,
  artifacts?: readonly DialogArtifactRecord[],
  sessionUploads?: readonly SessionUploadRecord[],
  focusedSpawnedSessionRunId?: string | null,
  coordinatorActorId?: string | null,
  dialogExecutionPlan?: DialogExecutionPlan | null,
  approvalCache?: Record<string, "always-allow" | "ask-every-time" | "deny">,
  sessionId?: string,
): PersistedSession {
  const persistedTasks: PersistedSpawnedTask[] = [];
  if (spawnedTasks) {
    for (const r of spawnedTasks.values()) {
      persistedTasks.push({
        runId: r.runId,
        spawnerActorId: r.spawnerActorId,
        targetActorId: r.targetActorId,
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
    focusedSpawnedSessionRunId,
    coordinatorActorId,
    dialogExecutionPlan,
    approvalCache,
    sessionId,
    savedAt: Date.now(),
  };
}

/** Max session age: discard sessions older than 7 days */
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
    system.getFocusedSpawnedSessionRunId(),
    system.getCoordinatorId(),
    system.getDialogExecutionPlan(),
    getSessionApprovalsSnapshot(),
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
      } else if (system.getAll().length === 0) {
        spawnDefaultActors(system);
      }
      saveActiveSessionPointer(system.sessionId);
      get().sync();
    })().catch((err) => {
      log.warn("Failed to hydrate dialog session snapshot", err);
      if (system.getAll().length === 0) {
        spawnDefaultActors(system);
        get().sync();
      }
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
    clearPersistedSession();
    set({
      spawnedTasks: [],
      artifacts: [],
      sessionUploads: [],
      focusedSpawnedSessionRunId: null,
      spawnedTaskEvents: [],
      actorTodos: {},
    });
    get().sync();
  },

  sync: () => {
    const system = get()._system;
    if (!system) {
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
    const pendingUserInteractions = system.getPendingUserInteractions();
    set({
      actors,
      dialogHistory,
      spawnedTasks,
      artifacts,
      sessionUploads,
      focusedSpawnedSessionRunId,
      coordinatorActorId,
      actorTodos,
      pendingUserInteractions,
    });

    debouncedSave(system);
  },
}));
