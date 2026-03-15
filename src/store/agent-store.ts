import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type {
  AgentScheduledTask,
  AgentScheduleType,
  AgentTaskSkippedEvent,
  AgentTaskStatus,
  AgentTaskStatusPatch,
} from "@/core/ai/types";
import { handleError } from "@/core/errors";
import { MAX_CONVERSATIONS } from "@/core/constants";
import { createDebouncedPersister } from "@/core/storage";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { AICenterHandoff } from "@/store/app-store";
import { buildRecoveredAgentTaskPatch } from "@/plugins/builtin/SmartAgent/core/agent-task-state";
import { useAISessionRuntimeStore } from "@/store/ai-session-runtime-store";

/** 单个任务（一次用户提问 + Agent 执行流程） */
export interface AgentTask {
  id: string;
  query: string;
  /** 用户附带的图片路径 */
  images?: string[];
  steps: AgentStep[];
  answer: string | null;
  status?: AgentTaskStatus;
  schedule_type?: AgentScheduleType;
  schedule_value?: string;
  retry_count?: number;
  next_run_at?: number;
  last_error?: string;
  last_started_at?: number;
  last_finished_at?: number;
  last_duration_ms?: number;
  last_result_status?: "success" | "error" | "skipped";
}

export interface AgentSession {
  id: string;
  title: string;
  tasks: AgentTask[];
  createdAt: number;
  /** 跨模式 handoff 来源信息（如从 Ask 切换到 Agent） */
  sourceHandoff?: AICenterHandoff;
}

interface AgentState {
  sessions: AgentSession[];
  scheduledTasks: AgentScheduledTask[];
  currentSessionId: string | null;
  historyLoaded: boolean;

  loadHistory: () => Promise<void>;
  persistHistory: () => Promise<void>;
  loadScheduledTasks: () => Promise<void>;
  createScheduledTask: (params: {
    query: string;
    scheduleType: AgentScheduleType;
    scheduleValue: string;
    sessionId?: string;
  }) => Promise<AgentScheduledTask | null>;
  pauseScheduledTask: (taskId: string) => Promise<void>;
  resumeScheduledTask: (taskId: string) => Promise<void>;
  cancelScheduledTask: (taskId: string) => Promise<void>;
  upsertScheduledTask: (task: AgentScheduledTask) => void;
  applyScheduledTaskPatch: (patch: AgentTaskStatusPatch) => void;
  applyScheduledTaskSkipped: (event: AgentTaskSkippedEvent) => void;
  createSession: (query: string, sourceHandoff?: AgentSession["sourceHandoff"]) => string;
  getCurrentSession: () => AgentSession | null;
  setCurrentSession: (id: string) => void;
  /** 向会话追加一个新任务，返回新任务的 id */
  addTask: (sessionId: string, query: string, images?: string[]) => string;
  /** 更新指定任务的 steps / answer（按 taskId 查找） */
  updateTask: (
    sessionId: string,
    taskId: string,
    updates: Partial<
      Pick<
        AgentTask,
        | "steps"
        | "answer"
        | "status"
        | "retry_count"
        | "next_run_at"
        | "last_error"
        | "last_started_at"
        | "last_finished_at"
        | "last_duration_ms"
        | "last_result_status"
      >
    >,
  ) => void;
  /** 更新会话级字段（如清空 tasks） */
  updateSession: (id: string, updates: Partial<Pick<AgentSession, "tasks" | "title">>) => void;
  deleteSession: (id: string) => void;
  deleteAllSessions: () => void;
  renameSession: (id: string, title: string) => void;
  clearCurrentSession: () => void;
}

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

