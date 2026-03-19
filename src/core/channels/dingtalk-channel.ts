/**
 * DingTalk Channel — 钉钉机器人 IM 通道实现
 *
 * 支持两种模式：
 * 1. Webhook 模式：通过 Webhook URL 发送消息（单向推送，适合通知场景）
 * 2. Stream 模式：通过 Tauri 后端建立钉钉 Stream 长连接接收消息（双向，适合交互场景）
 *
 * 当前实现：
 * - 入站：优先使用钉钉 Stream 长连接（无需公网回调）
 * - 出站：优先 OpenAPI，回退到 Webhook
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
  /** 机器人编码（群发 OpenAPI 使用；未填写时回退为 AppKey） */
  robotCode?: string;
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
  private _channelId: string | null = null;
  private _config: DingTalkConfig | null = null;
  private _handlers: MessageHandler[] = [];
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _recentIncomingMessageIds = new Map<string, number>();
  private _recentIncomingFingerprints = new Map<string, number>();
  private _recentOutboundFingerprints = new Map<string, number>();

  get status(): ChannelStatus {
    return this._status;
  }

  getStatus(): ChannelStatus {
    return this._status;
  }

  async connect(config: ChannelConfig): Promise<void> {
    const platform = config.platformConfig as unknown as DingTalkConfig;
    const hasWebhook = !!platform.webhookUrl?.trim();
    const hasAppPair = !!platform.appKey?.trim() && !!platform.appSecret?.trim();

    if (!hasWebhook && !hasAppPair) {
      throw new Error("钉钉通道需要配置 webhookUrl，或同时配置 appKey + appSecret");
    }

    this._config = platform;
    this._channelId = config.id;
    this._status = "connecting";

    try {
      if (hasAppPair) {
        await invoke("start_dingtalk_stream_channel", {
          channelId: config.id,
          clientId: platform.appKey!.trim(),
          clientSecret: platform.appSecret!.trim(),
        });
      }

      if (hasWebhook) {
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
    if (this._channelId && this._config?.appKey && this._config?.appSecret) {
      await invoke("stop_dingtalk_stream_channel", {
        channelId: this._channelId,
      }).catch((err) => {
        log.warn("Failed to stop DingTalk Stream channel", err);
      });
    }
    this._status = "disconnected";
    this._channelId = null;
    this._config = null;
    this._recentIncomingMessageIds.clear();
    this._recentIncomingFingerprints.clear();
    this._recentOutboundFingerprints.clear();
    log.info("DingTalk channel disconnected");
  }

  async send(msg: ChannelOutgoingMessage): Promise<void> {
    if (!this._config) throw new Error("DingTalk channel not connected");
    this._rememberOutboundMessage(msg);

    if (msg.replyWebhookUrl && !isWebhookExpired(msg.replyWebhookExpiresAt)) {
      try {
        await this._sendByWebhookUrl(msg.replyWebhookUrl, msg);
        return;
      } catch (err) {
        log.warn("DingTalk session webhook send failed, falling back to API/webhook", err);
      }
    }

    // 优先 App API 模式：有应用凭证且有明确的群会话 ID（非 "default"）
    if (this._config.appKey && this._config.appSecret && msg.conversationId && msg.conversationId !== "default") {
      await this._sendByApi(msg);
      return;
    }

    await this._sendByWebhook(msg);
  }

  private async _sendByApi(msg: ChannelOutgoingMessage): Promise<void> {
    const robotCode = msg.robotCode?.trim() || this._config!.robotCode?.trim() || this._config!.appKey?.trim();
    if (!robotCode) {
      throw new Error("钉钉发送缺少 robotCode（请在通道配置中补充，或使用会话回调回复）");
    }

    const outgoing = buildDingTalkAppPayload(msg);
    const body: Record<string, unknown> = {
      openConversationId: msg.conversationId,
      robotCode,
      msgKey: outgoing.msgKey,
      msgParam: outgoing.msgParam,
    };

    try {
      await invoke("dingtalk_send_app_message", {
        clientId: this._config!.appKey,
        clientSecret: this._config!.appSecret,
        robotCode: body.robotCode,
        openConversationId: body.openConversationId,
        msgKey: body.msgKey,
        msgParam: body.msgParam,
      });
      log.info("Message sent via DingTalk API", { conversationId: msg.conversationId });
    } catch (err) {
      log.warn("DingTalk API send failed, falling back to webhook", err);
      await this._sendByWebhook(msg);
    }
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

    await this._sendByWebhookUrl(url, msg);
    log.info("Message sent via DingTalk webhook", { conversationId: msg.conversationId });
  }

  private async _sendByWebhookUrl(url: string, msg: ChannelOutgoingMessage): Promise<void> {
    const body = this._buildMessageBody(msg);
    await invoke("dingtalk_send_webhook_message", {
      url,
      body,
    });
    log.info("Message sent via DingTalk webhook URL", { conversationId: msg.conversationId });
  }

  onMessage(handler: MessageHandler): () => void {
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== handler);
    };
  }

  /**
   * 处理来自 Tauri 后端转发的钉钉入站消息。
   * Tauri 端可能通过 Stream 长连接或本地回调服务接收，再统一 emit 到前端。
   */
  async handleIncomingCallback(raw: Record<string, unknown>): Promise<string | undefined> {
    const msg = this._parseCallback(raw);
    if (!msg) return;
    const now = Date.now();

    this._pruneRecentIncomingMessageIds();
    if (this._recentIncomingMessageIds.has(msg.messageId)) {
      log.info("Ignoring duplicated DingTalk callback", {
        messageId: msg.messageId,
        conversationId: msg.conversationId,
      });
      return;
    }
    this._recentIncomingMessageIds.set(msg.messageId, now);

    this._pruneRecentIncomingFingerprints();
    const inboundFingerprint = buildDingTalkIncomingFingerprint(msg);
    const recentInboundAt = inboundFingerprint
      ? this._recentIncomingFingerprints.get(inboundFingerprint)
      : undefined;
    if (recentInboundAt && now - recentInboundAt <= 10_000) {
      log.info("Ignoring replayed DingTalk callback by fingerprint", {
        messageId: msg.messageId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
      });
      return;
    }
    if (inboundFingerprint) {
      this._recentIncomingFingerprints.set(inboundFingerprint, now);
    }

    this._pruneRecentOutboundFingerprints();
    const recentOutboundAt = getRecentDingTalkOutboundFingerprintCandidates(msg)
      .map((fingerprint) => this._recentOutboundFingerprints.get(fingerprint))
      .find((timestamp): timestamp is number => typeof timestamp === "number");
    if (recentOutboundAt && now - recentOutboundAt <= 15_000) {
      log.info("Ignoring echoed DingTalk outbound message", {
        messageId: msg.messageId,
        conversationId: msg.conversationId,
      });
      return;
    }

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

  private _pruneRecentIncomingMessageIds(): void {
    if (this._recentIncomingMessageIds.size <= 200) return;
    const expireBefore = Date.now() - 10 * 60_000;
    for (const [messageId, timestamp] of this._recentIncomingMessageIds) {
      if (timestamp < expireBefore) {
        this._recentIncomingMessageIds.delete(messageId);
      }
    }
  }

  private _pruneRecentIncomingFingerprints(): void {
    if (this._recentIncomingFingerprints.size <= 400) return;
    const expireBefore = Date.now() - 2 * 60_000;
    for (const [fingerprint, timestamp] of this._recentIncomingFingerprints) {
      if (timestamp < expireBefore) {
        this._recentIncomingFingerprints.delete(fingerprint);
      }
    }
  }

  private _pruneRecentOutboundFingerprints(): void {
    if (this._recentOutboundFingerprints.size <= 400) return;
    const expireBefore = Date.now() - 2 * 60_000;
    for (const [fingerprint, timestamp] of this._recentOutboundFingerprints) {
      if (timestamp < expireBefore) {
        this._recentOutboundFingerprints.delete(fingerprint);
      }
    }
  }

  private _rememberOutboundMessage(msg: ChannelOutgoingMessage): void {
    const text = normalizeDingTalkMessageText(msg);
    if (!text) return;
    this._pruneRecentOutboundFingerprints();
    for (const fingerprint of buildDingTalkOutboundFingerprints(msg.conversationId, text)) {
      this._recentOutboundFingerprints.set(fingerprint, Date.now());
    }
  }

  private _buildMessageBody(msg: ChannelOutgoingMessage): Record<string, unknown> {
    const at: Record<string, unknown> = {};
    if (msg.atAll) at.isAtAll = true;
    if (msg.atUsers?.length) at.atMobiles = msg.atUsers;

    const explicitMarkdown = resolveMarkdownContent(msg);
    if (explicitMarkdown) {
      return {
        msgtype: "markdown",
        markdown: explicitMarkdown,
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

    const text = msg.text || "";
    if (looksLikeMarkdown(text)) {
      return {
        msgtype: "markdown",
        markdown: {
          title: inferDingTalkMarkdownTitle(text),
          text,
        },
        at,
      };
    }

    return {
      msgtype: "text",
      text: { content: text },
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

      const senderId = pickFirstString(
        raw.senderStaffId,
        raw.senderId,
        raw.senderNick,
      );
      if (isDingTalkSelfMessage(raw, senderId)) {
        log.info("Ignoring self-sent DingTalk callback", {
          senderId,
          chatbotUserId: pickFirstString(raw.chatbotUserId),
          robotCode: pickFirstString(raw.robotCode),
        });
        return null;
      }

      const senderName = String(raw.senderNick || raw.senderName || senderId || "unknown");
      const conversationType = resolveDingTalkConversationType(raw.conversationType);
      const conversationId = resolveDingTalkConversationId(raw, conversationType, senderId);
      if (!conversationId) {
        log.warn("Ignoring DingTalk callback without stable conversation id", {
          messageId: pickFirstString(raw.msgId),
          senderId,
          conversationType,
          availableKeys: Object.keys(raw),
        });
        return null;
      }

      const atUsers = raw.atUsers as Array<{ dingtalkId: string }> | undefined;
      const atBot = atUsers?.some((u) => u.dingtalkId === "$:LWCP_v1:$") ?? false;

      return {
        messageId: String(raw.msgId || Date.now()),
        senderId: senderId || "unknown",
        senderName,
        text: text.replace(/@\S+\s*/g, "").trim(),
        messageType: msgType as ChannelIncomingMessage["messageType"],
        conversationId,
        conversationType,
        timestamp: Number(raw.createAt || Date.now()),
        atBot,
        replyWebhookUrl: typeof raw.sessionWebhook === "string" ? raw.sessionWebhook : undefined,
        replyWebhookExpiresAt: toTimestamp(raw.sessionWebhookExpiredTime),
        robotCode: typeof raw.robotCode === "string" ? raw.robotCode : undefined,
        raw,
      };
    } catch (err) {
      log.error("Failed to parse DingTalk callback", err);
      return null;
    }
  }
}

function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function resolveDingTalkConversationType(value: unknown): "private" | "group" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "1" || normalized === "private" || normalized === "single" || normalized === "p2p") {
    return "private";
  }
  return "group";
}

