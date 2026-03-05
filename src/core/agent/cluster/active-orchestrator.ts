import type { ClusterOrchestrator } from "./cluster-orchestrator";

interface ActiveEntry {
  sessionId: string;
  orchestrator: ClusterOrchestrator;
  abortController: AbortController;
  startedAt: number;
}

const activeEntries = new Map<string, ActiveEntry>();
let foregroundSessionId: string | null = null;
let panelVisible = false;

function ensureForegroundSession(): string | null {
  if (foregroundSessionId && activeEntries.has(foregroundSessionId)) {
    return foregroundSessionId;
  }

  let latest: ActiveEntry | null = null;
  for (const entry of activeEntries.values()) {
    if (!latest || entry.startedAt > latest.startedAt) {
      latest = entry;
    }
  }
  foregroundSessionId = latest?.sessionId ?? null;
  return foregroundSessionId;
}

export function setActiveOrchestrator(
  sessionId: string,
  orchestrator: ClusterOrchestrator,
  abortController: AbortController,
): void {
  activeEntries.set(sessionId, {
    sessionId,
    orchestrator,
    abortController,
    startedAt: Date.now(),
  });
  foregroundSessionId = sessionId;
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
    ensureForegroundSession();
    return;
  }

  const current = ensureForegroundSession();
  if (!current) return;
  activeEntries.delete(current);
  ensureForegroundSession();
}

export async function abortActiveOrchestrator(sessionId?: string): Promise<void> {
  const target = getActiveOrchestrator(sessionId);
  if (!target) return;

  activeEntries.delete(target.sessionId);
  ensureForegroundSession();

  target.abortController.abort();
  await target.orchestrator.abort();
}

export async function abortAllActiveOrchestrators(): Promise<void> {
  const entries = [...activeEntries.values()];
  activeEntries.clear();
  foregroundSessionId = null;

  await Promise.allSettled(
    entries.map(async (entry) => {
      entry.abortController.abort();
      await entry.orchestrator.abort();
    }),
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
  panelVisible = visible;
}

export function isClusterPanelVisible(): boolean {
  return panelVisible;
}
