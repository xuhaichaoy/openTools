import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { buildRuntimeSessionKey, type RuntimeSessionRecord } from "@/core/agent/context-runtime/runtime-state";
import type {
  IMConversationSessionPreview,
  IMConversationSnapshot,
} from "@/store/im-conversation-runtime-store";
import {
  buildChildSessionPreviewText,
  buildDialogChannelGroups,
  ChannelSessionBoard,
  getPrimaryChildSessionPreview,
} from "./DialogChannelBoard";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    approvalStatus: input.approvalStatus,
    approvalSummary: input.approvalSummary,
    approvalRiskLabel: input.approvalRiskLabel,
    pendingApprovalReason: input.pendingApprovalReason,
    roomCompactionSummaryPreview: input.roomCompactionSummaryPreview,
    roomCompactionUpdatedAt: input.roomCompactionUpdatedAt,
    roomCompactionMessageCount: input.roomCompactionMessageCount,
    roomCompactionTaskCount: input.roomCompactionTaskCount,
    roomCompactionArtifactCount: input.roomCompactionArtifactCount,
    roomCompactionPreservedIdentifiers: input.roomCompactionPreservedIdentifiers,
    startedAt: input.startedAt ?? 1,
    updatedAt: input.updatedAt ?? 2,
    lastInputText: input.lastInputText,
    conversationMode: input.conversationMode,
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
    approvalStatus: input.approvalStatus,
    approvalSummary: input.approvalSummary,
    approvalRiskLabel: input.approvalRiskLabel,
    pendingApprovalReason: input.pendingApprovalReason,
    roomCompactionSummaryPreview: input.roomCompactionSummaryPreview,
    roomCompactionUpdatedAt: input.roomCompactionUpdatedAt,
    roomCompactionMessageCount: input.roomCompactionMessageCount,
    roomCompactionTaskCount: input.roomCompactionTaskCount,
    roomCompactionArtifactCount: input.roomCompactionArtifactCount,
    roomCompactionPreservedIdentifiers: input.roomCompactionPreservedIdentifiers,
    backgroundTopicCount: input.backgroundTopicCount ?? 0,
    conversationMode: input.conversationMode,
    topics: input.topics ?? [],
  };
}

function createDialogMessage(index: number) {
  return {
    id: `msg-${index}`,
    from: index % 2 === 0 ? "user" : "agent-1",
    content: `渠道历史 ${index}`,
    timestamp: index,
    priority: "normal" as const,
    kind: index % 2 === 0 ? "user_input" as const : "agent_result" as const,
  };
}

function hasExactText(container: HTMLElement | null | undefined, text: string): boolean {
  return Array.from(container?.querySelectorAll("div") ?? []).some((node) =>
    node.textContent?.trim() === text,
  );
}

