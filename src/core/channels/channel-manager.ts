/**
 * ChannelManager — IM 通道统一管理器
 *
 * 负责：
 * 1. 注册/初始化各 IM 通道
 * 2. 将收到的 IM 消息路由到 ActorSystem
 * 3. 将 ActorSystem 的回复转发回 IM 通道
 * 4. 通道状态管理与监控
 */

import type {
  IMChannel,
  ChannelConfig,
  ChannelType,
  ChannelIncomingMessage,
  ChannelOutgoingMessage,
  ChannelStatus,
  MessageHandler,
} from "./types";
import { DingTalkChannel } from "./dingtalk-channel";
import { FeishuChannel } from "./feishu-channel";
import { ChannelProgressEmitter } from "./channel-progress-emitter";
import { IMConversationRuntimeManager } from "./im-conversation-runtime-manager";
import {
  clearPersistedConversationRoutes,
  loadPersistedConversationRoutes,
  savePersistedConversationRoutes,
  type PersistedConversationRoute,
} from "./channel-route-persistence";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createLogger } from "@/core/logger";
import type { IMConversationSnapshot } from "@/store/im-conversation-runtime-store";
import type { AgentScheduledTask } from "@/core/ai/types";
import type { IMDataExportRuntimeManager } from "@/core/data-export/im-data-export-runtime-manager";

const log = createLogger("ChannelManager");

/** 通道工厂：按类型创建通道实例 */
const channelFactories: Record<ChannelType, () => IMChannel> = {
  dingtalk: () => new DingTalkChannel(),
  feishu: () => new FeishuChannel(),
};

export interface ChannelEntry {
  channel: IMChannel;
  config: ChannelConfig;
  unsubscribe?: () => void;
}

interface ConversationRoute {
  channelId: string;
  conversationId: string;
  conversationType?: ChannelIncomingMessage["conversationType"];
  targetUserId?: string;
  lastActiveAt: number;
  messageId?: string;
  replyWebhookUrl?: string;
  replyWebhookExpiresAt?: number;
  robotCode?: string;
}

export class ChannelManager {
  private static readonly CALLBACK_DEDUPE_TTL_MS = 15_000;

  private channels = new Map<string, ChannelEntry>();
  private _globalHandlers: MessageHandler[] = [];
  private _actorSystemUnsubscribe: (() => void) | null = null;
  private _conversationRuntimeManager: IMConversationRuntimeManager | null = null;
  private _dataExportRuntimeManager: IMDataExportRuntimeManager | null = null;
  private _dataExportRuntimeManagerPromise: Promise<IMDataExportRuntimeManager> | null = null;
  private _progressEmitter: ChannelProgressEmitter | null = null;
  private _callbackListenerUnlisten: UnlistenFn | null = null;
  private _callbackListenerPromise: Promise<UnlistenFn> | null = null;
  private _recentCallbackFingerprints = new Map<string, number>();

  /**
   * IM 会话路由表：将 IM conversationId 映射到来源通道，
   * 使回复能精准送回触发消息的 IM 会话。
   */
  private _conversationRoutes = new Map<
    string, // channelId::conversationId
    ConversationRoute
  >();

  /** 路由表条目超时清理时间（30 分钟） */
  private static readonly ROUTE_TTL_MS = 30 * 60 * 1000;

  constructor() {
    this._hydrateConversationRoutes();
  }

