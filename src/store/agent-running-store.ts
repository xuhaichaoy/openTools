import { create } from "zustand";
import {
  registerRuntimeAbortHandler,
  unregisterRuntimeAbortHandler,
  useRuntimeStateStore,
} from "@/core/agent/context-runtime/runtime-state";

export interface AgentRunningInfo {
  sessionId: string;
  query: string;
  startedAt: number;
  workspaceRoot?: string;
  waitingStage?: string;
}

interface AgentRunningState {
  /** 当前正在运行的 Agent 信息，null 表示空闲 */
  info: AgentRunningInfo | null;
  /** Agent 模式的 abort 回调 */
  abortFn: (() => void) | null;

  start: (info: AgentRunningInfo, abortFn?: () => void) => void;
  patch: (updates: Partial<AgentRunningInfo>) => void;
  stop: () => void;
}

export const useAgentRunningStore = create<AgentRunningState>((set) => ({
  info: null,
  abortFn: null,

  start: (info, abortFn) => set((state) => {
    if (state.info?.sessionId && state.info.sessionId !== info.sessionId) {
      unregisterRuntimeAbortHandler("agent", state.info.sessionId);
      useRuntimeStateStore.getState().removeSession("agent", state.info.sessionId);
    }
    registerRuntimeAbortHandler("agent", info.sessionId, abortFn ?? null);
    useRuntimeStateStore.getState().upsertSession({
      mode: "agent",
      sessionId: info.sessionId,
      query: info.query,
      startedAt: info.startedAt,
      workspaceRoot: info.workspaceRoot,
      waitingStage: info.waitingStage,
      status: "running",
    });
    return { info, abortFn: abortFn ?? null };
  }),
  patch: (updates) => set((state) => {
    if (!state.info) return state;
    const nextInfo = {
      ...state.info,
      ...updates,
    };
    useRuntimeStateStore.getState().patchSession("agent", nextInfo.sessionId, {
      ...(typeof updates.query === "string" ? { query: updates.query } : {}),
      ...(typeof updates.workspaceRoot === "string"
        ? { workspaceRoot: updates.workspaceRoot }
        : {}),
      ...(typeof updates.waitingStage === "string"
        ? { waitingStage: updates.waitingStage }
        : {}),
      status: "running",
    });
    return {
      info: nextInfo,
      abortFn: state.abortFn,
    };
  }),
  stop: () => set((state) => {
    if (state.info?.sessionId) {
      unregisterRuntimeAbortHandler("agent", state.info.sessionId);
      useRuntimeStateStore.getState().removeSession("agent", state.info.sessionId);
    }
    return { info: null, abortFn: null };
  }),
}));
