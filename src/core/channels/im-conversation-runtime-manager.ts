import { ActorSystem } from "@/core/agent/actor/actor-system";
import {
  buildDefaultDialogActorConfig,
  spawnDefaultDialogActors,
} from "@/core/agent/actor/default-dialog-actors";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import {
  registerRuntimeAbortHandler,
  unregisterRuntimeAbortHandler,
  useRuntimeStateStore,
} from "@/core/agent/context-runtime/runtime-state";
import { createLogger } from "@/core/logger";
import {
  useIMConversationRuntimeStore,
  type IMConversationRuntimeStatus,
  type IMConversationSessionPreview,
  type IMConversationSnapshot,
  type IMConversationTopicSnapshot,
} from "@/store/im-conversation-runtime-store";
import type { DialogMessage } from "@/core/agent/actor/types";
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
const MAX_PREVIEW_MESSAGES = 120;
const MAX_PERSISTED_DIALOG_MESSAGES = 200;

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
}

interface RuntimeActivitySnapshot {
  pendingApprovals: number;
  pendingReplies: number;
  runningTasks: number;
  activeActors: number;
}

interface IMConversationRuntime {
  key: string;
  channelId: string;
  channelType: ChannelType;
  conversationId: string;
  conversationType: ChannelIncomingMessage["conversationType"];
  topicId: string;
  system: ActorSystem;
  queue: PendingIMMessage[];
  status: IMConversationRuntimeStatus;
  lastInput?: PendingIMMessage;
  updatedAt: number;
  inFlight: boolean;
  pumping: boolean;
  settleTimer: ReturnType<typeof setTimeout> | null;
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
  };
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

    if (this.shouldDispatchImmediately(runtime)) {
      this.dispatch(runtime, pending);
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
      this.disposeRuntime(runtime);
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

    if (restored?.dialogHistory?.length) {
      system.restoreDialogHistory(restored.dialogHistory.map((message) => cloneDialogMessage(message)));
    }

    const runtime: IMConversationRuntime = {
      key: buildRuntimeKey(params.channelId, params.conversationId, params.topicId),
      channelId: params.channelId,
      channelType: params.channelType,
      conversationId: params.conversationId,
      conversationType: params.conversationType,
      topicId: params.topicId,
      system,
      queue: [],
      status: restored ? "idle" : "idle",
      ...(restored?.lastInput ? { lastInput: clonePendingIMMessage(restored.lastInput as PendingIMMessage) } : {}),
      updatedAt: restored?.updatedAt ?? Date.now(),
      inFlight: false,
      pumping: false,
      settleTimer: null,
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

  private shouldDispatchImmediately(runtime: IMConversationRuntime): boolean {
    const activity = this.inspectRuntime(runtime);
    if (activity.pendingApprovals > 0 || activity.pendingReplies > 0) {
      return true;
    }
    return !runtime.inFlight && activity.runningTasks === 0 && activity.activeActors === 0;
  }

  private dispatch(runtime: IMConversationRuntime, pending: PendingIMMessage): void {
    runtime.inFlight = true;
    runtime.lastInput = pending;
    runtime.status = "running";
    runtime.updatedAt = Date.now();
    runtime.system.broadcastAndResolve("user", pending.text, {
      _briefContent: pending.briefContent,
      externalChannelType: pending.channelType,
      externalChannelId: runtime.channelId,
      externalConversationId: runtime.conversationId,
      externalConversationType: pending.conversationType,
      externalSessionId: runtime.system.sessionId,
      runtimeDisplayLabel: pending.displayLabel,
      runtimeDisplayDetail: pending.displayDetail,
      images: pending.images,
      attachments: pending.attachments,
    });
    this.emitProgress({
      channelId: runtime.channelId,
      channelType: runtime.channelType,
      conversationId: runtime.conversationId,
      topicId: runtime.topicId,
      messageId: pending.messageId,
      kind: "accepted",
    });
    this.syncRuntimeState(runtime);
  }

  private inspectRuntime(runtime: IMConversationRuntime): RuntimeActivitySnapshot {
    const pendingInteractions = runtime.system.getPendingUserInteractions();
    const pendingApprovals = pendingInteractions.filter((item) => item.type === "approval").length;
    const pendingReplies = pendingInteractions.length - pendingApprovals;
    const runningTasks = runtime.system
      .getSpawnedTasksSnapshot()
      .filter((task) => task.status === "running").length;
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
    const activity = this.inspectRuntime(runtime);
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
    } else if (runtime.inFlight || activity.runningTasks > 0 || activity.activeActors > 0) {
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
    }

    runtime.updatedAt = Date.now();
    this.syncRuntimeState(runtime, activity);

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
      if (next) {
        this.dispatch(runtime, next);
      }
      runtime.pumping = false;
      this.syncRuntimeState(runtime);
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

  private syncRuntimeState(
    runtime: IMConversationRuntime,
    activity = this.inspectRuntime(runtime),
  ): void {
    const pendingApprovals = activity.pendingApprovals;
    const pendingReplies = activity.pendingReplies;
    const runningTasks = activity.runningTasks;
    const queueLength = runtime.queue.length;
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
      unregisterRuntimeAbortHandler("dialog", runtime.system.sessionId);
      useRuntimeStateStore.getState().removeSession("dialog", runtime.system.sessionId);
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
            : "dialog_running";
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

    registerRuntimeAbortHandler("dialog", runtime.system.sessionId, () => {
      runtime.queue = [];
      runtime.inFlight = false;
      runtime.system.abortAll();
      for (const actor of runtime.system.getAll()) {
        runtime.system.cancelPendingInteractionsForActor(actor.id);
      }
      this.refreshRuntime(runtime);
    });

    useRuntimeStateStore.getState().upsertSession({
      mode: "dialog",
      sessionId: runtime.system.sessionId,
      query,
      displayLabel: runtime.lastInput?.displayLabel ?? getChannelDisplayLabel(runtime.channelType),
      displayDetail: runtime.lastInput?.displayDetail
        ?? getConversationDisplayDetail(runtime.channelType, runtime.conversationType),
      startedAt: runtime.lastInput?.timestamp ?? runtime.updatedAt,
      updatedAt: runtime.updatedAt,
      waitingStage,
      status,
    });
    this.syncConversationSnapshots();
  }

  private disposeRuntime(runtime: IMConversationRuntime): void {
    this.clearSettledRefresh(runtime);
    this.options.onFinalized?.({
      channelId: runtime.channelId,
      conversationId: runtime.conversationId,
      topicId: runtime.topicId,
    });
    unregisterRuntimeAbortHandler("dialog", runtime.system.sessionId);
    useRuntimeStateStore.getState().removeSession("dialog", runtime.system.sessionId);
    runtime.queue = [];
    runtime.unsubscribe();
    runtime.system.killAll();
    this.runtimes.delete(runtime.key);
    this.syncConversationSnapshots();
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
      version: 1,
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
      dialogHistory: runtime.system
        .getDialogHistory()
        .slice(-MAX_PERSISTED_DIALOG_MESSAGES)
        .map((message) => cloneDialogMessage(message)),
      actorConfigs: runtime.system.getAll().map((actor) => ({
        id: actor.id,
        roleName: actor.role.name,
        ...(actor.modelOverride ? { model: actor.modelOverride } : {}),
        ...(actor.hasExplicitMaxIterationsConfig ? { maxIterations: actor.configuredMaxIterations } : {}),
        ...(actor.getSystemPromptOverride() ? { systemPrompt: actor.getSystemPromptOverride() } : {}),
        ...(actor.capabilities ? { capabilities: actor.capabilities } : {}),
        ...(actor.toolPolicyConfig ? { toolPolicy: actor.toolPolicyConfig } : {}),
        ...(actor.workspace ? { workspace: actor.workspace } : {}),
        ...(typeof actor.timeoutSeconds === "number" ? { timeoutSeconds: actor.timeoutSeconds } : {}),
        ...(typeof actor.contextTokens === "number" ? { contextTokens: actor.contextTokens } : {}),
        ...(actor.thinkingLevel ? { thinkingLevel: actor.thinkingLevel } : {}),
        ...(actor.middlewareOverrides ? { middlewareOverrides: actor.middlewareOverrides } : {}),
        sessionHistory: actor.getSessionHistory(),
      })),
    };
  }

  private buildSessionPreview(runtime: IMConversationRuntime): IMConversationSessionPreview {
    const dialogHistory = runtime.system
      .getDialogHistory()
      .slice(-MAX_PREVIEW_MESSAGES)
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
    const activeRuntime = runtimes.find((runtime) => runtime.topicId === activeTopicId) ?? null;
    const latestRuntime = activeRuntime ?? runtimes[0] ?? null;
    const channelType = latestRuntime?.channelType ?? state?.channelType;
    if (!channelType) {
      return null;
    }

    const conversationType = latestRuntime?.conversationType ?? state?.conversationType ?? "private";
    const displayLabel = activeRuntime?.lastInput?.displayLabel
      ?? latestRuntime?.lastInput?.displayLabel
      ?? getChannelDisplayLabel(channelType);
    const displayDetail = activeRuntime?.lastInput?.displayDetail
      ?? latestRuntime?.lastInput?.displayDetail
      ?? getConversationDisplayDetail(channelType, conversationType);
    const topics: IMConversationTopicSnapshot[] = runtimes
      .map((runtime) => ({
        runtimeKey: runtime.key,
        topicId: runtime.topicId,
        sessionId: runtime.system.sessionId,
        status: runtime.status,
        queueLength: runtime.queue.length,
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
    if (activity.pendingApprovals > 0) return "等待审批";
    if (activity.pendingReplies > 0) return "等待回复";
    if (runtime.queue.length > 0) return "排队中";
    switch (runtime.status) {
      case "running":
        return "运行中";
      case "waiting":
        return "等待中";
      case "queued":
        return "排队中";
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