function isDingTalkSelfMessage(raw: Record<string, unknown>, senderId: string): boolean {
  const chatbotUserId = pickFirstString(raw.chatbotUserId);
  if (chatbotUserId && senderId === chatbotUserId) {
    return true;
  }

  const robotCode = pickFirstString(raw.robotCode);
  if (robotCode && senderId === robotCode) {
    return true;
  }

  return false;
}

function resolveDingTalkConversationId(
  raw: Record<string, unknown>,
  conversationType: "private" | "group",
  senderId: string,
): string {
  if (conversationType === "private") {
    return pickFirstString(
      raw.conversationId,
      raw.openConversationId,
      raw.sessionWebhook,
      raw.senderId,
      raw.senderStaffId,
      senderId,
    );
  }

  return pickFirstString(
    raw.conversationId,
    raw.openConversationId,
    raw.openThreadId,
    raw.sessionWebhook,
  );
}

function normalizeDingTalkText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

function buildDingTalkIncomingFingerprint(msg: ChannelIncomingMessage): string {
  const normalizedText = normalizeDingTalkText(msg.text);
  if (!normalizedText) return "";
  return [
    msg.conversationType,
    msg.conversationId || "unknown-conversation",
    msg.senderId || "unknown-sender",
    normalizedText,
  ].join("::");
}