function buildAgentRuntimeSummary(task: Partial<AgentTask>): string | undefined {
  if (typeof task.answer === "string" && task.answer.trim()) {
    return summarizeAISessionRuntimeText(task.answer, 140);
  }
  if (typeof task.last_error === "string" && task.last_error.trim()) {
    const preview = summarizeAISessionRuntimeText(task.last_error, 110);
    return preview ? `失败：${preview}` : "任务执行失败";
  }
  switch (task.status) {
    case "running":
      return "任务运行中";
    case "success":
      return "任务已完成";
    case "error":
      return "任务执行失败";
    case "paused":
      return "任务已暂停";
    case "pending":
      return "任务等待执行";
    default:
      return undefined;
  }
}

/**
 * 兼容旧格式：将 { query, steps, answer } 迁移到 { tasks: [...] }
 */
function migrateSession(raw: Record<string, unknown>): AgentSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as any;
  if (Array.isArray(r.tasks)) {
    // 为旧数据中缺少 id 的 task 补充 id
    const tasks = r.tasks.map((t: AgentTask) => {
      const baseTask: AgentTask = {
        ...t,
        id: t.id || generateId(),
        status: t.status || (t.answer ? "success" : "pending"),
        retry_count: t.retry_count ?? 0,
      };
      return {
        ...baseTask,
        ...(buildRecoveredAgentTaskPatch(baseTask) ?? {}),
      };
    });
    return {
      id: r.id,
      title: r.title,
      tasks,
      createdAt: r.createdAt,
      ...(r.sourceHandoff ? { sourceHandoff: r.sourceHandoff } : {}),
    };
  }
  // Legacy: query / steps / answer 作为唯一一个 task
  const hasContent = r.query || (Array.isArray(r.steps) && r.steps.length > 0) || r.answer;
  return {
    id: r.id,
    title: r.title || "新任务",
    tasks: hasContent
      ? [
          (() => {
            const task: AgentTask = {
              id: generateId(),
              query: r.query || "",
              steps: r.steps || [],
              answer: r.answer ?? null,
              status: r.answer ? "success" : "pending",
              retry_count: 0,
            };
            return {
              ...task,
              ...(buildRecoveredAgentTaskPatch(task) ?? {}),
            };
          })(),
        ]
      : [],
    createdAt: r.createdAt ?? Date.now(),
    ...(r.sourceHandoff ? { sourceHandoff: r.sourceHandoff } : {}),
  };
}

let _lastPersistedHash = 0;

/** DJB2 哈希算法 —— 简单高效的字符串哈希 */
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// 使用统一的防抖持久化工具
const _agentPersister = createDebouncedPersister(() => {
  useAgentStore.getState().persistHistory();
});
const debouncedPersist = () => _agentPersister.trigger();

