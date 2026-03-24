import { create } from "zustand";
import { persist } from "zustand/middleware";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { ClusterContextRuntimeDebugReport } from "@/core/agent/context-runtime/debug-types";
import type { AgentInstanceStatus } from "@/core/agent/cluster/types";
import {
  buildClusterContextSnapshot,
  cloneClusterContextSnapshot,
  type ClusterContextSnapshot,
} from "@/plugins/builtin/SmartAgent/core/cluster-context-snapshot";
import { tauriPersistStorage } from "@/core/storage";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { AICenterHandoff } from "@/store/app-store";
import { useAISessionRuntimeStore } from "@/store/ai-session-runtime-store";
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
  workspaceRoot?: string;
  /** 跨模式 handoff 来源信息 */
  sourceHandoff?: AICenterHandoff;
  contextSnapshot?: ClusterContextSnapshot | null;
  lastSessionNotePreview?: string;
  lastContextRuntimeReport?: ClusterContextRuntimeDebugReport;
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

  createSession: (
    query: string,
    mode?: ClusterMode,
    model?: string,
    images?: string[],
    sourceHandoff?: AICenterHandoff,
    workspaceRoot?: string,
  ) => string;
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

const RUNNING_INSTANCE_STATUSES: readonly AgentInstanceStatus[] = ["running", "reviewing"];

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

function buildClusterSnapshotForSession(session: ClusterSession): ClusterContextSnapshot {
  const runningInstanceCount = session.instances.filter((instance) =>
    RUNNING_INSTANCE_STATUSES.includes(instance.status),
  ).length;
  const memoryPreview = collectUniquePreviewItems(
    session.instances.flatMap((instance) => instance.appliedMemoryPreview ?? []),
  );
  const transcriptPreview = collectUniquePreviewItems(
    session.instances.flatMap((instance) => instance.appliedTranscriptPreview ?? []),
  );
  const transcriptRecallHitCount = session.instances.reduce(
    (sum, instance) => sum + Math.max(0, instance.transcriptRecallHitCount ?? 0),
    0,
  );

  return buildClusterContextSnapshot({
    sessionId: session.id,
    query: session.query,
    mode: session.mode,
    status: session.status,
    workspaceRoot: session.workspaceRoot,
    sourceHandoff: session.sourceHandoff,
    imageCount: session.images?.length ?? 0,
    messageCount: session.messages.length,
    planStepCount: session.plan?.steps.length ?? 0,
    instanceCount: session.instances.length,
    runningInstanceCount,
    completedInstanceCount: session.instances.filter((instance) => instance.status === "done").length,
    errorInstanceCount: session.instances.filter((instance) => instance.status === "error").length,
    finalAnswer: session.result?.finalAnswer,
    lastSessionNotePreview: session.lastSessionNotePreview,
    lastRunStatus: session.lastContextRuntimeReport?.execution.status,
    lastRunDurationMs: session.lastContextRuntimeReport?.execution.durationMs,
    memoryRecallAttempted: session.instances.some((instance) => instance.memoryRecallAttempted === true),
    memoryHitCount: memoryPreview.length,
    memoryPreview,
    transcriptRecallAttempted: session.instances.some(
      (instance) => instance.transcriptRecallAttempted === true,
    ),
    transcriptRecallHitCount,
    transcriptPreview,
  });
}

function withClusterSnapshot(session: ClusterSession): ClusterSession {
  return {
    ...session,
    contextSnapshot: buildClusterSnapshotForSession(session),
  };
}

function buildClusterRuntimeSummary(session: ClusterSession): string | undefined {
  if (session.result?.finalAnswer?.trim()) {
    return summarizeAISessionRuntimeText(session.result.finalAnswer, 160);
  }
  switch (session.status) {
    case "planning":
      return "正在拆解任务";
    case "awaiting_approval":
      return "等待计划审批";
    case "dispatching":
      return "正在分发子任务";
    case "running":
      return "多 Agent 执行中";
    case "aggregating":
      return "正在汇总结果";
    case "done":
      return "Cluster 已完成";
    case "error":
      return "Cluster 执行失败";
    default:
      return undefined;
  }
}

