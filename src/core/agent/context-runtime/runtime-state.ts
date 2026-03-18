import { create } from "zustand";

export type RuntimeSessionMode = "agent" | "cluster" | "ask" | "dialog";

export interface RuntimeSessionRecord {
  key: string;
  mode: RuntimeSessionMode;
  sessionId: string;
  query: string;
  startedAt: number;
  updatedAt: number;
  workspaceRoot?: string;
  waitingStage?: string;
  status: string;
}

interface RuntimeStateSnapshot {
  sessions: Record<string, RuntimeSessionRecord>;
  foregroundSessionIds: Partial<Record<RuntimeSessionMode, string>>;
  panelVisibility: Partial<Record<RuntimeSessionMode, boolean>>;
}

interface RuntimeStateStore extends RuntimeStateSnapshot {
  upsertSession: (input: {
    mode: RuntimeSessionMode;
    sessionId: string;
    query: string;
    startedAt?: number;
    updatedAt?: number;
    workspaceRoot?: string;
    waitingStage?: string;
    status?: string;
  }) => RuntimeSessionRecord | null;
  patchSession: (
    mode: RuntimeSessionMode,
    sessionId: string,
    patch: Partial<Pick<RuntimeSessionRecord, "query" | "workspaceRoot" | "waitingStage" | "status" | "updatedAt">>,
  ) => void;
  removeSession: (mode: RuntimeSessionMode, sessionId: string) => void;
  clearMode: (mode: RuntimeSessionMode) => void;
  setForegroundSession: (mode: RuntimeSessionMode, sessionId?: string | null) => void;
  setPanelVisible: (mode: RuntimeSessionMode, visible: boolean) => void;
  resetAll: () => void;
}

type RuntimeAbortHandler = () => void | Promise<void>;

const STORAGE_KEY = "mtools-runtime-state-v1";
const runtimeAbortHandlers = new Map<string, RuntimeAbortHandler>();

function canUseLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function buildEmptySnapshot(): RuntimeStateSnapshot {
  return {
    sessions: {},
    foregroundSessionIds: {},
    panelVisibility: {},
  };
}

function sanitizeSnapshot(input: unknown): RuntimeStateSnapshot {
  if (!input || typeof input !== "object") {
    return buildEmptySnapshot();
  }
  const raw = input as Partial<RuntimeStateSnapshot>;
  const sessions = Object.fromEntries(
    Object.entries(raw.sessions ?? {}).filter(([key, value]) => {
      if (!key || !value || typeof value !== "object") return false;
      const record = value as Partial<RuntimeSessionRecord>;
      return typeof record.mode === "string"
        && typeof record.sessionId === "string"
        && typeof record.query === "string"
        && typeof record.startedAt === "number";
    }),
  ) as Record<string, RuntimeSessionRecord>;

  return {
    sessions,
    foregroundSessionIds: { ...(raw.foregroundSessionIds ?? {}) },
    panelVisibility: { ...(raw.panelVisibility ?? {}) },
  };
}

function loadRuntimeSnapshot(): RuntimeStateSnapshot {
  if (!canUseLocalStorage()) return buildEmptySnapshot();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return buildEmptySnapshot();
    return sanitizeSnapshot(JSON.parse(raw));
  } catch {
    return buildEmptySnapshot();
  }
}

function persistRuntimeSnapshot(snapshot: RuntimeStateSnapshot): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore local persistence failures during runtime.
  }
}

function selectSnapshot(state: RuntimeStateStore): RuntimeStateSnapshot {
  return {
    sessions: state.sessions,
    foregroundSessionIds: state.foregroundSessionIds,
    panelVisibility: state.panelVisibility,
  };
}

function pickLatestSessionId(
  sessions: Record<string, RuntimeSessionRecord>,
  mode: RuntimeSessionMode,
): string | undefined {
  const matches = Object.values(sessions)
    .filter((session) => session.mode === mode)
    .sort((a, b) => b.startedAt - a.startedAt);
  return matches[0]?.sessionId;
}