export const useAgentStore = create<AgentState>((set, get) => ({
  sessions: [],
  scheduledTasks: [],
  currentSessionId: null,
  historyLoaded: false,

  loadHistory: async () => {
    try {
      const json = await invoke<string>("load_agent_history");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawSessions = JSON.parse(json) as any[];
      const sessions = rawSessions.map(migrateSession);
      useAISessionRuntimeStore.getState().syncSessions(
        sessions.map((session) => ({
          mode: "agent" as const,
          externalSessionId: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.tasks[session.tasks.length - 1]?.last_finished_at
            ?? session.tasks[session.tasks.length - 1]?.last_started_at
            ?? session.createdAt,
          summary: buildAgentRuntimeSummary(session.tasks[session.tasks.length - 1] ?? {}),
          source: session.sourceHandoff,
        })),
      );
      if (sessions.length > 0) {
        set({
          sessions,
          currentSessionId: sessions[0]?.id || null,
          historyLoaded: true,
        });
      } else {
        set({ historyLoaded: true });
      }
    } catch (e) {
      handleError(e, { context: "加载Agent历史" });
      set({ historyLoaded: true });
    }
  },

  persistHistory: async () => {
    try {
      const { sessions } = get();
      // 最多保留 MAX_CONVERSATIONS 个会话，每个任务最多 50 步
      const trimmed = sessions
        .slice(0, MAX_CONVERSATIONS)
        .map((s) => ({
          ...s,
          tasks: s.tasks.map((t) => ({
            ...t,
            steps: t.steps.slice(-50),
          })),
        }));
      const json = JSON.stringify(trimmed);
      const hash = djb2Hash(json);
      if (hash === _lastPersistedHash) return;
      _lastPersistedHash = hash;
      await invoke("save_agent_history", { sessions: json });
    } catch (e) {
      handleError(e, { context: "保存Agent历史", silent: true });
    }
  },

  loadScheduledTasks: async () => {
    try {
      const tasks = await invoke<AgentScheduledTask[]>("agent_task_list");
      set({ scheduledTasks: tasks });
    } catch (e) {
      handleError(e, { context: "加载 Agent 编排任务", silent: true });
    }
  },

  createScheduledTask: async ({ query, scheduleType, scheduleValue, sessionId }) => {
    try {
      const task = await invoke<AgentScheduledTask>("agent_task_create", {
        query,
        sessionId: sessionId || null,
        scheduleType,
        scheduleValue,
      });
      set((state) => ({
        scheduledTasks: [task, ...state.scheduledTasks.filter((t) => t.id !== task.id)],
      }));
      return task;
    } catch (e) {
      handleError(e, { context: "创建 Agent 编排任务" });
      return null;
    }
  },

  pauseScheduledTask: async (taskId) => {
    try {
      await invoke("agent_task_pause", { taskId });
      set((state) => ({
        scheduledTasks: state.scheduledTasks.map((task) =>
          task.id === taskId
            ? { ...task, status: "paused", updated_at: Date.now() }
            : task,
        ),
      }));
    } catch (e) {
      handleError(e, { context: "暂停 Agent 编排任务" });
    }
  },

  resumeScheduledTask: async (taskId) => {
    try {
      await invoke("agent_task_resume", { taskId });
      set((state) => ({
        scheduledTasks: state.scheduledTasks.map((task) =>
          task.id === taskId
            ? { ...task, status: "pending", updated_at: Date.now() }
            : task,
        ),
      }));
    } catch (e) {
      handleError(e, { context: "恢复 Agent 编排任务" });
    }
  },

  cancelScheduledTask: async (taskId) => {
    try {
      await invoke("agent_task_cancel", { taskId });
      set((state) => ({
        scheduledTasks: state.scheduledTasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: "cancelled",
                next_run_at: undefined,
                updated_at: Date.now(),
              }
            : task,
        ),
      }));
    } catch (e) {
      handleError(e, { context: "取消 Agent 编排任务" });
    }
  },

  upsertScheduledTask: (task) => {
    set((state) => {
      const exists = state.scheduledTasks.some((t) => t.id === task.id);
      if (!exists) {
        return { scheduledTasks: [task, ...state.scheduledTasks] };
      }
      return {
        scheduledTasks: state.scheduledTasks.map((t) =>
          t.id === task.id ? { ...t, ...task } : t,
        ),
      };
    });
  },

  applyScheduledTaskPatch: (patch) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map((task) =>
        task.id === patch.task_id
          ? {
              ...task,
              status: patch.status,
              retry_count: patch.retry_count,
              next_run_at: patch.next_run_at,
              last_error: patch.last_error,
              last_started_at: patch.last_started_at,
              last_finished_at: patch.last_finished_at,
              last_duration_ms: patch.last_duration_ms,
              last_result_status: patch.last_result_status,
              last_skip_reason: patch.last_skip_reason,
              updated_at: patch.updated_at,
            }
          : task,
      ),
    }));
  },

  applyScheduledTaskSkipped: (event) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map((task) =>
        task.id === event.task_id
          ? {
              ...task,
              next_run_at: event.next_run_at,
              last_result_status: "skipped",
              last_skip_reason: event.reason,
              updated_at: event.skipped_at,
            }
          : task,
      ),
    }));
  },

  createSession: (query: string, sourceHandoff?: AgentSession["sourceHandoff"]) => {
    const id = generateId();
    const now = Date.now();
    const session: AgentSession = {
      id,
      title: query.slice(0, 30) || "新任务",
      tasks: query
        ? [
            {
              id: generateId(),
              query,
              steps: [],
              answer: null,
              status: "pending",
              retry_count: 0,
            },
          ]
        : [],
      createdAt: now,
      ...(sourceHandoff ? { sourceHandoff } : {}),
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }));
    useAISessionRuntimeStore.getState().ensureSession({
      mode: "agent",
      externalSessionId: id,
      title: session.title,
      createdAt: now,
      updatedAt: now,
      source: sourceHandoff,
    });
    debouncedPersist();
    return id;
  },

  getCurrentSession: () => {
    const { sessions, currentSessionId } = get();
    return sessions.find((s) => s.id === currentSessionId) || null;
  },

  setCurrentSession: (id) => set({ currentSessionId: id }),

  addTask: (sessionId: string, query: string, images?: string[]) => {
    const taskId = generateId();
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const newTask: AgentTask = {
          id: taskId,
          query,
          images,
          steps: [],
          answer: null,
          status: "pending",
          retry_count: 0,
        };
        return { ...s, tasks: [...s.tasks, newTask] };
      }),
    }));
    useAISessionRuntimeStore.getState().touchSession("agent", sessionId, {
      title: query.slice(0, 30) || undefined,
    });
    debouncedPersist();
    return taskId;
  },

  updateTask: (sessionId, taskId, updates) => {
    set((state) => {
      // 校验 session 和 task 仍然存在，防止异步竞态
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session) return state;
      const taskExists = session.tasks.some((t) => t.id === taskId);
      if (!taskExists) return state;

      return {
        sessions: state.sessions.map((s) => {
          if (s.id !== sessionId) return s;
          const newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...t, ...updates } : t,
          );
          return { ...s, tasks: newTasks };
        }),
      };
    });
    const shouldSyncRuntime = [
      updates.status,
      updates.answer,
      updates.last_error,
      updates.last_started_at,
      updates.last_finished_at,
      updates.last_result_status,
    ].some((value) => value !== undefined);
    if (shouldSyncRuntime) {
      const session = get().sessions.find((item) => item.id === sessionId);
      const updatedAt =
        updates.last_finished_at
        ?? updates.last_started_at
        ?? Date.now();
      useAISessionRuntimeStore.getState().ensureSession({
        mode: "agent",
        externalSessionId: sessionId,
        title: session?.title,
        summary: buildAgentRuntimeSummary(updates),
        updatedAt,
        source: session?.sourceHandoff,
      });
    }
    debouncedPersist();
  },

  updateSession: (id, updates) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...updates } : s,
      ),
    }));
    if (updates.title !== undefined) {
      useAISessionRuntimeStore.getState().touchSession("agent", id, {
        title: updates.title,
      });
    }
    debouncedPersist();
  },

  deleteSession: (id) => {
    set((state) => {
      const remaining = state.sessions.filter((s) => s.id !== id);
      const needSwitch = state.currentSessionId === id;
      return {
        sessions: remaining,
        currentSessionId: needSwitch
          ? remaining[0]?.id || null
          : state.currentSessionId,
      };
    });
    debouncedPersist();
  },

  deleteAllSessions: () => {
    set({
      sessions: [],
      currentSessionId: null,
    });
    debouncedPersist();
  },

  renameSession: (id, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title } : s,
      ),
    }));
    useAISessionRuntimeStore.getState().touchSession("agent", id, { title });
    debouncedPersist();
  },

  clearCurrentSession: () => {
    const id = generateId();
    const now = Date.now();
    const session: AgentSession = {
      id,
      title: "新任务",
      tasks: [],
      createdAt: now,
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }));
    useAISessionRuntimeStore.getState().ensureSession({
      mode: "agent",
      externalSessionId: id,
      title: session.title,
      createdAt: now,
      updatedAt: now,
    });
    debouncedPersist();
  },
}));
