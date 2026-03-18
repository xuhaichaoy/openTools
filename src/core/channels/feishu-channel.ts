/**
 * Feishu Channel — 飞书机器人 IM 通道实现
 *
 * 支持两种模式：
 * 1. Webhook 模式：通过自定义机器人 Webhook 发送消息（单向推送）
 * 2. App 模式：通过 Tauri 后端建立飞书 WebSocket 长连接接收消息（双向）
 *
 * 飞书 Webhook 文档：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 * 飞书 API 文档：https://open.feishu.cn/document/server-docs/im-v1/message/create
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  IMChannel,
  ChannelConfig,
  ChannelStatus,
  ChannelOutgoingMessage,
  ChannelIncomingMessage,
  MessageHandler,
} from "./types";
import { createLogger } from "@/core/logger";

const log = createLogger("Feishu");
// Typing reaction 会一直存在直到显式移除；这里保留较长 TTL 只做兜底清理，
// 避免异常中断后残留，同时不至于让正常长任务过早丢失输入提示。
const FEISHU_TYPING_TTL_MS = 10 * 60_000;

interface FeishuTypingState {
  messageId: string;
  reactionId: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface FeishuTypingReactionResult {
  reactionId: string;
}

export interface FeishuConfig {
  /** 自定义机器人 Webhook URL */
  webhookUrl: string;
  /** Webhook 签名密钥（可选） */
  secret?: string;
  /** 飞书应用 App ID（用于 API 模式） */
  appId?: string;
  /** 飞书应用 App Secret */
  appSecret?: string;
  /** 飞书 OpenAPI 基础地址 */
  openBaseUrl?: string;
}