  /**
   * 将 ChannelManager 连接到 IM runtime 管理器。
   * 入站：IM 消息 → 独立 runtime → Agent 处理
   * 出站：runtime agent_result → 回发到来源通道的对应会话
   */
  connectToActorSystem(
    _actorSystem: {
      broadcastAndResolve: (
        from: string,
        content: string,
        opts?: {
          _briefContent?: string;
          images?: string[];
          externalChannelType?: ChannelType;
          externalConversationType?: ChannelIncomingMessage["conversationType"];
          runtimeDisplayLabel?: string;
          runtimeDisplayDetail?: string;
        },
      ) => void;
      getAll: () => Array<{ id: string }>;
      onEvent: (handler: (event: Record<string, unknown>) => void) => () => void;
    },
  ): () => void {
    this._actorSystemUnsubscribe?.();
    this._progressEmitter?.dispose();
    this._conversationRuntimeManager?.dispose();
    this._dataExportRuntimeManager?.dispose();
    this._progressEmitter = new ChannelProgressEmitter({
      sendProgress: async (params: { channelId: string; conversationId: string; message: string }) => {
        const { channelId, conversationId, message } = params;
        const route = this._getConversationRoute(channelId, conversationId);
        if (!route) return;
        await this._sendProgressThroughRoute(conversationId, route, message);
      },
      startFeishuTyping: async ({ channelId, conversationId, messageId }) => {
        const entry = this.channels.get(channelId);
        if (!(entry?.channel instanceof FeishuChannel)) return;
        await entry.channel.startTypingIndicator(conversationId, messageId);
      },
    });
    this._conversationRuntimeManager = new IMConversationRuntimeManager({
      onReply: async (params: {
        channelId: string;
        conversationId: string;
        text: string;
        messageId?: string;
        mediaUrl?: string;
        mediaUrls?: string[];
        images?: string[];
        attachments?: { path: string; fileName?: string }[];
      }) => {
        const { channelId, conversationId, text, messageId, mediaUrl, mediaUrls, images, attachments } = params;
        const route = this._getConversationRoute(channelId, conversationId);
        if (route) {
          await this._sendReplyWithMediaThroughRoute(
            conversationId,
            route,
            text,
            messageId,
            mediaUrl,
            mediaUrls,
            images,
            attachments,
          );
        }
      },
      onProgress: async (event) => {
        await this._progressEmitter?.emit(event);
      },
      onFinalized: ({ channelId, conversationId, topicId }) => {
        this._progressEmitter?.clear(channelId, conversationId, topicId);
      },
    });
    const unsub = this.onMessage(async (msg) => {
      const sourceChannelId = this._findChannelIdForMessage(msg);
      if (!sourceChannelId) {
        log.warn(`No channel route available for IM conversation ${msg.conversationId}`);
        return;
      }
      const sourceChannelType = this.channels.get(sourceChannelId)?.config.type;
      if (!sourceChannelType) {
        log.warn(`Channel ${sourceChannelId} has no runtime config for IM message`);
        return;
      }

      const exportManager = await this._getDataExportRuntimeManager();
      const exportResult = await exportManager.handleIncoming({
        channelId: sourceChannelId,
        channelType: sourceChannelType,
        msg,
      });
      log.info("export lane routing result", {
        channelId: sourceChannelId,
        conversationId: msg.conversationId,
        messageId: msg.messageId,
        handled: exportResult.handled,
        textPreview: String(msg.text ?? "").slice(0, 120),
      });
      if (exportResult.handled) {
        return;
      }

      log.info(`Routing IM message to isolated runtime: "${msg.text.slice(0, 60)}" (conv=${msg.conversationId})`);
      const result = await this._conversationRuntimeManager?.handleIncoming({
        channelId: sourceChannelId,
        channelType: sourceChannelType,
        msg,
      });
      if (result?.handled && result.replyText) {
        const route = this._getConversationRoute(sourceChannelId, msg.conversationId);
        if (route) {
          await this._sendReplyThroughRoute(msg.conversationId, route, result.replyText);
        }
      }
    });
    this._actorSystemUnsubscribe = () => {
      unsub();
      this._progressEmitter?.dispose();
      this._progressEmitter = null;
      this._conversationRuntimeManager?.dispose();
      this._conversationRuntimeManager = null;
      this._dataExportRuntimeManager?.dispose();
      this._dataExportRuntimeManager = null;
      this._dataExportRuntimeManagerPromise = null;
    };

    // 定期清理过期路由条目
    const cleanupInterval = setInterval(() => this._cleanupStaleRoutes(), ChannelManager.ROUTE_TTL_MS);
    const originalUnsub = this._actorSystemUnsubscribe;
    this._actorSystemUnsubscribe = () => {
      originalUnsub();
      clearInterval(cleanupInterval);
    };

    return this._actorSystemUnsubscribe;
  }

