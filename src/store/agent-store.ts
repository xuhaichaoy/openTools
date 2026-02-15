import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import {
  MAX_CONVERSATIONS,
  PERSIST_DEBOUNCE_MS,
} from "@/core/constants";

export interface AgentSession {
  id: string;
  title: string;
  query: string;
  steps: AgentStep[];
  answer: string | null;
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
  updateSession: (id: string, updates: Partial<Pick<AgentSession, "steps" | "answer">>) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  clearCurrentSession: () => void;
}

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _lastPersistedHash = "";
function debouncedPersist() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    useAgentStore.getState().persistHistory();
  }, PERSIST_DEBOUNCE_MS);
}

export const useAgentStore = create<AgentState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  historyLoaded: false,

  loadHistory: async () => {
    try {
      const json = await invoke<string>("load_agent_history");
      const sessions = JSON.parse(json) as AgentSession[];
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
      console.error("加载 Agent 历史失败:", e);
      set({ historyLoaded: true });
    }
  },

  persistHistory: async () => {
    try {
      const { sessions } = get();
      // 最多保留 MAX_CONVERSATIONS 个会话，每个会话最多 50 步
      const trimmed = sessions
        .slice(0, MAX_CONVERSATIONS)
        .map((s) => ({
          ...s,
          steps: s.steps.slice(-50),
        }));
      const json = JSON.stringify(trimmed);
      const hash = json.length + ":" + (json.charCodeAt(0) || 0) + ":" + (json.charCodeAt(json.length - 1) || 0);
      if (hash === _lastPersistedHash && json.length < 100000) return;
      _lastPersistedHash = hash;
      await invoke("save_agent_history", { sessions: json });
    } catch (e) {
      console.error("保存 Agent 历史失败:", e);
    }
  },

  createSession: (query: string) => {
    const id = generateId();
    const session: AgentSession = {
      id,
      title: query.slice(0, 30) || "新任务",
      query,
      steps: [],
      answer: null,
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
      query: "",
      steps: [],
      answer: null,
      createdAt: Date.now(),
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }));
  },
}));