async function computeFeishuSign(timestamp: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const stringToSign = `${timestamp}\n${secret}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(stringToSign),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(""));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export class FeishuChannel implements IMChannel {
  readonly type = "feishu" as const;

  private _status: ChannelStatus = "disconnected";
  private _channelId: string | null = null;
  private _config: FeishuConfig | null = null;
  private _handlers: MessageHandler[] = [];
  private _typingStates = new Map<string, FeishuTypingState>();

  get status(): ChannelStatus {
    return this._status;
  }

  getStatus(): ChannelStatus {
    return this._status;
  }

  async connect(config: ChannelConfig): Promise<void> {
    const platform = config.platformConfig as unknown as FeishuConfig;
    const hasWebhook = !!platform.webhookUrl?.trim();
    const hasAppPair = !!platform.appId?.trim() && !!platform.appSecret?.trim();

    if (!hasWebhook && !hasAppPair) {
      throw new Error("飞书通道需要配置 webhookUrl，或同时配置 appId + appSecret");
    }

    this._config = platform;
    this._channelId = config.id;
    this._status = "connecting";

    try {
      if (hasAppPair) {
        await invoke("start_feishu_ws_channel", {
          channelId: config.id,
          appId: platform.appId!.trim(),
          appSecret: platform.appSecret!.trim(),
          baseUrl: resolveFeishuOpenBaseUrl(platform),
        });
      }

      if (hasWebhook) {
        const url = new URL(platform.webhookUrl);
        if (!url.hostname.includes("feishu") && !url.hostname.includes("larksuite")) {
          log.warn("Webhook URL does not appear to be a Feishu/Lark URL");
        }
      }

      this._status = "connected";
      log.info("Feishu channel connected", { hasWebhook: !!platform.webhookUrl, hasApp: !!platform.appId });
    } catch (err) {
      this._status = "error";
      log.error("Feishu channel connection failed", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const activeTypingConversations = [...this._typingStates.keys()];
    await Promise.allSettled(
      activeTypingConversations.map((conversationId) => this.stopTypingForConversation(conversationId)),
    );
    if (this._channelId && this._config?.appId && this._config?.appSecret) {
      await invoke("stop_feishu_ws_channel", {
        channelId: this._channelId,
      }).catch((err) => {
        log.warn("Failed to stop Feishu WebSocket channel", err);
      });
    }
    this._status = "disconnected";
    this._channelId = null;
    this._config = null;
    this._typingStates.clear();
    log.info("Feishu channel disconnected");
  }

  async send(msg: ChannelOutgoingMessage): Promise<void> {
    if (!this._config) throw new Error("Feishu channel not connected");

    // 优先 App API 模式：有应用凭证且有明确会话 ID
    if (this._config.appId && this._config.appSecret && msg.conversationId && msg.conversationId !== "default") {
      await this._sendByApi(msg);
      return;
    }

    await this._sendByWebhook(msg);
  }

  async startTypingForMessage(msg: ChannelIncomingMessage): Promise<void> {
    if (!this._config?.appId || !this._config?.appSecret) return;
    const conversationId = msg.conversationId.trim();
    const messageId = msg.messageId.trim();
    if (!conversationId || !messageId) return;

    const existing = this._typingStates.get(conversationId);
    if (existing?.messageId === messageId) {
      return;
    }
    if (existing) {
      await this.stopTypingForConversation(conversationId);
    }

    try {
      const result = await invoke<FeishuTypingReactionResult>("feishu_add_typing_reaction", {
        appId: this._config.appId,
        appSecret: this._config.appSecret,
        baseUrl: this._getOpenBaseUrl(),
        messageId,
      });
      const timeoutId = setTimeout(() => {
        void this.stopTypingForConversation(conversationId);
      }, FEISHU_TYPING_TTL_MS);
      this._typingStates.set(conversationId, {
        messageId,
        reactionId: result.reactionId,
        timeoutId,
      });
    } catch (err) {
      log.warn("Failed to start Feishu typing indicator", err);
    }
  }

  async stopTypingForConversation(conversationId: string): Promise<void> {
    const state = this._typingStates.get(conversationId);
    if (!state) return;

    clearTimeout(state.timeoutId);
    this._typingStates.delete(conversationId);

    if (!this._config?.appId || !this._config?.appSecret) return;

    try {
      await invoke("feishu_remove_typing_reaction", {
        appId: this._config.appId,
        appSecret: this._config.appSecret,
        baseUrl: this._getOpenBaseUrl(),
        messageId: state.messageId,
        reactionId: state.reactionId,
      });
    } catch (err) {
      log.warn("Failed to stop Feishu typing indicator", err);
    }
  }

  private async _sendByApi(msg: ChannelOutgoingMessage): Promise<void> {
    const { msgType, content } = buildFeishuAppMessagePayload(msg);

    try {
      await invoke("feishu_send_app_message", {
        appId: this._config!.appId,
        appSecret: this._config!.appSecret,
        baseUrl: this._getOpenBaseUrl(),
        receiveId: msg.conversationId,
        msgType,
        content,
        replyToMessageId: msg.replyToMessageId ?? null,
      });
      log.info("Message sent via Feishu API", { conversationId: msg.conversationId });
    } catch (err) {
      log.warn("Feishu API send failed, falling back to webhook", err);
      await this._sendByWebhook(msg);
    }
  }

  private async _sendByWebhook(msg: ChannelOutgoingMessage): Promise<void> {
    const webhookUrl = this._config?.webhookUrl;
    if (!webhookUrl) throw new Error("No webhook URL configured");

    const body = await this._buildMessageBody(msg);
    await invoke("feishu_send_webhook_message", {
      webhookUrl,
      body,
    });
    log.info("Message sent via Feishu webhook", { conversationId: msg.conversationId });
  }

  onMessage(handler: MessageHandler): () => void {
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== handler);
    };
  }

  /**
   * 处理来自 Tauri 后端转发的飞书入站事件。
   * Tauri 端可能通过 WebSocket 长连接或兼容回调服务接收，再统一 emit 到前端。
   */
  async handleIncomingCallback(raw: Record<string, unknown>): Promise<string | undefined> {
    // 飞书 URL 验证（challenge 机制）
    if (raw.challenge) {
      return JSON.stringify({ challenge: raw.challenge });
    }

    const msg = this._parseCallback(raw);
    if (!msg) return;

    log.info("Incoming Feishu message", { sender: msg.senderName, text: msg.text.slice(0, 50) });

    for (const handler of this._handlers) {
      try {
        const reply = await handler(msg);
        if (reply) return reply;
      } catch (err) {
        log.error("Message handler error", err);
      }
    }
  }

  // ── Private ──

  private _getOpenBaseUrl(): string {
    return resolveFeishuOpenBaseUrl(this._config);
  }

  private async _buildMessageBody(msg: ChannelOutgoingMessage): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};

    if (this._config?.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      body.timestamp = timestamp;
      body.sign = await computeFeishuSign(timestamp, this._config.secret);
    }

    if (msg.messageType === "markdown" && msg.markdown) {
      body.msg_type = "interactive";
      body.card = buildFeishuMarkdownCard(msg.markdown.text, msg.markdown.title);
    } else if (looksLikeMarkdown(msg.text || "")) {
      body.msg_type = "interactive";
      body.card = buildFeishuMarkdownCard(msg.text || "", inferFeishuCardTitle(msg.text || ""));
    } else {
      body.msg_type = "text";
      body.content = { text: msg.text || "" };
    }

    return body;
  }

  private _parseCallback(raw: Record<string, unknown>): ChannelIncomingMessage | null {
    try {
      // 飞书 Event v2.0 格式
      const header = raw.header as Record<string, unknown> | undefined;
      const event = raw.event as Record<string, unknown> | undefined;

      if (!event) return null;

      const message = event.message as Record<string, unknown> | undefined;
      const sender = event.sender as Record<string, unknown> | undefined;

      if (!message) return null;

      const senderId = sender?.sender_id as Record<string, unknown> | undefined;
      const senderUserId = String(senderId?.user_id || senderId?.open_id || "unknown");
      const senderName = String((sender as Record<string, unknown>)?.sender_id
        ? senderUserId : "unknown");

      const msgType = String(message.message_type || "text");
      let text = "";

      if (msgType === "text") {
        try {
          const content = JSON.parse(String(message.content || "{}"));
          text = String(content.text || "");
        } catch {
          text = String(message.content || "");
        }
      } else {
        text = String(message.content || "");
      }

      if (!text.trim()) return null;

      const chatId = String(message.chat_id || "default");
      const chatType = String(message.chat_type || "p2p");
      const mentions = message.mentions as Array<{ key: string; id: Record<string, string>; name: string }> | undefined;
      const atBot = mentions?.some((m) => m.id?.app_id) ?? false;

      // 移除 @机器人 mention 标记
      if (mentions?.length) {
        for (const m of mentions) {
          text = text.replace(new RegExp(`@${m.name}\\s*`, "g"), "").trim();
        }
      }

      return {
        messageId: String(message.message_id || header?.event_id || Date.now()),
        senderId: senderUserId,
        senderName,
        text: text.trim(),
        messageType: msgType as ChannelIncomingMessage["messageType"],
        conversationId: chatId,
        conversationType: chatType === "p2p" ? "private" : "group",
        timestamp: Number(header?.create_time || Date.now()),
        atBot,
        raw,
      };
    } catch (err) {
      log.error("Failed to parse Feishu callback", err);
      return null;
    }
  }
}

function resolveFeishuOpenBaseUrl(config: FeishuConfig | null): string {
  const explicit = config?.openBaseUrl?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const webhookUrl = config?.webhookUrl?.trim();
  if (webhookUrl) {
    try {
      const hostname = new URL(webhookUrl).hostname;
      if (hostname.includes("larksuite")) {
        return "https://open.larksuite.com";
      }
    } catch {
      // Ignore malformed webhook URL here; validation happens during connect.
    }
  }

  return "https://open.feishu.cn";
}

function buildFeishuMarkdownCard(text: string, title?: string): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  };

  if (title?.trim()) {
    card.header = {
      title: {
        tag: "plain_text",
        content: title.trim(),
      },
      template: "blue",
    };
  }

  return card;
}

function buildFeishuPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [
        [
          {
            tag: "md",
            text,
          },
        ],
      ],
    },
  });
}

function buildFeishuAppMessagePayload(msg: ChannelOutgoingMessage): {
  msgType: "interactive" | "post";
  content: string;
} {
  if (msg.messageType === "markdown" && msg.markdown) {
    return {
      msgType: "interactive",
      content: JSON.stringify(buildFeishuMarkdownCard(msg.markdown.text, msg.markdown.title)),
    };
  }

  const text = msg.text || "";
  if (shouldUseFeishuMarkdownCard(text)) {
    return {
      msgType: "interactive",
      content: JSON.stringify(buildFeishuMarkdownCard(text, inferFeishuCardTitle(text))),
    };
  }

  return {
    msgType: "post",
    content: buildFeishuPostContent(text),
  };
}

function shouldUseFeishuMarkdownCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  if (shouldUseFeishuMarkdownCard(text)) return true;
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|>\s|\d+\.\s|\[[ xX]\]\s)/m.test(text)
    || /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\))/m.test(text);
}

function inferFeishuCardTitle(text: string): string | undefined {
  const firstHeading = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+/.test(line));

  if (firstHeading) {
    return firstHeading.replace(/^#{1,6}\s+/, "").trim().slice(0, 80);
  }

  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : undefined;
}