  private _buildConversationRouteKey(channelId: string, conversationId: string): string {
    return `${channelId.trim()}::${conversationId.trim()}`;
  }

  private async _getDataExportRuntimeManager(): Promise<IMDataExportRuntimeManager> {
    if (this._dataExportRuntimeManager) {
      return this._dataExportRuntimeManager;
    }
    if (!this._dataExportRuntimeManagerPromise) {
      this._dataExportRuntimeManagerPromise = import("@/core/data-export/im-data-export-runtime-manager")
        .then(({ IMDataExportRuntimeManager: Manager }) => {
          const manager = new Manager({
            onReply: async (params) => {
              const { channelId, conversationId, text, messageId, attachments } = params;
              const route = this._getConversationRoute(channelId, conversationId);
              if (route) {
                await this._sendReplyWithMediaThroughRoute(
                  conversationId,
                  route,
                  text,
                  messageId,
                  undefined,
                  undefined,
                  undefined,
                  attachments,
                );
              }
            },
          });
          this._dataExportRuntimeManager = manager;
          return manager;
        })
        .finally(() => {
          this._dataExportRuntimeManagerPromise = null;
        });
    }
    return this._dataExportRuntimeManagerPromise;
  }

  private _getConversationRoute(channelId: string, conversationId: string): ConversationRoute | null {
    return this._conversationRoutes.get(this._buildConversationRouteKey(channelId, conversationId)) ?? null;
  }

  private _normalizeConversationRoute(route: ConversationRoute): ConversationRoute | null {
    const channelId = route.channelId.trim();
    const conversationId = route.conversationId.trim();
    if (!channelId || !conversationId || !Number.isFinite(route.lastActiveAt) || route.lastActiveAt <= 0) {
      return null;
    }

    const now = Date.now();
    const normalized: ConversationRoute = {
      channelId,
      conversationId,
      lastActiveAt: route.lastActiveAt,
      ...(route.conversationType ? { conversationType: route.conversationType } : {}),
      ...(route.targetUserId?.trim() ? { targetUserId: route.targetUserId.trim() } : {}),
      ...(route.messageId?.trim() ? { messageId: route.messageId.trim() } : {}),
      ...(route.robotCode?.trim() ? { robotCode: route.robotCode.trim() } : {}),
    };

    if (
      route.replyWebhookUrl?.trim()
      && (!route.replyWebhookExpiresAt || route.replyWebhookExpiresAt > now)
    ) {
      normalized.replyWebhookUrl = route.replyWebhookUrl.trim();
      if (route.replyWebhookExpiresAt) {
        normalized.replyWebhookExpiresAt = route.replyWebhookExpiresAt;
      }
    }

    return normalized;
  }

  private _persistConversationRoutes(): void {
    if (this._conversationRoutes.size === 0) {
      clearPersistedConversationRoutes();
      return;
    }

    const persistedRoutes: PersistedConversationRoute[] = [];
    for (const [key, route] of this._conversationRoutes) {
      const normalized = this._normalizeConversationRoute(route);
      if (!normalized) continue;
      persistedRoutes.push({
        key,
        channelId: normalized.channelId,
        conversationId: normalized.conversationId,
        lastActiveAt: normalized.lastActiveAt,
        ...(normalized.conversationType ? { conversationType: normalized.conversationType } : {}),
        ...(normalized.targetUserId ? { targetUserId: normalized.targetUserId } : {}),
        ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
        ...(normalized.replyWebhookUrl ? { replyWebhookUrl: normalized.replyWebhookUrl } : {}),
        ...(normalized.replyWebhookExpiresAt ? { replyWebhookExpiresAt: normalized.replyWebhookExpiresAt } : {}),
        ...(normalized.robotCode ? { robotCode: normalized.robotCode } : {}),
      });
    }

    if (persistedRoutes.length === 0) {
      clearPersistedConversationRoutes();
      return;
    }
    savePersistedConversationRoutes(persistedRoutes);
  }

