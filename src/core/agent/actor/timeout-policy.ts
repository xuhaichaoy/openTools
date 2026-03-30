export type TimeoutReason = "idle" | "budget";

export const DEFAULT_DIALOG_WORKER_BUDGET_SECONDS = 7 * 60;
export const DEFAULT_DIALOG_WORKER_IDLE_LEASE_SECONDS = 120;
export const DEFAULT_DIALOG_MAIN_BUDGET_SECONDS = 20 * 60;
export const DEFAULT_DIALOG_MAIN_IDLE_LEASE_SECONDS = 300;
export const TIMEOUT_CHECK_INTERVAL_MS = 5_000;

export function formatTimeoutError(reason: TimeoutReason, seconds: number): string {
  return reason === "idle"
    ? `Idle timeout after ${seconds}s`
    : `Budget exceeded after ${seconds}s`;
}

export function isTimeoutErrorMessage(value: string | undefined | null): boolean {
  const normalized = String(value ?? "").trim();
  if (!normalized) return false;
  return /^Idle timeout after \d+s$/.test(normalized)
    || /^Budget exceeded after \d+s$/.test(normalized);
}

export function normalizePositiveSeconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

export function formatDurationSeconds(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return remain > 0 ? `${minutes}m ${remain}s` : `${minutes}m`;
}
