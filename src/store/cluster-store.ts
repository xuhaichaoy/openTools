import { create } from "zustand";
import { persist } from "zustand/middleware";
import { tauriPersistStorage } from "@/core/storage";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type {
  AgentInstance,
  AgentMessage,
  ClusterMode,
  ClusterPlan,
  ClusterResult,
  ClusterSessionStatus,
} from "@/core/agent/cluster/types";

export interface ClusterSession {
  id: string;
  query: string;
  mode?: ClusterMode;
  /** 该次任务使用的模型名称（创建时写入，用于在任务名称后展示） */
  model?: string;
  /** 用户附带的图片路径 */
  images?: string[];
  status: ClusterSessionStatus;
  plan?: ClusterPlan;
  instances: AgentInstance[];
  messages: AgentMessage[];
  result?: ClusterResult;
  createdAt: number;
  finishedAt?: number;
}

const MAX_PERSISTED_SESSIONS = 50;

interface ClusterState {
  sessions: ClusterSession[];
  currentSessionId: string | null;

  createSession: (query: string, mode?: ClusterMode, model?: string, images?: string[]) => string;
  getCurrentSession: () => ClusterSession | null;
  setCurrentSession: (id: string) => void;
  updateSession: (id: string, patch: Partial<ClusterSession>) => void;
  updateInstance: (sessionId: string, instance: AgentInstance) => void;
  addInstanceStep: (sessionId: string, instanceId: string, step: AgentStep) => void;
  addMessage: (sessionId: string, message: AgentMessage) => void;
  deleteSession: (id: string) => void;
  deleteAllSessions: () => void;
}

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

export const useClusterStore = create<ClusterState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,

      createSession: (query, mode, model, images) => {
        const id = generateId();
        const session: ClusterSession = {
          id,
          query,
          mode,
          model,
          images,
          status: "idle",
          instances: [],
          messages: [],
          createdAt: Date.now(),
        };
        set((state) => ({
          sessions: [session, ...state.sessions].slice(0, MAX_PERSISTED_SESSIONS),
          currentSessionId: id,
        }));
        return id;
      },

      getCurrentSession: () => {
        const { sessions, currentSessionId } = get();
        return sessions.find((s) => s.id === currentSessionId) ?? null;
      },

      setCurrentSession: (id) => set({ currentSessionId: id }),

      updateSession: (id, patch) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, ...patch } : s,
          ),
        }));
      },

      updateInstance: (sessionId, instance) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s;
            const exists = s.instances.some((i) => i.id === instance.id);
            const instances = exists
              ? s.instances.map((i) => (i.id === instance.id ? instance : i))
              : [...s.instances, instance];
            return { ...s, instances };
          }),
        }));
      },

      addInstanceStep: (sessionId, instanceId, step) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              instances: s.instances.map((i) => {
                if (i.id !== instanceId) return i;
                return { ...i, steps: [...i.steps, step] };
              }),
            };
          }),
        }));
      },

      addMessage: (sessionId, message) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, messages: [...s.messages, message] } : s,
          ),
        }));
      },

      deleteSession: (id) => {
        set((state) => {
          const remaining = state.sessions.filter((s) => s.id !== id);
          return {
            sessions: remaining,
            currentSessionId:
              state.currentSessionId === id
                ? remaining[0]?.id ?? null
                : state.currentSessionId,
          };
        });
      },

      deleteAllSessions: () => {
        set({ sessions: [], currentSessionId: null });
      },
    }),
    {
      name: "mtools-cluster",
      storage: tauriPersistStorage("cluster-sessions.json", "集群会话"),
      partialize: (state) => ({
        sessions: state.sessions
          .map((s) => {
            if (s.status !== "done" && s.status !== "error") {
              return { ...s, status: "error" as const, finishedAt: s.finishedAt ?? Date.now() };
            }
            return s;
          })
          .slice(0, MAX_PERSISTED_SESSIONS)
          .map((s) => ({
            ...s,
            instances: s.instances.map((inst) => ({
              ...inst,
              result: inst.result && inst.result.length > 2000
                ? inst.result.slice(0, 2000) + "\n...(已截断)"
                : inst.result,
              steps: inst.steps.slice(-20),
            })),
            messages: s.messages.slice(-100),
            result: s.result ? {
              ...s.result,
              finalAnswer: s.result.finalAnswer.length > 5000
                ? s.result.finalAnswer.slice(0, 5000) + "\n...(已截断)"
                : s.result.finalAnswer,
              agentInstances: [],
            } : undefined,
          })),
        currentSessionId: state.currentSessionId,
      }),
    },
  ),
);
