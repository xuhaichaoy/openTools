import type { AICenterMode, AICenterSourceRef } from "@/store/app-store";

export type AISessionRuntimeKind =
  | "conversation"
  | "task_session"
  | "workflow_session"
  | "collaboration_room";

export type AISessionRuntimeLinkType = "handoff" | "resume" | "derived";

export interface AISessionRuntimeSession {
  id: string;
  mode: AICenterMode;
  kind: AISessionRuntimeKind;
  externalSessionId: string;
  title: string;
  rootId: string;
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
  mode: AICenterMode;
  externalSessionId: string;
  kind?: AISessionRuntimeKind;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  summary?: string;
  source?: Partial<AICenterSourceRef> | null;
  linkType?: AISessionRuntimeLinkType;
}

export function buildAISessionRuntimeId(mode: AICenterMode, externalSessionId: string): string {
  const normalized = externalSessionId.trim();
  return `${mode}:${encodeURIComponent(normalized)}`;
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

export function getAISessionRuntimeKind(mode: AICenterMode): AISessionRuntimeKind {
  switch (mode) {
    case "ask":
      return "conversation";
    case "agent":
      return "task_session";
    case "cluster":
      return "workflow_session";
    case "dialog":
      return "collaboration_room";
    default:
      return "conversation";
  }
}

export function getAISessionRuntimeFallbackTitle(mode: AICenterMode): string {
  switch (mode) {
    case "ask":
      return "Ask 对话";
    case "agent":
      return "Agent 任务";
    case "cluster":
      return "Cluster 会话";
    case "dialog":
      return "Dialog 房间";
    default:
      return "AI 会话";
  }
}

export function resolveAISessionRuntimeSourceId(
  source?: Partial<AICenterSourceRef> | null,
): string | undefined {
  const mode = source?.sourceMode;
  const sessionId = source?.sourceSessionId?.trim();
  if (!mode || !sessionId) return undefined;
  return buildAISessionRuntimeId(mode, sessionId);
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
