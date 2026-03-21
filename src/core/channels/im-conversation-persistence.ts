import type {
  DialogMessage,
  AgentCapabilities,
  ExecutionPolicy,
  MiddlewareOverrides,
  ThinkingLevel,
  ToolPolicy,
} from "@/core/agent/actor/types";
import {
  cloneCollaborationSnapshot,
  sanitizeCollaborationSnapshot,
} from "@/core/collaboration/persistence";
import type { CollaborationSessionSnapshot } from "@/core/collaboration/types";
import type { ChannelIncomingMessage, ChannelType } from "./types";

const IM_CONVERSATION_PERSIST_KEY = "mtools-im-conversation-runtime-v2";
const IM_CONVERSATION_LEGACY_PERSIST_KEY = "mtools-im-conversation-runtime-v1";
const IM_CONVERSATION_PERSIST_VERSION = 2;

export interface PersistedIMPendingMessage {
  messageId: string;
  text: string;
  briefContent: string;
  timestamp: number;
  channelType: ChannelType;
  conversationType: ChannelIncomingMessage["conversationType"];
  displayLabel: string;
  displayDetail: string;
  images?: string[];
  attachments?: Array<{
    name: string;
    downloadCode: string;
  }>;
}

export interface PersistedIMActorConfig {
  id: string;
  roleName: string;
  model?: string;
  maxIterations?: number;
  systemPrompt?: string;
  capabilities?: AgentCapabilities;
  toolPolicy?: ToolPolicy;
  executionPolicy?: ExecutionPolicy;
  workspace?: string;
  timeoutSeconds?: number;
  contextTokens?: number;
  thinkingLevel?: ThinkingLevel;
  middlewareOverrides?: MiddlewareOverrides;
  sessionHistory?: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
}

export interface PersistedIMRuntimeRecord {
  key: string;
  channelId: string;
  channelType: ChannelType;
  conversationId: string;
  conversationType: ChannelIncomingMessage["conversationType"];
  topicId: string;
  sessionId: string;
  updatedAt: number;
  lastInput?: PersistedIMPendingMessage;
  queuedMessages?: PersistedIMPendingMessage[];
  dialogHistory: DialogMessage[];
  actorConfigs: PersistedIMActorConfig[];
  collaborationSnapshot?: CollaborationSessionSnapshot;
}

export interface PersistedIMConversationStateRecord {
  key: string;
  channelType?: ChannelType;
  conversationType?: ChannelIncomingMessage["conversationType"];
  activeTopicId: string;
  nextTopicSeq: number;
  updatedAt: number;
}

export interface PersistedIMConversationRuntimeSnapshot {
  version: number;
  savedAt: number;
  conversations: PersistedIMConversationStateRecord[];
  runtimes: PersistedIMRuntimeRecord[];
}

function canUseLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function isChannelType(value: unknown): value is ChannelType {
  return value === "dingtalk" || value === "feishu";
}

function isConversationType(value: unknown): value is ChannelIncomingMessage["conversationType"] {
  return value === "private" || value === "group";
}

function sanitizePendingMessage(input: unknown): PersistedIMPendingMessage | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<PersistedIMPendingMessage>;
  if (
    typeof record.messageId !== "string"
    || typeof record.text !== "string"
    || typeof record.briefContent !== "string"
    || typeof record.timestamp !== "number"
    || !isChannelType(record.channelType)
    || !isConversationType(record.conversationType)
    || typeof record.displayLabel !== "string"
    || typeof record.displayDetail !== "string"
  ) {
    return undefined;
  }

  return {
    messageId: record.messageId,
    text: record.text,
    briefContent: record.briefContent,
    timestamp: record.timestamp,
    channelType: record.channelType,
    conversationType: record.conversationType,
    displayLabel: record.displayLabel,
    displayDetail: record.displayDetail,
    ...(Array.isArray(record.images) ? { images: record.images.filter((item): item is string => typeof item === "string") } : {}),
    ...(Array.isArray(record.attachments)
      ? {
          attachments: record.attachments
            .filter((item): item is { name: string; downloadCode: string } => (
              Boolean(item)
              && typeof item === "object"
              && typeof item.name === "string"
              && typeof item.downloadCode === "string"
            ))
            .map((item) => ({ name: item.name, downloadCode: item.downloadCode })),
        }
      : {}),
  };
}

function sanitizeActorConfig(input: unknown): PersistedIMActorConfig | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Partial<PersistedIMActorConfig>;
  if (typeof record.id !== "string" || typeof record.roleName !== "string") {
    return null;
  }

  return {
    id: record.id,
    roleName: record.roleName,
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.maxIterations === "number" ? { maxIterations: record.maxIterations } : {}),
    ...(typeof record.systemPrompt === "string" ? { systemPrompt: record.systemPrompt } : {}),
    ...(record.capabilities && typeof record.capabilities === "object" ? { capabilities: record.capabilities } : {}),
    ...(record.toolPolicy && typeof record.toolPolicy === "object" ? { toolPolicy: record.toolPolicy } : {}),
    ...(record.executionPolicy && typeof record.executionPolicy === "object" ? { executionPolicy: record.executionPolicy } : {}),
    ...(typeof record.workspace === "string" ? { workspace: record.workspace } : {}),
    ...(typeof record.timeoutSeconds === "number" ? { timeoutSeconds: record.timeoutSeconds } : {}),
    ...(typeof record.contextTokens === "number" ? { contextTokens: record.contextTokens } : {}),
    ...(typeof record.thinkingLevel === "string" ? { thinkingLevel: record.thinkingLevel } : {}),
    ...(record.middlewareOverrides && typeof record.middlewareOverrides === "object"
      ? { middlewareOverrides: record.middlewareOverrides }
      : {}),
    ...(Array.isArray(record.sessionHistory)
      ? {
          sessionHistory: record.sessionHistory
            .filter((entry): entry is { role: "user" | "assistant"; content: string; timestamp: number } => (
              Boolean(entry)
              && typeof entry === "object"
              && (entry.role === "user" || entry.role === "assistant")
              && typeof entry.content === "string"
              && typeof entry.timestamp === "number"
            ))
            .map((entry) => ({ role: entry.role, content: entry.content, timestamp: entry.timestamp })),
        }
      : {}),
  };
}

