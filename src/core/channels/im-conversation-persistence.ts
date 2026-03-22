import type {
  DialogMessage,
  DialogRoomCompactionState,
  AgentCapabilities,
  ExecutionPolicy,
  MiddlewareOverrides,
  ThinkingLevel,
  ToolPolicy,
} from "@/core/agent/actor/types";
import {
  createEmptyCollaborationSnapshot,
  cloneCollaborationSnapshotForPersistence,
  sanitizeCollaborationSnapshot,
} from "@/core/collaboration/persistence";
import { cloneExecutionContract } from "@/core/collaboration/execution-contract";
import type {
  CollaborationSessionSnapshot,
  ExecutionContract,
} from "@/core/collaboration/types";
import { createLogger } from "@/core/logger";
import type { ChannelIncomingMessage, ChannelType } from "./types";

const IM_CONVERSATION_PERSIST_KEY = "mtools-im-conversation-runtime-v2";
const IM_CONVERSATION_LEGACY_PERSIST_KEY = "mtools-im-conversation-runtime-v1";
const IM_CONVERSATION_PERSIST_VERSION = 2;
const log = createLogger("IMConversationPersistence");

const PERSIST_FALLBACK_ATTEMPTS: Array<{
  label: string;
  maxDialogHistoryMessages?: number;
  maxActorSessionHistoryEntries?: number;
}> = [
  { label: "full-history" },
  { label: "dialog-600", maxDialogHistoryMessages: 600, maxActorSessionHistoryEntries: 24 },
  { label: "dialog-300", maxDialogHistoryMessages: 300, maxActorSessionHistoryEntries: 16 },
  { label: "dialog-120", maxDialogHistoryMessages: 120, maxActorSessionHistoryEntries: 8 },
];

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
  approvalState?: "awaiting_user" | "approved_ready";
  approvalInteractionId?: string;
  approvalMessageId?: string;
  approvalContract?: ExecutionContract;
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
  dialogRoomCompaction?: DialogRoomCompactionState;
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

function cloneDialogMessage(message: DialogMessage): DialogMessage {
  return {
    ...message,
    ...(message.images ? { images: [...message.images] } : {}),
    ...(message.attachments ? { attachments: message.attachments.map((item) => ({ ...item })) } : {}),
    ...(message.options ? { options: [...message.options] } : {}),
    ...(message.appliedMemoryPreview ? { appliedMemoryPreview: [...message.appliedMemoryPreview] } : {}),
    ...(message.appliedTranscriptPreview ? { appliedTranscriptPreview: [...message.appliedTranscriptPreview] } : {}),
    ...(message.approvalRequest
      ? {
          approvalRequest: {
            ...message.approvalRequest,
            ...(message.approvalRequest.details
              ? { details: message.approvalRequest.details.map((detail) => ({ ...detail })) }
              : {}),
            ...(message.approvalRequest.decisionOptions
              ? {
                  decisionOptions: message.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                }
              : {}),
          },
        }
      : {}),
  };
}

function clonePersistedPendingMessage(
  message: PersistedIMPendingMessage,
): PersistedIMPendingMessage {
  return {
    ...message,
    ...(message.images ? { images: [...message.images] } : {}),
    ...(message.attachments ? { attachments: message.attachments.map((item) => ({ ...item })) } : {}),
    ...(message.approvalContract ? { approvalContract: cloneExecutionContract(message.approvalContract) } : {}),
  };
}

function cloneDialogRoomCompaction(
  state: DialogRoomCompactionState,
): DialogRoomCompactionState {
  return {
    ...state,
    preservedIdentifiers: [...state.preservedIdentifiers],
    ...(state.triggerReasons ? { triggerReasons: [...state.triggerReasons] } : {}),
  };
}

function sanitizeDialogRoomCompaction(input: unknown): DialogRoomCompactionState | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<DialogRoomCompactionState>;
  if (
    typeof record.summary !== "string"
    || typeof record.compactedMessageCount !== "number"
    || typeof record.compactedSpawnedTaskCount !== "number"
    || typeof record.compactedArtifactCount !== "number"
    || !Array.isArray(record.preservedIdentifiers)
    || typeof record.updatedAt !== "number"
  ) {
    return undefined;
  }

  return {
    summary: record.summary,
    compactedMessageCount: record.compactedMessageCount,
    compactedSpawnedTaskCount: record.compactedSpawnedTaskCount,
    compactedArtifactCount: record.compactedArtifactCount,
    preservedIdentifiers: record.preservedIdentifiers
      .filter((item): item is string => typeof item === "string"),
    ...(Array.isArray(record.triggerReasons)
      ? {
          triggerReasons: record.triggerReasons
            .filter((item): item is string => typeof item === "string"),
        }
      : {}),
    ...(typeof record.memoryFlushNoteId === "string" ? { memoryFlushNoteId: record.memoryFlushNoteId } : {}),
    ...(typeof record.memoryConfirmedCount === "number" ? { memoryConfirmedCount: record.memoryConfirmedCount } : {}),
    ...(typeof record.memoryQueuedCount === "number" ? { memoryQueuedCount: record.memoryQueuedCount } : {}),
    updatedAt: record.updatedAt,
  };
}

function limitTail<T>(items: readonly T[] | undefined, maxEntries?: number): T[] | undefined {
  if (!items?.length) return undefined;
  if (typeof maxEntries !== "number" || maxEntries <= 0 || items.length <= maxEntries) {
    return [...items];
  }
  return [...items.slice(-maxEntries)];
}

function safeJSONStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === "function") {
      return undefined;
    }
    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return undefined;
      }
      seen.add(currentValue);
    }
    return currentValue;
  });
}