  private _hydrateConversationRoutes(): void {
    const now = Date.now();
    let changed = false;
    for (const record of loadPersistedConversationRoutes()) {
      if (now - record.lastActiveAt > ChannelManager.ROUTE_TTL_MS) {
        changed = true;
        continue;
      }
      const normalized = this._normalizeConversationRoute({
        channelId: record.channelId,
        conversationId: record.conversationId,
        conversationType: record.conversationType,
        targetUserId: record.targetUserId,
        lastActiveAt: record.lastActiveAt,
        messageId: record.messageId,
        replyWebhookUrl: record.replyWebhookUrl,
        replyWebhookExpiresAt: record.replyWebhookExpiresAt,
        robotCode: record.robotCode,
      });
      if (!normalized) {
        changed = true;
        continue;
      }
      this._conversationRoutes.set(this._buildConversationRouteKey(normalized.channelId, normalized.conversationId), normalized);
      if (
        normalized.replyWebhookUrl !== record.replyWebhookUrl
        || normalized.replyWebhookExpiresAt !== record.replyWebhookExpiresAt
      ) {
        changed = true;
      }
    }
    if (changed) {
      this._persistConversationRoutes();
    }
  }

  private _setConversationRoute(route: ConversationRoute): void {
    const normalized = this._normalizeConversationRoute(route);
    if (!normalized) return;
    this._conversationRoutes.set(
      this._buildConversationRouteKey(normalized.channelId, normalized.conversationId),
      normalized,
    );
    this._persistConversationRoutes();
  }

  /** 清理超时的路由条目 */
  private _cleanupStaleRoutes(): void {
    const now = Date.now();
    let removed = false;
    for (const [conversationId, route] of this._conversationRoutes) {
      if (now - route.lastActiveAt > ChannelManager.ROUTE_TTL_MS) {
        this._conversationRoutes.delete(conversationId);
        removed = true;
      }
    }
    if (removed) {
      this._persistConversationRoutes();
    }
  }

  private _clearConversationRoutes(channelId: string, conversationIds: string[]): void {
    if (conversationIds.length === 0) return;
    let removed = false;
    for (const conversationId of conversationIds) {
      this._progressEmitter?.clear(channelId, conversationId);
      removed = this._conversationRoutes.delete(this._buildConversationRouteKey(channelId, conversationId)) || removed;
    }
    if (removed) {
      this._persistConversationRoutes();
    }
  }

  /** 注册一个 IM 通道 */
  async register(config: ChannelConfig): Promise<void> {
    if (this.channels.has(config.id)) {
      log.warn(`Channel ${config.id} already registered, reconnecting...`);
      await this.unregister(config.id, { clearConversations: false });
    }

    const factory = channelFactories[config.type];
    if (!factory) {
      throw new Error(`Unknown channel type: ${config.type}`);
    }

    const channel = factory();

    if (config.enabled) {
      await channel.connect(config);
    }

    const unsubscribe = channel.onMessage(async (msg) => {
      return this._dispatchMessage(config.id, msg);
    });

    this.channels.set(config.id, { channel, config, unsubscribe });
    log.info(`Channel registered: ${config.name} (${config.type})`, { enabled: config.enabled });
  }

  /** 注销通道 */
  async unregister(id: string, options?: { clearConversations?: boolean }): Promise<void> {
    const entry = this.channels.get(id);
    if (!entry) return;

    if (options?.clearConversations) {
      this._conversationRuntimeManager?.disposeChannel(id);
      this._dataExportRuntimeManager?.disposeChannel(id);
    }
    for (const [key, route] of this._conversationRoutes) {
      if (route.channelId === id) {
        this._progressEmitter?.clear(id, route.conversationId);
        this._conversationRoutes.delete(key);
      }
    }
    this._persistConversationRoutes();
    entry.unsubscribe?.();
    await entry.channel.disconnect();
    this.channels.delete(id);
    log.info(`Channel unregistered: ${id}`, {
      clearConversations: options?.clearConversations === true,
    });
  }

  /** 获取指定通道 */
  getChannel(id: string): IMChannel | undefined {
    return this.channels.get(id)?.channel;
  }

