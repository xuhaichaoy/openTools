import type { ChannelType } from "@/core/channels/types";
import type { AIProductMode, AICenterCompatibleMode } from "@/core/ai/ai-mode-types";
import type { AICenterSourceRef } from "@/store/app-store";
import { normalizeAIProductMode } from "@/core/ai/ai-mode-types";

export type SessionSurface =
  | "ai_center"
  | "runtime_state"
  | "local_dialog"
  | "im_conversation"
  | "child_session";

export type SessionKind =
  | "conversation"
  | "task_session"
  | "workflow_session"
  | "collaboration_room"
  | "review_session"
  | "channel_topic"
  | "child_session";

export type SessionScope =
  | "main"
  | "workspace"
  | "room"
  | "channel_peer"
  | "channel_topic"
  | "child";

export interface SessionIdentity {
  id: string;
  productMode: AIProductMode;
  surface: SessionSurface;
  sessionKey: string;
  sessionKind: SessionKind;
  scope: SessionScope;
  workspaceId?: string;
  channelType?: ChannelType;
  accountId?: string;
  conversationId?: string;
  topicId?: string;
  peerId?: string;
  parentSessionId?: string;
  runtimeSessionId?: string;
}

export interface SessionIdentityInput {
  productMode?: AICenterCompatibleMode;
  surface: SessionSurface;
  sessionKey: string;
  sessionKind?: SessionKind;
  scope?: SessionScope;
  workspaceId?: string;
  channelType?: ChannelType;
  accountId?: string;
  conversationId?: string;
  topicId?: string;
  peerId?: string;
  parentSessionId?: string;
  runtimeSessionId?: string;
}

export interface SessionControlPlaneSession {
  id: string;
  identity: SessionIdentity;
  title: string;
  summary?: string;
  status?: string;
  source?: AICenterSourceRef;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  placeholder?: boolean;
}

export type SessionControlPlaneLinkType = "handoff" | "resume" | "derived" | "runtime_mirror";

export interface SessionControlPlaneLink {
  id: string;
  fromId: string;
  toId: string;
  type: SessionControlPlaneLinkType;
  createdAt: number;
  note?: string;
}

export interface SessionControlPlaneSnapshot {
  version: 1;
  sessions: Record<string, SessionControlPlaneSession>;
  links: SessionControlPlaneLink[];
  updatedAt: number;
}

function createIdentityId(input: Omit<SessionIdentity, "id">): string {
  return [
    input.surface,
    input.productMode,
    encodeURIComponent(input.sessionKey),
    input.scope,
    input.parentSessionId ? `parent:${encodeURIComponent(input.parentSessionId)}` : "",
    input.topicId ? `topic:${encodeURIComponent(input.topicId)}` : "",
  ].filter(Boolean).join(":");
}

export function getSessionKindForProductMode(
  mode?: AICenterCompatibleMode | null,
): SessionKind {
  switch (normalizeAIProductMode(mode)) {
    case "explore":
      return "conversation";
    case "build":
      return "task_session";
    case "plan":
      return "workflow_session";
    case "review":
      return "review_session";
    case "dialog":
      return "collaboration_room";
    case "im_conversation":
      return "channel_topic";
    default:
      return "conversation";
  }
}

export function buildSessionIdentity(
  input: SessionIdentityInput,
): SessionIdentity {
  const productMode = normalizeAIProductMode(input.productMode);
  const scope = input.scope ?? (
    input.surface === "im_conversation"
      ? (input.topicId ? "channel_topic" : "channel_peer")
      : input.surface === "child_session"
        ? "child"
        : input.workspaceId
          ? "workspace"
          : "room"
  );
  const identity: Omit<SessionIdentity, "id"> = {
    productMode,
    surface: input.surface,
    sessionKey: input.sessionKey.trim(),
    sessionKind: input.sessionKind ?? getSessionKindForProductMode(productMode),
    scope,
    ...(input.workspaceId ? { workspaceId: input.workspaceId.trim() } : {}),
    ...(input.channelType ? { channelType: input.channelType } : {}),
    ...(input.accountId ? { accountId: input.accountId.trim() } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId.trim() } : {}),
    ...(input.topicId ? { topicId: input.topicId.trim() } : {}),
    ...(input.peerId ? { peerId: input.peerId.trim() } : {}),
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId.trim() } : {}),
    ...(input.runtimeSessionId ? { runtimeSessionId: input.runtimeSessionId.trim() } : {}),
  };
  return {
    ...identity,
    id: createIdentityId(identity),
  };
}

export function cloneSessionIdentity(identity: SessionIdentity): SessionIdentity {
  return { ...identity };
}

export function cloneSessionControlPlaneSession(
  session: SessionControlPlaneSession,
): SessionControlPlaneSession {
  return {
    ...session,
    identity: cloneSessionIdentity(session.identity),
    ...(session.source ? { source: { ...session.source } } : {}),
  };
}

export function cloneSessionControlPlaneLink(
  link: SessionControlPlaneLink,
): SessionControlPlaneLink {
  return { ...link };
}

export function createEmptySessionControlPlaneSnapshot(): SessionControlPlaneSnapshot {
  return {
    version: 1,
    sessions: {},
    links: [],
    updatedAt: Date.now(),
  };
}
