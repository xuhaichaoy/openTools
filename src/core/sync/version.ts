const MAX_SYNC_VERSION = 2_147_483_647;

export function nowSyncVersion(): number {
  const seconds = Math.floor(Date.now() / 1000);
  return Math.min(seconds, MAX_SYNC_VERSION);
}

export function normalizeSyncVersion(
  value: unknown,
  fallback: number = nowSyncVersion(),
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  let normalized = Math.floor(parsed);
  if (normalized <= 0) {
    return fallback;
  }

  if (normalized > MAX_SYNC_VERSION) {
    normalized = Math.floor(normalized / 1000);
  }
  if (normalized > MAX_SYNC_VERSION) {
    normalized = MAX_SYNC_VERSION;
  }
  if (normalized <= 0) {
    return fallback;
  }

  return normalized;
}