  /** 获取所有通道状态快照 */
  getStatuses(): Array<{ id: string; type: ChannelType; name: string; status: ChannelStatus }> {
    return [...this.channels.entries()].map(([id, entry]) => ({
      id,
      type: entry.config.type,
      name: entry.config.name,
      status: entry.channel.getStatus(),
    }));
  }

  /** 获取当前活跃的 IM 会话快照 */
  getConversationSnapshots(channelId?: string): IMConversationSnapshot[] {
    const conversations = this._conversationRuntimeManager?.getConversationSnapshots() ?? [];
    if (!channelId) return conversations;
    return conversations.filter((item) => item.channelId === channelId);
  }

  /** 为指定会话创建新话题 */
  createNewTopic(channelId: string, conversationId: string): string {
    return this._conversationRuntimeManager?.createNewTopic(channelId, conversationId)
      ?? "IM 会话管理器尚未初始化。";
  }

  /** 重置指定会话的当前话题 */
  resetActiveConversation(channelId: string, conversationId: string): string {
    return this._conversationRuntimeManager?.resetActiveTopic(channelId, conversationId)
      ?? "IM 会话管理器尚未初始化。";
  }

  /** 停止指定会话的当前话题 */
  stopActiveConversation(channelId: string, conversationId: string): string {
    return this._conversationRuntimeManager?.stopActiveTopic(channelId, conversationId)
      ?? "IM 会话管理器尚未初始化。";
  }

  /** 获取指定会话的状态摘要 */
  getConversationStatusText(channelId: string, conversationId: string): string {
    return this._conversationRuntimeManager?.getConversationStatus(channelId, conversationId)
      ?? "IM 会话管理器尚未初始化。";
  }

  /** 从桌面端继续向指定 IM 会话发送消息 */
  async sendDesktopMessageToConversation(params: {
    channelId: string;
    channelType: ChannelType;
    conversationId: string;
    conversationType: ChannelIncomingMessage["conversationType"];
    text: string;
    topicId?: string | null;
    senderName?: string;
    images?: string[];
    timestamp?: number;
    messageId?: string;
  }): Promise<{
    handled: boolean;
    queued?: boolean;
    runtimeKey?: string;
    sessionId?: string;
  }> {
    if (!this._conversationRuntimeManager) {
      return {
        handled: true,
      };
    }
    return this._conversationRuntimeManager.submitDesktopMessage(params);
  }

  clearConversation(channelId: string, conversationId: string): number {
    const removedConversationIds = this._conversationRuntimeManager?.clearConversation(channelId, conversationId) ?? [];
    this._dataExportRuntimeManager?.clearConversation(channelId, conversationId);
    this._clearConversationRoutes(channelId, removedConversationIds);
    return removedConversationIds.length;
  }

  clearChannelConversations(channelId: string, options?: { keepConversationId?: string | null }): number {
    const removedConversationIds = this._conversationRuntimeManager?.clearChannelConversations(channelId, options) ?? [];
    for (const conversationId of removedConversationIds) {
      this._dataExportRuntimeManager?.clearConversation(channelId, conversationId);
    }
    this._clearConversationRoutes(channelId, removedConversationIds);
    return removedConversationIds.length;
  }

