import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/agent/actor/actor-transcript", () => ({
  appendDialogMessageSync: vi.fn(),
  appendSpawnEventSync: vi.fn(),
  appendAnnounceEventSync: vi.fn(),
  updateTranscriptActors: vi.fn(async () => undefined),
  archiveSession: vi.fn(async () => undefined),
  deleteTranscriptSession: vi.fn(async () => undefined),
  clearSessionCache: vi.fn(),
}));

import { clearAllRuntimeSessions } from "@/core/agent/context-runtime/runtime-state";
import { useIMConversationRuntimeStore } from "@/store/im-conversation-runtime-store";
import {
  clearPersistedIMConversationRuntimeSnapshot,
  savePersistedIMConversationRuntimeSnapshot,
} from "./im-conversation-persistence";
import { IMConversationRuntimeManager } from "./im-conversation-runtime-manager";

describe("IMConversationRuntimeManager persistence", () => {
  beforeEach(() => {
    clearAllRuntimeSessions();
    clearPersistedIMConversationRuntimeSnapshot();
    localStorage.clear();
    useIMConversationRuntimeStore.getState().reset();
  });

  it("hydrates persisted IM runtimes and preserves dialog history previews", () => {
    savePersistedIMConversationRuntimeSnapshot({
      version: 1,
      savedAt: 1710000000000,
      conversations: [
        {
          key: "ch-1::conv-1",
          channelType: "dingtalk",
          conversationType: "private",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 1710000000000,
        },
      ],
      runtimes: [
        {
          key: "ch-1::conv-1::default",
          channelId: "ch-1",
          channelType: "dingtalk",
          conversationId: "conv-1",
          conversationType: "private",
          topicId: "default",
          sessionId: "im-session-1",
          updatedAt: 1710000000000,
          lastInput: {
            messageId: "msg-1",
            text: "帮我看一下昨天的结果",
            briefContent: "[IM:Alice] 帮我看一下昨天的结果",
            timestamp: 1710000000000,
            channelType: "dingtalk",
            conversationType: "private",
            displayLabel: "钉钉会话",
            displayDetail: "钉钉 · 私聊",
          },
          dialogHistory: [
            {
              id: "dialog-user-1",
              from: "user",
              content: "昨天那张图还在吗？",
              timestamp: 1710000000000,
              priority: "normal",
              kind: "user_input",
              externalChannelType: "dingtalk",
              externalConversationType: "private",
              runtimeDisplayLabel: "钉钉会话",
              runtimeDisplayDetail: "钉钉 · 私聊",
            },
            {
              id: "dialog-agent-1",
              from: "agent-lead",
              content: "还在，我已经记录到上下文里了。",
              timestamp: 1710000001000,
              priority: "normal",
              kind: "agent_result",
            },
          ],
          actorConfigs: [
            {
              id: "agent-lead",
              roleName: "Lead",
              maxIterations: 40,
              sessionHistory: [
                {
                  role: "user",
                  content: "昨天那张图还在吗？",
                  timestamp: 1710000000000,
                },
                {
                  role: "assistant",
                  content: "还在，我已经记录到上下文里了。",
                  timestamp: 1710000001000,
                },
              ],
            },
          ],
        },
      ],
    });

    const manager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });

    const snapshots = manager.getConversationSnapshots();
    const preview = useIMConversationRuntimeStore.getState().sessionPreviews["im-session-1"];

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.conversationId).toBe("conv-1");
    expect(preview?.dialogHistory).toHaveLength(2);
    expect(preview?.dialogHistory[0]?.content).toBe("昨天那张图还在吗？");

    const recorded = manager.recordOutboundReminder("ch-1", "conv-1", "系统提醒：继续沿用之前上下文", "dingtalk");
    const refreshedPreview = useIMConversationRuntimeStore.getState().sessionPreviews["im-session-1"];

    expect(recorded).toBe(true);
    expect(refreshedPreview?.dialogHistory.some((message) => message.content.includes("继续沿用之前上下文"))).toBe(true);

    manager.dispose();
  });

  it("clears persisted IM snapshot once all restored conversations are removed", () => {
    savePersistedIMConversationRuntimeSnapshot({
      version: 1,
      savedAt: 1710000000000,
      conversations: [
        {
          key: "ch-2::conv-2",
          channelType: "feishu",
          conversationType: "group",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 1710000000000,
        },
      ],
      runtimes: [
        {
          key: "ch-2::conv-2::default",
          channelId: "ch-2",
          channelType: "feishu",
          conversationId: "conv-2",
          conversationType: "group",
          topicId: "default",
          sessionId: "im-session-2",
          updatedAt: 1710000000000,
          dialogHistory: [],
          actorConfigs: [
            {
              id: "agent-lead-2",
              roleName: "Lead",
              maxIterations: 40,
            },
          ],
        },
      ],
    });

    const manager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });

    manager.clearConversation("ch-2", "conv-2");

    expect(localStorage.getItem("mtools-im-conversation-runtime-v1")).toBeNull();

    manager.dispose();
  });
});
