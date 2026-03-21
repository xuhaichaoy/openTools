import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ChannelConfig, ChannelIncomingMessage } from "./types";
import { DingTalkChannel } from "./dingtalk-channel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const APP_CONFIG: ChannelConfig = {
  id: "ding-test",
  type: "dingtalk",
  name: "DingTalk Test",
  enabled: true,
  platformConfig: {
    appKey: "ding-app-key",
    appSecret: "ding-app-secret",
    webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=test",
  },
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("DingTalkChannel.handleIncomingCallback", () => {
  it("parses classic callback payloads into channel messages", async () => {
    const channel = new DingTalkChannel();
    const received: ChannelIncomingMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.handleIncomingCallback({
      msgId: "msg-1",
      msgtype: "text",
      text: { content: "你好 @机器人" },
      senderStaffId: "user-1",
      senderNick: "Alice",
      conversationType: "1",
      openConversationId: "conv-1",
      sessionWebhook: "https://example.com/reply",
      sessionWebhookExpiredTime: "1710000000000",
      createAt: 1710000000000,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      messageId: "msg-1",
      senderId: "user-1",
      senderName: "Alice",
      text: "你好",
      conversationId: "conv-1",
      conversationType: "private",
      replyWebhookUrl: "https://example.com/reply",
      replyWebhookExpiresAt: 1710000000000,
    });
  });

  it("accepts stream-style payload variants with messageId, chatId and nested text", async () => {
    const channel = new DingTalkChannel();
    const received: ChannelIncomingMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.handleIncomingCallback({
      messageId: "evt-2",
      messageType: "text",
      msgData: {
        text: {
          content: "请帮我排查一下",
        },
      },
      senderId: "user-2",
      senderName: "Bob",
      chatType: "2",
      chatId: "chat-2",
      createTime: 1710000000,
      robot_code: "dingxxxx",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      messageId: "evt-2",
      senderId: "user-2",
      senderName: "Bob",
      text: "请帮我排查一下",
      conversationId: "chat-2",
      conversationType: "group",
      robotCode: "dingxxxx",
      timestamp: 1710000000000,
    });
  });

  it("downloads incoming picture messages to local image paths before forwarding", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          downloadCode: "img-code-1",
          path: "/tmp/dingtalk-image-1.png",
          fileName: "dingtalk-image-1.png",
          contentType: "image/png",
        },
      ]);

    const channel = new DingTalkChannel();
    const received: ChannelIncomingMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect(APP_CONFIG);
    await channel.handleIncomingCallback({
      msgId: "msg-image-1",
      msgtype: "picture",
      content: {
        downloadCode: "img-code-1",
        pictureDownloadCode: "img-code-1",
      },
      senderStaffId: "user-3",
      senderNick: "Carol",
      conversationType: "2",
      openConversationId: "conv-image-1",
      robotCode: "ding-robot",
      createAt: 1710000000000,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      messageId: "msg-image-1",
      messageType: "image",
      text: "[图片]",
      images: ["/tmp/dingtalk-image-1.png"],
      conversationId: "conv-image-1",
      conversationType: "group",
    });
    expect(invokeMock).toHaveBeenCalledWith("dingtalk_download_files", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      robotCode: "ding-robot",
      downloadCodes: ["img-code-1"],
    });
  });

  it("prefers downloadCode over pictureDownloadCode for the same image payload", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          downloadCode: "primary-code",
          path: "/tmp/dingtalk-image-2.png",
          fileName: "dingtalk-image-2.png",
          contentType: "image/png",
        },
      ]);

    const channel = new DingTalkChannel();
    const received: ChannelIncomingMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect(APP_CONFIG);
    await channel.handleIncomingCallback({
      msgId: "msg-image-2",
      msgtype: "picture",
      content: {
        downloadCode: "primary-code",
        pictureDownloadCode: "secondary-code",
      },
      senderStaffId: "user-4",
      senderNick: "Dora",
      conversationType: "2",
      openConversationId: "conv-image-2",
      robotCode: "ding-robot",
      createAt: 1710000000000,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.images).toEqual(["/tmp/dingtalk-image-2.png"]);
    expect(invokeMock).toHaveBeenCalledWith("dingtalk_download_files", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      robotCode: "ding-robot",
      downloadCodes: ["primary-code"],
    });
  });

  it("parses richText image callbacks without dropping the message", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          downloadCode: "primary-rich-code",
          path: "/tmp/dingtalk-image-3.png",
          fileName: "dingtalk-image-3.png",
          contentType: "image/png",
        },
      ]);

    const channel = new DingTalkChannel();
    const received: ChannelIncomingMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect(APP_CONFIG);
    await channel.handleIncomingCallback({
      msgId: "msg-image-3",
      msgtype: "richText",
      content: {
        richText: [
          {
            pictureDownloadCode: "secondary-rich-code",
            downloadCode: "primary-rich-code",
            type: "picture",
          },
          {
            text: "\n",
          },
          {
            text: "获取图片时间",
          },
        ],
      },
      senderStaffId: "user-5",
      senderNick: "Eve",
      conversationType: "1",
      openConversationId: "conv-image-3",
      robotCode: "ding-robot",
      createAt: 1710000000000,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      messageId: "msg-image-3",
      messageType: "image",
      text: "获取图片时间",
      images: ["/tmp/dingtalk-image-3.png"],
      conversationId: "conv-image-3",
      conversationType: "private",
    });
    expect(invokeMock).toHaveBeenCalledWith("dingtalk_download_files", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      robotCode: "ding-robot",
      downloadCodes: ["primary-rich-code"],
    });
  });
});