  async sendScheduledReminder(task: Pick<
    AgentScheduledTask,
    "origin_channel_id" | "origin_conversation_id" | "origin_mode" | "id"
  >, text: string): Promise<boolean> {
    const channelId = task.origin_channel_id?.trim() || "";
    const conversationId = task.origin_conversation_id?.trim() || "";
    const content = text.trim();
    if (!channelId || !conversationId || !content) {
      return false;
    }

    const route = this._getConversationRoute(channelId, conversationId);
    const entry = this.channels.get(channelId);
    let delivered = false;

    if (entry?.channel && entry.channel.status === "connected") {
      try {
        await entry.channel.send({
          conversationId,
          ...(route?.conversationType ? { conversationType: route.conversationType } : {}),
          ...(route?.targetUserId ? { targetUserId: route.targetUserId } : {}),
          ...(route?.messageId ? { replyToMessageId: route.messageId } : {}),
          ...(route?.replyWebhookUrl ? { replyWebhookUrl: route.replyWebhookUrl } : {}),
          ...(route?.replyWebhookExpiresAt ? { replyWebhookExpiresAt: route.replyWebhookExpiresAt } : {}),
          ...(route?.robotCode ? { robotCode: route.robotCode } : {}),
          text: content,
        });
        delivered = true;
        if (route) {
          route.lastActiveAt = Date.now();
          this._persistConversationRoutes();
        }
      } catch (err) {
        log.error("Failed to send scheduled reminder through channel", err);
      }
    }

    const recorded = this._conversationRuntimeManager?.recordOutboundReminder(
      channelId,
      conversationId,
      content,
      entry?.config.type ?? (task.origin_mode === "feishu"
        ? "feishu"
        : task.origin_mode === "dingtalk"
          ? "dingtalk"
          : undefined),
    ) ?? false;
    return delivered || recorded;
  }

  /** 向指定通道发送消息 */
  async send(channelId: string, msg: ChannelOutgoingMessage): Promise<void> {
    const entry = this.channels.get(channelId);
    if (!entry) throw new Error(`Channel ${channelId} not found`);
    if (entry.channel.status !== "connected") {
      throw new Error(`Channel ${channelId} is not connected (status: ${entry.channel.status})`);
    }
    await entry.channel.send(msg);
  }

  /** 向所有已连接通道广播消息 */
  async broadcast(msg: ChannelOutgoingMessage): Promise<void> {
    const connected = [...this.channels.values()].filter(
      (e) => e.channel.status === "connected",
    );
    await Promise.allSettled(connected.map((e) => e.channel.send(msg)));
  }

  /** 注册全局消息处理器（所有通道的消息都会触发） */
  onMessage(handler: MessageHandler): () => void {
    this._globalHandlers.push(handler);
    return () => {
      this._globalHandlers = this._globalHandlers.filter((h) => h !== handler);
    };
  }

  /** 断开所有通道 */
  async disconnectAll(): Promise<void> {
    this._progressEmitter?.dispose();
    this._progressEmitter = null;
    this._conversationRuntimeManager?.dispose();
    this._conversationRuntimeManager = null;
    this._dataExportRuntimeManager?.dispose();
    this._dataExportRuntimeManager = null;
    for (const [id] of this.channels) {
      await this.unregister(id);
    }
  }

  /**
   * 处理来自 Tauri 后端转发的 IM 回调。
   * 用于 Tauri 端接收 HTTP 回调后 emit 到前端。
   */
  async handleExternalCallback(channelId: string, raw: Record<string, unknown>): Promise<string | undefined> {
    const entry = this.channels.get(channelId);
    if (!entry) {
      log.warn(`External callback for unknown channel: ${channelId}`);
      return;
    }

    if (entry.channel instanceof DingTalkChannel) {
      return entry.channel.handleIncomingCallback(raw);
    }
    if (entry.channel instanceof FeishuChannel) {
      return entry.channel.handleIncomingCallback(raw);
    }

    log.warn(`Channel ${channelId} does not support external callbacks`);
  }

  /**
   * 注册 Tauri 事件监听器，接收后端转发的 IM 回调。
   * Tauri Rust 端收到 IM 平台 HTTP 回调后 emit("im-channel-callback", { channelId, payload })。
   * 返回取消监听的函数。
   */
  async listenForCallbacks(): Promise<UnlistenFn> {
    if (this._callbackListenerUnlisten) {
      return this._callbackListenerUnlisten;
    }
    if (this._callbackListenerPromise) {
      return this._callbackListenerPromise;
    }

    this._callbackListenerPromise = listen<{ channelId: string; payload: Record<string, unknown> }>(
      "im-channel-callback",
      async (event) => {
        const { channelId, payload } = event.payload;
        if (!channelId || !payload) {
          log.warn("Invalid im-channel-callback event", event.payload);
          return;
        }
        if (this._isDuplicateCallback(channelId, payload)) {
          log.info(`Ignoring duplicated IM callback for channel ${channelId}`);
          return;
        }
        log.info(`Received IM callback for channel ${channelId}`, payload);
        try {
          await this.handleExternalCallback(channelId, payload);
        } catch (err) {
          log.error("Error handling IM callback", err);
        }
      },
    ).then((unlisten) => {
      this._callbackListenerUnlisten = () => {
        unlisten();
        if (this._callbackListenerUnlisten) {
          this._callbackListenerUnlisten = null;
        }
        this._callbackListenerPromise = null;
      };
      this._callbackListenerPromise = null;
      log.info("Listening for IM channel callbacks (im-channel-callback)");
      return this._callbackListenerUnlisten;
    }).catch((error) => {
      this._callbackListenerPromise = null;
      throw error;
    });

    return this._callbackListenerPromise;
  }

