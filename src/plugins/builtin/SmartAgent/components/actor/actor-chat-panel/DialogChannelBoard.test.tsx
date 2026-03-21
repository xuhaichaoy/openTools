import { describe, expect, it } from "vitest";
import { buildRuntimeSessionKey, type RuntimeSessionRecord } from "@/core/agent/context-runtime/runtime-state";
import type {
  IMConversationSessionPreview,
  IMConversationSnapshot,
} from "@/store/im-conversation-runtime-store";
import { buildDialogChannelGroups } from "./DialogChannelBoard";

function makeRuntimeRecord(input: Partial<RuntimeSessionRecord> & Pick<RuntimeSessionRecord, "sessionId" | "mode">): RuntimeSessionRecord {
  return {
    key: buildRuntimeSessionKey(input.mode, input.sessionId),
    mode: input.mode,
    sessionId: input.sessionId,
    query: input.query ?? "test query",
    startedAt: input.startedAt ?? 1,
    updatedAt: input.updatedAt ?? 2,
    status: input.status ?? "running",
    waitingStage: input.waitingStage,
    displayLabel: input.displayLabel,
    displayDetail: input.displayDetail,
    workspaceRoot: input.workspaceRoot,
  };
}

function makeSessionPreview(input: Partial<IMConversationSessionPreview> & Pick<IMConversationSessionPreview, "sessionId" | "channelType" | "conversationId">): IMConversationSessionPreview {
  return {
    sessionId: input.sessionId,
    runtimeKey: input.runtimeKey ?? `runtime:${input.sessionId}`,
    channelId: input.channelId ?? "",
    channelType: input.channelType,
    conversationId: input.conversationId,
    conversationType: input.conversationType ?? "private",
    topicId: input.topicId ?? "default",
    displayLabel: input.displayLabel ?? "IM 会话",
    displayDetail: input.displayDetail ?? "外部会话",
    status: input.status ?? "running",
    queueLength: input.queueLength ?? 0,
    executionStrategy: input.executionStrategy ?? "coordinator",
    pendingInteractionCount: input.pendingInteractionCount ?? 0,
    childSessionsPreview: input.childSessionsPreview ?? [],
    queuedFollowUpCount: input.queuedFollowUpCount ?? 0,
    contractState: input.contractState ?? "active",
    startedAt: input.startedAt ?? 1,
    updatedAt: input.updatedAt ?? 2,
    lastInputText: input.lastInputText,
    actors: input.actors ?? [],
    dialogHistory: input.dialogHistory ?? [],
  };
}

function makeConversation(input: Partial<IMConversationSnapshot> & Pick<IMConversationSnapshot, "key" | "channelId" | "channelType" | "conversationId">): IMConversationSnapshot {
  return {
    key: input.key,
    channelId: input.channelId,
    channelType: input.channelType,
    conversationId: input.conversationId,
    conversationType: input.conversationType ?? "private",
    displayLabel: input.displayLabel ?? "会话",
    displayDetail: input.displayDetail ?? "详情",
    activeTopicId: input.activeTopicId ?? "default",
    nextTopicSeq: input.nextTopicSeq ?? 2,
    updatedAt: input.updatedAt ?? 2,
    activeSessionId: input.activeSessionId,
    activeStatus: input.activeStatus ?? "running",
    activeQueueLength: input.activeQueueLength ?? 0,
    executionStrategy: input.executionStrategy ?? "coordinator",
    pendingInteractionCount: input.pendingInteractionCount ?? 0,
    childSessionsPreview: input.childSessionsPreview ?? [],
    queuedFollowUpCount: input.queuedFollowUpCount ?? 0,
    contractState: input.contractState ?? "active",
    backgroundTopicCount: input.backgroundTopicCount ?? 0,
    topics: input.topics ?? [],
  };
}

describe("buildDialogChannelGroups", () => {
  it("uses im_conversation runtime records for active IM conversations", () => {
    const sessionId = "im-session-1";
    const conversation = makeConversation({
      key: "conv-1",
      channelId: "channel-1",
      channelType: "dingtalk",
      conversationId: "conversation-1",
      displayLabel: "钉钉会话",
      activeSessionId: sessionId,
      activeStatus: "waiting",
    });
    const runtimeSessions = {
      [buildRuntimeSessionKey("im_conversation", sessionId)]: makeRuntimeRecord({
        sessionId,
        mode: "im_conversation",
        waitingStage: "user_reply",
        displayLabel: "钉钉会话",
        displayDetail: "测试群",
      }),
    };

    const groups = buildDialogChannelGroups({
      currentRoomSessionId: null,
      conversations: [conversation],
      runtimeSessions,
      sessionPreviews: {},
    });

    expect(groups.dingtalk.conversations).toHaveLength(1);
    expect(groups.dingtalk.conversations[0].statusLabel).toBe("等待回复");
    expect(groups.dingtalk.conversations[0].activeSessionId).toBe(sessionId);
  });

  it("includes runtime-only IM sessions registered under im_conversation", () => {
    const sessionId = "im-runtime-only-1";
    const preview = makeSessionPreview({
      sessionId,
      channelType: "feishu",
      conversationId: "conversation-2",
      displayLabel: "飞书会话",
      displayDetail: "外部运行时",
    });
    const runtimeSessions = {
      [buildRuntimeSessionKey("im_conversation", sessionId)]: makeRuntimeRecord({
        sessionId,
        mode: "im_conversation",
        displayLabel: "飞书会话",
        displayDetail: "外部运行时",
      }),
    };

    const groups = buildDialogChannelGroups({
      currentRoomSessionId: null,
      conversations: [],
      runtimeSessions,
      sessionPreviews: {
        [sessionId]: preview,
      },
    });

    expect(groups.feishu.conversations).toHaveLength(1);
    expect(groups.feishu.conversations[0].activeSessionId).toBe(sessionId);
    expect(groups.feishu.conversations[0].preview?.sessionId).toBe(sessionId);
  });
});
