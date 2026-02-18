import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { handleError } from "@/core/errors";
import { MAX_CONVERSATIONS } from "@/core/constants";
import { createDebouncedPersister } from "@/core/storage";

/** 单个任务（一次用户提问 + Agent 执行流程） */
export interface AgentTask {
  id: string;
  query: string;
  steps: AgentStep[];
  answer: string | null;
}

export interface AgentSession {
  id: string;
  title: string;
  tasks: AgentTask[];
  createdAt: number;
}

interface AgentState {
  sessions: AgentSession[];
  currentSessionId: string | null;
  historyLoaded: boolean;

  loadHistory: () => Promise<void>;
  persistHistory: () => Promise<void>;
  createSession: (query: string) => string;
  getCurrentSession: () => AgentSession | null;
  setCurrentSession: (id: string) => void;
  /** 向会话追加一个新任务，返回新任务的 id */
  addTask: (sessionId: string, query: string) => string;
  /** 更新指定任务的 steps / answer（按 taskId 查找） */
  updateTask: (sessionId: string, taskId: string, updates: Partial<Pick<AgentTask, "steps" | "answer">>) => void;
  /** 更新会话级字段（如清空 tasks） */
  updateSession: (id: string, updates: Partial<Pick<AgentSession, "tasks" | "title">>) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  clearCurrentSession: () => void;
}

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

/**
 * 兼容旧格式：将 { query, steps, answer } 迁移到 { tasks: [...] }
 */
function migrateSession(raw: Record<string, unknown>): AgentSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as any;
  if (Array.isArray(r.tasks)) {
    // 为旧数据中缺少 id 的 task 补充 id
    const tasks = r.tasks.map((t: AgentTask) => ({
      ...t,
      id: t.id || generateId(),
    }));
    return {
      id: r.id,
      title: r.title,
      tasks,
      createdAt: r.createdAt,
    };
  }
  // Legacy: query / steps / answer 作为唯一一个 task
  const hasContent = r.query || (Array.isArray(r.steps) && r.steps.length > 0) || r.answer;
  return {
    id: r.id,
    title: r.title || "新任务",
    tasks: hasContent
      ? [{ id: generateId(), query: r.query || "", steps: r.steps || [], answer: r.answer ?? null }]
      : [],
    createdAt: r.createdAt ?? Date.now(),
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
  currentSessionId: null,
  historyLoaded: false,

  loadHistory: async () => {
    try {
      const json = await invoke<string>("load_agent_history");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawSessions = JSON.parse(json) as any[];
      const sessions = rawSessions.map(migrateSession);
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

  createSession: (query: string) => {
    const id = generateId();
    const session: AgentSession = {
      id,
      title: query.slice(0, 30) || "新任务",
      tasks: query ? [{ id: generateId(), query, steps: [], answer: null }] : [],
      createdAt: Date.now(),
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }));
    debouncedPersist();
    return id;
  },

  getCurrentSession: () => {
    const { sessions, currentSessionId } = get();
    return sessions.find((s) => s.id === currentSessionId) || null;
  },

  setCurrentSession: (id) => set({ currentSessionId: id }),

  addTask: (sessionId: string, query: string) => {
    const taskId = generateId();
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const newTask: AgentTask = { id: taskId, query, steps: [], answer: null };
        return { ...s, tasks: [...s.tasks, newTask] };
      }),
    }));
    debouncedPersist();
    return taskId;
  },

  updateTask: (sessionId: string, taskId: string, updates: Partial<Pick<AgentTask, "steps" | "answer">>) => {
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
    debouncedPersist();
  },

  updateSession: (id, updates) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...updates } : s,
      ),
    }));
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

  renameSession: (id, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title } : s,
      ),
    }));
    debouncedPersist();
  },

  clearCurrentSession: () => {
    const id = generateId();
    const session: AgentSession = {
      id,
      title: "新任务",
      tasks: [],
      createdAt: Date.now(),
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }));
    debouncedPersist();
  },
}));
