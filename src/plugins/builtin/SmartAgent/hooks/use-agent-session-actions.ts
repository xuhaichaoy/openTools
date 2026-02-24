import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useAgentStore } from "@/store/agent-store";
import type { WorkbenchTab } from "../core/ui-state";

type AgentStoreState = ReturnType<typeof useAgentStore.getState>;
type ScheduledType = "once" | "interval" | "cron";

interface UseAgentSessionActionsParams {
  busy: boolean;
  currentSessionId: string | null;
  workbenchTab: WorkbenchTab;
  scheduledQuery: string;
  scheduledType: ScheduledType;
  scheduledValue: string;
  createSession: AgentStoreState["createSession"];
  setCurrentSession: AgentStoreState["setCurrentSession"];
  updateSession: AgentStoreState["updateSession"];
  deleteSession: AgentStoreState["deleteSession"];
  deleteAllSessions: AgentStoreState["deleteAllSessions"];
  createScheduledTask: AgentStoreState["createScheduledTask"];
  setShowHistory: Dispatch<SetStateAction<boolean>>;
  setScheduledQuery: Dispatch<SetStateAction<string>>;
  setScheduledValue: Dispatch<SetStateAction<string>>;
  setShowWorkbench: Dispatch<SetStateAction<boolean>>;
  setWorkbenchTab: Dispatch<SetStateAction<WorkbenchTab>>;
  resetSessionVisualState: () => void;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
}

interface UseAgentSessionActionsResult {
  handleClear: () => void;
  handleNewSession: () => void;
  handleSelectHistorySession: (id: string) => void;
  handleDeleteHistorySession: (id: string) => void;
  handleDeleteAllHistory: () => void;
  handleCreateScheduledTask: () => Promise<void>;
  toggleWorkbenchTab: (tab: WorkbenchTab) => void;
}

export function useAgentSessionActions({
  busy,
  currentSessionId,
  workbenchTab,
  scheduledQuery,
  scheduledType,
  scheduledValue,
  createSession,
  setCurrentSession,
  updateSession,
  deleteSession,
  deleteAllSessions,
  createScheduledTask,
  setShowHistory,
  setScheduledQuery,
  setScheduledValue,
  setShowWorkbench,
  setWorkbenchTab,
  resetSessionVisualState,
  inputRef,
}: UseAgentSessionActionsParams): UseAgentSessionActionsResult {
  const handleClear = useCallback(() => {
    if (busy) return;
    const id = useAgentStore.getState().currentSessionId;
    if (id) updateSession(id, { tasks: [] });
    resetSessionVisualState();
  }, [busy, updateSession, resetSessionVisualState]);

  const handleNewSession = useCallback(() => {
    if (busy) return;
    createSession("");
    resetSessionVisualState();
    inputRef.current?.focus();
  }, [busy, createSession, resetSessionVisualState, inputRef]);

  const handleSelectHistorySession = useCallback(
    (id: string) => {
      if (busy) return;
      setCurrentSession(id);
      setShowHistory(false);
      resetSessionVisualState();
    },
    [busy, setCurrentSession, setShowHistory, resetSessionVisualState],
  );

  const handleDeleteHistorySession = useCallback(
    (sessionIdToDelete: string) => {
      if (busy) return;
      deleteSession(sessionIdToDelete);

      if (currentSessionId === sessionIdToDelete) {
        resetSessionVisualState();
      }
    },
    [deleteSession, busy, currentSessionId, resetSessionVisualState],
  );

  const handleDeleteAllHistory = useCallback(() => {
    if (busy) return;
    deleteAllSessions();
    setShowHistory(false);
    resetSessionVisualState();
  }, [busy, deleteAllSessions, setShowHistory, resetSessionVisualState]);

  const handleCreateScheduledTask = useCallback(async () => {
    const query = scheduledQuery.trim();
    const value = scheduledValue.trim();
    if (!query || !value) return;
    const created = await createScheduledTask({
      query,
      scheduleType: scheduledType,
      scheduleValue: value,
      sessionId: currentSessionId || undefined,
    });
    if (created) {
      setScheduledQuery("");
      setScheduledValue("");
    }
  }, [
    scheduledQuery,
    scheduledValue,
    createScheduledTask,
    scheduledType,
    currentSessionId,
    setScheduledQuery,
    setScheduledValue,
  ]);

  const toggleWorkbenchTab = useCallback(
    (tab: WorkbenchTab) => {
      setShowWorkbench((prev) => (prev && workbenchTab === tab ? false : true));
      setWorkbenchTab(tab);
    },
    [setShowWorkbench, setWorkbenchTab, workbenchTab],
  );

  return {
    handleClear,
    handleNewSession,
    handleSelectHistorySession,
    handleDeleteHistorySession,
    handleDeleteAllHistory,
    handleCreateScheduledTask,
    toggleWorkbenchTab,
  };
}
