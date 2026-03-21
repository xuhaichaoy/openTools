import { createLogger } from "@/core/logger";
import type { ChannelType } from "./types";

const log = createLogger("ChannelProgressEmitter");

export type IMConversationProgressKind =
  | "accepted"
  | "queued"
  | "running"
  | "waiting_reply"
  | "waiting_approval";

export interface IMConversationProgressEvent {
  channelId: string;
  channelType: ChannelType;
  conversationId: string;
  topicId: string;
  messageId?: string;
  kind: IMConversationProgressKind;
  queueLength?: number;
  detail?: string;
}

interface ChannelProgressEmitterOptions {
  sendProgress: (params: {
    channelId: string;
    conversationId: string;
    message: string;
  }) => Promise<void>;
  startFeishuTyping: (params: {
    channelId: string;
    conversationId: string;
    messageId: string;
  }) => Promise<void>;
}

export class ChannelProgressEmitter {
  private readonly options: ChannelProgressEmitterOptions;
  constructor(options: ChannelProgressEmitterOptions) {
    this.options = options;
  }

  async emit(event: IMConversationProgressEvent): Promise<void> {
    if (event.channelType === "feishu") {
      await this.emitFeishuProgress(event);
    }
    // 恢复更接近旧逻辑的 IM 体验：
    // 飞书保留输入态；钉钉和其他通道不再主动发送“处理中/排队中/等待确认”文本消息。
  }

  clear(_channelId: string, _conversationId: string, _topicId?: string): void {}

  dispose(): void {}

  private async emitFeishuProgress(event: IMConversationProgressEvent): Promise<void> {
    if (!event.messageId) return;
    if (
      event.kind !== "accepted"
      && event.kind !== "running"
      && event.kind !== "waiting_reply"
      && event.kind !== "waiting_approval"
    ) {
      return;
    }

    try {
      await this.options.startFeishuTyping({
        channelId: event.channelId,
        conversationId: event.conversationId,
        messageId: event.messageId,
      });
    } catch (error) {
      log.warn("Failed to update Feishu typing progress", error);
    }
  }
}
