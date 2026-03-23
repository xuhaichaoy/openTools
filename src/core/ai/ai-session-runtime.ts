import type { AICenterSourceRef } from "@/store/app-store";
import type {
  AICenterCompatibleMode,
  AIProductMode,
} from "@/core/ai/ai-mode-types";
import {
  getDefaultRuntimeSessionLabel,
} from "./ai-product-modes";
import { normalizeAIProductMode } from "@/core/ai/ai-mode-types";
import {
  buildSessionIdentity,
  type SessionIdentity,
  type SessionIdentityInput,
} from "@/core/session-control-plane/types";

export type AISessionRuntimeKind =
  | "conversation"
  | "task_session"
  | "workflow_session"
  | "collaboration_room"
  | "review_session";

export type AISessionRuntimeLinkType = "handoff" | "resume" | "derived";

export interface AISessionRuntimeSession {
  id: string;
  mode: AIProductMode;
  kind: AISessionRuntimeKind;
  externalSessionId: string;
  title: string;
  rootId: string;
  identity?: SessionIdentity;
  parentId?: string;
  source?: AICenterSourceRef;
  summary?: string;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  placeholder?: boolean;
}

export interface AISessionRuntimeLink {
  id: string;
  fromId: string;
  toId: string;
  type: AISessionRuntimeLinkType;
  createdAt: number;
  note?: string;
}

export interface AISessionRuntimeUpsertInput {
  mode: AICenterCompatibleMode;
  externalSessionId: string;
  kind?: AISessionRuntimeKind;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  summary?: string;
  source?: Partial<AICenterSourceRef> | null;
  linkType?: AISessionRuntimeLinkType;
  sessionIdentity?: Omit<SessionIdentityInput, "sessionKey" | "productMode">;
}

export function buildAISessionRuntimeId(mode: AICenterCompatibleMode, externalSessionId: string): string {
  const normalizedMode = normalizeAIProductMode(mode);
  const normalized = externalSessionId.trim();
  return `${normalizedMode}:${encodeURIComponent(normalized)}`;
}

export function buildAISessionRuntimeChildExternalId(
  parentExternalSessionId: string,
  childScope: string,
  childId: string,
): string {
  const parent = parentExternalSessionId.trim();
  const scope = childScope.trim();
  const child = childId.trim();
  return `${parent}::${scope}:${child}`;
}

export function getAISessionRuntimeKind(mode: AICenterCompatibleMode): AISessionRuntimeKind {
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
      return "conversation";
    default:
      return "conversation";
  }
}

export function getAISessionRuntimeFallbackTitle(mode: AICenterCompatibleMode): string {
  return getDefaultRuntimeSessionLabel(mode);
}

export function resolveAISessionRuntimeSourceId(
  source?: Partial<AICenterSourceRef> | null,
): string | undefined {
  const mode = source?.sourceMode ? normalizeAIProductMode(source.sourceMode) : undefined;
  const sessionId = source?.sourceSessionId?.trim();
  if (!mode || !sessionId) return undefined;
  return buildAISessionRuntimeId(mode, sessionId);
}

export function buildAISessionRuntimeIdentity(
  input: AISessionRuntimeUpsertInput,
): SessionIdentity {
  const normalizedMode = normalizeAIProductMode(input.mode);
  return buildSessionIdentity({
    productMode: normalizedMode,
    surface: input.sessionIdentity?.surface ?? "ai_center",
    sessionKey: input.externalSessionId.trim(),
    sessionKind: input.sessionIdentity?.sessionKind ?? getAISessionRuntimeKind(normalizedMode),
    scope: input.sessionIdentity?.scope,
    workspaceId: input.sessionIdentity?.workspaceId,
    channelType: input.sessionIdentity?.channelType,
    accountId: input.sessionIdentity?.accountId,
    conversationId: input.sessionIdentity?.conversationId,
    topicId: input.sessionIdentity?.topicId,
    peerId: input.sessionIdentity?.peerId,
    parentSessionId: input.sessionIdentity?.parentSessionId,
    runtimeSessionId: input.sessionIdentity?.runtimeSessionId,
  });
}

export function summarizeAISessionRuntimeText(
  input?: string | null,
  maxLength = 120,
): string | undefined {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  const safeLength = Math.max(1, maxLength - 3);
  return `${normalized.slice(0, safeLength)}...`;
}
