import { create } from "zustand";
import { persist } from "zustand/middleware";
import { tauriPersistStorage } from "@/core/storage";
import type { AICenterSourceRef } from "@/store/app-store";
import {
  buildSessionIdentity,
  cloneSessionControlPlaneLink,
  cloneSessionControlPlaneSession,
  createEmptySessionControlPlaneSnapshot,
  type SessionControlPlaneLink,
  type SessionControlPlaneLinkType,
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

interface SessionControlPlaneState {
  snapshot: SessionControlPlaneSnapshot;
  upsertSession: (input: SessionControlPlaneUpsertInput) => SessionControlPlaneSession | null;
  linkSessions: (params: {
    fromId: string;
    toId: string;
    type?: SessionControlPlaneLinkType;
    createdAt?: number;
    note?: string;
  }) => void;
  getSession: (id: string) => SessionControlPlaneSession | null;
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