  // ── Private ──

  /** 根据 incoming message 查找来源 channel ID */
  private _findChannelIdForMessage(msg: ChannelIncomingMessage): string | null {
    let best: ConversationRoute | null = null;
    for (const route of this._conversationRoutes.values()) {
      if (route.conversationId !== msg.conversationId) continue;
      if (!this.channels.has(route.channelId)) continue;
      if (!best || route.lastActiveAt > best.lastActiveAt) {
        best = route;
      }
    }
    if (best) {
      return best.channelId;
    }

    // 回退：从已连接通道中查找（单通道场景直接返回）
    const connectedChannels: string[] = [];
    for (const [id, entry] of this.channels) {
      if (entry.channel.status === "connected") {
        connectedChannels.push(id);
      }
    }

    if (connectedChannels.length === 1) {
      return connectedChannels[0];
    }

    // 多通道场景：无法确定来源时返回 null
    if (connectedChannels.length > 1) {
      log.warn(`Multiple connected channels, cannot determine source for conversation ${msg.conversationId}`);
    }
    return null;
  }

  private async _dispatchMessage(channelId: string, msg: ChannelIncomingMessage): Promise<string | void> {
    log.info(`Message from ${channelId}: [${msg.senderName}] ${msg.text.slice(0, 60)}`);
    this._setConversationRoute({
      channelId,
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      targetUserId: msg.senderId,
      lastActiveAt: Date.now(),
      messageId: msg.messageId,
      replyWebhookUrl: msg.replyWebhookUrl,
      replyWebhookExpiresAt: msg.replyWebhookExpiresAt,
      robotCode: msg.robotCode,
    });

    for (const handler of this._globalHandlers) {
      try {
        const reply = await handler(msg);
        if (reply) return reply;
      } catch (err) {
        log.error("Global message handler error", err);
      }
    }
  }

  private async _sendReplyThroughRoute(
    conversationId: string,
    route: ConversationRoute,
    text: string,
    expectedTypingMessageId?: string,
  ): Promise<void> {
    await this._sendReplyWithMediaThroughRoute(conversationId, route, text, expectedTypingMessageId);
  }

  private async _sendReplyWithMediaThroughRoute(
    conversationId: string,
    route: ConversationRoute,
    text: string,
    expectedTypingMessageId?: string,
    mediaUrl?: string,
    mediaUrls?: string[],
    images?: string[],
    attachments?: { path: string; fileName?: string }[],
  ): Promise<void> {
    const entry = this.channels.get(route.channelId);
    if (!entry?.channel || entry.channel.status !== "connected") {
      return;
    }

    try {
      log.info("Forwarding IM reply through route", {
        channelId: route.channelId,
        conversationId,
        conversationType: route.conversationType,
        targetUserId: route.targetUserId,
        hasReplyWebhook: Boolean(route.replyWebhookUrl),
        hasText: Boolean(text),
        imageCount: images?.length ?? 0,
        attachmentCount: attachments?.length ?? 0,
      });
      await entry.channel.send({
        conversationId,
        conversationType: route.conversationType,
        targetUserId: route.targetUserId,
        replyToMessageId: route.messageId,
        replyWebhookUrl: route.replyWebhookUrl,
        replyWebhookExpiresAt: route.replyWebhookExpiresAt,
        robotCode: route.robotCode,
        text,
        mediaUrl,
        mediaUrls,
        images,
        attachments,
      });
      const storedRoute = this._getConversationRoute(route.channelId, conversationId);
      if (storedRoute) {
        storedRoute.lastActiveAt = Date.now();
        this._persistConversationRoutes();
      }
    } catch (err) {
      log.error("Failed to forward reply to source IM channel", err);
    } finally {
      if (entry.channel instanceof FeishuChannel) {
        await entry.channel.stopTypingIfMessageMatches(
          conversationId,
          expectedTypingMessageId ?? route.messageId,
        );
      }
    }
  }

