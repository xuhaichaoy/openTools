import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import * as dialogContextPressure from "@/core/agent/actor/dialog-context-pressure";
import { useIMConversationRuntimeStore } from "@/store/im-conversation-runtime-store";
import { useToolTrustStore } from "@/store/command-allowlist-store";
import {
  clearPersistedIMConversationRuntimeSnapshot,
  loadPersistedIMConversationRuntimeSnapshot,
  savePersistedIMConversationRuntimeSnapshot,
} from "./im-conversation-persistence";
import { IMConversationRuntimeManager } from "./im-conversation-runtime-manager";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("IMConversationRuntimeManager persistence", () => {
  beforeEach(() => {
    clearAllRuntimeSessions();
    clearPersistedIMConversationRuntimeSnapshot();
    localStorage.clear();
    useIMConversationRuntimeStore.getState().reset();
    useToolTrustStore.getState().setTrustLevel("auto_approve_file");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

    expect(localStorage.getItem("mtools-im-conversation-runtime-v2")).toBeNull();
    expect(localStorage.getItem("mtools-im-conversation-runtime-v1")).toBeNull();

    manager.dispose();
  });

  it("hydrates controller-first IM snapshots and restores queued IM messages", () => {
    savePersistedIMConversationRuntimeSnapshot({
      version: 2,
      savedAt: 1710000000000,
      conversations: [
        {
          key: "ch-3::conv-3",
          channelType: "dingtalk",
          conversationType: "private",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 1710000000000,
        },
      ],
      runtimes: [
        {
          key: "ch-3::conv-3::default",
          channelId: "ch-3",
          channelType: "dingtalk",
          conversationId: "conv-3",
          conversationType: "private",
          topicId: "default",
          sessionId: "im-session-3",
          updatedAt: 1710000000000,
          queuedMessages: [
            {
              messageId: "queued-1",
              text: "继续看一下刚才的异常",
              briefContent: "[IM:Alice] 继续看一下刚才的异常",
              timestamp: 1710000002000,
              channelType: "dingtalk",
              conversationType: "private",
              displayLabel: "钉钉会话",
              displayDetail: "钉钉 · 私聊",
            },
          ],
          dialogHistory: [],
          actorConfigs: [
            {
              id: "agent-lead-3",
              roleName: "Lead",
              maxIterations: 40,
              executionPolicy: {
                accessMode: "read_only",
                approvalMode: "off",
              },
            },
          ],
          collaborationSnapshot: {
            version: 1,
            surface: "im_conversation",
            sessionId: "im-session-3",
            activeContract: {
              contractId: "contract-im-3",
              surface: "im_conversation",
              executionStrategy: "coordinator",
              executionPolicy: {
                accessMode: "read_only",
                approvalMode: "off",
              },
              summary: "读取 IM 上下文并继续答复",
              inputHash: "input-hash-3",
              actorRosterHash: "roster-hash-3",
              initialRecipientActorIds: ["agent-lead-3"],
              participantActorIds: ["agent-lead-3"],
              allowedMessagePairs: [],
              allowedSpawnPairs: [],
              plannedDelegations: [],
              approvedAt: 1710000000000,
              state: "sealed",
            },
            pendingInteractions: [],
            childSessions: [],
            queuedFollowUps: [],
            focusedChildSessionId: null,
            presentationState: {
              surface: "im_conversation",
              status: "queued",
              pendingInteractionCount: 0,
              pendingApprovalCount: 0,
              childSessionsPreview: [],
              queuedFollowUpCount: 0,
              focusedChildSessionId: null,
              contractState: "sealed",
              executionStrategy: "coordinator",
            },
            dialogMessages: [
              {
                id: "dialog-user-3",
                from: "user",
                content: "先帮我看一下日志",
                timestamp: 1710000000000,
                priority: "normal",
                kind: "user_input",
                externalChannelType: "dingtalk",
                externalConversationType: "private",
                runtimeDisplayLabel: "钉钉会话",
                runtimeDisplayDetail: "钉钉 · 私聊",
              },
              {
                id: "dialog-agent-3",
                from: "agent-lead-3",
                content: "已经开始检查日志。",
                timestamp: 1710000001000,
                priority: "normal",
                kind: "agent_result",
              },
            ],
            updatedAt: 1710000001000,
          },
        },
      ],
    });

    const manager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });

    const preview = useIMConversationRuntimeStore.getState().sessionPreviews["im-session-3"];
    const conversation = manager.getConversationSnapshots()[0];

    expect(preview?.dialogHistory.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(preview?.dialogHistory.some((message) => message.content === "已经开始检查日志。")).toBe(true);
    expect(preview?.lastInputText).toBe("继续看一下刚才的异常");
    expect(preview?.queueLength ?? 0).toBeGreaterThanOrEqual(0);
    expect(["sealed", "active", "completed"]).toContain(preview?.contractState);
    expect(conversation?.pendingInteractionCount).toBe(0);
    expect(["sealed", "active", "completed"]).toContain(conversation?.contractState);

    manager.dispose();
  });

  it("asks for human approval in strict manual mode before IM dispatch", async () => {
    useToolTrustStore.getState().setTrustLevel("always_ask");
    const onReply = vi.fn(async () => undefined);
    const manager = new IMConversationRuntimeManager({
      onReply,
    });

    await manager.handleIncoming({
      channelId: "ch-approval",
      channelType: "dingtalk",
      msg: {
        messageId: "msg-approval-1",
        conversationId: "conv-approval-1",
        conversationType: "private",
        senderId: "user-1",
        senderName: "Alice",
        text: "请继续帮我推进这个任务",
      },
    });
    await flushMicrotasks();

    const previewBefore = useIMConversationRuntimeStore.getState().sessionPreviews[
      manager.getConversationSnapshots()[0]?.activeSessionId ?? ""
    ];

    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "ch-approval",
      conversationId: "conv-approval-1",
      text: expect.stringContaining("请直接回复“允许”或“拒绝”"),
    }));
    expect(
      onReply.mock.calls.filter(
        ([payload]) => String(payload?.text ?? "").includes("请直接回复“允许”或“拒绝”"),
      ),
    ).toHaveLength(1);
    expect(previewBefore?.pendingInteractionCount).toBe(1);
    expect(previewBefore?.queueLength).toBe(1);
    expect(previewBefore?.contractState ?? null).toBeNull();
    expect(previewBefore?.approvalStatus).toBe("awaiting_user");
    expect(previewBefore?.approvalSummary).toContain("待确认任务");
    expect(previewBefore?.approvalRiskLabel).toBeTruthy();
    expect(previewBefore?.pendingApprovalReason).toBeTruthy();
    const approvalMessage = previewBefore?.dialogHistory.find((message) => message.interactionType === "approval");
    expect(approvalMessage?.approvalRequest?.toolName).toBe("execution_contract");
    expect(approvalMessage?.approvalRequest?.previewLabel).toBe("协作契约");
    expect(approvalMessage?.approvalRequest?.riskDescription).toContain("风险");
    expect(approvalMessage?.approvalRequest?.decisionOptions?.map((item) => item.label)).toEqual(["允许", "拒绝"]);
    expect(approvalMessage?.approvalRequest?.details?.some((detail) => detail.label === "风险级别")).toBe(true);

    await manager.handleIncoming({
      channelId: "ch-approval",
      channelType: "dingtalk",
      msg: {
        messageId: "msg-approval-2",
        conversationId: "conv-approval-1",
        conversationType: "private",
        senderId: "user-1",
        senderName: "Alice",
        text: "允许",
      },
    });
    await flushMicrotasks();

    const previewAfter = useIMConversationRuntimeStore.getState().sessionPreviews[
      manager.getConversationSnapshots()[0]?.activeSessionId ?? ""
    ];
    expect(previewAfter?.pendingInteractionCount).toBe(0);
    expect(previewAfter?.queueLength).toBe(0);
    expect(["sealed", "active", "completed"]).toContain(previewAfter?.contractState);
    expect(previewAfter?.approvalStatus).toBe("none");

    manager.dispose();
  });

  it("auto-approves low-risk IM contracts without prompting the user", async () => {
    const onReply = vi.fn(async () => undefined);
    const manager = new IMConversationRuntimeManager({
      onReply,
    });

    await manager.handleIncoming({
      channelId: "ch-auto",
      channelType: "dingtalk",
      msg: {
        messageId: "msg-auto-1",
        conversationId: "conv-auto-1",
        conversationType: "private",
        senderId: "user-2",
        senderName: "Bob",
        text: "先帮我看一下这个问题",
      },
    });
    await flushMicrotasks();

    const preview = useIMConversationRuntimeStore.getState().sessionPreviews[
      manager.getConversationSnapshots()[0]?.activeSessionId ?? ""
    ];
    expect(preview?.pendingInteractionCount).toBe(0);
    expect(["sealed", "active", "completed"]).toContain(preview?.contractState);
    expect(onReply).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("请直接回复“允许”或“拒绝”"),
    }));

    manager.dispose();
  });

  it("auto-compacts IM topic context before dispatching a fresh message", async () => {
    const compactionSpy = vi.spyOn(dialogContextPressure, "ensureDialogRoomCompaction").mockResolvedValue({
      changed: true,
      state: {
        summary: "压缩后的渠道续跑摘要",
        compactedMessageCount: 18,
        compactedSpawnedTaskCount: 1,
        compactedArtifactCount: 0,
        preservedIdentifiers: ["src/app.ts"],
        triggerReasons: ["消息过多"],
        updatedAt: 1710000003000,
      },
    });
    const manager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });

    await manager.handleIncoming({
      channelId: "ch-compaction",
      channelType: "dingtalk",
      msg: {
        messageId: "msg-compaction-1",
        conversationId: "conv-compaction-1",
        conversationType: "private",
        senderId: "user-3",
        senderName: "Carol",
        text: "继续基于之前的上下文推进",
      },
    });

    expect(compactionSpy).toHaveBeenCalledTimes(1);

    manager.dispose();
    compactionSpy.mockRestore();
  });

  it("auto-compacts idle hydrated IM topics in the background", async () => {
    vi.useFakeTimers();
    const compactedState = {
      summary: "后台压缩后的渠道续跑摘要",
      compactedMessageCount: 32,
      compactedSpawnedTaskCount: 2,
      compactedArtifactCount: 1,
      preservedIdentifiers: ["src/main.ts"],
      triggerReasons: ["消息过多"],
      updatedAt: 1710000005000,
    } as const;
    const compactionSpy = vi.spyOn(dialogContextPressure, "ensureDialogRoomCompaction").mockImplementation(async (system) => {
      system.setDialogRoomCompaction({ ...compactedState });
      return {
        changed: true,
        state: { ...compactedState },
      };
    });

    savePersistedIMConversationRuntimeSnapshot({
      version: 2,
      savedAt: 1710000004000,
      conversations: [
        {
          key: "ch-idle::conv-idle",
          channelType: "dingtalk",
          conversationType: "private",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 1710000004000,
        },
      ],
      runtimes: [
        {
          key: "ch-idle::conv-idle::default",
          channelId: "ch-idle",
          channelType: "dingtalk",
          conversationId: "conv-idle",
          conversationType: "private",
          topicId: "default",
          sessionId: "im-session-idle",
          updatedAt: 1710000004000,
          dialogHistory: [
            {
              id: "dialog-user-idle-1",
              from: "user",
              content: "这是第一条渠道历史",
              timestamp: 1710000001000,
              priority: "normal",
              kind: "user_input",
              externalChannelType: "dingtalk",
              externalConversationType: "private",
              runtimeDisplayLabel: "钉钉会话",
              runtimeDisplayDetail: "钉钉 · 私聊",
            },
            {
              id: "dialog-agent-idle-1",
              from: "agent-lead-idle",
              content: "这是延续上下文的回复",
              timestamp: 1710000002000,
              priority: "normal",
              kind: "agent_result",
            },
          ],
          actorConfigs: [
            {
              id: "agent-lead-idle",
              roleName: "Lead",
              maxIterations: 40,
              executionPolicy: {
                accessMode: "read_only",
                approvalMode: "off",
              },
            },
          ],
          collaborationSnapshot: {
            version: 1,
            surface: "im_conversation",
            sessionId: "im-session-idle",
            activeContract: null,
            pendingInteractions: [],
            childSessions: [],
            contractDelegations: [],
            queuedFollowUps: [],
            focusedChildSessionId: null,
            presentationState: {
              surface: "im_conversation",
              status: "idle",
              pendingInteractionCount: 0,
              pendingApprovalCount: 0,
              childSessionsPreview: [],
              queuedFollowUpCount: 0,
              focusedChildSessionId: null,
              contractState: null,
              executionStrategy: "coordinator",
            },
            dialogMessages: [
              {
                id: "dialog-user-idle-1",
                from: "user",
                content: "这是第一条渠道历史",
                timestamp: 1710000001000,
                priority: "normal",
                kind: "user_input",
                externalChannelType: "dingtalk",
                externalConversationType: "private",
                runtimeDisplayLabel: "钉钉会话",
                runtimeDisplayDetail: "钉钉 · 私聊",
              },
              {
                id: "dialog-agent-idle-1",
                from: "agent-lead-idle",
                content: "这是延续上下文的回复",
                timestamp: 1710000002000,
                priority: "normal",
                kind: "agent_result",
              },
            ],
            updatedAt: 1710000002000,
          },
        },
      ],
    });

    const manager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });

    expect(compactionSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(compactionSpy).toHaveBeenCalledTimes(1);
    const preview = useIMConversationRuntimeStore.getState().sessionPreviews["im-session-idle"];
    expect(preview?.roomCompactionMessageCount).toBe(32);
    expect(preview?.roomCompactionTaskCount).toBe(2);
    expect(preview?.roomCompactionSummaryPreview).toContain("后台压缩后的渠道续跑摘要");
    expect(preview?.roomCompactionPreservedIdentifiers).toContain("src/main.ts");

    manager.dispose();
  });

  it("does not repeatedly auto-compact while IM is waiting for approval", async () => {
    vi.useFakeTimers();
    useToolTrustStore.getState().setTrustLevel("always_ask");
    const compactionSpy = vi.spyOn(dialogContextPressure, "ensureDialogRoomCompaction").mockResolvedValue({
      changed: false,
      state: {
        summary: "已存在压缩摘要",
        compactedMessageCount: 12,
        compactedSpawnedTaskCount: 0,
        compactedArtifactCount: 0,
        preservedIdentifiers: [],
        triggerReasons: ["消息过多"],
        updatedAt: 1710000006000,
      },
    });
    const manager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });

    await manager.handleIncoming({
      channelId: "ch-waiting",
      channelType: "dingtalk",
      msg: {
        messageId: "msg-waiting-1",
        conversationId: "conv-waiting-1",
        conversationType: "private",
        senderId: "user-waiting",
        senderName: "Alice",
        text: "请继续帮我推进这个任务",
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(compactionSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(compactionSpy).toHaveBeenCalledTimes(1);

    manager.dispose();
  });

  it("keeps the full restored IM dialog history in session previews instead of trimming to the recent tail", () => {
    const dialogHistory = Array.from({ length: 130 }, (_, index) => ({
      id: `dialog-${index + 1}`,
      from: index % 2 === 0 ? "user" : "agent-lead-4",
      content: `历史消息 ${index + 1}`,
      timestamp: 1710001000000 + index,
      priority: "normal" as const,
      kind: index % 2 === 0 ? "user_input" as const : "agent_result" as const,
      ...(index % 2 === 0
        ? {
            externalChannelType: "dingtalk" as const,
            externalConversationType: "private" as const,
            runtimeDisplayLabel: "钉钉会话",
            runtimeDisplayDetail: "钉钉 · 私聊",
          }
        : {}),
    }));

    savePersistedIMConversationRuntimeSnapshot({
      version: 2,
      savedAt: 1710001002000,
      conversations: [
        {
          key: "ch-4::conv-4",
          channelType: "dingtalk",
          conversationType: "private",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 1710001002000,
        },
      ],
      runtimes: [
        {
          key: "ch-4::conv-4::default",
          channelId: "ch-4",
          channelType: "dingtalk",
          conversationId: "conv-4",
          conversationType: "private",
          topicId: "default",
          sessionId: "im-session-4",
          updatedAt: 1710001002000,
          dialogHistory: dialogHistory.slice(-20),
          actorConfigs: [
            {
              id: "agent-lead-4",
              roleName: "Lead",
              maxIterations: 40,
              executionPolicy: {
                accessMode: "read_only",
                approvalMode: "off",
              },
            },
          ],
          collaborationSnapshot: {
            version: 1,
            surface: "im_conversation",
            sessionId: "im-session-4",
            activeContract: null,
            pendingInteractions: [],
            childSessions: [],
            contractDelegations: [],
            queuedFollowUps: [],
            focusedChildSessionId: null,
            presentationState: {
              surface: "im_conversation",
              status: "idle",
              pendingInteractionCount: 0,
              pendingApprovalCount: 0,
              childSessionsPreview: [],
              queuedFollowUpCount: 0,
              focusedChildSessionId: null,
              contractState: null,
              executionStrategy: null,
            },
            dialogMessages: dialogHistory,
            updatedAt: 1710001002000,
          },
        },
      ],
    });

    const manager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });

    const preview = useIMConversationRuntimeStore.getState().sessionPreviews["im-session-4"];

    expect(preview?.dialogHistory).toHaveLength(130);
    expect(preview?.dialogHistory[0]?.content).toBe("历史消息 1");
    expect(preview?.dialogHistory[129]?.content).toBe("历史消息 130");

    manager.dispose();
  });

  it("persists long IM dialog histories across manager reloads without trimming them to a fixed tail", () => {
    const manager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });

    for (let index = 0; index < 260; index += 1) {
      const recorded = manager.recordOutboundReminder(
        "ch-5",
        "conv-5",
        `历史提醒 ${index + 1}`,
        "dingtalk",
      );
      expect(recorded).toBe(true);
    }

    const sessionId = manager.getConversationSnapshots()[0]?.activeSessionId ?? "";
    const previewBeforeReload = useIMConversationRuntimeStore.getState().sessionPreviews[sessionId];
    expect(previewBeforeReload?.dialogHistory).toHaveLength(260);
    expect(previewBeforeReload?.dialogHistory[0]?.content).toBe("历史提醒 1");
    expect(previewBeforeReload?.dialogHistory[259]?.content).toBe("历史提醒 260");

    manager.dispose();
    useIMConversationRuntimeStore.getState().reset();

    const restoredManager = new IMConversationRuntimeManager({
      onReply: async () => undefined,
    });
    const restoredSessionId = restoredManager.getConversationSnapshots()[0]?.activeSessionId ?? "";
    const restoredPreview = useIMConversationRuntimeStore.getState().sessionPreviews[restoredSessionId];

    expect(restoredSessionId).toBeTruthy();
    expect(restoredPreview?.dialogHistory).toHaveLength(260);
    expect(restoredPreview?.dialogHistory[0]?.content).toBe("历史提醒 1");
    expect(restoredPreview?.dialogHistory[259]?.content).toBe("历史提醒 260");

    restoredManager.dispose();
  });

  it("compacts oversized IM persistence payloads instead of dropping the entire snapshot", () => {
    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItemWithQuotaGuard(
      key: string,
      value: string,
    ): void {
      if (key === "mtools-im-conversation-runtime-v2" && value.length > 50_000) {
        throw new Error("QuotaExceededError");
      }
      return Reflect.apply(originalSetItem, this, [key, value]);
    });

    const dialogHistory = Array.from({ length: 280 }, (_, index) => ({
      id: `oversized-${index + 1}`,
      from: index % 2 === 0 ? "user" : "agent-lead-6",
      content: `超长历史消息 ${index + 1} ${"上下文".repeat(24)}`,
      timestamp: 1710002000000 + index,
      priority: "normal" as const,
      kind: index % 2 === 0 ? "user_input" as const : "agent_result" as const,
      ...(index % 2 === 0
        ? {
            externalChannelType: "dingtalk" as const,
            externalConversationType: "private" as const,
            runtimeDisplayLabel: "钉钉会话",
            runtimeDisplayDetail: "钉钉 · 私聊",
          }
        : {}),
    }));

    savePersistedIMConversationRuntimeSnapshot({
      version: 2,
      savedAt: 1710002002000,
      conversations: [
        {
          key: "ch-6::conv-6",
          channelType: "dingtalk",
          conversationType: "private",
          activeTopicId: "default",
          nextTopicSeq: 2,
          updatedAt: 1710002002000,
        },
      ],
      runtimes: [
        {
          key: "ch-6::conv-6::default",
          channelId: "ch-6",
          channelType: "dingtalk",
          conversationId: "conv-6",
          conversationType: "private",
          topicId: "default",
          sessionId: "im-session-6",
          updatedAt: 1710002002000,
          dialogHistory,
          actorConfigs: [
            {
              id: "agent-lead-6",
              roleName: "Lead",
              sessionHistory: Array.from({ length: 36 }, (_, historyIndex) => ({
                role: historyIndex % 2 === 0 ? "user" as const : "assistant" as const,
                content: `内部上下文 ${historyIndex + 1} ${"任务".repeat(18)}`,
                timestamp: 1710002001000 + historyIndex,
              })),
            },
          ],
          collaborationSnapshot: {
            version: 1,
            surface: "im_conversation",
            sessionId: "im-session-6",
            activeContract: null,
            pendingInteractions: [],
            childSessions: [],
            contractDelegations: [],
            queuedFollowUps: [],
            focusedChildSessionId: null,
            presentationState: {
              surface: "im_conversation",
              status: "idle",
              pendingInteractionCount: 0,
              pendingApprovalCount: 0,
              childSessionsPreview: [],
              queuedFollowUpCount: 0,
              focusedChildSessionId: null,
              contractState: null,
              executionStrategy: null,
            },
            dialogMessages: dialogHistory,
            updatedAt: 1710002002000,
          },
        },
      ],
    });

    const restored = loadPersistedIMConversationRuntimeSnapshot();

    expect(restored).not.toBeNull();
    expect(restored?.runtimes[0]?.dialogHistory.length ?? 0).toBeGreaterThan(0);
    expect(restored?.runtimes[0]?.dialogHistory.length ?? 0).toBeLessThan(dialogHistory.length);
    expect(restored?.runtimes[0]?.collaborationSnapshot?.dialogMessages ?? []).toHaveLength(0);
    expect(restored?.runtimes[0]?.actorConfigs[0]?.sessionHistory?.length ?? 0).toBeLessThan(36);

    setItemSpy.mockRestore();
  });
});
