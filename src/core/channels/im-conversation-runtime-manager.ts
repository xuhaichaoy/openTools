import { ActorSystem } from "@/core/agent/actor/actor-system";
import {
  buildDefaultDialogActorConfig,
  spawnDefaultDialogActors,
} from "@/core/agent/actor/default-dialog-actors";
import { ensureDialogRoomCompaction } from "@/core/agent/actor/dialog-context-pressure";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import {
  registerRuntimeAbortHandler,
  unregisterRuntimeAbortHandler,
  useRuntimeStateStore,
} from "@/core/agent/context-runtime/runtime-state";
import { buildRuntimeSessionCompactionPreview } from "@/core/agent/context-runtime/runtime-session-compaction";
import { useToolTrustStore } from "@/store/command-allowlist-store";
import { CollaborationSessionController } from "@/core/collaboration/session-controller";
import { assessExecutionContractApproval } from "@/core/collaboration/contract-approval";
import { cloneCollaborationSnapshotForPersistence } from "@/core/collaboration/persistence";
import {
  buildActorRosterHash,
  buildInputHash,
  buildOpenExecutionContractDraft,
  cloneExecutionContract,
  doesExecutionContractMatchActorRoster,
  sealExecutionContract,
} from "@/core/collaboration/execution-contract";
import { createLogger } from "@/core/logger";
import {
  useIMConversationRuntimeStore,
  type IMConversationCompactionPreview,
  type IMConversationRuntimeStatus,
  type IMConversationSessionPreview,
  type IMConversationSnapshot,
  type IMConversationTopicSnapshot,
} from "@/store/im-conversation-runtime-store";
import type { DialogMessage } from "@/core/agent/actor/types";
import type {
  CollaborationSessionSnapshot,
  ExecutionContract,
  ExecutionContractDraft,
} from "@/core/collaboration/types";
import type { IMConversationProgressEvent } from "./channel-progress-emitter";
import type { ChannelIncomingMessage, ChannelType } from "./types";
import {
  clearPersistedIMConversationRuntimeSnapshot,
  loadPersistedIMConversationRuntimeSnapshot,
  savePersistedIMConversationRuntimeSnapshot,
  type PersistedIMActorConfig,
  type PersistedIMConversationRuntimeSnapshot,
  type PersistedIMRuntimeRecord,
} from "./im-conversation-persistence";
import {
  deriveShareableIMMediaFromText,
  sanitizeIMReplyTextForMedia,
  shouldExplicitlyDeliverMediaToIM,
} from "./im-media-delivery";
import { resolveChannelOutgoingMedia } from "./channel-outbound-media";

const log = createLogger("IMConversationRuntime");
const MAX_PERSISTED_ACTOR_SESSION_HISTORY = 24;
const IM_RUNTIME_IDLE_COMPACTION_DELAY_MS = 1_500;

interface PendingIMMessage {
  messageId: string;
  text: string;
  briefContent: string;
  timestamp: number;
  channelType: ChannelType;
  conversationType: ChannelIncomingMessage["conversationType"];
  displayLabel: string;
  displayDetail: string;
  images?: string[];
  attachments?: ChannelIncomingMessage["attachments"];
  approvalState?: "awaiting_user" | "approved_ready";
  approvalInteractionId?: string;
  approvalMessageId?: string;
  approvalContract?: ExecutionContract;
}

interface RuntimeActivitySnapshot {
  pendingApprovals: number;
  pendingReplies: number;
  runningTasks: number;
  activeActors: number;
}

interface RuntimeApprovalPreview {
  approvalStatus?: "none" | "awaiting_user" | "approved" | "rejected";
  approvalSummary?: string;
  approvalRiskLabel?: string;
  pendingApprovalReason?: string;
}

interface IMConversationRuntime {
  key: string;
  channelId: string;
  channelType: ChannelType;
  conversationId: string;
  conversationType: ChannelIncomingMessage["conversationType"];
  topicId: string;
  system: ActorSystem;
  controller: CollaborationSessionController;
  queue: PendingIMMessage[];
  status: IMConversationRuntimeStatus;
  lastInput?: PendingIMMessage;
  updatedAt: number;
  inFlight: boolean;
  pumping: boolean;
  settleTimer: ReturnType<typeof setTimeout> | null;
  idleCompactionTimer: ReturnType<typeof setTimeout> | null;
  idleCompactionScheduleKey: string | null;
  forwardedInteractionMessageIds: Set<string>;
  forwardedResultMessageIds: Set<string>;
  unsubscribe: () => void;
}

interface IMConversationState {
  channelType?: ChannelType;
  conversationType?: ChannelIncomingMessage["conversationType"];
  activeTopicId: string;
  nextTopicSeq: number;
  updatedAt: number;
}

interface IMCommandResult {
  handled: boolean;
  replyText?: string;
  queued?: boolean;
  runtimeKey?: string;
  sessionId?: string;
}

interface IMConversationRuntimeManagerOptions {
  onReply: (params: {
    channelId: string;
    conversationId: string;
    text: string;
    messageId?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    images?: string[];
    attachments?: { path: string; fileName?: string }[];
  }) => Promise<void>;
  onProgress?: (event: IMConversationProgressEvent) => Promise<void>;
  onFinalized?: (params: {
    channelId: string;
    conversationId: string;
    topicId: string;
  }) => void;
}

function getChannelDisplayLabel(channelType: ChannelType): string {
  return channelType === "dingtalk" ? "钉钉会话" : "飞书会话";
}

function getConversationDisplayDetail(
  channelType: ChannelType,
  conversationType: ChannelIncomingMessage["conversationType"],
): string {
  const platform = channelType === "dingtalk" ? "钉钉" : "飞书";
  const conversation = conversationType === "group" ? "群聊" : "私聊";
  return `${platform} · ${conversation}`;
}

function buildRuntimeKey(channelId: string, conversationId: string, topicId: string): string {
  return [channelId.trim(), conversationId.trim(), topicId.trim()].join("::");
}