function sanitizeRuntimeRecord(input: unknown): PersistedIMRuntimeRecord | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Partial<PersistedIMRuntimeRecord>;
  if (
    typeof record.key !== "string"
    || typeof record.channelId !== "string"
    || !isChannelType(record.channelType)
    || typeof record.conversationId !== "string"
    || !isConversationType(record.conversationType)
    || typeof record.topicId !== "string"
    || typeof record.sessionId !== "string"
    || typeof record.updatedAt !== "number"
    || !Array.isArray(record.actorConfigs)
  ) {
    return null;
  }

  return {
    key: record.key,
    channelId: record.channelId,
    channelType: record.channelType,
    conversationId: record.conversationId,
    conversationType: record.conversationType,
    topicId: record.topicId,
    sessionId: record.sessionId,
    updatedAt: record.updatedAt,
    ...(sanitizePendingMessage(record.lastInput) ? { lastInput: sanitizePendingMessage(record.lastInput) } : {}),
    ...(Array.isArray(record.queuedMessages)
      ? {
          queuedMessages: record.queuedMessages
            .map((item) => sanitizePendingMessage(item))
            .filter((item): item is PersistedIMPendingMessage => Boolean(item)),
        }
      : {}),
    dialogHistory: Array.isArray(record.dialogHistory) ? record.dialogHistory as DialogMessage[] : [],
    actorConfigs: record.actorConfigs
      .map((item) => sanitizeActorConfig(item))
      .filter((item): item is PersistedIMActorConfig => Boolean(item)),
    ...(record.collaborationSnapshot
      ? { collaborationSnapshot: sanitizeCollaborationSnapshot(record.collaborationSnapshot, "im_conversation") }
      : {}),
  };
}

function sanitizeConversationStateRecord(input: unknown): PersistedIMConversationStateRecord | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Partial<PersistedIMConversationStateRecord>;
  if (
    typeof record.key !== "string"
    || typeof record.activeTopicId !== "string"
    || typeof record.nextTopicSeq !== "number"
    || typeof record.updatedAt !== "number"
  ) {
    return null;
  }

  return {
    key: record.key,
    ...(isChannelType(record.channelType) ? { channelType: record.channelType } : {}),
    ...(isConversationType(record.conversationType) ? { conversationType: record.conversationType } : {}),
    activeTopicId: record.activeTopicId,
    nextTopicSeq: record.nextTopicSeq,
    updatedAt: record.updatedAt,
  };
}

export function loadPersistedIMConversationRuntimeSnapshot(): PersistedIMConversationRuntimeSnapshot | null {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(IM_CONVERSATION_PERSIST_KEY)
      ?? localStorage.getItem(IM_CONVERSATION_LEGACY_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedIMConversationRuntimeSnapshot>;
    if (
      typeof parsed !== "object"
      || !parsed
      || !Array.isArray(parsed.conversations)
      || !Array.isArray(parsed.runtimes)
    ) {
      return null;
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : IM_CONVERSATION_PERSIST_VERSION,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
      conversations: parsed.conversations
        .map((item) => sanitizeConversationStateRecord(item))
        .filter((item): item is PersistedIMConversationStateRecord => Boolean(item)),
      runtimes: parsed.runtimes
        .map((item) => sanitizeRuntimeRecord(item))
        .filter((item): item is PersistedIMRuntimeRecord => Boolean(item)),
    };
  } catch {
    return null;
  }
}

export function savePersistedIMConversationRuntimeSnapshot(
  snapshot: PersistedIMConversationRuntimeSnapshot,
): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(IM_CONVERSATION_PERSIST_KEY, JSON.stringify({
      ...snapshot,
      version: IM_CONVERSATION_PERSIST_VERSION,
      runtimes: snapshot.runtimes.map((runtime) => ({
        ...runtime,
        ...(runtime.collaborationSnapshot
          ? { collaborationSnapshot: cloneCollaborationSnapshot(runtime.collaborationSnapshot) }
          : {}),
      })),
    }));
    localStorage.removeItem(IM_CONVERSATION_LEGACY_PERSIST_KEY);
  } catch {
    // Ignore persistence failures for best-effort IM recovery.
  }
}

export function clearPersistedIMConversationRuntimeSnapshot(): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.removeItem(IM_CONVERSATION_PERSIST_KEY);
    localStorage.removeItem(IM_CONVERSATION_LEGACY_PERSIST_KEY);
  } catch {
    // Ignore best-effort clear failures.
  }
}
