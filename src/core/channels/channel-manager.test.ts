import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import type { ChannelConfig, IMChannel, MessageHandler } from "./types";
import { ChannelManager } from "./channel-manager";
import {
  CHANNEL_ROUTE_STORAGE_KEY,
  clearPersistedConversationRoutes,
  savePersistedConversationRoutes,
} from "./channel-route-persistence";

function createFakeChannel(): IMChannel {
  let handler: MessageHandler | null = null;
  return {
    type: "dingtalk",
    status: "connected",
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    onMessage: vi.fn((nextHandler: MessageHandler) => {
      handler = nextHandler;
      return () => {
        if (handler === nextHandler) {
          handler = null;
        }
      };
    }),
    getStatus: vi.fn(() => "connected"),
  };
}

function createChannelConfig(overrides?: Partial<ChannelConfig>): ChannelConfig {
  return {
    id: "ch-1",
    type: "dingtalk",
    name: "DingTalk Test",
    enabled: true,
    autoConnect: true,
    platformConfig: {},
    ...overrides,
  };
}

describe("ChannelManager route persistence", () => {
  beforeEach(() => {
    clearPersistedConversationRoutes();
    localStorage.clear();
  });

  it("persists routes from incoming channel messages and hydrates them on refresh", async () => {
    const manager = new ChannelManager();

    await (manager as unknown as {
      _dispatchMessage: (channelId: string, msg: Parameters<MessageHandler>[0]) => Promise<string | void>;
    })._dispatchMessage("ch-1", {
      messageId: "msg-1",
      senderId: "user-1",
      senderName: "Alice",
      text: "你好",
      messageType: "text",
      conversationId: "conv-1",
      conversationType: "private",
      timestamp: 1710000000000,
      replyWebhookUrl: "https://example.test/webhook",
      replyWebhookExpiresAt: Date.now() + 60_000,
      robotCode: "robot-1",
    });

    const persisted = JSON.parse(localStorage.getItem(CHANNEL_ROUTE_STORAGE_KEY) || "[]") as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      channelId: "ch-1",
      conversationId: "conv-1",
      conversationType: "private",
      targetUserId: "user-1",
      robotCode: "robot-1",
    });

    const reloaded = new ChannelManager();
    const restoredRoute = (reloaded as unknown as {
      _getConversationRoute: (channelId: string, conversationId: string) => Record<string, unknown> | null;
    })._getConversationRoute("ch-1", "conv-1");
    expect(restoredRoute).toMatchObject({
      channelId: "ch-1",
      conversationId: "conv-1",
      conversationType: "private",
      targetUserId: "user-1",
      robotCode: "robot-1",
    });
  });

  it("uses restored routes for scheduled reminders after refresh", async () => {
    savePersistedConversationRoutes([
      {
        key: "ch-1::conv-1",
        channelId: "ch-1",
        conversationId: "conv-1",
        conversationType: "private",
        targetUserId: "user-1",
        lastActiveAt: Date.now(),
        replyWebhookUrl: "https://example.test/webhook",
        replyWebhookExpiresAt: Date.now() + 60_000,
        robotCode: "robot-1",
      },
    ]);

    const manager = new ChannelManager();
    const fakeChannel = createFakeChannel();
    (manager as unknown as { channels: Map<string, { channel: IMChannel; config: ChannelConfig }> }).channels.set(
      "ch-1",
      {
        channel: fakeChannel,
        config: createChannelConfig(),
      },
    );

    const delivered = await manager.sendScheduledReminder({
      id: "task-1",
      origin_channel_id: "ch-1",
      origin_conversation_id: "conv-1",
      origin_mode: "dingtalk",
    }, "继续沿用之前上下文");

    expect(delivered).toBe(true);
    expect(fakeChannel.send).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      conversationType: "private",
      targetUserId: "user-1",
      replyWebhookUrl: "https://example.test/webhook",
      robotCode: "robot-1",
      text: "继续沿用之前上下文",
    }));
  });
});
