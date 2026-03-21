/**
 * IM Channel 抽象层 — 统一不同 IM 平台的消息收发接口
 *
 * 支持的平台通过实现 IMChannel 接口接入，当前规划：
 * - 钉钉（DingTalk）— 已实现
 * - 企业微信（WeCom）— 预留
 * - 飞书（Feishu/Lark）— 预留
 * - Slack — 预留
 */

/** 通道状态 */
export type ChannelStatus = "disconnected" | "connecting" | "connected" | "error";

/** 收到的 IM 消息 */
export interface ChannelIncomingMessage {
  /** 消息 ID（IM 平台原始 ID） */
  messageId: string;
  /** 发送者 ID */
  senderId: string;
  /** 发送者名称 */
  senderName: string;
  /** 文本内容 */
  text: string;
  /** 消息类型 */
  messageType: "text" | "image" | "file" | "markdown" | "interactive";
  /** 会话 ID（群聊 ID 或私聊 ID） */
  conversationId: string;
  /** 会话类型 */
  conversationType: "private" | "group";
  /** 时间戳 */
  timestamp: number;
  /** 是否 @了机器人 */
  atBot?: boolean;
  /** 会话级回复 webhook（如钉钉 sessionWebhook） */
  replyWebhookUrl?: string;
  /** 会话级回复 webhook 过期时间戳 */
  replyWebhookExpiresAt?: number;
  /** 平台机器人编码（如钉钉 robotCode） */
  robotCode?: string;
  /** 附带的图片路径（IM 平台原始下载地址或代码） */
  images?: string[];
  /** 附带的文件列表 */
  attachments?: Array<{
    name: string;
    downloadCode: string;
  }>;
  /** 原始消息数据 */
  raw?: unknown;
}

/** 发送的 IM 消息 */
export interface ChannelOutgoingMessage {
  /** 目标会话 ID */
  conversationId: string;
  /** 会话类型 */
  conversationType?: ChannelIncomingMessage["conversationType"];
  /** 私聊目标用户 ID（如钉钉单聊 API 所需 userId） */
  targetUserId?: string;
  /** OpenClaw 风格的单个媒体引用（本地路径/file URL；兼容旧字段） */
  mediaUrl?: string;
  /** OpenClaw 风格的多个媒体引用（本地路径/file URL；兼容旧字段） */
  mediaUrls?: string[];
  /** 回复的目标消息 ID（如平台支持） */
  replyToMessageId?: string;
  /** 会话级回复 webhook（如钉钉 sessionWebhook） */
  replyWebhookUrl?: string;
  /** 会话级回复 webhook 过期时间戳 */
  replyWebhookExpiresAt?: number;
  /** 平台机器人编码（如钉钉 robotCode） */
  robotCode?: string;
  /** 文本内容 */
  text?: string;
  /** Markdown 内容 */
  markdown?: { title: string; text: string };
  /** 消息类型（默认 text） */
  messageType?: "text" | "markdown" | "actionCard" | "feedCard" | "image" | "file";
  /** 附带的图片路径（本地文件路径，兼容旧字段） */
  images?: string[];
  /** 附带的文件列表（兼容旧字段） */
  attachments?: Array<{
    path: string;
    fileName?: string;
  }>;
  /** 是否 @所有人 */
  atAll?: boolean;
  /** @指定人的手机号或 ID 列表 */
  atUsers?: string[];
}

/** 通道配置（通用字段） */
export interface ChannelConfig {
  /** 通道唯一标识 */
  id: string;
  /** 通道类型 */
  type: ChannelType;
  /** 显示名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 启动时是否自动连接 */
  autoConnect?: boolean;
  /** 平台特定配置 */
  platformConfig: Record<string, unknown>;
}

export type ChannelType = "dingtalk" | "feishu";

/** 消息处理器 */
export type MessageHandler = (msg: ChannelIncomingMessage) => Promise<string | void>;

/** IM Channel 接口 */
export interface IMChannel {
  readonly type: ChannelType;
  readonly status: ChannelStatus;

  /** 连接/启动通道 */
  connect(config: ChannelConfig): Promise<void>;
  /** 断开通道 */
  disconnect(): Promise<void>;
  /** 发送消息 */
  send(msg: ChannelOutgoingMessage): Promise<void>;
  /** 注册消息处理器 */
  onMessage(handler: MessageHandler): () => void;
  /** 获取通道状态 */
  getStatus(): ChannelStatus;
}
