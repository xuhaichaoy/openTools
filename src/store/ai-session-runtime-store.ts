import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  buildAISessionRuntimeId,
  buildAISessionRuntimeIdentity,
  getAISessionRuntimeFallbackTitle,
  getAISessionRuntimeKind,
  resolveAISessionRuntimeSourceId,
  type AISessionRuntimeLink,
  type AISessionRuntimeSession,
  type AISessionRuntimeUpsertInput,
} from "@/core/ai/ai-session-runtime";
import { tauriPersistStorage } from "@/core/storage";
import type { AICenterCompatibleMode } from "@/core/ai/ai-mode-types";
import { normalizeAIProductMode } from "@/core/ai/ai-mode-types";
import type { AICenterSourceRef } from "@/store/app-store";
import { useSessionControlPlaneStore } from "@/store/session-control-plane-store";

interface AISessionRuntimeState {
  sessions: Record<string, AISessionRuntimeSession>;
  links: AISessionRuntimeLink[];
  ensureSession: (input: AISessionRuntimeUpsertInput) => AISessionRuntimeSession | null;
  syncSessions: (inputs: AISessionRuntimeUpsertInput[]) => void;
  touchSession: (mode: AICenterCompatibleMode, externalSessionId: string, updates?: Partial<Pick<AISessionRuntimeSession, "title" | "summary">>) => void;
  getSession: (id: string) => AISessionRuntimeSession | null;
  getSessionByExternal: (mode: AICenterCompatibleMode, externalSessionId: string) => AISessionRuntimeSession | null;
  getLineage: (id: string) => AISessionRuntimeSession[];
  clear: () => void;
}

function buildLinkId(fromId: string, toId: string, type: AISessionRuntimeLink["type"]): string {
  return `${type}:${fromId}->${toId}`;
}

function mergeSourceRef(
  existing: AICenterSourceRef | undefined,
  incoming?: Partial<AICenterSourceRef> | null,
): AICenterSourceRef | undefined {
  if (!incoming?.sourceMode) return existing;
  return {
    sourceMode: incoming.sourceMode,
    ...(incoming.sourceSessionId ? { sourceSessionId: incoming.sourceSessionId } : {}),
    ...(incoming.sourceLabel ? { sourceLabel: incoming.sourceLabel } : {}),
    ...(incoming.summary ? { summary: incoming.summary } : {}),
  };
}

function chooseTitle(
  existing: string | undefined,
  incoming: string | undefined,
  mode: AICenterCompatibleMode,
): string {
  const next = incoming?.trim();
  if (next) return next;
  const current = existing?.trim();
  if (current) return current;
  return getAISessionRuntimeFallbackTitle(mode);
}

function mergeSessionIdentityInput(
  existing: AISessionRuntimeSession | undefined,
  input: AISessionRuntimeUpsertInput,
) {
  return {
    surface: input.sessionIdentity?.surface ?? existing?.identity?.surface,
    sessionKind: input.sessionIdentity?.sessionKind ?? existing?.identity?.sessionKind,
    scope: input.sessionIdentity?.scope ?? existing?.identity?.scope,
    workspaceId: input.sessionIdentity?.workspaceId ?? existing?.identity?.workspaceId,
    channelType: input.sessionIdentity?.channelType ?? existing?.identity?.channelType,
    accountId: input.sessionIdentity?.accountId ?? existing?.identity?.accountId,
    conversationId: input.sessionIdentity?.conversationId ?? existing?.identity?.conversationId,
    topicId: input.sessionIdentity?.topicId ?? existing?.identity?.topicId,
    peerId: input.sessionIdentity?.peerId ?? existing?.identity?.peerId,
    parentSessionId: input.sessionIdentity?.parentSessionId ?? existing?.identity?.parentSessionId,
    runtimeSessionId: input.sessionIdentity?.runtimeSessionId ?? existing?.identity?.runtimeSessionId,
  };
}

