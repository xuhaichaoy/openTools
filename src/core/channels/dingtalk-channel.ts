/**
 * DingTalk Channel — 钉钉机器人 IM 通道实现
 *
 * 支持两种模式：
 * 1. Webhook 模式：通过 Webhook URL 发送消息（单向推送，适合通知场景）
 * 2. Stream 模式：通过钉钉 Stream SDK 接收+发送消息（双向，适合交互场景）
 *
 * 当前实现 Webhook + HTTP 回调模式，Stream 模式需 Tauri 端转发。
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

const log = createLogger("DingTalk");

export interface DingTalkConfig {
  /** 机器人 Webhook URL（用于发送消息） */
  webhookUrl: string;
  /** Webhook 签名密钥（用于安全验证） */
  secret?: string;
  /** 应用 AppKey（用于 Stream/API 模式） */
  appKey?: string;
  /** 应用 AppSecret */
  appSecret?: string;
  /** 本地回调端口（Tauri 端监听 HTTP 回调） */
  callbackPort?: number;
}

/** 签名计算（HmacSHA256 + Base64） */
async function computeSign(timestamp: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = encoder.encode(`${timestamp}\n${secret}`);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export class DingTalkChannel implements IMChannel {
  readonly type = "dingtalk" as const;

  private _status: ChannelStatus = "disconnected";
  private _config: DingTalkConfig | null = null;
  private _handlers: MessageHandler[] = [];
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _accessToken: string | null = null;
  private _tokenExpiresAt = 0;

  get status(): ChannelStatus {
    return this._status;
  }

  getStatus(): ChannelStatus {
    return this._status;
  }

  async connect(config: ChannelConfig): Promise<void> {
    const platform = config.platformConfig as unknown as DingTalkConfig;
    if (!platform.webhookUrl && !platform.appKey) {
      throw new Error("钉钉通道需要配置 webhookUrl 或 appKey");
    }

    this._config = platform;
    this._status = "connecting";

    try {
      // 如果配置了 appKey，获取 access_token（用于主动发消息等 API）
      if (platform.appKey && platform.appSecret) {
        await this._refreshAccessToken();
      }

      // Webhook 模式只需要验证 URL 格式
      if (platform.webhookUrl) {
        const url = new URL(platform.webhookUrl);
        if (!url.hostname.includes("dingtalk")) {
          log.warn("Webhook URL does not appear to be a DingTalk URL");
        }
      }

      this._status = "connected";
      log.info("DingTalk channel connected", { hasWebhook: !!platform.webhookUrl, hasApp: !!platform.appKey });
    } catch (err) {
      this._status = "error";
      log.error("DingTalk channel connection failed", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._status = "disconnected";
    this._config = null;
    this._accessToken = null;
    log.info("DingTalk channel disconnected");
  }

  async send(msg: ChannelOutgoingMessage): Promise<void> {
    if (!this._config) throw new Error("DingTalk channel not connected");

    // 优先 API 模式：有 accessToken 且有明确的群会话 ID（非 "default"）
    if (this._accessToken && msg.conversationId && msg.conversationId !== "default") {
      await this._sendByApi(msg);
      return;
    }

    await this._sendByWebhook(msg);
  }

  private async _sendByApi(msg: ChannelOutgoingMessage): Promise<void> {
    await this._refreshAccessToken();
    if (!this._accessToken) throw new Error("No access token available for API mode");

    const body: Record<string, unknown> = {
      openConversationId: msg.conversationId,
      robotCode: this._config!.appKey,
      msgKey: msg.messageType === "markdown" ? "sampleMarkdown" : "sampleText",
      msgParam: msg.messageType === "markdown" && msg.markdown
        ? JSON.stringify({ title: msg.markdown.title, text: msg.markdown.text })
        : JSON.stringify({ content: msg.text || "" }),
    };

    const response = await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": this._accessToken,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log.warn(`DingTalk API send failed (${response.status}), falling back to webhook`, text);
      await this._sendByWebhook(msg);
      return;
    }

    log.info("Message sent via DingTalk API", { conversationId: msg.conversationId });
  }

  private async _sendByWebhook(msg: ChannelOutgoingMessage): Promise<void> {
    const webhookUrl = this._config?.webhookUrl;
    if (!webhookUrl) throw new Error("No webhook URL configured");

    let url = webhookUrl;
    if (this._config?.secret) {
      const timestamp = String(Date.now());
      const sign = await computeSign(timestamp, this._config.secret);
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    }

    const body = this._buildMessageBody(msg);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error("DingTalk webhook send failed", { status: response.status, body: text });
      throw new Error(`DingTalk send failed: ${response.status} ${text}`);
    }

    const result = await response.json() as { errcode: number; errmsg: string };
    if (result.errcode !== 0) {
      log.error("DingTalk API error", result);
      throw new Error(`DingTalk API error: ${result.errmsg} (${result.errcode})`);
    }

    log.info("Message sent via DingTalk webhook", { conversationId: msg.conversationId });
  }

  onMessage(handler: MessageHandler): () => void {
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== handler);
    };
  }

  /**
   * 处理来自 Tauri 后端转发的钉钉回调消息。
   * Tauri 端通过 HTTP server 接收钉钉推送，再 emit 到前端。
   */
  async handleIncomingCallback(raw: Record<string, unknown>): Promise<string | undefined> {
    const msg = this._parseCallback(raw);
    if (!msg) return;

    log.info("Incoming DingTalk message", { sender: msg.senderName, text: msg.text.slice(0, 50) });

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

  private async _refreshAccessToken(): Promise<void> {
    if (!this._config?.appKey || !this._config?.appSecret) return;
    if (Date.now() < this._tokenExpiresAt - 60_000) return;

    const params = new URLSearchParams({
      appkey: this._config.appKey,
      appsecret: this._config.appSecret,
    });

    const response = await fetch(`https://oapi.dingtalk.com/gettoken?${params}`);
    const data = await response.json() as { access_token: string; expires_in: number; errcode: number };

    if (data.errcode === 0 && data.access_token) {
      this._accessToken = data.access_token;
      this._tokenExpiresAt = Date.now() + data.expires_in * 1000;
      log.info("DingTalk access_token refreshed", { expiresIn: data.expires_in });
    } else {
      log.error("Failed to get DingTalk access_token", data);
    }
  }

  private _buildMessageBody(msg: ChannelOutgoingMessage): Record<string, unknown> {
    const at: Record<string, unknown> = {};
    if (msg.atAll) at.isAtAll = true;
    if (msg.atUsers?.length) at.atMobiles = msg.atUsers;

    if (msg.messageType === "markdown" && msg.markdown) {
      return {
        msgtype: "markdown",
        markdown: { title: msg.markdown.title, text: msg.markdown.text },
        at,
      };
    }

    if (msg.messageType === "actionCard" && msg.markdown) {
      return {
        msgtype: "actionCard",
        actionCard: {
          title: msg.markdown.title,
          text: msg.markdown.text,
          singleTitle: "查看详情",
          singleURL: "",
        },
      };
    }

    return {
      msgtype: "text",
      text: { content: msg.text || "" },
      at,
    };
  }

  private _parseCallback(raw: Record<string, unknown>): ChannelIncomingMessage | null {
    try {
      // 钉钉机器人回调消息格式
      const msgType = String(raw.msgtype || "text");
      const text = msgType === "text"
        ? String((raw.text as Record<string, unknown>)?.content || "")
        : String(raw.content || raw.text || "");

      if (!text.trim()) return null;

      const senderId = String(raw.senderStaffId || raw.senderId || raw.senderNick || "unknown");
      const senderName = String(raw.senderNick || raw.senderName || senderId);
      const conversationId = String(raw.conversationId || raw.chatbotCorpId || "default");
      const conversationType = String(raw.conversationType) === "1" ? "private" as const : "group" as const;

      const atUsers = raw.atUsers as Array<{ dingtalkId: string }> | undefined;
      const atBot = atUsers?.some((u) => u.dingtalkId === "$:LWCP_v1:$") ?? false;

      return {
        messageId: String(raw.msgId || Date.now()),
        senderId,
        senderName,
        text: text.replace(/@\S+\s*/g, "").trim(),
        messageType: msgType as ChannelIncomingMessage["messageType"],
        conversationId,
        conversationType,
        timestamp: Number(raw.createAt || Date.now()),
        atBot,
        raw,
      };
    } catch (err) {
      log.error("Failed to parse DingTalk callback", err);
      return null;
    }
  }
}
