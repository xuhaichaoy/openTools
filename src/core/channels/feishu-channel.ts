/**
 * Feishu Channel — 飞书机器人 IM 通道实现
 *
 * 支持两种模式：
 * 1. Webhook 模式：通过自定义机器人 Webhook 发送消息（单向推送）
 * 2. App 模式：通过飞书开放平台 App 接收+发送消息（双向，需 Tauri 端转发回调）
 *
 * 飞书 Webhook 文档：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 * 飞书 API 文档：https://open.feishu.cn/document/server-docs/im-v1/message/create
 */

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

export interface FeishuConfig {
  /** 自定义机器人 Webhook URL */
  webhookUrl: string;
  /** Webhook 签名密钥（可选） */
  secret?: string;
  /** 飞书应用 App ID（用于 API 模式） */
  appId?: string;
  /** 飞书应用 App Secret */
  appSecret?: string;
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
  private _config: FeishuConfig | null = null;
  private _handlers: MessageHandler[] = [];
  private _tenantAccessToken: string | null = null;
  private _tokenExpiresAt = 0;

  get status(): ChannelStatus {
    return this._status;
  }

  getStatus(): ChannelStatus {
    return this._status;
  }

  async connect(config: ChannelConfig): Promise<void> {
    const platform = config.platformConfig as unknown as FeishuConfig;
    if (!platform.webhookUrl && !platform.appId) {
      throw new Error("飞书通道需要配置 webhookUrl 或 appId");
    }

    this._config = platform;
    this._status = "connecting";

    try {
      if (platform.appId && platform.appSecret) {
        await this._refreshTenantAccessToken();
      }

      if (platform.webhookUrl) {
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
    this._status = "disconnected";
    this._config = null;
    this._tenantAccessToken = null;
    log.info("Feishu channel disconnected");
  }

  async send(msg: ChannelOutgoingMessage): Promise<void> {
    if (!this._config) throw new Error("Feishu channel not connected");

    // 优先 API 模式：有 tenantAccessToken 且有明确的群/用户会话 ID
    if (this._tenantAccessToken && msg.conversationId && msg.conversationId !== "default") {
      await this._sendByApi(msg);
      return;
    }

    await this._sendByWebhook(msg);
  }

  private async _sendByApi(msg: ChannelOutgoingMessage): Promise<void> {
    await this._refreshTenantAccessToken();
    if (!this._tenantAccessToken) throw new Error("No tenant_access_token available for API mode");

    const content = msg.messageType === "markdown" && msg.markdown
      ? JSON.stringify({
          elements: [{ tag: "markdown", content: msg.markdown.text }],
          header: { title: { tag: "plain_text", content: msg.markdown.title }, template: "blue" },
        })
      : JSON.stringify({ text: msg.text || "" });

    const msgType = msg.messageType === "markdown" && msg.markdown ? "interactive" : "text";

    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._tenantAccessToken}`,
        },
        body: JSON.stringify({
          receive_id: msg.conversationId,
          msg_type: msgType,
          content,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      log.warn(`Feishu API send failed (${response.status}), falling back to webhook`, text);
      await this._sendByWebhook(msg);
      return;
    }

    const result = await response.json() as { code: number; msg: string };
    if (result.code !== 0) {
      log.warn(`Feishu API error (${result.code}), falling back to webhook`);
      await this._sendByWebhook(msg);
      return;
    }

    log.info("Message sent via Feishu API", { conversationId: msg.conversationId });
  }

  private async _sendByWebhook(msg: ChannelOutgoingMessage): Promise<void> {
    const webhookUrl = this._config?.webhookUrl;
    if (!webhookUrl) throw new Error("No webhook URL configured");

    const body = await this._buildMessageBody(msg);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error("Feishu webhook send failed", { status: response.status, body: text });
      throw new Error(`Feishu send failed: ${response.status} ${text}`);
    }

    const result = await response.json() as { code: number; msg: string };
    if (result.code !== 0) {
      log.error("Feishu API error", result);
      throw new Error(`Feishu API error: ${result.msg} (${result.code})`);
    }

    log.info("Message sent via Feishu webhook", { conversationId: msg.conversationId });
  }

  onMessage(handler: MessageHandler): () => void {
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== handler);
    };
  }

  /**
   * 处理来自 Tauri 后端转发的飞书事件回调。
   * 飞书通过 Event Subscription 推送消息，Tauri 端接收后 emit 到前端。
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

  private async _refreshTenantAccessToken(): Promise<void> {
    if (!this._config?.appId || !this._config?.appSecret) return;
    if (Date.now() < this._tokenExpiresAt - 60_000) return;

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: this._config.appId,
        app_secret: this._config.appSecret,
      }),
    });

    const data = await response.json() as {
      code: number;
      msg: string;
      tenant_access_token: string;
      expire: number;
    };

    if (data.code === 0 && data.tenant_access_token) {
      this._tenantAccessToken = data.tenant_access_token;
      this._tokenExpiresAt = Date.now() + data.expire * 1000;
      log.info("Feishu tenant_access_token refreshed", { expire: data.expire });
    } else {
      log.error("Failed to get Feishu tenant_access_token", data);
    }
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
      body.card = {
        elements: [{
          tag: "markdown",
          content: msg.markdown.text,
        }],
        header: {
          title: { tag: "plain_text", content: msg.markdown.title },
          template: "blue",
        },
      };
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