function buildDingTalkOutboundFingerprints(conversationId: string | undefined, normalizedText: string): string[] {
  if (!normalizedText) return [];
  const fingerprints = [normalizedText];
  const normalizedConversationId = (conversationId || "").trim();
  if (normalizedConversationId) {
    fingerprints.unshift(`${normalizedConversationId}::${normalizedText}`);
  }
  return fingerprints;
}

function getRecentDingTalkOutboundFingerprintCandidates(msg: ChannelIncomingMessage): string[] {
  const normalizedText = normalizeDingTalkText(msg.text);
  if (!normalizedText) return [];
  return buildDingTalkOutboundFingerprints(msg.conversationId, normalizedText);
}

function normalizeDingTalkMessageText(msg: ChannelOutgoingMessage): string {
  const explicitMarkdown = resolveMarkdownContent(msg);
  const text = explicitMarkdown?.text ?? msg.text ?? "";
  return normalizeDingTalkText(text);
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
    }
  }
  return undefined;
}

function isWebhookExpired(expiresAt?: number): boolean {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt - 1000;
}

function resolveMarkdownContent(
  msg: ChannelOutgoingMessage,
): { title: string; text: string } | null {
  if (msg.messageType === "markdown" && msg.markdown) {
    return {
      title: msg.markdown.title?.trim() || "消息",
      text: msg.markdown.text,
    };
  }
  return null;
}

function buildDingTalkAppPayload(msg: ChannelOutgoingMessage): {
  msgKey: "sampleText" | "sampleMarkdown";
  msgParam: string;
} {
  const explicitMarkdown = resolveMarkdownContent(msg);
  if (explicitMarkdown) {
    return {
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify(explicitMarkdown),
    };
  }

  const text = msg.text || "";
  if (looksLikeMarkdown(text)) {
    return {
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        title: inferDingTalkMarkdownTitle(text),
        text,
      }),
    };
  }

  return {
    msgKey: "sampleText",
    msgParam: JSON.stringify({ content: text }),
  };
}

function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|>\s|\d+\.\s|\[[ xX]\]\s)/m.test(text)
    || /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\))/m.test(text)
    || /```[\s\S]*?```/.test(text)
    || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function inferDingTalkMarkdownTitle(text: string): string {
  const firstHeading = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+/.test(line));

  if (firstHeading) {
    return firstHeading.replace(/^#{1,6}\s+/, "").trim().slice(0, 80) || "消息";
  }

  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine?.slice(0, 80) || "消息";
}
