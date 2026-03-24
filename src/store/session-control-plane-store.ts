import { create } from "zustand";
import { persist } from "zustand/middleware";
import { tauriPersistStorage } from "@/core/storage";
import type { AICenterSourceRef } from "@/store/app-store";
import {
  buildSessionIdentity,
  cloneSessionControlPlaneContinuityState,
  cloneSessionControlPlaneLink,
  cloneSessionControlPlaneRuntimeState,
  cloneSessionControlPlaneSession,
  createEmptySessionControlPlaneSnapshot,
  type SessionControlPlaneContinuitySource,
  type SessionControlPlaneContinuityState,
  type SessionControlPlaneLink,
  type SessionControlPlaneLinkType,
  type SessionControlPlaneRuntimeState,
  type SessionControlPlaneSession,
  type SessionIdentityInput,
  type SessionControlPlaneSnapshot,
} from "@/core/session-control-plane/types";

export interface SessionControlPlaneUpsertInput {
  identity: SessionIdentityInput;
  title: string;
  summary?: string;
  status?: string;
  source?: AICenterSourceRef;
  createdAt?: number;
  updatedAt?: number;
  lastActiveAt?: number;
  placeholder?: boolean;
}

type SessionControlPlaneRuntimeStatePatch = Partial<Omit<SessionControlPlaneRuntimeState, "active" | "updatedAt">> & {
  active?: boolean;
  updatedAt?: number;
};

type SessionControlPlaneContinuityStatePatch = Partial<Omit<SessionControlPlaneContinuityState, "source" | "updatedAt">> & {
  source?: SessionControlPlaneContinuitySource;
  updatedAt?: number;
};

interface SessionControlPlaneState {
  snapshot: SessionControlPlaneSnapshot;
  upsertSession: (input: SessionControlPlaneUpsertInput) => SessionControlPlaneSession | null;
  patchSessionRuntimeState: (id: string, patch: SessionControlPlaneRuntimeStatePatch | null) => SessionControlPlaneSession | null;
  patchSessionContinuityState: (id: string, patch: SessionControlPlaneContinuityStatePatch | null) => SessionControlPlaneSession | null;
  linkSessions: (params: {
    fromId: string;
    toId: string;
    type?: SessionControlPlaneLinkType;
    createdAt?: number;
    note?: string;
  }) => void;
  getSession: (id: string) => SessionControlPlaneSession | null;
  findSessionByRuntimeSessionId: (runtimeSessionId: string) => SessionControlPlaneSession | null;
  findSessionByIdentity: (input: Partial<SessionIdentityInput>) => SessionControlPlaneSession | null;
  getSnapshot: () => SessionControlPlaneSnapshot;
  removeSession: (id: string) => void;
  clear: () => void;
}

function buildLinkId(fromId: string, toId: string, type: SessionControlPlaneLinkType): string {
  return `${type}:${fromId}->${toId}`;
}