describe("buildDialogChannelGroups", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

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

  it("deduplicates runtime fallback sessions when the same channel conversation is already present", () => {
    const activeSessionId = "export-overlay-session";
    const staleSessionId = "runtime-history-session";
    const conversation = makeConversation({
      key: "channel-1::conversation-1",
      channelId: "channel-1",
      channelType: "dingtalk",
      conversationId: "conversation-1",
      displayLabel: "钉钉会话",
      activeSessionId,
      updatedAt: 200,
    });

    const groups = buildDialogChannelGroups({
      currentRoomSessionId: null,
      conversations: [conversation],
      runtimeSessions: {
        [buildRuntimeSessionKey("im_conversation", staleSessionId)]: makeRuntimeRecord({
          sessionId: staleSessionId,
          mode: "im_conversation",
          updatedAt: 150,
          displayLabel: "钉钉会话",
          displayDetail: "测试群",
        }),
      },
      sessionPreviews: {
        [activeSessionId]: makeSessionPreview({
          sessionId: activeSessionId,
          channelId: "channel-1",
          channelType: "dingtalk",
          conversationId: "conversation-1",
          displayLabel: "钉钉会话",
          displayDetail: "测试群",
        }),
        [staleSessionId]: makeSessionPreview({
          sessionId: staleSessionId,
          channelId: "channel-1",
          channelType: "dingtalk",
          conversationId: "conversation-1",
          displayLabel: "钉钉会话",
          displayDetail: "测试群",
        }),
      },
    });

    expect(groups.dingtalk.conversations).toHaveLength(1);
    expect(groups.dingtalk.conversations[0].activeSessionId).toBe(activeSessionId);
  });

  it("shows waiting confirmation label when the active conversation is pending approval", () => {
    const conversation = makeConversation({
      key: "conv-approval",
      channelId: "channel-approval",
      channelType: "dingtalk",
      conversationId: "conversation-approval",
      activeStatus: "waiting",
      approvalStatus: "awaiting_user",
      approvalSummary: "待确认任务：执行部署脚本",
      approvalRiskLabel: "中风险",
      pendingApprovalReason: "当前操作会写入工作区并触发脚本执行。",
    });

    const groups = buildDialogChannelGroups({
      currentRoomSessionId: null,
      conversations: [conversation],
      runtimeSessions: {},
      sessionPreviews: {},
    });

    expect(groups.dingtalk.conversations[0].statusLabel).toBe("等待确认");
  });

  it("carries approval preview fields from runtime-only session previews", () => {
    const sessionId = "im-runtime-approval";
    const preview = makeSessionPreview({
      sessionId,
      channelType: "feishu",
      conversationId: "conversation-approval",
      approvalStatus: "awaiting_user",
      approvalSummary: "待确认任务：修改配置并重启服务",
      approvalRiskLabel: "高风险",
      pendingApprovalReason: "当前操作涉及写文件和服务重启，需要人工确认。",
    });

    const runtimeSessions = {
      [buildRuntimeSessionKey("im_conversation", sessionId)]: makeRuntimeRecord({
        sessionId,
        mode: "im_conversation",
        status: "awaiting_approval",
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

    expect(groups.feishu.conversations[0].conversation.approvalSummary).toBe(preview.approvalSummary);
    expect(groups.feishu.conversations[0].conversation.approvalRiskLabel).toBe(preview.approvalRiskLabel);
    expect(groups.feishu.conversations[0].conversation.pendingApprovalReason).toBe(preview.pendingApprovalReason);
    expect(groups.feishu.conversations[0].conversation.approvalStatus).toBe(preview.approvalStatus);
  });

  it("prefers child session previews with status summaries", () => {
    const preview = getPrimaryChildSessionPreview([
      {
        id: "child-1",
        label: "Review Session",
        targetActorId: "reviewer",
        status: "waiting",
        mode: "session",
        focusable: true,
        resumable: true,
      },
      {
        id: "child-2",
        label: "Validation Session",
        targetActorId: "validator",
        status: "running",
        mode: "session",
        focusable: true,
        resumable: true,
        statusSummary: "主 Agent 已收到第一轮验证摘要。",
        nextStepHint: "继续等待验证结论。",
      },
    ]);

    expect(preview?.id).toBe("child-2");
    expect(buildChildSessionPreviewText([preview!])).toBe("主 Agent 已收到第一轮验证摘要。");
  });

  it("falls back to child session next-step hints when no summary is available", () => {
    expect(buildChildSessionPreviewText([
      {
        id: "child-3",
        label: "Executor",
        targetActorId: "executor",
        status: "waiting",
        mode: "session",
        focusable: true,
        resumable: true,
        nextStepHint: "主 Agent 可按需继续复用该线程。",
      },
    ])).toBe("主 Agent 可按需继续复用该线程。");
  });

  it("loads older IM dialog messages on demand instead of dropping them from the board", () => {
    const sessionId = "im-history-session";
    const preview = makeSessionPreview({
      sessionId,
      channelType: "dingtalk",
      conversationId: "conversation-history",
      displayLabel: "钉钉会话",
      displayDetail: "历史会话",
      actors: [{ id: "agent-1", roleName: "Lead", status: "idle" }],
      dialogHistory: Array.from({ length: 130 }, (_, index) => createDialogMessage(index + 1)),
    });
    const conversation = makeConversation({
      key: "conv-history",
      channelId: "channel-history",
      channelType: "dingtalk",
      conversationId: "conversation-history",
      displayLabel: "钉钉会话",
      activeSessionId: sessionId,
      updatedAt: 130,
    });
    const groups = buildDialogChannelGroups({
      currentRoomSessionId: null,
      conversations: [conversation],
      runtimeSessions: {},
      sessionPreviews: {
        [sessionId]: preview,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ChannelSessionBoard
          group={groups.dingtalk}
          selectedConversationKey={groups.dingtalk.conversations[0]?.key}
          onSelectConversation={() => undefined}
          onClearExtraConversations={null}
          onReturnToCurrentRoom={null}
          renderMessageBubble={({ message }) => <div>{message.content}</div>}
        />,
      );
    });

    expect(container?.textContent).toContain("加载更早的 30 条消息");
    expect(container?.textContent).toContain("渠道历史 130");
    expect(hasExactText(container, "渠道历史 1")).toBe(false);

    const loadMoreButton = Array.from(container?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.includes("加载更早的 30 条消息")) ?? null;

    act(() => {
      loadMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(hasExactText(container, "渠道历史 1")).toBe(true);
    expect(container?.textContent).not.toContain("加载更早的 30 条消息");
  });

  it("shows IM compaction continuity when the session is running from a compacted context", () => {
    const sessionId = "im-compacted-session";
    const preview = makeSessionPreview({
      sessionId,
      channelType: "dingtalk",
      conversationId: "conversation-compacted",
      displayLabel: "钉钉会话",
      displayDetail: "压缩续跑",
      actors: [{ id: "agent-1", roleName: "Lead", status: "idle" }],
      roomCompactionMessageCount: 24,
      roomCompactionTaskCount: 2,
      roomCompactionSummaryPreview: "已整理早期排查结论，并保留 src/main.ts 与日志关键线索。",
      roomCompactionPreservedIdentifiers: ["src/main.ts"],
      dialogHistory: [createDialogMessage(1)],
    });
    const conversation = makeConversation({
      key: "conv-compacted",
      channelId: "channel-compacted",
      channelType: "dingtalk",
      conversationId: "conversation-compacted",
      displayLabel: "钉钉会话",
      activeSessionId: sessionId,
      updatedAt: 24,
      roomCompactionMessageCount: 24,
      roomCompactionTaskCount: 2,
      roomCompactionSummaryPreview: "已整理早期排查结论，并保留 src/main.ts 与日志关键线索。",
      roomCompactionPreservedIdentifiers: ["src/main.ts"],
    });
    const groups = buildDialogChannelGroups({
      currentRoomSessionId: null,
      conversations: [conversation],
      runtimeSessions: {},
      sessionPreviews: {
        [sessionId]: preview,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ChannelSessionBoard
          group={groups.dingtalk}
          selectedConversationKey={groups.dingtalk.conversations[0]?.key}
          onSelectConversation={() => undefined}
          onClearExtraConversations={null}
          onReturnToCurrentRoom={null}
          renderMessageBubble={({ message }) => <div>{message.content}</div>}
        />,
      );
    });

    expect(container?.textContent).toContain("上下文已整理");
    expect(container?.textContent).toContain("消息 24");
    expect(container?.textContent).toContain("线程 2");
    expect(container?.textContent).toContain("已整理早期排查结论");
  });

  it("shows database operation mode hints for explicit export sessions", () => {
    const sessionId = "im-db-mode-session";
    const preview = makeSessionPreview({
      sessionId,
      channelType: "dingtalk",
      conversationId: "conversation-db-mode",
      displayLabel: "钉钉会话",
      displayDetail: "数据库模式",
      conversationMode: "database_operation",
      actors: [{ id: "agent-1", roleName: "Lead", status: "idle" }],
      dialogHistory: [createDialogMessage(1)],
    });
    const conversation = makeConversation({
      key: "conv-db-mode",
      channelId: "channel-db-mode",
      channelType: "dingtalk",
      conversationId: "conversation-db-mode",
      displayLabel: "钉钉会话",
      activeSessionId: sessionId,
      updatedAt: 2,
      conversationMode: "database_operation",
    });
    const groups = buildDialogChannelGroups({
      currentRoomSessionId: null,
      conversations: [conversation],
      runtimeSessions: {},
      sessionPreviews: {
        [sessionId]: preview,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ChannelSessionBoard
          group={groups.dingtalk}
          selectedConversationKey={groups.dingtalk.conversations[0]?.key}
          onSelectConversation={() => undefined}
          onClearExtraConversations={null}
          onReturnToCurrentRoom={null}
          renderMessageBubble={({ message }) => <div>{message.content}</div>}
        />,
      );
    });

    expect(container?.textContent).toContain("当前处于数据库操作模式");
    expect(container?.textContent).toContain("发送“退出数据库操作”可返回普通对话");
  });
});