export const useClusterStore = create<ClusterState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,

      createSession: (query, mode, model, images, sourceHandoff, workspaceRoot) => {
        const id = generateId();
        const now = Date.now();
        const session: ClusterSession = {
          id,
          query,
          mode,
          model,
          images,
          ...(workspaceRoot ? { workspaceRoot } : {}),
          ...(sourceHandoff ? { sourceHandoff } : {}),
          status: "idle",
          instances: [],
          messages: [],
          createdAt: now,
        };
        const nextSession = withClusterSnapshot(session);
        set((state) => ({
          sessions: [nextSession, ...state.sessions].slice(0, MAX_PERSISTED_SESSIONS),
          currentSessionId: id,
        }));
        useAISessionRuntimeStore.getState().ensureSession({
          mode: "cluster",
          externalSessionId: id,
          title: query.slice(0, 60) || "Cluster 会话",
          createdAt: now,
          updatedAt: now,
          source: sourceHandoff,
          sessionIdentity: {
            surface: "ai_center",
            sessionKey: id,
            sessionKind: "workflow_session",
            workspaceId: workspaceRoot,
            runtimeSessionId: id,
          },
        });
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
            s.id === id ? withClusterSnapshot({ ...s, ...patch }) : s,
          ),
        }));
        const session = get().sessions.find((item) => item.id === id);
        if (session) {
          useAISessionRuntimeStore.getState().ensureSession({
            mode: "cluster",
            externalSessionId: id,
            title: session.query.slice(0, 60) || "Cluster 会话",
            summary: buildClusterRuntimeSummary(session),
            updatedAt: session.finishedAt ?? Date.now(),
            source: session.sourceHandoff,
            sessionIdentity: {
              surface: "ai_center",
              sessionKey: id,
              sessionKind: "workflow_session",
              workspaceId: session.workspaceRoot,
              runtimeSessionId: id,
            },
          });
        }
      },

      updateInstance: (sessionId, instance) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s;
            const exists = s.instances.some((i) => i.id === instance.id);
            const instances = exists
              ? s.instances.map((i) => (i.id === instance.id ? instance : i))
              : [...s.instances, instance];
            return withClusterSnapshot({ ...s, instances });
          }),
        }));
      },

      addInstanceStep: (sessionId, instanceId, step) => {
        set((state) => ({
          sessions: state.sessions.map((s) => {
            if (s.id !== sessionId) return s;
            return withClusterSnapshot({
              ...s,
              instances: s.instances.map((i) => {
                if (i.id !== instanceId) return i;
                return { ...i, steps: [...i.steps, step] };
              }),
            });
          }),
        }));
      },

      addMessage: (sessionId, message) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? withClusterSnapshot({ ...s, messages: [...s.messages, message] })
              : s,
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
      onRehydrateStorage: () => (state) => {
        if (!state?.sessions?.length) return;
        const normalizedSessions = state.sessions.map((session) =>
          withClusterSnapshot({
            ...session,
            contextSnapshot: cloneClusterContextSnapshot(session.contextSnapshot),
          }),
        );
        const nextCurrentSessionId =
          state.currentSessionId && normalizedSessions.some((session) => session.id === state.currentSessionId)
            ? state.currentSessionId
            : normalizedSessions[0]?.id ?? null;
        useClusterStore.setState({
          sessions: normalizedSessions,
          currentSessionId: nextCurrentSessionId,
        });
        useAISessionRuntimeStore.getState().syncSessions(
          normalizedSessions.map((session) => ({
            mode: "cluster" as const,
            externalSessionId: session.id,
            title: session.query.slice(0, 60) || "Cluster 会话",
            createdAt: session.createdAt,
            updatedAt: session.finishedAt ?? session.createdAt,
            summary: buildClusterRuntimeSummary(session),
            source: session.sourceHandoff,
          })),
        );
      },
      partialize: (state) => ({
        sessions: state.sessions
          .map((s) => {
            if (s.status !== "done" && s.status !== "error") {
              return withClusterSnapshot({
                ...s,
                status: "error" as const,
                finishedAt: s.finishedAt ?? Date.now(),
              });
            }
            return withClusterSnapshot(s);
          })
          .slice(0, MAX_PERSISTED_SESSIONS)
          .map((s) =>
            withClusterSnapshot({
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
            }),
          ),
        currentSessionId: state.currentSessionId,
      }),
    },
  ),
);