function cloneSnapshot(snapshot: SessionControlPlaneSnapshot): SessionControlPlaneSnapshot {
  return {
    ...snapshot,
    sessions: Object.fromEntries(
      Object.entries(snapshot.sessions).map(([id, session]) => [id, cloneSessionControlPlaneSession(session)]),
    ),
    links: snapshot.links.map((link) => cloneSessionControlPlaneLink(link)),
  };
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function matchesIdentityInput(
  session: SessionControlPlaneSession,
  input: Partial<SessionIdentityInput>,
): boolean {
  const identity = session.identity;
  if (input.productMode && identity.productMode !== input.productMode) return false;
  if (input.surface && identity.surface !== input.surface) return false;
  if (input.sessionKey && identity.sessionKey !== input.sessionKey.trim()) return false;
  if (input.sessionKind && identity.sessionKind !== input.sessionKind) return false;
  if (input.scope && identity.scope !== input.scope) return false;
  if (input.workspaceId && identity.workspaceId !== input.workspaceId.trim()) return false;
  if (input.channelType && identity.channelType !== input.channelType) return false;
  if (input.accountId && identity.accountId !== input.accountId.trim()) return false;
  if (input.conversationId && identity.conversationId !== input.conversationId.trim()) return false;
  if (input.topicId && identity.topicId !== input.topicId.trim()) return false;
  if (input.peerId && identity.peerId !== input.peerId.trim()) return false;
  if (input.parentSessionId && identity.parentSessionId !== input.parentSessionId.trim()) return false;
  if (input.runtimeSessionId && identity.runtimeSessionId !== input.runtimeSessionId.trim()) return false;
  return true;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function applyRuntimeStatePatch(
  existing: SessionControlPlaneRuntimeState | undefined,
  patch: SessionControlPlaneRuntimeStatePatch | null,
): SessionControlPlaneRuntimeState | undefined {
  if (!patch) return undefined;
  const updatedAt = normalizeOptionalNumber(patch.updatedAt) ?? Date.now();
  const next: SessionControlPlaneRuntimeState = existing
    ? cloneSessionControlPlaneRuntimeState(existing)
    : {
        active: patch.active ?? false,
        updatedAt,
      };

  if ("mode" in patch) {
    next.mode = patch.mode;
  }
  if ("active" in patch) {
    next.active = patch.active ?? false;
  }
  if ("status" in patch) {
    next.status = normalizeOptionalString(patch.status);
  }
  if ("waitingStage" in patch) {
    next.waitingStage = normalizeOptionalString(patch.waitingStage);
  }
  if ("query" in patch) {
    next.query = normalizeOptionalString(patch.query);
  }
  if ("displayLabel" in patch) {
    next.displayLabel = normalizeOptionalString(patch.displayLabel);
  }
  if ("displayDetail" in patch) {
    next.displayDetail = normalizeOptionalString(patch.displayDetail);
  }
  if ("workspaceRoot" in patch) {
    next.workspaceRoot = normalizeOptionalString(patch.workspaceRoot);
  }
  if ("startedAt" in patch) {
    next.startedAt = normalizeOptionalNumber(patch.startedAt);
  }
  next.updatedAt = updatedAt;
  return next;
}

function applyContinuityStatePatch(
  existing: SessionControlPlaneContinuityState | undefined,
  patch: SessionControlPlaneContinuityStatePatch | null,
): SessionControlPlaneContinuityState | undefined {
  if (!patch) return undefined;
  const updatedAt = normalizeOptionalNumber(patch.updatedAt) ?? Date.now();
  const next: SessionControlPlaneContinuityState = existing
    ? cloneSessionControlPlaneContinuityState(existing)
    : {
        source: patch.source ?? "runtime_state",
        updatedAt,
      };

  if ("source" in patch) {
    next.source = patch.source ?? next.source;
  }
  if ("executionStrategy" in patch) {
    next.executionStrategy = normalizeOptionalString(patch.executionStrategy);
  }
  if ("contractState" in patch) {
    next.contractState = normalizeOptionalString(patch.contractState);
  }
  if ("pendingInteractionCount" in patch) {
    next.pendingInteractionCount = normalizeOptionalNumber(patch.pendingInteractionCount);
  }
  if ("queuedFollowUpCount" in patch) {
    next.queuedFollowUpCount = normalizeOptionalNumber(patch.queuedFollowUpCount);
  }
  if ("childSessionCount" in patch) {
    next.childSessionCount = normalizeOptionalNumber(patch.childSessionCount);
  }
  if ("openChildSessionCount" in patch) {
    next.openChildSessionCount = normalizeOptionalNumber(patch.openChildSessionCount);
  }
  if ("roomCompactionSummary" in patch) {
    next.roomCompactionSummary = normalizeOptionalString(patch.roomCompactionSummary);
  }
  if ("roomCompactionSummaryPreview" in patch) {
    next.roomCompactionSummaryPreview = normalizeOptionalString(patch.roomCompactionSummaryPreview);
  }
  if ("roomCompactionUpdatedAt" in patch) {
    next.roomCompactionUpdatedAt = normalizeOptionalNumber(patch.roomCompactionUpdatedAt);
  }
  if ("roomCompactionMessageCount" in patch) {
    next.roomCompactionMessageCount = normalizeOptionalNumber(patch.roomCompactionMessageCount);
  }
  if ("roomCompactionTaskCount" in patch) {
    next.roomCompactionTaskCount = normalizeOptionalNumber(patch.roomCompactionTaskCount);
  }
  if ("roomCompactionArtifactCount" in patch) {
    next.roomCompactionArtifactCount = normalizeOptionalNumber(patch.roomCompactionArtifactCount);
  }
  if ("roomCompactionPreservedIdentifiers" in patch) {
    next.roomCompactionPreservedIdentifiers = normalizeStringList(patch.roomCompactionPreservedIdentifiers);
  }
  if ("roomCompactionTriggerReasons" in patch) {
    next.roomCompactionTriggerReasons = normalizeStringList(patch.roomCompactionTriggerReasons);
  }
  if ("roomCompactionMemoryFlushNoteId" in patch) {
    next.roomCompactionMemoryFlushNoteId = normalizeOptionalString(patch.roomCompactionMemoryFlushNoteId);
  }
  if ("roomCompactionMemoryConfirmedCount" in patch) {
    next.roomCompactionMemoryConfirmedCount = normalizeOptionalNumber(patch.roomCompactionMemoryConfirmedCount);
  }
  if ("roomCompactionMemoryQueuedCount" in patch) {
    next.roomCompactionMemoryQueuedCount = normalizeOptionalNumber(patch.roomCompactionMemoryQueuedCount);
  }
  next.updatedAt = updatedAt;
  return next;
}

export const useSessionControlPlaneStore = create<SessionControlPlaneState>()(
  persist(
    (set, get) => ({
      snapshot: createEmptySessionControlPlaneSnapshot(),

      upsertSession: (input) => {
        const title = input.title.trim();
        if (!title) return null;
        const identity = buildSessionIdentity(input.identity);
        const now = input.updatedAt ?? Date.now();
        let nextSession: SessionControlPlaneSession | null = null;
        set((state) => {
          const existing = state.snapshot.sessions[identity.id];
          const createdAt = input.createdAt ?? existing?.createdAt ?? now;
          nextSession = {
            ...(existing ?? {
              id: identity.id,
              createdAt,
            }),
            id: identity.id,
            identity,
            title,
            summary: input.summary?.trim() || existing?.summary,
            status: input.status ?? existing?.status,
            source: input.source
              ? { ...input.source }
              : existing?.source,
            updatedAt: now,
            lastActiveAt: input.lastActiveAt ?? now,
            placeholder: input.placeholder ?? existing?.placeholder,
          };
          return {
            snapshot: {
              ...state.snapshot,
              sessions: {
                ...state.snapshot.sessions,
                [identity.id]: nextSession,
              },
              updatedAt: now,
            },
          };
        });
        return nextSession ? cloneSessionControlPlaneSession(nextSession) : null;
      },

      patchSessionRuntimeState: (id, patch) => {
        const normalizedId = id.trim();
        if (!normalizedId) return null;
        let nextSession: SessionControlPlaneSession | null = null;
        set((state) => {
          const existing = state.snapshot.sessions[normalizedId];
          if (!existing) return state;
          const updatedAt = normalizeOptionalNumber(patch?.updatedAt) ?? Date.now();
          const runtimeState = applyRuntimeStatePatch(existing.runtimeState, patch);
          nextSession = {
            ...existing,
            ...(runtimeState ? { runtimeState } : { runtimeState: undefined }),
            ...(runtimeState?.status ? { status: runtimeState.status } : {}),
            updatedAt: Math.max(existing.updatedAt, updatedAt),
            lastActiveAt: runtimeState?.active
              ? Math.max(existing.lastActiveAt, updatedAt)
              : existing.lastActiveAt,
          };
          return {
            snapshot: {
              ...state.snapshot,
              sessions: {
                ...state.snapshot.sessions,
                [normalizedId]: nextSession,
              },
              updatedAt: Math.max(state.snapshot.updatedAt, updatedAt),
            },
          };
        });
        return nextSession ? cloneSessionControlPlaneSession(nextSession) : null;
      },

      patchSessionContinuityState: (id, patch) => {
        const normalizedId = id.trim();
        if (!normalizedId) return null;
        let nextSession: SessionControlPlaneSession | null = null;
        set((state) => {
          const existing = state.snapshot.sessions[normalizedId];
          if (!existing) return state;
          const updatedAt = normalizeOptionalNumber(patch?.updatedAt) ?? Date.now();
          const continuityState = applyContinuityStatePatch(existing.continuityState, patch);
          nextSession = {
            ...existing,
            ...(continuityState ? { continuityState } : { continuityState: undefined }),
            updatedAt: Math.max(existing.updatedAt, updatedAt),
            lastActiveAt: Math.max(existing.lastActiveAt, updatedAt),
          };
          return {
            snapshot: {
              ...state.snapshot,
              sessions: {
                ...state.snapshot.sessions,
                [normalizedId]: nextSession,
              },
              updatedAt: Math.max(state.snapshot.updatedAt, updatedAt),
            },
          };
        });
        return nextSession ? cloneSessionControlPlaneSession(nextSession) : null;
      },

      linkSessions: ({ fromId, toId, type = "derived", createdAt, note }) => {
        const normalizedFromId = fromId.trim();
        const normalizedToId = toId.trim();
        if (!normalizedFromId || !normalizedToId || normalizedFromId === normalizedToId) return;
        const timestamp = createdAt ?? Date.now();
        const linkId = buildLinkId(normalizedFromId, normalizedToId, type);
        set((state) => {
          if (state.snapshot.links.some((link) => link.id === linkId)) {
            return state;
          }
          const nextLink: SessionControlPlaneLink = {
            id: linkId,
            fromId: normalizedFromId,
            toId: normalizedToId,
            type,
            createdAt: timestamp,
            ...(note?.trim() ? { note: note.trim() } : {}),
          };
          return {
            snapshot: {
              ...state.snapshot,
              links: [...state.snapshot.links, nextLink].slice(-1000),
              updatedAt: timestamp,
            },
          };
        });
      },

      getSession: (id) => {
        const session = get().snapshot.sessions[id];
        return session ? cloneSessionControlPlaneSession(session) : null;
      },

      findSessionByRuntimeSessionId: (runtimeSessionId) => {
        const normalizedRuntimeSessionId = runtimeSessionId.trim();
        if (!normalizedRuntimeSessionId) return null;
        const matched = Object.values(get().snapshot.sessions)
          .filter((session) => session.identity.runtimeSessionId === normalizedRuntimeSessionId)
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        return matched ? cloneSessionControlPlaneSession(matched) : null;
      },

      findSessionByIdentity: (input) => {
        const matched = Object.values(get().snapshot.sessions)
          .filter((session) => matchesIdentityInput(session, input))
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        return matched ? cloneSessionControlPlaneSession(matched) : null;
      },

      getSnapshot: () => cloneSnapshot(get().snapshot),

      removeSession: (id) => set((state) => {
        if (!state.snapshot.sessions[id]) return state;
        const nextSessions = { ...state.snapshot.sessions };
        delete nextSessions[id];
        return {
          snapshot: {
            ...state.snapshot,
            sessions: nextSessions,
            links: state.snapshot.links.filter((link) => link.fromId !== id && link.toId !== id),
            updatedAt: Date.now(),
          },
        };
      }),

      clear: () => set({ snapshot: createEmptySessionControlPlaneSnapshot() }),
    }),
    {
      name: "session-control-plane",
      storage: tauriPersistStorage("session-control-plane.json", "会话控制平面"),
      partialize: (state) => ({
        snapshot: state.snapshot,
      }),
    },
  ),
);
