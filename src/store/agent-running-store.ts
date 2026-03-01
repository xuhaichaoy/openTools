import { create } from "zustand";

export interface AgentRunningInfo {
  sessionId: string;
  query: string;
  startedAt: number;
}

interface AgentRunningState {
  /** 当前正在运行的 Agent 信息，null 表示空闲 */
  info: AgentRunningInfo | null;
  /** Agent 模式的 abort 回调 */
  abortFn: (() => void) | null;

  start: (info: AgentRunningInfo, abortFn?: () => void) => void;
  stop: () => void;
}

export const useAgentRunningStore = create<AgentRunningState>((set) => ({
  info: null,
  abortFn: null,

  start: (info, abortFn) => set({ info, abortFn: abortFn ?? null }),
  stop: () => set({ info: null, abortFn: null }),
}));