export const useAISessionRuntimeStore = create<AISessionRuntimeState>()(
  persist(
    (set, get) => ({
      sessions: {},
      links: [],

      ensureSession: (input) => {
        const externalSessionId = input.externalSessionId.trim();
        if (!externalSessionId) return null;

        const normalizedMode = normalizeAIProductMode(input.mode);
        const runtimeId = buildAISessionRuntimeId(normalizedMode, externalSessionId);
        const now = Date.now();
        let created: AISessionRuntimeSession | null = null;

        set((state) => {
          const nextSessions = { ...state.sessions };
          const nextLinks = [...state.links];

          const ensureSourcePlaceholder = (
            source?: Partial<AICenterSourceRef> | null,
          ): AISessionRuntimeSession | undefined => {
            const sourceId = resolveAISessionRuntimeSourceId(source);
            if (!sourceId || !source?.sourceMode || !source.sourceSessionId) return undefined;
            const sourceMode = normalizeAIProductMode(source.sourceMode);

            const existing = nextSessions[sourceId];
            if (existing) return existing;

            const placeholder: AISessionRuntimeSession = {
              id: sourceId,
              mode: sourceMode,
              kind: getAISessionRuntimeKind(sourceMode),
              externalSessionId: source.sourceSessionId,
              title: chooseTitle(undefined, source.sourceLabel, sourceMode),
              rootId: sourceId,
              identity: buildAISessionRuntimeIdentity({
                mode: sourceMode,
                externalSessionId: source.sourceSessionId,
                sessionIdentity: mergeSessionIdentityInput(undefined, {
                  mode: sourceMode,
                  externalSessionId: source.sourceSessionId,
                }),
              }),
              summary: source.summary?.trim() || undefined,
              createdAt: now,
              updatedAt: now,
              lastActiveAt: now,
              placeholder: true,
            };
            nextSessions[sourceId] = placeholder;
            return placeholder;
          };

          const sourceSession = ensureSourcePlaceholder(input.source);
          const existing = nextSessions[runtimeId];
          const createdAt = input.createdAt ?? existing?.createdAt ?? now;
          const updatedAt = input.updatedAt ?? now;
          const linkType = input.linkType ?? "handoff";

          const base: AISessionRuntimeSession = existing
            ? {
                ...existing,
                mode: normalizedMode,
                kind: input.kind ?? existing.kind,
                title: chooseTitle(existing.title, input.title, normalizedMode),
                summary: input.summary?.trim() || existing.summary,
                updatedAt,
                lastActiveAt: updatedAt,
                placeholder: false,
                identity: buildAISessionRuntimeIdentity({
                  ...input,
                  mode: normalizedMode,
                  sessionIdentity: mergeSessionIdentityInput(existing, input),
                }),
                source: mergeSourceRef(existing.source, input.source),
              }
            : {
                id: runtimeId,
                mode: normalizedMode,
                kind: input.kind ?? getAISessionRuntimeKind(normalizedMode),
                externalSessionId,
                title: chooseTitle(undefined, input.title, normalizedMode),
                rootId: runtimeId,
                identity: buildAISessionRuntimeIdentity({
                  ...input,
                  mode: normalizedMode,
                  sessionIdentity: mergeSessionIdentityInput(undefined, input),
                }),
                summary: input.summary?.trim() || undefined,
                createdAt,
                updatedAt,
                lastActiveAt: updatedAt,
                placeholder: false,
                ...(input.source?.sourceMode ? { source: mergeSourceRef(undefined, input.source) } : {}),
              };

          if (!base.parentId && sourceSession && sourceSession.id !== runtimeId) {
            base.parentId = sourceSession.id;
            base.rootId = sourceSession.rootId || sourceSession.id;
          }

          nextSessions[runtimeId] = base;
          void useSessionControlPlaneStore.getState().upsertSession({
            identity: {
              productMode: base.mode,
              surface: base.identity?.surface ?? "ai_center",
              sessionKey: base.externalSessionId,
              sessionKind: base.identity?.sessionKind,
              scope: base.identity?.scope,
              workspaceId: base.identity?.workspaceId,
              channelType: base.identity?.channelType,
              accountId: base.identity?.accountId,
              conversationId: base.identity?.conversationId,
              topicId: base.identity?.topicId,
              peerId: base.identity?.peerId,
              parentSessionId: base.parentId ?? base.identity?.parentSessionId,
              runtimeSessionId: base.identity?.runtimeSessionId,
            },
            title: base.title,
            summary: base.summary,
            source: base.source,
            createdAt: base.createdAt,
            updatedAt: updatedAt,
            lastActiveAt: base.lastActiveAt,
            placeholder: base.placeholder,
          });

          if (sourceSession && sourceSession.id !== runtimeId) {
            const linkId = buildLinkId(sourceSession.id, runtimeId, linkType);
            if (!nextLinks.some((link) => link.id === linkId)) {
              nextLinks.push({
                id: linkId,
                fromId: sourceSession.id,
                toId: runtimeId,
                type: linkType,
                createdAt: updatedAt,
                note: `${sourceSession.mode} -> ${input.mode}`,
              });
            }
            useSessionControlPlaneStore.getState().linkSessions({
              fromId: sourceSession.identity?.id ?? sourceSession.id,
              toId: base.identity?.id ?? runtimeId,
              type: linkType,
              createdAt: updatedAt,
              note: `${sourceSession.mode} -> ${base.mode}`,
            });
          }

          created = nextSessions[runtimeId];
          return {
            sessions: nextSessions,
            links: nextLinks,
          };
        });

        return created;
      },

      syncSessions: (inputs) => {
        for (const input of inputs) {
          get().ensureSession(input);
        }
      },

      touchSession: (mode, externalSessionId, updates) => {
        get().ensureSession({
          mode,
          externalSessionId,
          ...(updates?.title ? { title: updates.title } : {}),
          ...(updates?.summary ? { summary: updates.summary } : {}),
          updatedAt: Date.now(),
        });
      },

      getSession: (id) => get().sessions[id] ?? null,

      getSessionByExternal: (mode, externalSessionId) => {
        const normalized = externalSessionId.trim();
        if (!normalized) return null;
        const runtimeId = buildAISessionRuntimeId(mode, normalized);
        return get().sessions[runtimeId] ?? null;
      },

      getLineage: (id) => {
        const sessions = get().sessions;
        const lineage: AISessionRuntimeSession[] = [];
        let current: AISessionRuntimeSession | undefined = sessions[id];
        while (current) {
          lineage.unshift(current);
          current = current.parentId ? sessions[current.parentId] : undefined;
        }
        return lineage;
      },

      clear: () => set({ sessions: {}, links: [] }),
    }),
    {
      name: "ai-session-runtime",
      storage: tauriPersistStorage("ai-session-runtime.json", "AI 会话运行时"),
      partialize: (state) => ({
        sessions: state.sessions,
        links: state.links.slice(-500),
      }),
    },
  ),
);
