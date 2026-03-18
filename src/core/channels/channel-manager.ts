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
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createLogger } from "@/core/logger";

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
  lastActiveAt: number;
  messageId?: string;
  replyWebhookUrl?: string;
  replyWebhookExpiresAt?: number;
  robotCode?: string;
}

export class ChannelManager {
  private channels = new Map<string, ChannelEntry>();
  private _globalHandlers: MessageHandler[] = [];
  private _actorSystemUnsubscribe: (() => void) | null = null;

  /**
   * IM 会话路由表：将 IM conversationId 映射到来源通道，
   * 使回复能精准送回触发消息的 IM 会话。
   */
  private _conversationRoutes = new Map<
    string, // conversationId
    ConversationRoute
  >();

  /** 路由表条目超时清理时间（30 分钟） */
  private static readonly ROUTE_TTL_MS = 30 * 60 * 1000;

  /**
   * 将 ChannelManager 连接到 ActorSystem，实现 IM 消息自动路由到 Agent。
   * 入站：IM 消息 → broadcastAndResolve → Agent 处理
   * 出站：agent_result 事件 → 回发到来源通道的对应会话
   */
  connectToActorSystem(
    actorSystem: {
      broadcastAndResolve: (from: string, content: string, opts?: { _briefContent?: string; _imConversationId?: string }) => void;
      getAll: () => Array<{ id: string }>;
      onEvent: (handler: (event: Record<string, unknown>) => void) => () => void;
    },
  ): () => void {
    const unsub = this.onMessage(async (msg) => {
      const actors = actorSystem.getAll();
      if (actors.length === 0) {
        log.warn("No actor available to handle IM message");
        return;
      }

      log.info(`Routing IM message to ActorSystem: "${msg.text.slice(0, 60)}" (conv=${msg.conversationId})`);
      actorSystem.broadcastAndResolve("user", msg.text, {
        _briefContent: `[IM:${msg.senderName}] ${msg.text.slice(0, 40)}`,
        _imConversationId: msg.conversationId,
      });
    });

    const eventUnsub = actorSystem.onEvent((event) => {
      const dialogEvent = event as { kind?: string; content?: string };
      if (dialogEvent.kind !== "agent_result") return;

      const text = String(dialogEvent.content || "").slice(0, 2000);
      if (!text.trim()) return;

      // 回退：查找最近活跃的路由
      const recentRoute = this._findMostRecentRoute();
      if (recentRoute) {
        void this._sendReplyThroughRoute(recentRoute.conversationId, recentRoute, text);
        return;
      }

      // 最终回退：广播到所有已连接通道
      for (const entry of this.channels.values()) {
        if (entry.channel.status === "connected") {
          entry.channel.send({ conversationId: "default", text })
            .catch((err) => log.error("Failed to forward reply to IM", err));
        }
      }
    });

    this._actorSystemUnsubscribe = () => { unsub(); eventUnsub(); };

    // 定期清理过期路由条目
    const cleanupInterval = setInterval(() => this._cleanupStaleRoutes(), ChannelManager.ROUTE_TTL_MS);
    const originalUnsub = this._actorSystemUnsubscribe;
    this._actorSystemUnsubscribe = () => {
      originalUnsub();
      clearInterval(cleanupInterval);
    };

    return this._actorSystemUnsubscribe;
  }

  /** 查找最近活跃的路由条目 */
  private _findMostRecentRoute(): ({ conversationId: string } & ConversationRoute) | null {
    let best: ({ conversationId: string } & ConversationRoute) | null = null;
    for (const [conversationId, route] of this._conversationRoutes) {
      if (!best || route.lastActiveAt > best.lastActiveAt) {
        best = { ...route, conversationId };
      }
    }
    return best;
  }

  /** 清理超时的路由条目 */
  private _cleanupStaleRoutes(): void {
    const now = Date.now();
    for (const [conversationId, route] of this._conversationRoutes) {
      if (now - route.lastActiveAt > ChannelManager.ROUTE_TTL_MS) {
        this._conversationRoutes.delete(conversationId);
      }
    }
  }

  /** 注册一个 IM 通道 */
  async register(config: ChannelConfig): Promise<void> {
    if (this.channels.has(config.id)) {
      log.warn(`Channel ${config.id} already registered, reconnecting...`);
      await this.unregister(config.id);
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
  async unregister(id: string): Promise<void> {
    const entry = this.channels.get(id);
    if (!entry) return;

    entry.unsubscribe?.();
    await entry.channel.disconnect();
    this.channels.delete(id);
    log.info(`Channel unregistered: ${id}`);
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
    const unlisten = await listen<{ channelId: string; payload: Record<string, unknown> }>(
      "im-channel-callback",
      async (event) => {
        const { channelId, payload } = event.payload;
        if (!channelId || !payload) {
          log.warn("Invalid im-channel-callback event", event.payload);
          return;
        }
        log.info(`Received IM callback for channel ${channelId}`);
        try {
          await this.handleExternalCallback(channelId, payload);
        } catch (err) {
          log.error("Error handling IM callback", err);
        }
      },
    );
    log.info("Listening for IM channel callbacks (im-channel-callback)");
    return unlisten;
  }

  // ── Private ──

  /** 根据 incoming message 查找来源 channel ID */
  private _findChannelIdForMessage(msg: ChannelIncomingMessage): string | null {
    // 优先：检查路由表是否已有此 conversationId 的记录
    const existing = this._conversationRoutes.get(msg.conversationId);
    if (existing && this.channels.has(existing.channelId)) {
      return existing.channelId;
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
    this._conversationRoutes.set(msg.conversationId, {
      channelId,
      lastActiveAt: Date.now(),
      messageId: msg.messageId,
      replyWebhookUrl: msg.replyWebhookUrl,
      replyWebhookExpiresAt: msg.replyWebhookExpiresAt,
      robotCode: msg.robotCode,
    });

    const entry = this.channels.get(channelId);
    if (entry?.channel instanceof FeishuChannel) {
      void entry.channel.startTypingForMessage(msg);
    }

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
  ): Promise<void> {
    const entry = this.channels.get(route.channelId);
    if (!entry?.channel || entry.channel.status !== "connected") {
      return;
    }

    try {
      await entry.channel.send({
        conversationId,
        replyToMessageId: route.messageId,
        replyWebhookUrl: route.replyWebhookUrl,
        replyWebhookExpiresAt: route.replyWebhookExpiresAt,
        robotCode: route.robotCode,
        text,
      });
      const storedRoute = this._conversationRoutes.get(conversationId);
      if (storedRoute) {
        storedRoute.lastActiveAt = Date.now();
      }
    } catch (err) {
      log.error("Failed to forward reply to source IM channel", err);
    } finally {
      if (entry.channel instanceof FeishuChannel) {
        await entry.channel.stopTypingForConversation(conversationId);
      }
    }
  }
}

/** 全局单例 */
let _instance: ChannelManager | null = null;

export function getChannelManager(): ChannelManager {
  if (!_instance) {
    _instance = new ChannelManager();
  }
  return _instance;
}