export function buildRuntimeSessionKey(
  mode: RuntimeSessionMode,
  sessionId: string,
): string {
  return `${mode}:${sessionId.trim()}`;
}

const initialSnapshot = loadRuntimeSnapshot();

export const useRuntimeStateStore = create<RuntimeStateStore>((set, get) => ({
  ...initialSnapshot,

  upsertSession: (input) => {
    const sessionId = input.sessionId.trim();
    const query = input.query.trim();
    if (!sessionId || !query) return null;

    const now = input.updatedAt ?? Date.now();
    const startedAt = input.startedAt ?? now;
    const key = buildRuntimeSessionKey(input.mode, sessionId);
    let created: RuntimeSessionRecord | null = null;

    set((state) => {
      const existing = state.sessions[key];
      const nextRecord: RuntimeSessionRecord = existing
        ? {
            ...existing,
            query,
            updatedAt: now,
            ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
            ...(typeof input.waitingStage === "string"
              ? { waitingStage: input.waitingStage || undefined }
              : {}),
            status: input.status ?? existing.status,
          }
        : {
            key,
            mode: input.mode,
            sessionId,
            query,
            startedAt,
            updatedAt: now,
            ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
            ...(input.waitingStage ? { waitingStage: input.waitingStage } : {}),
            status: input.status ?? "running",
          };
      created = nextRecord;
      const nextState: RuntimeStateSnapshot = {
        sessions: {
          ...state.sessions,
          [key]: nextRecord,
        },
        foregroundSessionIds: {
          ...state.foregroundSessionIds,
          [input.mode]: sessionId,
        },
        panelVisibility: state.panelVisibility,
      };
      persistRuntimeSnapshot(nextState);
      return nextState;
    });

    return created;
  },

  patchSession: (mode, sessionId, patch) => {
    const key = buildRuntimeSessionKey(mode, sessionId);
    set((state) => {
      const existing = state.sessions[key];
      if (!existing) return state;
      const nextRecord: RuntimeSessionRecord = {
        ...existing,
        ...(typeof patch.query === "string" ? { query: patch.query } : {}),
        ...(typeof patch.workspaceRoot === "string"
          ? { workspaceRoot: patch.workspaceRoot || undefined }
          : {}),
        ...(typeof patch.waitingStage === "string"
          ? { waitingStage: patch.waitingStage || undefined }
          : {}),
        ...(typeof patch.status === "string" ? { status: patch.status } : {}),
        updatedAt: patch.updatedAt ?? Date.now(),
      };
      const nextState: RuntimeStateSnapshot = {
        sessions: {
          ...state.sessions,
          [key]: nextRecord,
        },
        foregroundSessionIds: state.foregroundSessionIds,
        panelVisibility: state.panelVisibility,
      };
      persistRuntimeSnapshot(nextState);
      return nextState;
    });
  },

  removeSession: (mode, sessionId) => {
    const key = buildRuntimeSessionKey(mode, sessionId);
    set((state) => {
      if (!state.sessions[key]) return state;
      const nextSessions = { ...state.sessions };
      delete nextSessions[key];
      const nextForeground = { ...state.foregroundSessionIds };
      if (nextForeground[mode] === sessionId) {
        const fallback = pickLatestSessionId(nextSessions, mode);
        if (fallback) {
          nextForeground[mode] = fallback;
        } else {
          delete nextForeground[mode];
        }
      }
      const nextState: RuntimeStateSnapshot = {
        sessions: nextSessions,
        foregroundSessionIds: nextForeground,
        panelVisibility: state.panelVisibility,
      };
      persistRuntimeSnapshot(nextState);
      return nextState;
    });
  },

  clearMode: (mode) => {
    set((state) => {
      const nextSessions = Object.fromEntries(
        Object.entries(state.sessions).filter(([, session]) => session.mode !== mode),
      ) as Record<string, RuntimeSessionRecord>;
      const nextForeground = { ...state.foregroundSessionIds };
      delete nextForeground[mode];
      const nextState: RuntimeStateSnapshot = {
        sessions: nextSessions,
        foregroundSessionIds: nextForeground,
        panelVisibility: state.panelVisibility,
      };
      persistRuntimeSnapshot(nextState);
      return nextState;
    });
  },

  setForegroundSession: (mode, sessionId) => {
    set((state) => {
      const nextForeground = { ...state.foregroundSessionIds };
      const normalized = sessionId?.trim() || "";
      if (normalized) {
        nextForeground[mode] = normalized;
      } else {
        delete nextForeground[mode];
      }
      const nextState: RuntimeStateSnapshot = {
        sessions: state.sessions,
        foregroundSessionIds: nextForeground,
        panelVisibility: state.panelVisibility,
      };
      persistRuntimeSnapshot(nextState);
      return nextState;
    });
  },

  setPanelVisible: (mode, visible) => {
    set((state) => {
      const nextState: RuntimeStateSnapshot = {
        sessions: state.sessions,
        foregroundSessionIds: state.foregroundSessionIds,
        panelVisibility: {
          ...state.panelVisibility,
          [mode]: visible,
        },
      };
      persistRuntimeSnapshot(nextState);
      return nextState;
    });
  },

  resetAll: () => {
    persistRuntimeSnapshot(buildEmptySnapshot());
    set(buildEmptySnapshot());
  },
}));

