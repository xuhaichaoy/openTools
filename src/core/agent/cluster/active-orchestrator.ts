import type { ClusterOrchestrator } from "./cluster-orchestrator";
import {
  abortRuntimeSession,
  registerRuntimeAbortHandler,
  unregisterRuntimeAbortHandler,
  useRuntimeStateStore,
} from "@/core/agent/context-runtime/runtime-state";

interface ActiveEntry {
  sessionId: string;
  orchestrator: ClusterOrchestrator;
  abortController: AbortController;
  startedAt: number;
}

const activeEntries = new Map<string, ActiveEntry>();

function ensureForegroundSession(): string | null {
  const state = useRuntimeStateStore.getState();
  const foregroundSessionId = state.foregroundSessionIds.cluster ?? null;
  if (foregroundSessionId && activeEntries.has(foregroundSessionId)) {
    return foregroundSessionId;
  }

  let latest: ActiveEntry | null = null;
  for (const entry of activeEntries.values()) {
    if (!latest || entry.startedAt > latest.startedAt) {
      latest = entry;
    }
  }
  const nextSessionId = latest?.sessionId ?? null;
  useRuntimeStateStore.getState().setForegroundSession("cluster", nextSessionId);
  return nextSessionId;
}

export function setActiveOrchestrator(
  sessionId: string,
  orchestrator: ClusterOrchestrator,
  abortController: AbortController,
  runtimeInfo?: {
    query?: string;
    workspaceRoot?: string;
    status?: string;
  },
): void {
  const startedAt = Date.now();
  activeEntries.set(sessionId, {
    sessionId,
    orchestrator,
    abortController,
    startedAt,
  });
  registerRuntimeAbortHandler("cluster", sessionId, async () => {
    abortController.abort();
    await orchestrator.abort();
  });
  useRuntimeStateStore.getState().upsertSession({
    mode: "cluster",
    sessionId,
    query: runtimeInfo?.query?.trim() || sessionId,
    startedAt,
    workspaceRoot: runtimeInfo?.workspaceRoot,
    status: runtimeInfo?.status || "running",
  });
}

export function getActiveOrchestrator(sessionId?: string): ActiveEntry | null {
  if (sessionId) {
    return activeEntries.get(sessionId) ?? null;
  }
  const current = ensureForegroundSession();
  if (!current) return null;
  return activeEntries.get(current) ?? null;
}

export function getActiveOrchestratorCount(): number {
  return activeEntries.size;
}

export function getActiveSessionIds(): string[] {
  return [...activeEntries.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((entry) => entry.sessionId);
}

export function clearActiveOrchestrator(sessionId?: string): void {
  if (sessionId) {
    activeEntries.delete(sessionId);
    unregisterRuntimeAbortHandler("cluster", sessionId);
    useRuntimeStateStore.getState().removeSession("cluster", sessionId);
    ensureForegroundSession();
    return;
  }

  const current = ensureForegroundSession();
  if (!current) return;
  activeEntries.delete(current);
  unregisterRuntimeAbortHandler("cluster", current);
  useRuntimeStateStore.getState().removeSession("cluster", current);
  ensureForegroundSession();
}

export async function abortActiveOrchestrator(sessionId?: string): Promise<void> {
  const target = getActiveOrchestrator(sessionId);
  if (!target) return;

  activeEntries.delete(target.sessionId);
  await abortRuntimeSession("cluster", target.sessionId);
  ensureForegroundSession();
}

export async function abortAllActiveOrchestrators(): Promise<void> {
  const entries = [...activeEntries.values()];
  activeEntries.clear();
  useRuntimeStateStore.getState().setForegroundSession("cluster", null);

  await Promise.allSettled(
    entries.map((entry) => abortRuntimeSession("cluster", entry.sessionId)),
  );
}

export function isClusterRunning(sessionId?: string): boolean {
  if (sessionId) return activeEntries.has(sessionId);
  return activeEntries.size > 0;
}

export function getActiveSessionId(): string | null {
  return ensureForegroundSession();
}

export function setClusterPanelVisible(visible: boolean): void {
  useRuntimeStateStore.getState().setPanelVisible("cluster", visible);
}

export function isClusterPanelVisible(): boolean {
  return !!useRuntimeStateStore.getState().panelVisibility.cluster;
}
