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
import { createLogger } from "@/core/logger";

const log = createLogger("ChannelManager");

/** 通道工厂：按类型创建通道实例 */
const channelFactories: Record<ChannelType, () => IMChannel> = {
  dingtalk: () => new DingTalkChannel(),
  wecom: () => { throw new Error("企业微信通道尚未实现"); },
  feishu: () => { throw new Error("飞书通道尚未实现"); },
  slack: () => { throw new Error("Slack 通道尚未实现"); },
};

export interface ChannelEntry {
  channel: IMChannel;
  config: ChannelConfig;
  unsubscribe?: () => void;
}

export class ChannelManager {
  private channels = new Map<string, ChannelEntry>();
  private _globalHandlers: MessageHandler[] = [];

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

    log.warn(`Channel ${channelId} does not support external callbacks`);
  }

  // ── Private ──

  private async _dispatchMessage(channelId: string, msg: ChannelIncomingMessage): Promise<string | void> {
    log.info(`Message from ${channelId}: [${msg.senderName}] ${msg.text.slice(0, 60)}`);

    for (const handler of this._globalHandlers) {
      try {
        const reply = await handler(msg);
        if (reply) return reply;
      } catch (err) {
        log.error("Global message handler error", err);
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