export function getRuntimeSession(
  mode: RuntimeSessionMode,
  sessionId: string,
): RuntimeSessionRecord | null {
  return useRuntimeStateStore.getState().sessions[buildRuntimeSessionKey(mode, sessionId)] ?? null;
}

export function getForegroundRuntimeSession(
  mode: RuntimeSessionMode,
): RuntimeSessionRecord | null {
  const state = useRuntimeStateStore.getState();
  const sessionId = state.foregroundSessionIds[mode];
  if (!sessionId) return null;
  return getRuntimeSession(mode, sessionId);
}

export function registerRuntimeAbortHandler(
  mode: RuntimeSessionMode,
  sessionId: string,
  handler?: RuntimeAbortHandler | null,
): void {
  const key = buildRuntimeSessionKey(mode, sessionId);
  if (!handler) {
    runtimeAbortHandlers.delete(key);
    return;
  }
  runtimeAbortHandlers.set(key, handler);
}

export function unregisterRuntimeAbortHandler(
  mode: RuntimeSessionMode,
  sessionId: string,
): void {
  runtimeAbortHandlers.delete(buildRuntimeSessionKey(mode, sessionId));
}

export function getRuntimeAbortHandler(
  mode: RuntimeSessionMode,
  sessionId: string,
): RuntimeAbortHandler | null {
  return runtimeAbortHandlers.get(buildRuntimeSessionKey(mode, sessionId)) ?? null;
}

export function hasRuntimeAbortHandler(
  mode: RuntimeSessionMode,
  sessionId: string,
): boolean {
  return runtimeAbortHandlers.has(buildRuntimeSessionKey(mode, sessionId));
}

export async function abortRuntimeSession(
  mode: RuntimeSessionMode,
  sessionId: string,
): Promise<void> {
  const handler = getRuntimeAbortHandler(mode, sessionId);
  useRuntimeStateStore.getState().removeSession(mode, sessionId);
  unregisterRuntimeAbortHandler(mode, sessionId);
  await handler?.();
}

export function clearAllRuntimeSessions(mode?: RuntimeSessionMode): void {
  if (mode) {
    useRuntimeStateStore.getState().clearMode(mode);
    for (const key of [...runtimeAbortHandlers.keys()]) {
      if (key.startsWith(`${mode}:`)) {
        runtimeAbortHandlers.delete(key);
      }
    }
    return;
  }
  runtimeAbortHandlers.clear();
  useRuntimeStateStore.getState().resetAll();
}

export function listRuntimeSessions(mode?: RuntimeSessionMode): RuntimeSessionRecord[] {
  const sessions = Object.values(useRuntimeStateStore.getState().sessions);
  return sessions
    .filter((session) => !mode || session.mode === mode)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function getRuntimeSnapshot(): RuntimeStateSnapshot {
  return sanitizeSnapshot(selectSnapshot(useRuntimeStateStore.getState()));
}