function cloneDialogMessage(message: DialogMessage): DialogMessage {
  return {
    ...message,
    ...(message.images ? { images: [...message.images] } : {}),
    ...(message.attachments ? { attachments: message.attachments.map((a) => ({ ...a })) } : {}),
    ...(message.options ? { options: [...message.options] } : {}),
    ...(message.appliedMemoryPreview ? { appliedMemoryPreview: [...message.appliedMemoryPreview] } : {}),
    ...(message.appliedTranscriptPreview ? { appliedTranscriptPreview: [...message.appliedTranscriptPreview] } : {}),
    ...(message.approvalRequest
      ? {
          approvalRequest: {
            ...message.approvalRequest,
            ...(message.approvalRequest.details
              ? {
                  details: message.approvalRequest.details.map((detail) => ({ ...detail })),
                }
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

function mergeUniqueStrings(...groups: Array<readonly string[] | undefined>): string[] | undefined {
  const result = [...new Set(groups.flatMap((group) => group ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))];
  return result.length ? result : undefined;
}

function mergeUniqueAttachments(
  ...groups: Array<ReadonlyArray<{ path: string; fileName?: string }> | undefined>
): Array<{ path: string; fileName?: string }> | undefined {
  const merged = new Map<string, { path: string; fileName?: string }>();
  for (const group of groups) {
    for (const item of group ?? []) {
      const path = String(item.path ?? "").trim();
      if (!path) continue;
      merged.set(path, {
        path,
        ...(item.fileName ? { fileName: item.fileName } : {}),
      });
    }
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function clonePendingIMMessage(message?: PendingIMMessage): PendingIMMessage | undefined {
  if (!message) return undefined;
  return {
    ...message,
    ...(message.images ? { images: [...message.images] } : {}),
    ...(message.attachments ? { attachments: message.attachments.map((item) => ({ ...item })) } : {}),
    ...(message.approvalContract ? { approvalContract: cloneExecutionContract(message.approvalContract) } : {}),
  };
}

function mapTrustLevelToContractTrustMode(
  trustLevel: ReturnType<typeof useToolTrustStore.getState>["trustLevel"],
): "strict_manual" | "auto_review" | "full_auto" {
  switch (trustLevel) {
    case "always_ask":
      return "strict_manual";
    case "auto_approve":
      return "full_auto";
    default:
      return "auto_review";
  }
}

function contractRiskLabel(risk: ReturnType<typeof assessExecutionContractApproval>["risk"]): string {
  switch (risk) {
    case "safe":
      return "安全";
    case "low":
      return "低风险";
    case "medium":
      return "中风险";
    case "high":
      return "高风险";
    default:
      return "不确定";
  }
}

function mergeUniqueLines(lines: Array<string | undefined | null>): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const normalized = String(line ?? "").trim();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

function clipPreviewText(value: string | undefined | null, maxLength = 120): string | undefined {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function parseContractApprovalReply(content: string): "allow" | "deny" | "unknown" {
  const normalized = String(content ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (/^(拒绝|拒绝执行|reject|deny|不允许|不要|不行|取消|停止|no|n)$/i.test(normalized)) {
    return "deny";
  }
  if (/^(允许|允许执行|allow|approve|同意|可以|确认|继续|好的|ok|yes|y)$/i.test(normalized)) {
    return "allow";
  }
  if (/(拒绝|deny|reject|取消|停止|不要|不允许)/i.test(normalized)) {
    return "deny";
  }
  if (/(允许|allow|approve|同意|可以|确认|继续)/i.test(normalized)) {
    return "allow";
  }
  return "unknown";
}

function buildIMRuntimeIdleCompactionScheduleKey(params: {
  runtimeKey: string;
  dialogHistoryCount: number;
  artifactCount: number;
  spawnedTaskCount: number;
  queuedMessageCount: number;
  pendingInteractionCount: number;
  contractState: string | null;
  dialogRoomCompactionUpdatedAt?: number | null;
}): string {
  return [
    params.runtimeKey,
    params.dialogHistoryCount,
    params.artifactCount,
    params.spawnedTaskCount,
    params.queuedMessageCount,
    params.pendingInteractionCount,
    params.contractState ?? "",
    params.dialogRoomCompactionUpdatedAt ?? 0,
  ].join("::");
}

export class IMConversationRuntimeManager {
  private readonly options: IMConversationRuntimeManagerOptions;
  private runtimes = new Map<string, IMConversationRuntime>();
  private conversations = new Map<string, IMConversationState>();

  constructor(options: IMConversationRuntimeManagerOptions) {
    this.options = options;
    this.hydratePersistedState();
  }

  async handleIncoming(params: {
    channelId: string;
    channelType: ChannelType;
    msg: ChannelIncomingMessage;
  }): Promise<IMCommandResult> {
    const conversationState = this.getConversationState(
      params.channelId,
      params.msg.conversationId,
      {
        channelType: params.channelType,
        conversationType: params.msg.conversationType,
      },
    );
    const command = this.parseCommand(params.msg.text);
    if (command) {
      return this.handleCommand({
        channelId: params.channelId,
        conversationId: params.msg.conversationId,
        command,
        state: conversationState,
      });
    }

    const runtime = this.getOrCreateRuntime({
      channelId: params.channelId,
      channelType: params.channelType,
      conversationId: params.msg.conversationId,
      conversationType: params.msg.conversationType,
      topicId: conversationState.activeTopicId,
    });
    const pending = this.buildPendingMessage(params.channelType, params.msg);

    runtime.conversationType = params.msg.conversationType;
    runtime.updatedAt = Date.now();
    this.clearSettledRefresh(runtime);
    this.clearIdleCompaction(runtime, { clearScheduleKey: true });

    if (this.shouldDispatchImmediately(runtime)) {
      await this.dispatch(runtime, pending);
      return {
        handled: false,
        queued: false,
        runtimeKey: runtime.key,
        sessionId: runtime.system.sessionId,
      };
    }

    runtime.queue.push(pending);
    runtime.status = "queued";
    runtime.updatedAt = Date.now();
    this.emitProgress({
      channelId: runtime.channelId,
      channelType: runtime.channelType,
      conversationId: runtime.conversationId,
      topicId: runtime.topicId,
      messageId: pending.messageId,
      kind: "queued",
      queueLength: runtime.queue.length,
    });
    this.refreshRuntime(runtime);
    this.scheduleSettledRefresh(runtime);
    return {
      handled: false,
      queued: true,
      runtimeKey: runtime.key,
      sessionId: runtime.system.sessionId,
    };
  }

  disposeChannel(channelId: string): void {
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.channelId !== channelId) continue;
      this.disposeRuntime(runtime);
    }
    for (const [key] of this.conversations) {
      if (key.startsWith(`${channelId.trim()}::`)) {
        this.conversations.delete(key);
      }
    }
    this.syncConversationSnapshots();
  }

  dispose(): void {
    for (const runtime of [...this.runtimes.values()]) {
      this.disposeRuntime(runtime, { syncPersistence: false });
    }
    this.runtimes.clear();
    this.conversations.clear();
    useIMConversationRuntimeStore.getState().reset();
  }

  getConversationSnapshots(): IMConversationSnapshot[] {
    return useIMConversationRuntimeStore.getState().conversations;
  }

  clearConversation(channelId: string, conversationId: string): string[] {
    const normalizedChannelId = channelId.trim();
    const normalizedConversationId = conversationId.trim();
    if (!normalizedChannelId || !normalizedConversationId) return [];

    let removed = false;
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.channelId !== normalizedChannelId || runtime.conversationId !== normalizedConversationId) continue;
      this.disposeRuntime(runtime);
      removed = true;
    }

    if (this.conversations.delete(this.buildConversationKey(normalizedChannelId, normalizedConversationId))) {
      removed = true;
    }

    if (removed) {
      this.syncConversationSnapshots();
      return [normalizedConversationId];
    }
    return [];
  }

  clearChannelConversations(
    channelId: string,
    options?: { keepConversationId?: string | null },
  ): string[] {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) return [];
    const keepConversationId = options?.keepConversationId?.trim() || "";
    const removedConversationIds = new Set<string>();

    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.channelId !== normalizedChannelId) continue;
      if (keepConversationId && runtime.conversationId === keepConversationId) continue;
      removedConversationIds.add(runtime.conversationId);
      this.disposeRuntime(runtime);
    }

    for (const key of [...this.conversations.keys()]) {
      if (!key.startsWith(`${normalizedChannelId}::`)) continue;
      const conversationId = key.slice(normalizedChannelId.length + 2);
      if (keepConversationId && conversationId === keepConversationId) continue;
      if (this.conversations.delete(key)) {
        removedConversationIds.add(conversationId);
      }
    }

    if (removedConversationIds.size > 0) {
      this.syncConversationSnapshots();
    }

    return [...removedConversationIds];
  }

  createNewTopic(channelId: string, conversationId: string): string {
    return this.handleCommand({
      channelId,
      conversationId,
      command: { name: "new", raw: "/new" },
      state: this.getConversationState(channelId, conversationId),
    }).replyText ?? "已创建新话题。";
  }

  resetActiveTopic(channelId: string, conversationId: string): string {
    return this.handleCommand({
      channelId,
      conversationId,
      command: { name: "reset", raw: "/reset" },
      state: this.getConversationState(channelId, conversationId),
    }).replyText ?? "已重置当前话题。";
  }

  stopActiveTopic(channelId: string, conversationId: string): string {
    return this.handleCommand({
      channelId,
      conversationId,
      command: { name: "stop", raw: "/stop" },
      state: this.getConversationState(channelId, conversationId),
    }).replyText ?? "已停止当前话题。";
  }

  getConversationStatus(channelId: string, conversationId: string): string {
    return this.handleCommand({
      channelId,
      conversationId,
      command: { name: "status", raw: "/status" },
      state: this.getConversationState(channelId, conversationId),
    }).replyText ?? "当前没有可用状态。";
  }

  recordOutboundReminder(
    channelId: string,
    conversationId: string,
    text: string,
    channelType?: ChannelType,
  ): boolean {
    const normalizedChannelId = channelId.trim();
    const normalizedConversationId = conversationId.trim();
    const normalizedText = text.trim();
    if (!normalizedChannelId || !normalizedConversationId || !normalizedText) {
      return false;
    }

    const state = this.getConversationState(normalizedChannelId, normalizedConversationId, {
      channelType,
    });
    const runtime = this.getConversationRuntimes(normalizedChannelId, normalizedConversationId)[0]
      ?? (state.channelType
        ? this.getOrCreateRuntime({
            channelId: normalizedChannelId,
            channelType: state.channelType,
            conversationId: normalizedConversationId,
            conversationType: state.conversationType ?? "private",
            topicId: state.activeTopicId,
          })
        : null);
    if (!runtime) {
      return false;
    }

    runtime.updatedAt = Date.now();
    this.clearIdleCompaction(runtime, { clearScheduleKey: true });
    runtime.system.publishSystemNotice(normalizedText, { from: "scheduler" });
    this.refreshRuntime(runtime);
    this.scheduleSettledRefresh(runtime);
    return true;
  }

  private getOrCreateRuntime(params: {
    channelId: string;
    channelType: ChannelType;
    conversationId: string;
    conversationType: ChannelIncomingMessage["conversationType"];
    topicId?: string;
  }): IMConversationRuntime {
    const topicId = params.topicId?.trim() || "default";
    const key = buildRuntimeKey(params.channelId, params.conversationId, topicId);
    const existing = this.runtimes.get(key);
    if (existing) return existing;

    const runtime = this.createRuntime({
      ...params,
      topicId,
    });
    this.runtimes.set(key, runtime);
    this.refreshRuntime(runtime);
    return runtime;
  }

  private createRuntime(params: {
    channelId: string;
    channelType: ChannelType;
    conversationId: string;
    conversationType: ChannelIncomingMessage["conversationType"];
    topicId: string;
  }, restored?: PersistedIMRuntimeRecord): IMConversationRuntime {
    const system = new ActorSystem();
    if (restored?.sessionId) {
      (system as unknown as { sessionId: string }).sessionId = restored.sessionId;
    }

    if (restored?.actorConfigs?.length) {
      this.restoreRuntimeActors(system, params.channelType, restored.actorConfigs);
    } else {
      spawnDefaultDialogActors(system, {
        mode: "external_im",
        channelType: params.channelType,
      });
    }

    const restoredDialogHistory = restored?.collaborationSnapshot?.dialogMessages?.length
      ? restored.collaborationSnapshot.dialogMessages
      : restored?.dialogHistory;
    if (restoredDialogHistory?.length) {
      system.restoreDialogHistory(restoredDialogHistory.map((message) => cloneDialogMessage(message)));
    }
    if (restored?.dialogRoomCompaction) {
      system.setDialogRoomCompaction(restored.dialogRoomCompaction);
    }
    const controller = new CollaborationSessionController(system, {
      surface: "im_conversation",
      actorRosterProvider: () => system.getAll().map((actor) => ({
        actorId: actor.id,
        roleName: actor.role.name,
        capabilities: actor.capabilities?.tags,
        executionPolicy: actor.executionPolicy,
        workspace: actor.workspace,
      })),
    });
    if (restored?.collaborationSnapshot) {
      controller.restore(restored.collaborationSnapshot);
    } else {
      controller.snapshot();
    }

    const runtime: IMConversationRuntime = {
      key: buildRuntimeKey(params.channelId, params.conversationId, params.topicId),
      channelId: params.channelId,
      channelType: params.channelType,
      conversationId: params.conversationId,
      conversationType: params.conversationType,
      topicId: params.topicId,
      system,
      controller,
      queue: restored?.queuedMessages
        ?.map((message) => clonePendingIMMessage(message as PendingIMMessage))
        .filter((message): message is PendingIMMessage => Boolean(message))
        ?? [],
      status: restored ? "idle" : "idle",
      ...(restored?.lastInput ? { lastInput: clonePendingIMMessage(restored.lastInput as PendingIMMessage) } : {}),
      updatedAt: restored?.updatedAt ?? Date.now(),
      inFlight: false,
      pumping: false,
      settleTimer: null,
      idleCompactionTimer: null,
      idleCompactionScheduleKey: null,
      forwardedInteractionMessageIds: new Set<string>(),
      forwardedResultMessageIds: new Set<string>(),
      unsubscribe: () => {},
    };

    this.attachRuntimeSubscription(runtime);
    return runtime;
  }

  private restoreRuntimeActors(
    system: ActorSystem,
    channelType: ChannelType,
    actorConfigs: PersistedIMActorConfig[],
  ): void {
    for (const config of actorConfigs) {
      const baseConfig = buildDefaultDialogActorConfig(config.roleName, {
        mode: "external_im",
        channelType,
      });
      system.spawn({
        id: config.id,
        role: {
          ...baseConfig.role,
          name: config.roleName,
          systemPrompt: config.systemPrompt ?? baseConfig.role.systemPrompt,
        },
        ...(config.capabilities ? { capabilities: config.capabilities } : {}),
        ...(config.model ? { modelOverride: config.model } : {}),
        maxIterations: typeof config.maxIterations === "number" ? config.maxIterations : 40,
        ...(config.toolPolicy ? { toolPolicy: config.toolPolicy } : baseConfig.toolPolicy ? { toolPolicy: baseConfig.toolPolicy } : {}),
        executionPolicy: config.executionPolicy ?? baseConfig.executionPolicy,
        middlewareOverrides: config.middlewareOverrides ?? baseConfig.middlewareOverrides,
        ...(config.workspace ? { workspace: config.workspace } : {}),
        ...(typeof config.timeoutSeconds === "number" ? { timeoutSeconds: config.timeoutSeconds } : {}),
        ...(typeof config.contextTokens === "number" ? { contextTokens: config.contextTokens } : {}),
        ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
      });
      if (config.sessionHistory?.length) {
        system.restoreActorSessionHistory(config.id, config.sessionHistory);
      }
    }
  }

  private attachRuntimeSubscription(runtime: IMConversationRuntime): void {
    runtime.unsubscribe = runtime.system.onEvent((event) => {
      if ("kind" in event) {
        const dialogEvent = event as DialogMessage;
        const latestDialogEvent = this.getLatestDialogMessage(runtime, dialogEvent.id) ?? dialogEvent;

        if (this.shouldForwardInteractionPrompt(runtime, latestDialogEvent)) {
          const interactionText = this.buildExternalInteractionPrompt(runtime, latestDialogEvent);
          if (interactionText) {
            runtime.forwardedInteractionMessageIds.add(latestDialogEvent.id);
            void this.options.onReply({
              channelId: runtime.channelId,
              conversationId: runtime.conversationId,
              text: interactionText,
              messageId: runtime.lastInput?.messageId,
            }).catch((error) => {
              log.error("Failed to forward IM interaction prompt", error);
            });
          }
        }

        if (this.shouldForwardFinalAgentResult(runtime, latestDialogEvent)) {
          const originalText = String(latestDialogEvent.content || "").slice(0, 2000).trim();
          const shouldDeliverMedia = shouldExplicitlyDeliverMediaToIM(runtime.lastInput?.text);
          const derivedMedia = shouldDeliverMedia
            ? deriveShareableIMMediaFromText(originalText)
            : {};
          const outgoingMedia = shouldDeliverMedia
            ? resolveChannelOutgoingMedia({
                mediaUrls: derivedMedia.mediaUrls,
                images: latestDialogEvent.images,
                attachments: latestDialogEvent.attachments,
              })
            : {};
          const text = shouldDeliverMedia && outgoingMedia.mediaUrls?.length
            ? sanitizeIMReplyTextForMedia(originalText)
            : originalText;
          const hasMedia = Boolean(outgoingMedia.mediaUrls?.length);
          
          if (text || hasMedia) {
            log.info("Forwarding agent reply to IM", { 
              conversationId: runtime.conversationId,
              hasText: !!text,
              mediaCount: outgoingMedia.mediaUrls?.length || 0,
              imageCount: outgoingMedia.images?.length || 0,
              attachmentCount: outgoingMedia.attachments?.length || 0,
              shouldDeliverMedia,
            });

            runtime.forwardedResultMessageIds.add(latestDialogEvent.id);
            this.options.onFinalized?.({
              channelId: runtime.channelId,
              conversationId: runtime.conversationId,
              topicId: runtime.topicId,
            });
            void this.options.onReply({
              channelId: runtime.channelId,
              conversationId: runtime.conversationId,
              text,
              messageId: runtime.lastInput?.messageId,
              mediaUrl: outgoingMedia.mediaUrl,
              mediaUrls: outgoingMedia.mediaUrls,
              images: outgoingMedia.images,
              attachments: outgoingMedia.attachments,
            }).catch((error) => {
              log.error("Failed to send IM runtime reply", error);
            });
          }
        }
      }
      if ("type" in event) {
        const actorEvent = event as { type?: string; detail?: unknown };
        if (actorEvent.type === "spawned_task_started") {
          this.emitProgress({
            channelId: runtime.channelId,
            channelType: runtime.channelType,
            conversationId: runtime.conversationId,
            topicId: runtime.topicId,
            messageId: runtime.lastInput?.messageId,
            kind: "running",
            detail: "已进入多步骤执行",
          });
        } else if (actorEvent.type === "spawned_task_running") {
          const detail = actorEvent.detail as { message?: string; stepType?: string } | undefined;
          const progressDetail = this.getProgressDetailFromEvent(detail);
          if (progressDetail) {
            this.emitProgress({
              channelId: runtime.channelId,
              channelType: runtime.channelType,
              conversationId: runtime.conversationId,
              topicId: runtime.topicId,
              messageId: runtime.lastInput?.messageId,
              kind: "running",
              detail: progressDetail,
            });
          }
        }
      }
      this.refreshRuntime(runtime);
      this.scheduleSettledRefresh(runtime);
    });
  }

  private buildPendingMessage(
    channelType: ChannelType,
    msg: ChannelIncomingMessage,
  ): PendingIMMessage {
    return {
      messageId: msg.messageId,
      text: msg.text,
      briefContent: `[IM:${msg.senderName}] ${msg.text.slice(0, 40)}`,
      timestamp: msg.timestamp || Date.now(),
      channelType,
      conversationType: msg.conversationType,
      displayLabel: getChannelDisplayLabel(channelType),
      displayDetail: getConversationDisplayDetail(channelType, msg.conversationType),
      images: msg.images,
      attachments: msg.attachments,
    };
  }

  private getCollaborationSnapshot(runtime: IMConversationRuntime): CollaborationSessionSnapshot {
    return runtime.controller.snapshot();
  }

  private buildContractApprovalActors(runtime: IMConversationRuntime) {
    return runtime.system.getAll().map((actor) => ({
      id: actor.id,
      roleName: actor.role.name,
      executionPolicy: actor.executionPolicy,
    }));
  }

  private buildContractActorRoster(runtime: IMConversationRuntime) {
    return runtime.system.getAll().map((actor) => ({
      actorId: actor.id,
      roleName: actor.role.name,
      capabilities: actor.capabilities?.tags,
      executionPolicy: actor.executionPolicy,
      workspace: actor.workspace,
    }));
  }

  private buildIMExecutionContractDraft(
    runtime: IMConversationRuntime,
    pending: PendingIMMessage,
    snapshot: CollaborationSessionSnapshot,
  ): ExecutionContractDraft {
    const actors = runtime.system.getAll();
    const actorIds = actors.map((actor) => actor.id);
    const coordinatorId = runtime.system.getCoordinatorId() ?? actors[0]?.id;
    const baseDraft = buildOpenExecutionContractDraft({
      surface: "im_conversation",
      executionStrategy:
        snapshot.activeContract?.state === "sealed" || snapshot.activeContract?.state === "active"
          ? snapshot.activeContract.executionStrategy
          : "coordinator",
      actorIds,
      coordinatorActorId: coordinatorId,
      summary: pending.briefContent || pending.text.slice(0, 140),
    });
    const actorRoster = this.buildContractActorRoster(runtime);
    const input = {
      content: pending.text,
      briefContent: pending.briefContent,
      ...(pending.images?.length ? { images: pending.images } : {}),
    };
    const coordinatorPolicy = actors.find((actor) => actor.id === coordinatorId)?.executionPolicy;
    const accessMode = coordinatorPolicy?.accessMode ?? "read_only";

    return {
      ...baseDraft,
      summary: pending.briefContent || pending.text.slice(0, 140),
      input,
      actorRoster,
      inputHash: buildInputHash(input),
      actorRosterHash: buildActorRosterHash(actorRoster),
      executionPolicy: {
        accessMode,
        approvalMode: accessMode === "full_access" ? "strict" : "normal",
      },
    };
  }

  private buildExternalContractApprovalPrompt(params: {
    runtime: IMConversationRuntime;
    pending: PendingIMMessage;
    contract: ExecutionContract;
    assessment: ReturnType<typeof assessExecutionContractApproval>;
    clarifyOnly?: boolean;
  }): string {
    if (params.clarifyOnly) {
      return [
        "请确认是否允许本轮协作继续执行。",
        "请直接回复“允许”或“拒绝”。",
      ].join("\n\n");
    }

    const lines = mergeUniqueLines([
      `风险级别：${contractRiskLabel(params.assessment.risk)}`,
      params.assessment.reason,
      ...params.assessment.permissions,
      ...params.assessment.notes,
    ]);

    return [
      `当前消息准备进入协作执行：${params.pending.briefContent || params.pending.text.slice(0, 80)}`,
      lines.join("\n"),
      "请直接回复“允许”或“拒绝”。",
    ].join("\n\n");
  }

  private buildRuntimeApprovalPreview(
    runtime: IMConversationRuntime,
    snapshot: CollaborationSessionSnapshot,
  ): RuntimeApprovalPreview {
    const pendingApproval = snapshot.pendingInteractions.find(
      (interaction) => interaction.status === "pending" && interaction.type === "approval",
    );
    if (!pendingApproval) {
      return {
        approvalStatus: "none",
      };
    }

    const queuedApprovalMessage = this.findQueuedApprovalMessage(
      runtime,
      pendingApproval.messageId,
      pendingApproval.id,
    );
    if (queuedApprovalMessage?.approvalContract) {
      const assessment = assessExecutionContractApproval(
        queuedApprovalMessage.approvalContract,
        this.buildContractApprovalActors(runtime),
        {
          trustMode: mapTrustLevelToContractTrustMode(useToolTrustStore.getState().trustLevel),
        },
      );
      return {
        approvalStatus: "awaiting_user",
        approvalSummary: `待确认任务：${clipPreviewText(
          queuedApprovalMessage.approvalContract.summary
            || queuedApprovalMessage.briefContent
            || queuedApprovalMessage.text,
          96,
        )}`,
        approvalRiskLabel: contractRiskLabel(assessment.risk),
        pendingApprovalReason: clipPreviewText(assessment.reason, 140),
      };
    }

    const approvalRequest = pendingApproval.approvalRequest
      ?? this.getLatestDialogMessage(runtime, pendingApproval.messageId)?.approvalRequest;
    if (approvalRequest) {
      const approvalSummary = clipPreviewText(
        approvalRequest.title || approvalRequest.summary,
        96,
      );
      const pendingApprovalReason = clipPreviewText(
        mergeUniqueLines([
          approvalRequest.summary !== approvalRequest.title ? approvalRequest.summary : undefined,
          approvalRequest.riskDescription,
        ]).join(" · "),
        140,
      );
      return {
        approvalStatus: "awaiting_user",
        approvalSummary: approvalSummary || "当前操作等待确认",
        ...(pendingApprovalReason ? { pendingApprovalReason } : {}),
      };
    }

    return {
      approvalStatus: "awaiting_user",
      approvalSummary: clipPreviewText(
        `待确认：${this.getLatestDialogMessage(runtime, pendingApproval.messageId)?.content || pendingApproval.question}`,
        96,
      ) || "当前操作等待确认",
    };
  }

  private buildRuntimeCompactionPreview(runtime: IMConversationRuntime): IMConversationCompactionPreview {
    return {
      ...buildRuntimeSessionCompactionPreview(runtime.system.getDialogRoomCompaction()),
    };
  }

  private findQueuedApprovalMessage(
    runtime: IMConversationRuntime,
    interactionMessageId?: string | null,
    interactionId?: string | null,
  ): PendingIMMessage | null {
    return runtime.queue.find((item) => {
      if (item.approvalState !== "awaiting_user") return false;
      if (interactionMessageId && item.approvalMessageId === interactionMessageId) return true;
      if (interactionId && item.approvalInteractionId === interactionId) return true;
      return false;
    }) ?? null;
  }

  private removeQueuedApprovalMessage(runtime: IMConversationRuntime, target: PendingIMMessage): void {
    runtime.queue = runtime.queue.filter((item) => item !== target);
  }

  private requestExternalContractApproval(params: {
    runtime: IMConversationRuntime;
    pending: PendingIMMessage;
    contract: ExecutionContract;
    assessment: ReturnType<typeof assessExecutionContractApproval>;
    reuseQueuedMessage?: PendingIMMessage | null;
    clarifyOnly?: boolean;
  }): void {
    const { runtime, pending, contract, assessment } = params;
    const coordinatorId = runtime.system.getCoordinatorId() ?? runtime.system.getAll()[0]?.id;
    if (!coordinatorId) {
      void this.options.onReply({
        channelId: runtime.channelId,
        conversationId: runtime.conversationId,
        text: "当前 IM 会话没有可用协调者，无法继续发起协作确认。",
        messageId: pending.messageId,
      }).catch((error) => {
        log.warn("Failed to notify missing coordinator for IM approval", error);
      });
      return;
    }

    let queued = params.reuseQueuedMessage ?? null;
    if (!queued) {
      queued = {
        ...clonePendingIMMessage(pending)!,
        approvalState: "awaiting_user",
        approvalContract: cloneExecutionContract(contract),
      };
      runtime.queue.unshift(queued);
    } else {
      queued.approvalState = "awaiting_user";
      queued.approvalContract = cloneExecutionContract(contract);
    }

    const beforeHistoryLength = runtime.system.getDialogHistory().length;
    void runtime.system.askUserInChat(
      coordinatorId,
      this.buildExternalContractApprovalPrompt({
        runtime,
        pending,
        contract,
        assessment,
        ...(params.clarifyOnly ? { clarifyOnly: true } : {}),
      }),
      {
        timeoutMs: 300_000,
        interactionType: "approval",
        options: ["允许", "拒绝"],
      },
    ).then((result) => {
      if (result.status === "timed_out" && queued?.approvalState === "awaiting_user") {
        this.removeQueuedApprovalMessage(runtime, queued);
        void this.options.onReply({
          channelId: runtime.channelId,
          conversationId: runtime.conversationId,
          text: "这次确认已超时，本轮协作未继续执行。",
          messageId: pending.messageId,
        }).catch((error) => {
          log.warn("Failed to notify IM approval timeout", error);
        });
        this.refreshRuntime(runtime);
      }
    }).catch((error) => {
      log.warn("Failed to request IM contract approval", error);
    });

    const approvalMessage = runtime.system.getDialogHistory()[beforeHistoryLength];
    if (queued && approvalMessage?.interactionType === "approval") {
      queued.approvalInteractionId = approvalMessage.interactionId;
      queued.approvalMessageId = approvalMessage.id;
    }
    runtime.lastInput = pending;
    runtime.inFlight = false;
    runtime.status = "waiting";
    this.syncRuntimeState(runtime, undefined, this.getCollaborationSnapshot(runtime));
  }

  private continueApprovedQueuedMessage(runtime: IMConversationRuntime, queued: PendingIMMessage): void {
    const contract = queued.approvalContract ? cloneExecutionContract(queued.approvalContract) : null;
    this.removeQueuedApprovalMessage(runtime, queued);
    const dispatchable: PendingIMMessage = {
      ...queued,
      approvalState: "approved_ready",
      approvalInteractionId: undefined,
      approvalMessageId: undefined,
      approvalContract: contract ?? undefined,
    };
    void this.dispatch(runtime, dispatchable);
  }

  private cleanupStaleApprovalQueue(
    runtime: IMConversationRuntime,
    snapshot: CollaborationSessionSnapshot,
  ): void {
    const hasPendingApproval = snapshot.pendingInteractions.some((interaction) => interaction.type === "approval");
    const pendingApprovalKeys = new Set(
      snapshot.pendingInteractions
        .filter((interaction) => interaction.type === "approval")
        .flatMap((interaction) => [interaction.id, interaction.messageId]),
    );
    runtime.queue = runtime.queue.filter((item) => {
      if (item.approvalState !== "awaiting_user") return true;
      if (!item.approvalInteractionId && !item.approvalMessageId) {
        return hasPendingApproval;
      }
      if (
        (item.approvalInteractionId && pendingApprovalKeys.has(item.approvalInteractionId))
        || (item.approvalMessageId && pendingApprovalKeys.has(item.approvalMessageId))
      ) {
        return true;
      }
      return false;
    });
  }

  private shouldDispatchImmediately(runtime: IMConversationRuntime): boolean {
    const activity = this.inspectRuntime(runtime);
    if (activity.pendingApprovals > 0 || activity.pendingReplies > 0) {
      return true;
    }
    return !runtime.inFlight && activity.runningTasks === 0 && activity.activeActors === 0;
  }

  private async dispatch(runtime: IMConversationRuntime, pending: PendingIMMessage): Promise<void> {
    let snapshot = this.getCollaborationSnapshot(runtime);
    if (snapshot.pendingInteractions.length > 1) {
      runtime.queue = [pending, ...runtime.queue];
      runtime.inFlight = false;
      runtime.status = "waiting";
      void this.options.onReply({
        channelId: runtime.channelId,
        conversationId: runtime.conversationId,
        text: "当前有多条待处理交互，请先在桌面端确认或明确回复对象。",
        messageId: pending.messageId,
      }).catch((error) => {
        log.warn("Failed to notify IM multi-interaction ambiguity", error);
      });
      this.syncRuntimeState(runtime, this.inspectRuntime(runtime, snapshot), snapshot);
      return;
    }

    runtime.lastInput = pending;
    runtime.updatedAt = Date.now();

    if (snapshot.pendingInteractions.length === 0) {
      await this.ensureIMRuntimeDialogRoomCompaction(runtime);
      snapshot = this.getCollaborationSnapshot(runtime);
    }

    const singlePendingInteraction = snapshot.pendingInteractions.length === 1
      ? snapshot.pendingInteractions[0]
      : null;
    const queuedApprovalMessage = singlePendingInteraction?.type === "approval"
      ? this.findQueuedApprovalMessage(
          runtime,
          singlePendingInteraction.messageId,
          singlePendingInteraction.id,
        )
      : null;

    if (singlePendingInteraction?.type === "approval" && queuedApprovalMessage) {
      runtime.controller.dispatchUserInput({
        content: pending.text,
        briefContent: pending.briefContent,
        displayText: pending.briefContent,
        images: pending.images,
        externalChannelType: pending.channelType,
        externalChannelId: runtime.channelId,
        externalConversationId: runtime.conversationId,
        externalConversationType: pending.conversationType,
        externalSessionId: runtime.system.sessionId,
        runtimeDisplayLabel: pending.displayLabel,
        runtimeDisplayDetail: pending.displayDetail,
      }, {
        allowQueue: false,
        forceAsNewMessage: false,
        selectedPendingMessageId: singlePendingInteraction.messageId,
      });

      const decision = parseContractApprovalReply(pending.text);
      if (decision === "allow") {
        this.continueApprovedQueuedMessage(runtime, queuedApprovalMessage);
      } else if (decision === "deny") {
        this.removeQueuedApprovalMessage(runtime, queuedApprovalMessage);
        runtime.inFlight = false;
      } else {
        this.requestExternalContractApproval({
          runtime,
          pending: queuedApprovalMessage,
          contract: queuedApprovalMessage.approvalContract ?? sealExecutionContract(
            this.buildIMExecutionContractDraft(runtime, queuedApprovalMessage, this.getCollaborationSnapshot(runtime)),
            { approvedAt: Date.now() },
          ),
          assessment: assessExecutionContractApproval(
            this.buildIMExecutionContractDraft(runtime, queuedApprovalMessage, this.getCollaborationSnapshot(runtime)),
            this.buildContractApprovalActors(runtime),
            {
              trustMode: mapTrustLevelToContractTrustMode(useToolTrustStore.getState().trustLevel),
            },
          ),
          reuseQueuedMessage: queuedApprovalMessage,
          clarifyOnly: true,
        });
      }
      this.syncRuntimeState(runtime, undefined, this.getCollaborationSnapshot(runtime));
      return;
    }
    let dispatchContract: ExecutionContract | null = pending.approvalContract
      ? cloneExecutionContract(pending.approvalContract)
      : null;
    if (!dispatchContract && snapshot.pendingInteractions.length === 0) {
      const actorRoster = this.buildContractActorRoster(runtime);
      const activeContract = snapshot.activeContract;
      const canReuseActiveContract = activeContract
        && (activeContract.state === "sealed" || activeContract.state === "active")
        && doesExecutionContractMatchActorRoster(activeContract, actorRoster);
      if (!canReuseActiveContract) {
        const draft = this.buildIMExecutionContractDraft(runtime, pending, snapshot);
        const assessment = assessExecutionContractApproval(
          draft,
          this.buildContractApprovalActors(runtime),
          {
            trustMode: mapTrustLevelToContractTrustMode(useToolTrustStore.getState().trustLevel),
          },
        );
        if (assessment.decision === "deny") {
          runtime.inFlight = false;
          runtime.status = "waiting";
          void this.options.onReply({
            channelId: runtime.channelId,
            conversationId: runtime.conversationId,
            text: assessment.reason,
            messageId: pending.messageId,
          }).catch((error) => {
            log.warn("Failed to notify IM contract denial", error);
          });
          this.syncRuntimeState(runtime, undefined, snapshot);
          return;
        }
        if (assessment.decision === "ask") {
          this.requestExternalContractApproval({
            runtime,
            pending,
            contract: sealExecutionContract(draft, { approvedAt: Date.now() }),
            assessment,
          });
          return;
        }
        dispatchContract = sealExecutionContract(draft, { approvedAt: Date.now() });
      }
    }

    runtime.inFlight = true;
    runtime.status = "running";
    runtime.controller.dispatchUserInput({
      content: pending.text,
      briefContent: pending.briefContent,
      displayText: pending.briefContent,
      images: pending.images,
      externalChannelType: pending.channelType,
      externalChannelId: runtime.channelId,
      externalConversationId: runtime.conversationId,
      externalConversationType: pending.conversationType,
      externalSessionId: runtime.system.sessionId,
      runtimeDisplayLabel: pending.displayLabel,
      runtimeDisplayDetail: pending.displayDetail,
    }, {
      ...(dispatchContract ? { contract: dispatchContract } : {}),
      allowQueue: false,
      forceAsNewMessage: snapshot.pendingInteractions.length === 0,
    });
    this.emitProgress({
      channelId: runtime.channelId,
      channelType: runtime.channelType,
      conversationId: runtime.conversationId,
      topicId: runtime.topicId,
      messageId: pending.messageId,
      kind: "accepted",
    });
    this.syncRuntimeState(runtime, undefined, this.getCollaborationSnapshot(runtime));
  }

  private async ensureIMRuntimeDialogRoomCompaction(
    runtime: IMConversationRuntime,
  ): Promise<void> {
    try {
      const ensured = await ensureDialogRoomCompaction(runtime.system);
      if (!ensured?.changed) return;
      log.info("Auto-compacted IM runtime context before dispatch", {
        conversationId: runtime.conversationId,
        topicId: runtime.topicId,
        compactedMessageCount: ensured.state.compactedMessageCount,
        compactedSpawnedTaskCount: ensured.state.compactedSpawnedTaskCount,
        compactedArtifactCount: ensured.state.compactedArtifactCount,
      });
    } catch (error) {
      log.warn("Failed to auto-compact IM runtime context", error);
    }
  }

  private inspectRuntime(
    runtime: IMConversationRuntime,
    snapshot = this.getCollaborationSnapshot(runtime),
  ): RuntimeActivitySnapshot {
    const pendingApprovals = snapshot.presentationState.pendingApprovalCount;
    const pendingReplies = snapshot.presentationState.pendingInteractionCount - pendingApprovals;
    const runningTasks = snapshot.childSessions.filter((task) => task.status === "running").length;
    const activeActors = runtime.system
      .getAll()
      .filter((actor) => actor.status === "running" || actor.status === "waiting").length;

    return {
      pendingApprovals,
      pendingReplies,
      runningTasks,
      activeActors,
    };
  }

  private refreshRuntime(runtime: IMConversationRuntime): void {
    const snapshot = this.getCollaborationSnapshot(runtime);
    this.cleanupStaleApprovalQueue(runtime, snapshot);
    const activity = this.inspectRuntime(runtime, snapshot);
    let shouldScheduleIdleCompaction = false;
    if (activity.pendingApprovals > 0 || activity.pendingReplies > 0) {
      runtime.status = "waiting";
      this.emitProgress({
        channelId: runtime.channelId,
        channelType: runtime.channelType,
        conversationId: runtime.conversationId,
        topicId: runtime.topicId,
        messageId: runtime.lastInput?.messageId,
        kind: activity.pendingApprovals > 0 ? "waiting_approval" : "waiting_reply",
      });
    } else if (runtime.queue.length > 0) {
      runtime.status = "queued";
    } else if (
      runtime.inFlight
      || activity.runningTasks > 0
      || activity.activeActors > 0
      || snapshot.presentationState.status === "processing"
    ) {
      runtime.status = "running";
      this.emitProgress({
        channelId: runtime.channelId,
        channelType: runtime.channelType,
        conversationId: runtime.conversationId,
        topicId: runtime.topicId,
        messageId: runtime.lastInput?.messageId,
        kind: "running",
        detail: "正在分析和生成结果",
      });
    } else {
      runtime.status = "idle";
      runtime.inFlight = false;
      shouldScheduleIdleCompaction = true;
    }

    runtime.updatedAt = Date.now();
    this.syncRuntimeState(runtime, activity, snapshot);
    if (shouldScheduleIdleCompaction) {
      this.scheduleIdleCompaction(runtime, snapshot, activity);
    } else {
      this.clearIdleCompaction(runtime, { clearScheduleKey: true });
    }

    if (
      !runtime.pumping
      && runtime.queue.length > 0
      && activity.pendingApprovals === 0
      && activity.pendingReplies === 0
      && activity.runningTasks === 0
      && activity.activeActors === 0
    ) {
      runtime.pumping = true;
      const next = runtime.queue.shift();
      if (next && next.approvalState !== "awaiting_user") {
        void this.dispatch(runtime, next).finally(() => {
          runtime.pumping = false;
          this.syncRuntimeState(runtime, undefined, this.getCollaborationSnapshot(runtime));
          this.scheduleSettledRefresh(runtime);
        });
        return;
      }
      runtime.pumping = false;
      this.syncRuntimeState(runtime, undefined, this.getCollaborationSnapshot(runtime));
      this.scheduleSettledRefresh(runtime);
    }
  }

  private scheduleSettledRefresh(runtime: IMConversationRuntime, delayMs = 80): void {
    this.clearSettledRefresh(runtime);
    runtime.settleTimer = setTimeout(() => {
      runtime.settleTimer = null;
      if (!this.runtimes.has(runtime.key)) return;
      this.refreshRuntime(runtime);
    }, delayMs);
  }

  private clearSettledRefresh(runtime: IMConversationRuntime): void {
    if (!runtime.settleTimer) return;
    clearTimeout(runtime.settleTimer);
    runtime.settleTimer = null;
  }

  private scheduleIdleCompaction(
    runtime: IMConversationRuntime,
    snapshot = this.getCollaborationSnapshot(runtime),
    activity = this.inspectRuntime(runtime, snapshot),
    delayMs = IM_RUNTIME_IDLE_COMPACTION_DELAY_MS,
  ): void {
    if (
      runtime.inFlight
      || runtime.pumping
      || runtime.queue.length > 0
      || activity.pendingApprovals > 0
      || activity.pendingReplies > 0
      || activity.runningTasks > 0
      || activity.activeActors > 0
      || snapshot.presentationState.status === "processing"
    ) {
      this.clearIdleCompaction(runtime, { clearScheduleKey: true });
      return;
    }

    const scheduleKey = buildIMRuntimeIdleCompactionScheduleKey({
      runtimeKey: runtime.key,
      dialogHistoryCount: snapshot.dialogMessages.length,
      artifactCount: runtime.system.getArtifactRecordsSnapshot().length,
      spawnedTaskCount: runtime.system.getSpawnedTasksSnapshot().length,
      queuedMessageCount: runtime.queue.length + snapshot.queuedFollowUps.length,
      pendingInteractionCount: snapshot.pendingInteractions.length,
      contractState: snapshot.presentationState.contractState,
      dialogRoomCompactionUpdatedAt: runtime.system.getDialogRoomCompaction()?.updatedAt ?? null,
    });
    if (runtime.idleCompactionScheduleKey === scheduleKey) {
      return;
    }

    this.clearIdleCompaction(runtime);
    runtime.idleCompactionScheduleKey = scheduleKey;
    runtime.idleCompactionTimer = setTimeout(() => {
      runtime.idleCompactionTimer = null;
      void this.runIdleCompaction(runtime, scheduleKey);
    }, delayMs);
  }

  private clearIdleCompaction(
    runtime: IMConversationRuntime,
    options?: { clearScheduleKey?: boolean },
  ): void {
    if (runtime.idleCompactionTimer) {
      clearTimeout(runtime.idleCompactionTimer);
      runtime.idleCompactionTimer = null;
    }
    if (options?.clearScheduleKey) {
      runtime.idleCompactionScheduleKey = null;
    }
  }

  private async runIdleCompaction(
    runtime: IMConversationRuntime,
    scheduleKey: string,
  ): Promise<void> {
    if (!this.runtimes.has(runtime.key) || runtime.idleCompactionScheduleKey !== scheduleKey) {
      return;
    }

    const snapshot = this.getCollaborationSnapshot(runtime);
    const activity = this.inspectRuntime(runtime, snapshot);
    if (
      runtime.inFlight
      || runtime.pumping
      || runtime.queue.length > 0
      || activity.pendingApprovals > 0
      || activity.pendingReplies > 0
      || activity.runningTasks > 0
      || activity.activeActors > 0
      || snapshot.presentationState.status === "processing"
    ) {
      this.clearIdleCompaction(runtime, { clearScheduleKey: true });
      return;
    }

    await this.ensureIMRuntimeDialogRoomCompaction(runtime);
    if (!this.runtimes.has(runtime.key)) {
      return;
    }

    const latestScheduleKey = buildIMRuntimeIdleCompactionScheduleKey({
      runtimeKey: runtime.key,
      dialogHistoryCount: runtime.system.getDialogHistory().length,
      artifactCount: runtime.system.getArtifactRecordsSnapshot().length,
      spawnedTaskCount: runtime.system.getSpawnedTasksSnapshot().length,
      queuedMessageCount: runtime.queue.length + this.getCollaborationSnapshot(runtime).queuedFollowUps.length,
      pendingInteractionCount: runtime.system.getPendingUserInteractions().length,
      contractState: this.getCollaborationSnapshot(runtime).presentationState.contractState,
      dialogRoomCompactionUpdatedAt: runtime.system.getDialogRoomCompaction()?.updatedAt ?? null,
    });
    runtime.idleCompactionScheduleKey = latestScheduleKey;
    this.refreshRuntime(runtime);
  }

  private syncRuntimeState(
    runtime: IMConversationRuntime,
    activity = this.inspectRuntime(runtime),
    snapshot = this.getCollaborationSnapshot(runtime),
  ): void {
    const pendingApprovals = activity.pendingApprovals;
    const pendingReplies = activity.pendingReplies;
    const runningTasks = activity.runningTasks;
    const queueLength = runtime.queue.length + snapshot.queuedFollowUps.length;
    const hasActivity =
      runtime.inFlight
      || pendingApprovals > 0
      || pendingReplies > 0
      || runningTasks > 0
      || activity.activeActors > 0
      || queueLength > 0;

    if (!hasActivity) {
      this.options.onFinalized?.({
        channelId: runtime.channelId,
        conversationId: runtime.conversationId,
        topicId: runtime.topicId,
      });
      unregisterRuntimeAbortHandler("im_conversation", runtime.system.sessionId);
      useRuntimeStateStore.getState().removeSession("im_conversation", runtime.system.sessionId);
      this.syncConversationSnapshots();
      return;
    }

    const waitingStage =
      pendingApprovals > 0
        ? "user_confirm"
        : pendingReplies > 0
          ? "user_reply"
          : queueLength > 0 && runningTasks === 0 && activity.activeActors === 0
            ? "follow_up_queue"
            : "running";
    const status =
      pendingApprovals > 0
        ? "awaiting_approval"
        : pendingReplies > 0
          ? "awaiting_reply"
          : queueLength > 0 && runningTasks === 0 && activity.activeActors === 0
            ? "queued"
            : "running";
    const query = summarizeAISessionRuntimeText(
      runtime.lastInput?.briefContent ?? runtime.lastInput?.text ?? `${runtime.conversationId}`,
      96,
    ) || runtime.lastInput?.displayLabel || "IM 会话";

    registerRuntimeAbortHandler("im_conversation", runtime.system.sessionId, () => {
      runtime.queue = [];
      runtime.inFlight = false;
      runtime.system.abortAll();
      for (const actor of runtime.system.getAll()) {
        runtime.system.cancelPendingInteractionsForActor(actor.id);
      }
      runtime.controller.clearQueuedFollowUps();
      this.refreshRuntime(runtime);
    });

    useRuntimeStateStore.getState().upsertSession({
      mode: "im_conversation",
      sessionId: runtime.system.sessionId,
      query,
      displayLabel: runtime.lastInput?.displayLabel ?? getChannelDisplayLabel(runtime.channelType),
      displayDetail: runtime.lastInput?.displayDetail
        ?? getConversationDisplayDetail(runtime.channelType, runtime.conversationType),
      startedAt: runtime.lastInput?.timestamp ?? runtime.updatedAt,
      updatedAt: runtime.updatedAt,
      waitingStage,
      status,
      ...this.buildRuntimeCompactionPreview(runtime),
    });
    this.syncConversationSnapshots();
  }

  private disposeRuntime(
    runtime: IMConversationRuntime,
    options?: { syncPersistence?: boolean },
  ): void {
    this.clearSettledRefresh(runtime);
    this.clearIdleCompaction(runtime, { clearScheduleKey: true });
    this.options.onFinalized?.({
      channelId: runtime.channelId,
      conversationId: runtime.conversationId,
      topicId: runtime.topicId,
    });
    unregisterRuntimeAbortHandler("im_conversation", runtime.system.sessionId);
    useRuntimeStateStore.getState().removeSession("im_conversation", runtime.system.sessionId);
    runtime.queue = [];
    runtime.unsubscribe();
    runtime.controller.dispose();
    runtime.system.killAll();
    this.runtimes.delete(runtime.key);
    if (options?.syncPersistence !== false) {
      this.syncConversationSnapshots();
    }
  }

  private buildConversationKey(channelId: string, conversationId: string): string {
    return `${channelId.trim()}::${conversationId.trim()}`;
  }

  private getConversationState(
    channelId: string,
    conversationId: string,
    meta?: {
      channelType?: ChannelType;
      conversationType?: ChannelIncomingMessage["conversationType"];
    },
  ): IMConversationState {
    const key = this.buildConversationKey(channelId, conversationId);
    const existing = this.conversations.get(key);
    if (existing) {
      if (meta?.channelType) {
        existing.channelType = meta.channelType;
      }
      if (meta?.conversationType) {
        existing.conversationType = meta.conversationType;
      }
      existing.updatedAt = Date.now();
      return existing;
    }
    const created: IMConversationState = {
      channelType: meta?.channelType,
      conversationType: meta?.conversationType,
      activeTopicId: "default",
      nextTopicSeq: 2,
      updatedAt: Date.now(),
    };
    this.conversations.set(key, created);
    return created;
  }

  private getConversationRuntimes(channelId: string, conversationId: string): IMConversationRuntime[] {
    return [...this.runtimes.values()]
      .filter((runtime) => runtime.channelId === channelId && runtime.conversationId === conversationId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private getRuntimeForTopic(
    channelId: string,
    conversationId: string,
    topicId: string,
  ): IMConversationRuntime | null {
    return this.runtimes.get(buildRuntimeKey(channelId, conversationId, topicId)) ?? null;
  }

  private parseCommand(text: string): { name: "new" | "reset" | "stop" | "status"; raw: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    const [command] = trimmed.split(/\s+/, 1);
    switch (command.toLowerCase()) {
      case "/new":
        return { name: "new", raw: trimmed };
      case "/reset":
        return { name: "reset", raw: trimmed };
      case "/stop":
        return { name: "stop", raw: trimmed };
      case "/status":
        return { name: "status", raw: trimmed };
      default:
        return null;
    }
  }

  private handleCommand(params: {
    channelId: string;
    conversationId: string;
    command: { name: "new" | "reset" | "stop" | "status"; raw: string };
    state: IMConversationState;
  }): IMCommandResult {
    const activeTopicId = params.state.activeTopicId;
    const activeRuntime = this.getRuntimeForTopic(
      params.channelId,
      params.conversationId,
      activeTopicId,
    );

    switch (params.command.name) {
      case "new": {
        const nextTopicId = `topic-${params.state.nextTopicSeq}`;
        params.state.nextTopicSeq += 1;
        params.state.activeTopicId = nextTopicId;
        params.state.updatedAt = Date.now();
        const backgroundCount = this.getConversationRuntimes(
          params.channelId,
          params.conversationId,
        ).filter((runtime) => runtime.topicId !== nextTopicId).length;
        this.syncConversationSnapshots();
        return {
          handled: true,
          replyText: backgroundCount > 0
            ? `已新建话题 ${nextTopicId}，后续消息将进入新会话。当前仍有 ${backgroundCount} 个旧话题在后台。`
            : `已新建话题 ${nextTopicId}，后续消息将进入新会话。`,
        };
      }
      case "reset": {
        if (activeRuntime) {
          this.disposeRuntime(activeRuntime);
        }
        params.state.updatedAt = Date.now();
        this.syncConversationSnapshots();
        return {
          handled: true,
          replyText: `已重置当前话题（${activeTopicId}），后续消息会从新上下文开始。`,
        };
      }
      case "stop": {
        if (!activeRuntime) {
          params.state.updatedAt = Date.now();
          this.syncConversationSnapshots();
          return {
            handled: true,
            replyText: `当前话题（${activeTopicId}）没有运行中的任务。`,
          };
        }
        this.stopRuntime(activeRuntime);
        params.state.updatedAt = Date.now();
        return {
          handled: true,
          replyText: `已停止当前话题（${activeTopicId}）的运行，并清空排队消息。`,
        };
      }
      case "status": {
        const runtimes = this.getConversationRuntimes(params.channelId, params.conversationId);
        const backgroundCount = runtimes.filter((runtime) => runtime.topicId !== activeTopicId).length;
        const summary = activeRuntime
          ? this.buildStatusSummary(activeRuntime, activeTopicId, backgroundCount)
          : [
              `当前话题：${activeTopicId}`,
              "当前状态：空闲",
              `后台话题：${backgroundCount}`,
              "说明：发送新消息后会自动进入当前话题继续处理。",
            ].join("\n");
        params.state.updatedAt = Date.now();
        this.syncConversationSnapshots();
        return {
          handled: true,
          replyText: summary,
        };
      }
      default:
        return { handled: false };
    }
  }

  private stopRuntime(runtime: IMConversationRuntime): void {
    this.clearSettledRefresh(runtime);
    runtime.queue = [];
    runtime.inFlight = false;
    runtime.updatedAt = Date.now();
    runtime.controller.clearQueuedFollowUps();
    runtime.system.abortAll();
    for (const actor of runtime.system.getAll()) {
      runtime.system.cancelPendingInteractionsForActor(actor.id);
    }
    this.refreshRuntime(runtime);
  }

  private syncConversationSnapshots(): void {
    const conversationKeys = new Set<string>();
    for (const key of this.conversations.keys()) {
      conversationKeys.add(key);
    }
    for (const runtime of this.runtimes.values()) {
      conversationKeys.add(this.buildConversationKey(runtime.channelId, runtime.conversationId));
    }

    const snapshots: IMConversationSnapshot[] = [];
    const sessionPreviews: IMConversationSessionPreview[] = [];
    for (const conversationKey of conversationKeys) {
      const snapshot = this.buildConversationSnapshot(conversationKey);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    for (const runtime of this.runtimes.values()) {
      sessionPreviews.push(this.buildSessionPreview(runtime));
    }
    useIMConversationRuntimeStore.getState().replaceRuntimeData({
      conversations: snapshots,
      sessionPreviews,
    });

    const persistedSnapshot = this.buildPersistenceSnapshot();
    if (!persistedSnapshot) {
      clearPersistedIMConversationRuntimeSnapshot();
      return;
    }
    savePersistedIMConversationRuntimeSnapshot(persistedSnapshot);
  }

  private hydratePersistedState(): void {
    const persisted = loadPersistedIMConversationRuntimeSnapshot();
    if (!persisted) return;

    for (const conversation of persisted.conversations) {
      this.conversations.set(conversation.key, {
        channelType: conversation.channelType,
        conversationType: conversation.conversationType,
        activeTopicId: conversation.activeTopicId,
        nextTopicSeq: conversation.nextTopicSeq,
        updatedAt: conversation.updatedAt,
      });
    }

    for (const runtimeRecord of persisted.runtimes.sort((left, right) => left.updatedAt - right.updatedAt)) {
      if (this.runtimes.has(runtimeRecord.key)) continue;
      const runtime = this.createRuntime({
        channelId: runtimeRecord.channelId,
        channelType: runtimeRecord.channelType,
        conversationId: runtimeRecord.conversationId,
        conversationType: runtimeRecord.conversationType,
        topicId: runtimeRecord.topicId,
      }, runtimeRecord);
      this.runtimes.set(runtime.key, runtime);
      this.refreshRuntime(runtime);
    }

    this.syncConversationSnapshots();
  }

  private buildPersistenceSnapshot(): PersistedIMConversationRuntimeSnapshot | null {
    if (this.conversations.size === 0 && this.runtimes.size === 0) {
      return null;
    }

    return {
      version: 2,
      savedAt: Date.now(),
      conversations: [...this.conversations.entries()].map(([key, state]) => ({
        key,
        channelType: state.channelType,
        conversationType: state.conversationType,
        activeTopicId: state.activeTopicId,
        nextTopicSeq: state.nextTopicSeq,
        updatedAt: state.updatedAt,
      })),
      runtimes: [...this.runtimes.values()].map((runtime) => this.buildPersistedRuntimeRecord(runtime)),
    };
  }

  private buildPersistedRuntimeRecord(runtime: IMConversationRuntime): PersistedIMRuntimeRecord {
    const collaborationSnapshot = runtime.controller.snapshot();
    const persistedCollaborationSnapshot = cloneCollaborationSnapshotForPersistence(collaborationSnapshot);
    persistedCollaborationSnapshot.dialogMessages = [];
    return {
      key: runtime.key,
      channelId: runtime.channelId,
      channelType: runtime.channelType,
      conversationId: runtime.conversationId,
      conversationType: runtime.conversationType,
      topicId: runtime.topicId,
      sessionId: runtime.system.sessionId,
      updatedAt: runtime.updatedAt,
      ...(runtime.lastInput ? { lastInput: clonePendingIMMessage(runtime.lastInput) } : {}),
      ...(runtime.queue.length > 0
        ? {
            queuedMessages: runtime.queue.map((message) => clonePendingIMMessage(message)),
          }
        : {}),
      dialogHistory: collaborationSnapshot.dialogMessages
        .map((message) => cloneDialogMessage(message)),
      ...(runtime.system.getDialogRoomCompaction()
        ? { dialogRoomCompaction: runtime.system.getDialogRoomCompaction() ?? undefined }
        : {}),
      actorConfigs: runtime.system.getAll().map((actor) => ({
        id: actor.id,
        roleName: actor.role.name,
        ...(actor.modelOverride ? { model: actor.modelOverride } : {}),
        ...(actor.hasExplicitMaxIterationsConfig ? { maxIterations: actor.configuredMaxIterations } : {}),
        ...(actor.getSystemPromptOverride() ? { systemPrompt: actor.getSystemPromptOverride() } : {}),
        ...(actor.capabilities ? { capabilities: actor.capabilities } : {}),
        ...(actor.toolPolicyConfig ? { toolPolicy: actor.toolPolicyConfig } : {}),
        ...(actor.executionPolicy ? { executionPolicy: actor.executionPolicy } : {}),
        ...(actor.workspace ? { workspace: actor.workspace } : {}),
        ...(typeof actor.timeoutSeconds === "number" ? { timeoutSeconds: actor.timeoutSeconds } : {}),
        ...(typeof actor.contextTokens === "number" ? { contextTokens: actor.contextTokens } : {}),
        ...(actor.thinkingLevel ? { thinkingLevel: actor.thinkingLevel } : {}),
        ...(actor.middlewareOverrides ? { middlewareOverrides: actor.middlewareOverrides } : {}),
        sessionHistory: actor.getSessionHistory().slice(-MAX_PERSISTED_ACTOR_SESSION_HISTORY),
      })),
      collaborationSnapshot: persistedCollaborationSnapshot,
    };
  }

  private buildSessionPreview(runtime: IMConversationRuntime): IMConversationSessionPreview {
    const collaborationSnapshot = runtime.controller.snapshot();
    const approvalPreview = this.buildRuntimeApprovalPreview(runtime, collaborationSnapshot);
    const compactionPreview = this.buildRuntimeCompactionPreview(runtime);
    const dialogHistory = collaborationSnapshot.dialogMessages
      .map((message) => cloneDialogMessage(message));
    const actors = runtime.system.getAll().map((actor) => ({
      id: actor.id,
      roleName: actor.role.name,
      status: actor.status,
    }));
    const displayLabel = runtime.lastInput?.displayLabel ?? getChannelDisplayLabel(runtime.channelType);
    const displayDetail = runtime.lastInput?.displayDetail
      ?? getConversationDisplayDetail(runtime.channelType, runtime.conversationType);

    return {
      sessionId: runtime.system.sessionId,
      runtimeKey: runtime.key,
      channelId: runtime.channelId,
      channelType: runtime.channelType,
      conversationId: runtime.conversationId,
      conversationType: runtime.conversationType,
      topicId: runtime.topicId,
      displayLabel,
      displayDetail,
      status: runtime.status,
      queueLength: runtime.queue.length,
      executionStrategy: collaborationSnapshot.presentationState.executionStrategy,
      pendingInteractionCount: collaborationSnapshot.presentationState.pendingInteractionCount,
      childSessionsPreview: collaborationSnapshot.presentationState.childSessionsPreview.map((item) => ({ ...item })),
      queuedFollowUpCount: collaborationSnapshot.presentationState.queuedFollowUpCount,
      contractState: collaborationSnapshot.presentationState.contractState,
      ...approvalPreview,
      ...compactionPreview,
      startedAt: runtime.lastInput?.timestamp ?? runtime.updatedAt,
      updatedAt: runtime.updatedAt,
      lastInputText: runtime.lastInput?.text,
      actors,
      dialogHistory,
    };
  }

  private buildConversationSnapshot(conversationKey: string): IMConversationSnapshot | null {
    const separatorIndex = conversationKey.indexOf("::");
    if (separatorIndex < 0) return null;

    const channelId = conversationKey.slice(0, separatorIndex);
    const conversationId = conversationKey.slice(separatorIndex + 2);
    const state = this.conversations.get(conversationKey);
    const runtimes = this.getConversationRuntimes(channelId, conversationId);

    if (!state && runtimes.length === 0) {
      return null;
    }
    if (!runtimes.length && state?.activeTopicId === "default" && state.nextTopicSeq <= 2) {
      return null;
    }

    const activeTopicId = state?.activeTopicId ?? runtimes[0]?.topicId ?? "default";
    const runtimeViews = runtimes.map((runtime) => {
      const snapshot = runtime.controller.snapshot();
      return {
        runtime,
        snapshot,
        approvalPreview: this.buildRuntimeApprovalPreview(runtime, snapshot),
        compactionPreview: this.buildRuntimeCompactionPreview(runtime),
      };
    });
    const activeRuntimeView = runtimeViews.find((item) => item.runtime.topicId === activeTopicId) ?? null;
    const latestRuntimeView = activeRuntimeView ?? runtimeViews[0] ?? null;
    const activeRuntime = activeRuntimeView?.runtime ?? null;
    const latestRuntime = latestRuntimeView?.runtime ?? null;
    const channelType = latestRuntime?.channelType ?? state?.channelType;
    if (!channelType) {
      return null;
    }

    const conversationType = latestRuntime?.conversationType ?? state?.conversationType ?? "private";
    const activeCollaborationSnapshot = activeRuntimeView?.snapshot ?? null;
    const displayLabel = activeRuntime?.lastInput?.displayLabel
      ?? latestRuntime?.lastInput?.displayLabel
      ?? getChannelDisplayLabel(channelType);
    const displayDetail = activeRuntime?.lastInput?.displayDetail
      ?? latestRuntime?.lastInput?.displayDetail
      ?? getConversationDisplayDetail(channelType, conversationType);
    const activeApprovalPreview = activeRuntimeView?.approvalPreview ?? {};
    const activeCompactionPreview = activeRuntimeView?.compactionPreview ?? {};
    const topics: IMConversationTopicSnapshot[] = runtimeViews
      .map(({ runtime, snapshot, approvalPreview, compactionPreview }) => ({
        runtimeKey: runtime.key,
        topicId: runtime.topicId,
        sessionId: runtime.system.sessionId,
        status: runtime.status,
        queueLength: runtime.queue.length,
        pendingInteractionCount: snapshot.presentationState.pendingInteractionCount,
        queuedFollowUpCount: snapshot.presentationState.queuedFollowUpCount,
        contractState: snapshot.presentationState.contractState,
        ...approvalPreview,
        ...compactionPreview,
        updatedAt: runtime.updatedAt,
        startedAt: runtime.lastInput?.timestamp ?? runtime.updatedAt,
        lastInputText: runtime.lastInput?.text,
      }))
      .sort((a, b) => {
        if (a.topicId === activeTopicId && b.topicId !== activeTopicId) return -1;
        if (b.topicId === activeTopicId && a.topicId !== activeTopicId) return 1;
        return b.updatedAt - a.updatedAt;
      });

    return {
      key: conversationKey,
      channelId,
      channelType,
      conversationId,
      conversationType,
      displayLabel,
      displayDetail,
      activeTopicId,
      nextTopicSeq: state?.nextTopicSeq ?? 2,
      updatedAt: Math.max(
        state?.updatedAt ?? 0,
        activeRuntime?.updatedAt ?? 0,
        latestRuntime?.updatedAt ?? 0,
      ),
      activeSessionId: activeRuntime?.system.sessionId,
      activeStatus: activeRuntime?.status ?? "idle",
      activeQueueLength: activeRuntime?.queue.length ?? 0,
      executionStrategy: activeCollaborationSnapshot?.presentationState.executionStrategy ?? null,
      pendingInteractionCount: activeCollaborationSnapshot?.presentationState.pendingInteractionCount ?? 0,
      childSessionsPreview: activeCollaborationSnapshot?.presentationState.childSessionsPreview.map((item) => ({ ...item })) ?? [],
      queuedFollowUpCount: activeCollaborationSnapshot?.presentationState.queuedFollowUpCount ?? 0,
      contractState: activeCollaborationSnapshot?.presentationState.contractState ?? null,
      ...activeApprovalPreview,
      ...activeCompactionPreview,
      backgroundTopicCount: topics.filter((topic) => topic.topicId !== activeTopicId).length,
      topics,
    };
  }

  private buildStatusSummary(
    runtime: IMConversationRuntime,
    activeTopicId: string,
    backgroundCount: number,
  ): string {
    const activity = this.inspectRuntime(runtime);
    const statusLabel = this.getRuntimeStatusLabel(runtime, activity);
    return [
      `当前话题：${activeTopicId}`,
      `当前状态：${statusLabel}`,
      `排队消息：${runtime.queue.length}`,
      `后台话题：${backgroundCount}`,
      `会话标识：${runtime.system.sessionId}`,
    ].join("\n");
  }

  private getLatestDialogMessage(runtime: IMConversationRuntime, messageId?: string): DialogMessage | null {
    if (!messageId) return null;
    return runtime.system.getDialogHistory().find((message) => message.id === messageId) ?? null;
  }

  private shouldForwardInteractionPrompt(
    runtime: IMConversationRuntime,
    message: DialogMessage,
  ): boolean {
    return Boolean(
      message.id
      && !runtime.forwardedInteractionMessageIds.has(message.id)
      && message.from !== "user"
      && message.to === "user"
      && message.expectReply
      && message.interactionStatus === "pending",
    );
  }

  private shouldForwardFinalAgentResult(
    runtime: IMConversationRuntime,
    message: DialogMessage,
  ): boolean {
    if (
      message.kind !== "agent_result"
      || !message.id
      || runtime.forwardedResultMessageIds.has(message.id)
    ) {
      return false;
    }

    const coordinatorId = runtime.system.getCoordinatorId();
    if (!coordinatorId) {
      return true;
    }

    return message.from === coordinatorId;
  }

  private buildExternalInteractionPrompt(
    runtime: IMConversationRuntime,
    message: DialogMessage,
  ): string | null {
    const actorName = runtime.system.get(message.from)?.role.name ?? "助手";
    const content = String(message.content || "").trim();
    if (!content) return null;

    const parts = [`来自 ${actorName}：`, content];
    const options = message.options?.map((item) => item.trim()).filter(Boolean) ?? [];
    if (options.length > 0) {
      parts.push(`可直接回复：${options.join(" / ")}`);
    }

    if (message.interactionType === "approval") {
      parts.push("请直接回复“允许”或“拒绝”，也可以补充说明。");
    } else {
      parts.push("请直接回复这条消息继续。");
    }

    return parts.join("\n\n");
  }

  private getRuntimeStatusLabel(
    runtime: IMConversationRuntime,
    activity: RuntimeActivitySnapshot,
  ): string {
    if (activity.pendingApprovals > 0) return "等待确认";
    if (activity.pendingReplies > 0) return "等待回复";
    if (runtime.queue.length > 0) return "后台排队";
    switch (runtime.status) {
      case "running":
        return "处理中";
      case "waiting":
        return "等待回复";
      case "queued":
        return "后台排队";
      default:
        return "空闲";
    }
  }

  private getProgressDetailFromEvent(
    detail?: { message?: string; stepType?: string },
  ): string | null {
    const message = String(detail?.message || "").trim();
    if (message) {
      return message.replace(/\s+/g, " ").slice(0, 120);
    }

    switch (detail?.stepType) {
      case "thought":
      case "thinking":
        return "正在分析需求";
      case "action":
      case "tool_streaming":
        return "正在调用工具";
      case "observation":
        return "正在整理工具结果";
      case "answer":
        return "正在生成回复";
      default:
        return null;
    }
  }

  private emitProgress(event: IMConversationProgressEvent): void {
    if (!this.options.onProgress) return;
    void this.options.onProgress(event).catch((error) => {
      log.warn("Failed to emit IM progress event", error);
    });
  }
}
