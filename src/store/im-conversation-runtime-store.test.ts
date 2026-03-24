import { beforeEach, describe, expect, it } from "vitest";
import { useIMConversationRuntimeStore } from "./im-conversation-runtime-store";

describe("IMConversationRuntimeStore external overlays", () => {
  beforeEach(() => {
    useIMConversationRuntimeStore.getState().reset();
  });

  it("keeps external export conversation visible across runtime refreshes", () => {
    const store = useIMConversationRuntimeStore.getState();

    store.upsertExternalConversationTurn({
      channelId: "channel-1",
      channelType: "dingtalk",
      conversationId: "conversation-1",
      conversationType: "private",
      content: "帮我从数据库导出昨天已支付订单",
      from: "user",
      status: "running",
      messageId: "msg-user-1",
      timestamp: 1710000000000,
      displayLabel: "Alice",
      displayDetail: "钉钉 · 私聊",
    });

    store.upsertExternalConversationTurn({
      channelId: "channel-1",
      channelType: "dingtalk",
      conversationId: "conversation-1",
      conversationType: "private",
      content: "已生成导出预览，请回复“确认导出”。",
      from: "assistant",
      status: "waiting",
      timestamp: 1710000001000,
      displayLabel: "Alice",
      displayDetail: "钉钉 · 私聊",
    });

    let snapshot = useIMConversationRuntimeStore.getState();
    expect(snapshot.conversations).toHaveLength(1);
    expect(Object.keys(snapshot.sessionPreviews)).toHaveLength(1);

    const preview = Object.values(snapshot.sessionPreviews)[0];
    expect(preview.displayLabel).toBe("Alice");
    expect(preview.status).toBe("waiting");
    expect(preview.dialogHistory.map((message) => message.content)).toEqual([
      "帮我从数据库导出昨天已支付订单",
      "已生成导出预览，请回复“确认导出”。",
    ]);

    snapshot.replaceRuntimeData({ conversations: [], sessionPreviews: [] });
    snapshot = useIMConversationRuntimeStore.getState();

    expect(snapshot.conversations).toHaveLength(1);
    expect(Object.values(snapshot.sessionPreviews)[0]?.dialogHistory).toHaveLength(2);

    snapshot.replaceRuntimeData({
      conversations: [
        {
          key: "channel-1::conversation-1",
          channelId: "channel-1",
          channelType: "dingtalk",
          conversationId: "conversation-1",
          conversationType: "private",
          displayLabel: "旧 runtime",
          displayDetail: "钉钉 · 私聊",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 1710000009999,
          activeSessionId: "runtime-session-old",
          activeStatus: "running",
          activeQueueLength: 0,
          executionStrategy: "direct",
          pendingInteractionCount: 0,
          childSessionsPreview: [],
          queuedFollowUpCount: 0,
          contractState: null,
          backgroundTopicCount: 0,
          topics: [],
        },
      ],
      sessionPreviews: [
        {
          sessionId: "runtime-session-old",
          runtimeKey: "channel-1::conversation-1::default",
          channelId: "channel-1",
          channelType: "dingtalk",
          conversationId: "conversation-1",
          conversationType: "private",
          topicId: "default",
          displayLabel: "旧 runtime",
          displayDetail: "钉钉 · 私聊",
          status: "running",
          queueLength: 0,
          executionStrategy: "direct",
          pendingInteractionCount: 0,
          childSessionsPreview: [],
          queuedFollowUpCount: 0,
          contractState: null,
          startedAt: 1,
          updatedAt: 1710000009999,
          actors: [{ id: "agent-old", roleName: "Lead", status: "running" }],
          dialogHistory: [
            {
              id: "old-runtime-msg",
              from: "agent-old",
              content: "旧 runtime 回复",
              timestamp: 1710000009999,
              priority: "normal",
              kind: "agent_result",
            },
          ],
        },
      ],
    });
    snapshot = useIMConversationRuntimeStore.getState();

    expect(snapshot.conversations).toHaveLength(1);
    expect(snapshot.conversations[0]?.activeSessionId?.startsWith("im-export::")).toBe(true);
    const overlayPreview = snapshot.conversations[0]?.activeSessionId
      ? snapshot.sessionPreviews[snapshot.conversations[0].activeSessionId]
      : undefined;
    expect(overlayPreview?.dialogHistory.map((message) => message.content)).toEqual([
      "帮我从数据库导出昨天已支付订单",
      "已生成导出预览，请回复“确认导出”。",
      "旧 runtime 回复",
    ]);

    snapshot.clearChannel("channel-1");
    snapshot = useIMConversationRuntimeStore.getState();
    expect(snapshot.conversations).toHaveLength(0);
    expect(Object.keys(snapshot.sessionPreviews)).toHaveLength(0);
  });

  it("reuses the existing runtime session when export turns append into the same chat", () => {
    const store = useIMConversationRuntimeStore.getState();

    store.replaceRuntimeData({
      conversations: [
        {
          key: "channel-1::conversation-1",
          channelId: "channel-1",
          channelType: "dingtalk",
          conversationId: "conversation-1",
          conversationType: "private",
          displayLabel: "Alice",
          displayDetail: "钉钉 · 私聊",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 10,
          activeSessionId: "runtime-session-1",
          activeStatus: "waiting",
          activeQueueLength: 0,
          executionStrategy: "direct",
          pendingInteractionCount: 0,
          childSessionsPreview: [],
          queuedFollowUpCount: 0,
          contractState: null,
          backgroundTopicCount: 0,
          topics: [],
        },
      ],
      sessionPreviews: [
        {
          sessionId: "runtime-session-1",
          runtimeKey: "channel-1::conversation-1::default",
          channelId: "channel-1",
          channelType: "dingtalk",
          conversationId: "conversation-1",
          conversationType: "private",
          topicId: "default",
          displayLabel: "Alice",
          displayDetail: "钉钉 · 私聊",
          status: "waiting",
          queueLength: 0,
          executionStrategy: "direct",
          pendingInteractionCount: 0,
          childSessionsPreview: [],
          queuedFollowUpCount: 0,
          contractState: null,
          startedAt: 1,
          updatedAt: 10,
          lastInputText: "历史提问",
          actors: [{ id: "agent-old", roleName: "Lead", status: "idle" }],
          dialogHistory: [
            {
              id: "old-1",
              from: "user",
              content: "历史提问",
              timestamp: 1,
              priority: "normal",
              kind: "user_input",
            },
            {
              id: "old-2",
              from: "agent-old",
              content: "历史回答",
              timestamp: 2,
              priority: "normal",
              kind: "agent_result",
            },
          ],
        },
      ],
    });

    store.upsertExternalConversationTurn({
      channelId: "channel-1",
      channelType: "dingtalk",
      conversationId: "conversation-1",
      conversationType: "private",
      content: "帮我导出数据",
      from: "user",
      status: "running",
      messageId: "msg-user-1",
      timestamp: 20,
      displayLabel: "Alice",
      displayDetail: "钉钉 · 私聊",
    });

    const snapshot = useIMConversationRuntimeStore.getState();
    const activeSessionId = snapshot.conversations.find(
      (item) => item.key === "channel-1::conversation-1",
    )?.activeSessionId;
    const preview = activeSessionId ? snapshot.sessionPreviews[activeSessionId] : undefined;
    expect(activeSessionId).toBe("runtime-session-1");
    expect(preview?.dialogHistory.map((message) => message.content)).toEqual([
      "历史提问",
      "历史回答",
      "帮我导出数据",
    ]);
    expect(preview?.actors.map((actor) => actor.id)).toEqual(["agent-old", "agent-data-export"]);
    expect(preview?.displayLabel).toBe("Alice");
    expect(preview?.displayDetail).toBe("钉钉 · 私聊");
  });

  it("preserves and refreshes conversation mode across external overlay updates", () => {
    const store = useIMConversationRuntimeStore.getState();

    store.upsertExternalConversationTurn({
      channelId: "channel-mode",
      channelType: "dingtalk",
      conversationId: "conversation-mode",
      conversationType: "private",
      content: "数据库操作",
      from: "user",
      status: "running",
      timestamp: 100,
      conversationMode: "database_operation",
    });

    let snapshot = useIMConversationRuntimeStore.getState();
    let activeSessionId = snapshot.conversations[0]?.activeSessionId;
    let preview = activeSessionId ? snapshot.sessionPreviews[activeSessionId] : undefined;
    expect(snapshot.conversations[0]?.conversationMode).toBe("database_operation");
    expect(preview?.conversationMode).toBe("database_operation");

    store.replaceRuntimeData({
      conversations: [
        {
          key: "channel-mode::conversation-mode",
          channelId: "channel-mode",
          channelType: "dingtalk",
          conversationId: "conversation-mode",
          conversationType: "private",
          displayLabel: "Alice",
          displayDetail: "钉钉 · 私聊",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 120,
          activeSessionId: "runtime-mode-session",
          activeStatus: "idle",
          activeQueueLength: 0,
          executionStrategy: "direct",
          pendingInteractionCount: 0,
          childSessionsPreview: [],
          queuedFollowUpCount: 0,
          contractState: null,
          backgroundTopicCount: 0,
          topics: [],
        },
      ],
      sessionPreviews: [
        {
          sessionId: "runtime-mode-session",
          runtimeKey: "channel-mode::conversation-mode::default",
          channelId: "channel-mode",
          channelType: "dingtalk",
          conversationId: "conversation-mode",
          conversationType: "private",
          topicId: "default",
          displayLabel: "Alice",
          displayDetail: "钉钉 · 私聊",
          status: "idle",
          queueLength: 0,
          executionStrategy: "direct",
          pendingInteractionCount: 0,
          childSessionsPreview: [],
          queuedFollowUpCount: 0,
          contractState: null,
          startedAt: 1,
          updatedAt: 120,
          actors: [],
          dialogHistory: [],
        },
      ],
    });

    snapshot = useIMConversationRuntimeStore.getState();
    activeSessionId = snapshot.conversations[0]?.activeSessionId;
    preview = activeSessionId ? snapshot.sessionPreviews[activeSessionId] : undefined;
    expect(snapshot.conversations[0]?.conversationMode).toBe("database_operation");
    expect(preview?.conversationMode).toBe("database_operation");

    store.upsertExternalConversationTurn({
      channelId: "channel-mode",
      channelType: "dingtalk",
      conversationId: "conversation-mode",
      conversationType: "private",
      content: "已退出数据库操作模式",
      from: "assistant",
      status: "idle",
      timestamp: 130,
      conversationMode: "normal",
    });

    snapshot = useIMConversationRuntimeStore.getState();
    activeSessionId = snapshot.conversations[0]?.activeSessionId;
    preview = activeSessionId ? snapshot.sessionPreviews[activeSessionId] : undefined;
    expect(snapshot.conversations[0]?.conversationMode).toBe("normal");
    expect(preview?.conversationMode).toBe("normal");
  });

  it("keeps external overlay images visible in desktop previews", () => {
    const store = useIMConversationRuntimeStore.getState();

    store.upsertExternalConversationTurn({
      channelId: "channel-media",
      channelType: "dingtalk",
      conversationId: "conversation-media",
      conversationType: "private",
      content: "已从 Downloads 选取并发送图片。",
      from: "assistant",
      status: "idle",
      timestamp: 1710000010000,
      displayLabel: "Alice",
      displayDetail: "钉钉 · 私聊",
      images: ["/Users/haichao/Downloads/demo.png"],
      attachments: [{ path: "/Users/haichao/Downloads/report.pdf", fileName: "report.pdf" }],
    });

    const snapshot = useIMConversationRuntimeStore.getState();
    const preview = Object.values(snapshot.sessionPreviews)[0];
    const lastMessage = preview?.dialogHistory[preview.dialogHistory.length - 1];

    expect(lastMessage?.images).toEqual(["/Users/haichao/Downloads/demo.png"]);
    expect(lastMessage?.attachments).toEqual([
      { path: "/Users/haichao/Downloads/report.pdf", fileName: "report.pdf" },
    ]);
  });
});