  private async _sendProgressThroughRoute(
    conversationId: string,
    route: ConversationRoute,
    message: string,
  ): Promise<void> {
    const entry = this.channels.get(route.channelId);
    if (!entry?.channel || entry.channel.status !== "connected") {
      return;
    }

    try {
      await entry.channel.send({
        conversationId,
        conversationType: route.conversationType,
        targetUserId: route.targetUserId,
        replyToMessageId: route.messageId,
        replyWebhookUrl: route.replyWebhookUrl,
        replyWebhookExpiresAt: route.replyWebhookExpiresAt,
        robotCode: route.robotCode,
        text: message,
      });
    } catch (err) {
      log.error("Failed to forward progress to source IM channel", err);
    }
  }

  private _isDuplicateCallback(channelId: string, payload: Record<string, unknown>): boolean {
    this._pruneRecentCallbackFingerprints();
    const fingerprint = this._buildCallbackFingerprint(channelId, payload);
    if (!fingerprint) return false;

    const now = Date.now();
    const recentAt = this._recentCallbackFingerprints.get(fingerprint);
    if (typeof recentAt === "number" && now - recentAt <= ChannelManager.CALLBACK_DEDUPE_TTL_MS) {
      return true;
    }

    this._recentCallbackFingerprints.set(fingerprint, now);
    return false;
  }

  private _pruneRecentCallbackFingerprints(): void {
    if (this._recentCallbackFingerprints.size <= 300) return;
    const expireBefore = Date.now() - ChannelManager.CALLBACK_DEDUPE_TTL_MS;
    for (const [fingerprint, timestamp] of this._recentCallbackFingerprints) {
      if (timestamp < expireBefore) {
        this._recentCallbackFingerprints.delete(fingerprint);
      }
    }
  }

  private _buildCallbackFingerprint(channelId: string, payload: Record<string, unknown>): string {
    const pickString = (...values: unknown[]): string => {
      for (const value of values) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
      return "";
    };

    const textPayload = payload.text;
    const nestedText = textPayload && typeof textPayload === "object"
      ? pickString((textPayload as Record<string, unknown>).content)
      : "";
    const messageId = pickString(payload.msgId, payload.messageId, payload.eventId);
    const conversationId = pickString(
      payload.conversationId,
      payload.openConversationId,
      payload.chatId,
      payload.openThreadId,
      payload.sessionWebhook,
    );
    const senderId = pickString(
      payload.senderStaffId,
      payload.senderId,
      payload.openId,
      payload.userId,
      payload.senderNick,
    );
    const content = pickString(payload.content, payload.text, nestedText).replace(/\s+/g, " ").trim();

    if (messageId) {
      return `${channelId}::msg::${messageId}`;
    }
    if (!conversationId && !senderId && !content) {
      return "";
    }
    return `${channelId}::fp::${conversationId}::${senderId}::${content.slice(0, 500)}`;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __MTOOLS_CHANNEL_MANAGER__: ChannelManager | undefined;
}

export function getChannelManager(): ChannelManager {
  const existing = globalThis.__MTOOLS_CHANNEL_MANAGER__;
  if (!existing) {
    globalThis.__MTOOLS_CHANNEL_MANAGER__ = new ChannelManager();
    return globalThis.__MTOOLS_CHANNEL_MANAGER__;
  }
  if (Object.getPrototypeOf(existing) !== ChannelManager.prototype) {
    Object.setPrototypeOf(existing, ChannelManager.prototype);
  }
  return existing;
}
