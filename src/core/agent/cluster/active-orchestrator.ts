import type { ClusterOrchestrator } from "./cluster-orchestrator";

interface ActiveEntry {
  sessionId: string;
  orchestrator: ClusterOrchestrator;
  abortController: AbortController;
}

let active: ActiveEntry | null = null;
let panelVisible = false;

export function setActiveOrchestrator(
  sessionId: string,
  orchestrator: ClusterOrchestrator,
  abortController: AbortController,
): void {
  active = { sessionId, orchestrator, abortController };
}

export function getActiveOrchestrator(): ActiveEntry | null {
  return active;
}

export function clearActiveOrchestrator(): void {
  active = null;
}

export async function abortActiveOrchestrator(): Promise<void> {
  if (active) {
    const { abortController, orchestrator } = active;
    active = null;
    abortController.abort();
    await orchestrator.abort();
  }
}

export function isClusterRunning(): boolean {
  return active !== null;
}

export function getActiveSessionId(): string | null {
  return active?.sessionId ?? null;
}

export function setClusterPanelVisible(visible: boolean): void {
  panelVisible = visible;
}

export function isClusterPanelVisible(): boolean {
  return panelVisible;
}
