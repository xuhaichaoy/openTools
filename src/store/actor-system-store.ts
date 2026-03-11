import { create } from "zustand";
import { ActorSystem, type ActorSystemOptions } from "@/core/agent/actor/actor-system";
import type { AgentActor } from "@/core/agent/actor/agent-actor";
import { DIALOG_FULL_ROLE } from "@/core/agent/actor/agent-actor";
import type {
  AgentCapabilities,
  ActorConfig,
  ActorStatus,
  ActorTask,
  DialogMessage,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";

// ── LocalStorage 持久化 ──

const STORAGE_KEY = "dialog_session";

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
}

interface PersistedSession {
  dialogHistory: DialogMessage[];
  actorConfigs: Array<{ 
    id: string; 
    roleName: string; 
    model?: string; 
    systemPrompt?: string;
    sessionHistory?: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
  }>;
  spawnedTasks?: PersistedSpawnedTask[];
  sessionId?: string;
  savedAt: number;
}

function saveSession(
  dialogHistory: DialogMessage[],
  actors: AgentActor[],
  spawnedTasks?: Map<string, SpawnedTaskRecord>,
  sessionId?: string,
): void {
  try {
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
        });
      }
    }

    const data: PersistedSession = {
      dialogHistory: dialogHistory.slice(-200),
      actorConfigs: actors.map((a) => ({
        id: a.id,
        roleName: a.role.name,
        model: a.modelOverride,
        systemPrompt: a.getSystemPromptOverride(),
        sessionHistory: a.getSessionHistory(),
      })),
      spawnedTasks: persistedTasks,
      sessionId,
      savedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* quota exceeded or unavailable */ }
}

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedSession;
    return data;
  } catch {
    return null;
  }
}

function clearPersistedSession(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// ── Actor snapshot for UI ──

export interface ActorSnapshot {
  id: string;
  roleName: string;
  roleId: string;
  modelOverride?: string;
  systemPromptOverride?: string;
  status: ActorStatus;
  pendingInbox: number;
  capabilities?: AgentCapabilities;
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
  /** 当前 ActorSystem 实例引用（不序列化） */
  _system: ActorSystem | null;

  // Actions
  init: (options?: ActorSystemOptions) => ActorSystem;
  getSystem: () => ActorSystem | null;
  spawnActor: (config: ActorConfig) => AgentActor;
  killActor: (actorId: string) => void;
  destroyAll: () => void;
  sendMessage: (from: string, to: string, content: string, opts?: { expectReply?: boolean; replyTo?: string }) => void;
  broadcastMessage: (from: string, content: string) => void;
  broadcastAndResolve: (from: string, content: string) => void;
  /** 智能路由：根据内容自动选择合适的 Agent */
  routeTask: (content: string, preferredCapabilities?: string[]) => { agentId: string; reason: string }[];
  assignTask: (actorId: string, query: string, images?: string[]) => void;
  abortAll: () => void;
  replyToMessage: (messageId: string, content: string) => void;
  steer: (actorId: string, directive: string) => void;
  resetSession: (summary?: string) => void;
  /** 等待用户回复的消息 ID 列表 */
  pendingUserReplies: string[];
  /** 从 ActorSystem 同步最新状态到 store（供 UI 使用） */
  sync: () => void;
}

function snapshotActor(actor: AgentActor): ActorSnapshot {
  const current = actor.currentTask;
  return {
    id: actor.id,
    roleName: actor.role.name,
    roleId: actor.role.id,
    modelOverride: actor.modelOverride,
    systemPromptOverride: actor.getSystemPromptOverride(),
    status: actor.status,
    pendingInbox: actor.pendingInboxCount,
    capabilities: actor.capabilities,
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

// Debounced save: batch localStorage writes to avoid I/O on every sync
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(system: ActorSystem): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveSession(
      [...system.getDialogHistory()],
      system.getAll(),
      system.getSpawnedTasksMap(),
      system.sessionId,
    );
  }, 2000);
}

export const useActorSystemStore = create<ActorSystemState>((set, get) => ({
  active: false,
  actors: [],
  dialogHistory: [],
  pendingUserReplies: [],
  _system: null,

  init: (options) => {
    const existing = get()._system;
    if (existing) return existing;

    const system = new ActorSystem(options);

    // 恢复持久化的对话历史和 Agent 状态
    const persisted = loadSession();
    if (persisted) {
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
        });
        if (config.sessionHistory?.length) {
          system.restoreActorSessionHistory(config.id, config.sessionHistory);
        }
      }
    }

    // RAF-based debounce: coalesce rapid events into a single sync per frame
    let syncRAF = 0;
    system.onEvent(() => {
      if (!syncRAF) {
        syncRAF = requestAnimationFrame(() => {
          syncRAF = 0;
          get().sync();
        });
      }
    });

    set({ _system: system, active: true });
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
    clearPersistedSession();
    set({ _system: null, active: false, actors: [], dialogHistory: [] });
  },

  sendMessage: (from, to, content, opts) => {
    const system = get()._system;
    if (!system) return;
    system.send(from, to, content, opts);
    get().sync();
  },

  broadcastMessage: (from, content) => {
    const system = get()._system;
    if (!system) return;
    system.broadcast(from, content);
    get().sync();
  },

  broadcastAndResolve: (from, content) => {
    const system = get()._system;
    if (!system) {
      console.warn("[ActorStore] broadcastAndResolve: no system!");
      return;
    }
    system.broadcastAndResolve(from, content);
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

  replyToMessage: (messageId, content) => {
    const system = get()._system;
    if (!system) return;
    system.replyToMessage(messageId, content);
    get().sync();
  },

  steer: (actorId, directive) => {
    const system = get()._system;
    if (!system) return;
    system.steer(actorId, directive);
    get().sync();
  },

  resetSession: (summary) => {
    const system = get()._system;
    if (!system) return;
    system.resetSession(summary);
    clearPersistedSession();
    get().sync();
  },

  sync: () => {
    const system = get()._system;
    if (!system) {
      set({ actors: [], dialogHistory: [], pendingUserReplies: [] });
      return;
    }
    const actors = system.getAll().map(snapshotActor);
    const dialogHistory = [...system.getDialogHistory()];
    const pendingUserReplies = system.getPendingUserReplies();
    set({ actors, dialogHistory, pendingUserReplies });

    debouncedSave(system);
  },
}));