function buildPersistableCollaborationSnapshot(
  snapshot: CollaborationSessionSnapshot | undefined,
): CollaborationSessionSnapshot | undefined {
  if (!snapshot) return undefined;
  const persistedSnapshot = cloneCollaborationSnapshotForPersistence(snapshot);
  // IM persistence stores visible transcript in dialogHistory to avoid duplicating
  // the same history inside collaborationSnapshot and blowing the localStorage quota.
  persistedSnapshot.dialogMessages = [];
  return persistedSnapshot;
}

function buildPersistableRuntimeRecord(
  runtime: PersistedIMRuntimeRecord,
  attempt?: {
    maxDialogHistoryMessages?: number;
    maxActorSessionHistoryEntries?: number;
  },
): PersistedIMRuntimeRecord {
  const snapshotDialogHistory = runtime.collaborationSnapshot?.dialogMessages ?? [];
  const effectiveDialogHistory = snapshotDialogHistory.length > runtime.dialogHistory.length
    ? snapshotDialogHistory
    : runtime.dialogHistory;
  const limitedDialogHistory = limitTail(
    effectiveDialogHistory.map((message) => cloneDialogMessage(message)),
    attempt?.maxDialogHistoryMessages,
  ) ?? [];
  const persistedCollaborationSnapshot = buildPersistableCollaborationSnapshot(runtime.collaborationSnapshot);

  return {
    ...runtime,
    ...(runtime.lastInput ? { lastInput: clonePersistedPendingMessage(runtime.lastInput) } : {}),
    ...(runtime.queuedMessages?.length
      ? {
          queuedMessages: runtime.queuedMessages.map((message) => clonePersistedPendingMessage(message)),
        }
        : {}),
    dialogHistory: limitedDialogHistory,
    ...(runtime.dialogRoomCompaction
      ? { dialogRoomCompaction: cloneDialogRoomCompaction(runtime.dialogRoomCompaction) }
      : {}),
    actorConfigs: runtime.actorConfigs.map((config) => ({
      ...config,
      ...(config.sessionHistory
        ? {
            sessionHistory: limitTail(config.sessionHistory, attempt?.maxActorSessionHistoryEntries),
          }
        : {}),
    })),
    ...(persistedCollaborationSnapshot
      ? { collaborationSnapshot: persistedCollaborationSnapshot }
      : {}),
  };
}

function buildPersistableSnapshot(
  snapshot: PersistedIMConversationRuntimeSnapshot,
  attempt?: {
    maxDialogHistoryMessages?: number;
    maxActorSessionHistoryEntries?: number;
  },
): PersistedIMConversationRuntimeSnapshot {
  return {
    version: IM_CONVERSATION_PERSIST_VERSION,
    savedAt: snapshot.savedAt,
    conversations: snapshot.conversations.map((conversation) => ({ ...conversation })),
    runtimes: snapshot.runtimes.map((runtime) => buildPersistableRuntimeRecord(runtime, attempt)),
  };
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
    ...(record.approvalState === "awaiting_user" || record.approvalState === "approved_ready"
      ? { approvalState: record.approvalState }
      : {}),
    ...(typeof record.approvalInteractionId === "string" ? { approvalInteractionId: record.approvalInteractionId } : {}),
    ...(typeof record.approvalMessageId === "string" ? { approvalMessageId: record.approvalMessageId } : {}),
    ...(record.approvalContract && typeof record.approvalContract === "object"
      ? (() => {
          const sanitized = sanitizeCollaborationSnapshot({
            ...createEmptyCollaborationSnapshot("im_conversation"),
            activeContract: record.approvalContract,
          }, "im_conversation");
          return sanitized.activeContract
            ? { approvalContract: cloneExecutionContract(sanitized.activeContract) }
            : {};
        })()
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
    ...(sanitizeDialogRoomCompaction(record.dialogRoomCompaction)
      ? { dialogRoomCompaction: sanitizeDialogRoomCompaction(record.dialogRoomCompaction) }
      : {}),
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
  } catch (error) {
    log.warn("Failed to load persisted IM conversation snapshot", error);
    return null;
  }
}

export function savePersistedIMConversationRuntimeSnapshot(
  snapshot: PersistedIMConversationRuntimeSnapshot,
): void {
  if (!canUseLocalStorage()) return;
  let lastError: unknown = null;
  for (const [index, attempt] of PERSIST_FALLBACK_ATTEMPTS.entries()) {
    try {
      const payload = safeJSONStringify(buildPersistableSnapshot(snapshot, attempt));
      localStorage.setItem(IM_CONVERSATION_PERSIST_KEY, payload);
      localStorage.removeItem(IM_CONVERSATION_LEGACY_PERSIST_KEY);
      if (index > 0) {
        log.warn("Persisted IM conversation snapshot with compacted history window", {
          attempt: attempt.label,
          payloadBytes: payload.length,
        });
      }
      return;
    } catch (error) {
      lastError = error;
      if (index < PERSIST_FALLBACK_ATTEMPTS.length - 1) {
        log.warn("IM conversation snapshot exceeded storage budget, retrying with compaction", {
          failedAttempt: attempt.label,
          nextAttempt: PERSIST_FALLBACK_ATTEMPTS[index + 1]?.label,
          runtimeCount: snapshot.runtimes.length,
        });
      }
    }
  }

  log.error("Failed to persist IM conversation snapshot after fallback compaction", {
    error: lastError,
    runtimeCount: snapshot.runtimes.length,
    conversationCount: snapshot.conversations.length,
  });
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