describe("DingTalkChannel.send", () => {
  it("uploads local images and sends them as DingTalk media messages", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("media-image-1")
      .mockResolvedValueOnce(undefined);

    const channel = new DingTalkChannel();
    await channel.connect(APP_CONFIG);
    await channel.send({
      conversationId: "conv-send-1",
      conversationType: "group",
      robotCode: "ding-robot",
      images: ["/tmp/final-shot.png"],
    });

    expect(invokeMock).toHaveBeenCalledWith("dingtalk_upload_media", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      mediaType: "image",
      filePath: "/tmp/final-shot.png",
    });
    expect(invokeMock).toHaveBeenCalledWith("dingtalk_send_app_message", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      robotCode: "ding-robot",
      openConversationId: "conv-send-1",
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        title: "图片",
        text: "![图片](media-image-1)",
      }),
    });
  });

  it("supports openclaw-style mediaUrl for local images", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("media-image-openclaw")
      .mockResolvedValueOnce(undefined);

    const channel = new DingTalkChannel();
    await channel.connect(APP_CONFIG);
    await channel.send({
      conversationId: "conv-send-openclaw-1",
      conversationType: "group",
      robotCode: "ding-robot",
      mediaUrl: "/tmp/openclaw-style.png",
    });

    expect(invokeMock).toHaveBeenCalledWith("dingtalk_upload_media", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      mediaType: "image",
      filePath: "/tmp/openclaw-style.png",
    });
    expect(invokeMock).toHaveBeenCalledWith("dingtalk_send_app_message", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      robotCode: "ding-robot",
      openConversationId: "conv-send-openclaw-1",
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        title: "图片",
        text: "![图片](media-image-openclaw)",
      }),
    });
  });

  it("does not bypass media upload when replying through session webhook", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("media-image-2")
      .mockResolvedValueOnce(undefined);

    const channel = new DingTalkChannel();
    await channel.connect(APP_CONFIG);
    await channel.send({
      conversationId: "conv-send-2",
      conversationType: "group",
      replyWebhookUrl: "https://example.com/reply",
      images: ["/tmp/session-shot.png"],
    });

    expect(invokeMock).toHaveBeenCalledWith("dingtalk_upload_media", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      mediaType: "image",
      filePath: "/tmp/session-shot.png",
    });
    expect(invokeMock).toHaveBeenCalledWith("dingtalk_send_app_message", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      robotCode: "ding-app-key",
      openConversationId: "conv-send-2",
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({
        title: "图片",
        text: "![图片](media-image-2)",
      }),
    });
  });

  it("sends private images through the single-chat DingTalk API", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        running: true,
        starting: false,
        host: "127.0.0.1",
        port: 21947,
        baseUrl: "http://127.0.0.1:21947",
        callbackBaseUrl: "http://127.0.0.1:21947/callbacks/im",
        lastError: null,
      })
      .mockResolvedValueOnce("http://127.0.0.1:21947/callbacks/im/media/private-image-token")
      .mockResolvedValueOnce(undefined);

    const channel = new DingTalkChannel();
    await channel.connect(APP_CONFIG);
    await channel.send({
      conversationId: "cid-private-1",
      conversationType: "private",
      targetUserId: "user-private-1",
      robotCode: "ding-robot",
      images: ["/tmp/private-shot.png"],
    });

    expect(invokeMock).toHaveBeenCalledWith("dingtalk_send_app_single_message", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      robotCode: "ding-robot",
      userId: "user-private-1",
      msgKey: "sampleImageMsg",
      msgParam: JSON.stringify({
        photoURL: "http://127.0.0.1:21947/callbacks/im/media/private-image-token",
      }),
    });
  });

  it("uses photoURL directly for private HTTP image refs", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const channel = new DingTalkChannel();
    await channel.connect(APP_CONFIG);
    await channel.send({
      conversationId: "cid-private-2",
      conversationType: "private",
      targetUserId: "user-private-2",
      robotCode: "ding-robot",
      images: ["https://example.com/rendered.png"],
    });

    expect(invokeMock).not.toHaveBeenCalledWith("dingtalk_upload_media", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("dingtalk_send_app_single_message", {
      clientId: "ding-app-key",
      clientSecret: "ding-app-secret",
      robotCode: "ding-robot",
      userId: "user-private-2",
      msgKey: "sampleImageMsg",
      msgParam: JSON.stringify({
        photoURL: "https://example.com/rendered.png",
      }),
    });
  });
});
