import React, { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";

import {
  buildRuntimeSessionKey,
  type RuntimeSessionRecord,
} from "@/core/agent/context-runtime/runtime-state";
import { getRuntimeIndicatorStatus } from "@/core/agent/context-runtime/runtime-indicator";
import type { SavedChannelEntry } from "@/core/channels";
import type { DialogMessage } from "@/core/agent/actor/types";
import type {
  IMConversationRuntimeStatus,
  IMConversationApprovalPreview,
  IMConversationCompactionPreview,
  IMConversationSessionPreview,
  IMConversationSnapshot,
} from "@/store/im-conversation-runtime-store";
import type { CollaborationChildSessionPreview } from "@/core/collaboration/types";
import { getRuntimeAgentCount } from "./runtime-agent-count";

export type DialogSessionViewKey = "local" | "dingtalk" | "feishu";

export type DialogChannelConversationItem = {
  key: string;
  conversationId: string;
  channelType: "dingtalk" | "feishu";
  label: string;
  detail: string;
  statusLabel: string;
  updatedAt: number;
  activeTopicId: string;
  backgroundTopicCount: number;
  activeSessionId?: string;
  conversation: IMConversationSnapshot;
  preview?: IMConversationSessionPreview;
  runtimeRecord?: RuntimeSessionRecord;
};

export type DialogChannelGroup = {
  key: "dingtalk" | "feishu";
  label: string;
  detail: string;
  statusLabel: string;
  updatedAt: number;
  conversations: DialogChannelConversationItem[];
};

export type DialogTopSessionItem = {
  key: DialogSessionViewKey;
  label: string;
  detail: string;
  statusLabel: string;
  updatedAt: number;
  connectionState: "connected" | "connecting" | "disconnected" | "error" | "unconfigured";
  connectionLabel: string;
  canAutoConnect?: boolean;
};

export type DialogChannelConnectionMeta = {
  channelType: "dingtalk" | "feishu";
  entries: SavedChannelEntry[];
  configured: boolean;
  connectionState: "connected" | "connecting" | "disconnected" | "error" | "unconfigured";
  connectionLabel: string;
  canAutoConnect: boolean;
};

const CHANNEL_GROUP_META: Record<"dingtalk" | "feishu", { label: string; detail: string }> = {
  dingtalk: {
    label: "钉钉渠道",
    detail: "查看钉钉 IM 会话",
  },
  feishu: {
    label: "飞书渠道",
    detail: "查看飞书 IM 会话",
  },
};

const CHANNEL_MESSAGE_WINDOW_SIZE = 100;

export function formatSessionStripTime(timestamp: number): string {
  if (!timestamp) return "--";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getDialogViewLabel(view: DialogSessionViewKey): string {
  switch (view) {
    case "dingtalk":
      return "钉钉渠道";
    case "feishu":
      return "飞书渠道";
    default:
      return "本机";
  }
}

export function getDialogChannelConnectionLabel(
  state: DialogChannelConnectionMeta["connectionState"],
  configured: boolean,
  connectedCount = 0,
): string {
  if (!configured) {
    return "历史会话";
  }
  switch (state) {
    case "connected":
      return connectedCount > 1 ? `${connectedCount} 路在线` : "已连接";
    case "connecting":
      return "连接中";
    case "error":
      return "连接异常";
    case "disconnected":
      return "点击连接";
    default:
      return "未配置";
  }
}

function hasPendingApprovalPreview(
  item?: IMConversationApprovalPreview | IMConversationSessionPreview | IMConversationSnapshot | null,
): boolean {
  return item?.approvalStatus === "awaiting_user"
    || Boolean(item?.approvalSummary || item?.pendingApprovalReason);
}

function getApprovalHeadline(
  item?: IMConversationApprovalPreview | IMConversationSessionPreview | IMConversationSnapshot | null,
): string | null {
  if (!hasPendingApprovalPreview(item)) return null;
  return item?.approvalRiskLabel
    ? `等待确认 · ${item.approvalRiskLabel}`
    : "等待确认";
}

function hasCompactionPreview(
  item?: IMConversationCompactionPreview | IMConversationSessionPreview | IMConversationSnapshot | null,
): boolean {
  return Boolean(
    item?.roomCompactionSummaryPreview
    || (item?.roomCompactionMessageCount ?? 0) > 0
    || (item?.roomCompactionTaskCount ?? 0) > 0
    || (item?.roomCompactionArtifactCount ?? 0) > 0,
  );
}

function buildCompactionHeadline(
  item?: IMConversationCompactionPreview | IMConversationSessionPreview | IMConversationSnapshot | null,
): string | null {
  if (!hasCompactionPreview(item)) return null;
  const parts: string[] = [];
  if ((item?.roomCompactionMessageCount ?? 0) > 0) {
    parts.push(`消息 ${item?.roomCompactionMessageCount ?? 0}`);
  }
  if ((item?.roomCompactionTaskCount ?? 0) > 0) {
    parts.push(`线程 ${item?.roomCompactionTaskCount ?? 0}`);
  }
  if ((item?.roomCompactionArtifactCount ?? 0) > 0) {
    parts.push(`产物 ${item?.roomCompactionArtifactCount ?? 0}`);
  }
  return parts.length > 0
    ? `上下文已整理 · ${parts.join(" · ")}`
    : "上下文已整理";
}

function buildCompactionDetail(
  item?: IMConversationCompactionPreview | IMConversationSessionPreview | IMConversationSnapshot | null,
): string | null {
  const summary = item?.roomCompactionSummaryPreview?.trim();
  if (summary) return summary;
  const identifiers = item?.roomCompactionPreservedIdentifiers?.slice(0, 3) ?? [];
  if (identifiers.length > 0) {
    return `保留 ${identifiers.join("、")}`;
  }
  return null;
}

function getIMRuntimeStatusLabel(
  status: IMConversationRuntimeStatus,
  options?: { hasPendingApproval?: boolean },
): string {
  if (options?.hasPendingApproval) {
    return "等待确认";
  }
  switch (status) {
    case "running":
      return "处理中";
    case "waiting":
      return "等待回复";
    case "queued":
      return "后台排队";
    default:
      return "空闲";
  }
}

function isDatabaseOperationMode(
  item?: { conversationMode?: "normal" | "database_operation" } | null,
): boolean {
  return item?.conversationMode === "database_operation";
}

function getDatabaseOperationModeHint(
  item?: { conversationMode?: "normal" | "database_operation" } | null,
): string | null {
  if (!isDatabaseOperationMode(item)) return null;
  return "发送“退出数据库操作”可返回普通对话";
}

function getExecutionStrategyLabel(strategy?: IMConversationSessionPreview["executionStrategy"] | IMConversationSnapshot["executionStrategy"]): string | null {
  switch (strategy) {
    case "direct":
      return "直达";
    case "smart":
      return "智能";
    case "broadcast":
      return "广播";
    case "coordinator":
      return "协调";
    default:
      return null;
  }
}

function getContractStateLabel(state?: IMConversationSessionPreview["contractState"] | IMConversationSnapshot["contractState"]): string | null {
  switch (state) {
    case "sealed":
      return "已封存";
    case "active":
      return "执行中";
    case "completed":
      return "已完成";
    case "failed":
      return "已失败";
    case "superseded":
      return "已替代";
    default:
      return null;
  }
}

function buildCollaborationMetaPills(params: {
  executionStrategy?: IMConversationSessionPreview["executionStrategy"] | IMConversationSnapshot["executionStrategy"];
  pendingInteractionCount: number;
  queuedFollowUpCount: number;
  childSessionCount: number;
  contractState?: IMConversationSessionPreview["contractState"] | IMConversationSnapshot["contractState"];
}): string[] {
  const pills: string[] = [];
  const strategyLabel = getExecutionStrategyLabel(params.executionStrategy);
  const contractStateLabel = getContractStateLabel(params.contractState);
  if (strategyLabel) pills.push(`策略 ${strategyLabel}`);
  if (params.pendingInteractionCount > 0) pills.push(`待交互 ${params.pendingInteractionCount}`);
  if (params.queuedFollowUpCount > 0) pills.push(`排队 ${params.queuedFollowUpCount}`);
  if (params.childSessionCount > 0) pills.push(`子会话 ${params.childSessionCount}`);
  if (contractStateLabel) pills.push(contractStateLabel);
  return pills;
}

export function getPrimaryChildSessionPreview(
  previews?: readonly CollaborationChildSessionPreview[] | null,
): CollaborationChildSessionPreview | null {
  if (!previews?.length) return null;
  return previews.find((preview) => preview.statusSummary || preview.nextStepHint) ?? previews[0] ?? null;
}

export function buildChildSessionPreviewText(
  previews?: readonly CollaborationChildSessionPreview[] | null,
): string | null {
  const preview = getPrimaryChildSessionPreview(previews);
  if (!preview) return null;
  return preview.statusSummary || preview.nextStepHint || preview.label || null;
}

export function inferIMChannelType(params: {
  preview?: IMConversationSessionPreview | null;
  runtimeRecord?: RuntimeSessionRecord | null;
}): "dingtalk" | "feishu" | null {
  if (params.preview?.channelType === "dingtalk" || params.preview?.channelType === "feishu") {
    return params.preview.channelType;
  }
  const hint = `${params.runtimeRecord?.displayLabel || ""} ${params.runtimeRecord?.displayDetail || ""}`;
  if (hint.includes("钉钉")) return "dingtalk";
  if (hint.includes("飞书")) return "feishu";
  return null;
}

function isSameChannelConversation(params: {
  channelType: "dingtalk" | "feishu";
  channelId?: string | null;
  conversationId?: string | null;
  existing: DialogChannelConversationItem;
}): boolean {
  if (params.existing.channelType !== params.channelType) return false;
  const nextConversationId = params.conversationId?.trim() || "";
  if (!nextConversationId || params.existing.conversationId !== nextConversationId) {
    return false;
  }
  const nextChannelId = params.channelId?.trim() || "";
  const existingChannelId = params.existing.conversation.channelId?.trim() || "";
  if (nextChannelId && existingChannelId) {
    return nextChannelId === existingChannelId;
  }
  return true;
}

export function buildDialogChannelGroups(params: {
  currentRoomSessionId?: string | null;
  conversations: IMConversationSnapshot[];
  runtimeSessions: Record<string, RuntimeSessionRecord>;
  sessionPreviews: Record<string, IMConversationSessionPreview>;
}): Record<"dingtalk" | "feishu", DialogChannelGroup> {
  const groups: Record<"dingtalk" | "feishu", DialogChannelGroup> = {
    dingtalk: {
      key: "dingtalk",
      label: CHANNEL_GROUP_META.dingtalk.label,
      detail: CHANNEL_GROUP_META.dingtalk.detail,
      statusLabel: "暂无会话",
      updatedAt: 0,
      conversations: [],
    },
    feishu: {
      key: "feishu",
      label: CHANNEL_GROUP_META.feishu.label,
      detail: CHANNEL_GROUP_META.feishu.detail,
      statusLabel: "暂无会话",
      updatedAt: 0,
      conversations: [],
    },
  };
  const currentRoomSessionId = params.currentRoomSessionId?.trim() || "";

  for (const conversation of params.conversations) {
    const channelType = conversation.channelType;
    if (channelType !== "dingtalk" && channelType !== "feishu") continue;
    const activeSessionId = conversation.activeSessionId?.trim() || "";
    const preview = activeSessionId ? params.sessionPreviews[activeSessionId] : undefined;
    const runtimeRecord = activeSessionId
      ? params.runtimeSessions[buildRuntimeSessionKey("im_conversation", activeSessionId)]
      : undefined;
    if (activeSessionId && activeSessionId === currentRoomSessionId) continue;
    const statusLabel = runtimeRecord
      ? getRuntimeIndicatorStatus(runtimeRecord)
      : getIMRuntimeStatusLabel(conversation.activeStatus, {
          hasPendingApproval: hasPendingApprovalPreview(conversation),
        });
    const detailParts = [conversation.displayDetail];
    if (conversation.conversationType === "group") {
      detailParts.push("群聊");
    } else {
      detailParts.push("私聊");
    }
    groups[channelType].conversations.push({
      key: conversation.key,
      conversationId: conversation.conversationId,
      channelType,
      label: conversation.displayLabel || "IM 会话",
      detail: detailParts.filter(Boolean).join(" · "),
      statusLabel,
      updatedAt: Math.max(runtimeRecord?.updatedAt ?? 0, preview?.updatedAt ?? 0, conversation.updatedAt),
      activeTopicId: conversation.activeTopicId,
      backgroundTopicCount: conversation.backgroundTopicCount,
      activeSessionId: conversation.activeSessionId,
      conversation,
      preview,
      runtimeRecord,
    });
  }

  for (const runtimeRecord of Object.values(params.runtimeSessions)) {
    if (runtimeRecord.mode !== "im_conversation" && runtimeRecord.mode !== "dialog") continue;
    if (runtimeRecord.sessionId === currentRoomSessionId) continue;
    const preview = params.sessionPreviews[runtimeRecord.sessionId];
    if (!preview) continue;
    const channelType = inferIMChannelType({ preview, runtimeRecord });
    if (!channelType) continue;
    const alreadyCovered = groups[channelType].conversations.some((conversation) =>
      conversation.activeSessionId === runtimeRecord.sessionId
      || isSameChannelConversation({
        channelType,
        channelId: preview.channelId,
        conversationId: preview.conversationId,
        existing: conversation,
      }),
    );
    if (alreadyCovered) continue;
    groups[channelType].conversations.push({
      key: `runtime:${runtimeRecord.sessionId}`,
      conversationId: preview?.conversationId ?? runtimeRecord.sessionId,
      channelType,
      label: runtimeRecord.displayLabel?.trim() || preview?.displayLabel || "IM 会话",
      detail: runtimeRecord.displayDetail?.trim() || "外部运行时会话",
      statusLabel: getRuntimeIndicatorStatus(runtimeRecord),
      updatedAt: runtimeRecord.updatedAt,
      activeTopicId: preview?.topicId ?? "default",
      backgroundTopicCount: 0,
      activeSessionId: runtimeRecord.sessionId,
      conversation: {
        key: `runtime:${runtimeRecord.sessionId}`,
        channelId: preview?.channelId ?? "",
        channelType,
        conversationId: preview?.conversationId ?? runtimeRecord.sessionId,
        conversationType: preview?.conversationType ?? "private",
        displayLabel: runtimeRecord.displayLabel?.trim() || preview?.displayLabel || "IM 会话",
        displayDetail: runtimeRecord.displayDetail?.trim() || preview?.displayDetail || "外部运行时会话",
        activeTopicId: preview?.topicId ?? "default",
        nextTopicSeq: 2,
        updatedAt: runtimeRecord.updatedAt,
        activeSessionId: runtimeRecord.sessionId,
        activeStatus: preview?.status ?? "running",
        activeQueueLength: preview?.queueLength ?? 0,
        executionStrategy: preview?.executionStrategy ?? null,
        pendingInteractionCount: preview?.pendingInteractionCount ?? 0,
        childSessionsPreview: preview?.childSessionsPreview ?? [],
        queuedFollowUpCount: preview?.queuedFollowUpCount ?? 0,
        contractState: preview?.contractState ?? null,
        approvalStatus: preview?.approvalStatus,
        approvalSummary: preview?.approvalSummary,
        approvalRiskLabel: preview?.approvalRiskLabel,
        pendingApprovalReason: preview?.pendingApprovalReason,
        roomCompactionSummaryPreview: preview?.roomCompactionSummaryPreview,
        roomCompactionUpdatedAt: preview?.roomCompactionUpdatedAt,
        roomCompactionMessageCount: preview?.roomCompactionMessageCount,
        roomCompactionTaskCount: preview?.roomCompactionTaskCount,
        roomCompactionArtifactCount: preview?.roomCompactionArtifactCount,
        roomCompactionPreservedIdentifiers: preview?.roomCompactionPreservedIdentifiers,
        conversationMode: preview?.conversationMode,
        backgroundTopicCount: 0,
        topics: preview
          ? [{
              runtimeKey: preview.runtimeKey,
              topicId: preview.topicId,
              sessionId: preview.sessionId,
              status: preview.status,
              queueLength: preview.queueLength,
              pendingInteractionCount: preview.pendingInteractionCount,
              queuedFollowUpCount: preview.queuedFollowUpCount,
              contractState: preview.contractState ?? null,
              approvalStatus: preview.approvalStatus,
              approvalSummary: preview.approvalSummary,
              approvalRiskLabel: preview.approvalRiskLabel,
              pendingApprovalReason: preview.pendingApprovalReason,
              roomCompactionSummaryPreview: preview.roomCompactionSummaryPreview,
              roomCompactionUpdatedAt: preview.roomCompactionUpdatedAt,
              roomCompactionMessageCount: preview.roomCompactionMessageCount,
              roomCompactionTaskCount: preview.roomCompactionTaskCount,
              roomCompactionArtifactCount: preview.roomCompactionArtifactCount,
              roomCompactionPreservedIdentifiers: preview.roomCompactionPreservedIdentifiers,
              updatedAt: preview.updatedAt,
              startedAt: preview.startedAt,
              conversationMode: preview.conversationMode,
              lastInputText: preview.lastInputText,
            }]
          : [],
      },
      preview,
      runtimeRecord,
  });
}

  for (const channelType of ["dingtalk", "feishu"] as const) {
    groups[channelType].conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    if (groups[channelType].conversations.length > 1) {
      groups[channelType].conversations = [groups[channelType].conversations[0]];
    }
    groups[channelType].updatedAt = groups[channelType].conversations[0]?.updatedAt ?? 0;
    groups[channelType].statusLabel = groups[channelType].conversations[0]?.statusLabel ?? "暂无会话";
    groups[channelType].detail = groups[channelType].conversations.length > 0
      ? "当前会话"
      : CHANNEL_GROUP_META[channelType].detail;
  }

  return groups;
}

function RuntimeSessionPreview({
  preview,
  currentRoomSessionId,
  onReturnToCurrentRoom,
  compact = false,
  hideHeader = false,
  renderMessageBubble,
}: {
  preview: IMConversationSessionPreview;
  currentRoomSessionId?: string | null;
  onReturnToCurrentRoom?: (() => void) | null;
  compact?: boolean;
  hideHeader?: boolean;
  renderMessageBubble: (params: {
    message: DialogMessage;
    actorIndex: number;
    actorName: string;
    targetName?: string;
    isUser: boolean;
  }) => React.ReactNode;
}) {
  const [visibleMessageCount, setVisibleMessageCount] = useState(CHANNEL_MESSAGE_WINDOW_SIZE);
  const actorById = useMemo(
    () => new Map(preview.actors.map((actor) => [actor.id, actor] as const)),
    [preview.actors],
  );
  const actorIdToIndex = useMemo(
    () => new Map(preview.actors.map((actor, index) => [actor.id, index] as const)),
    [preview.actors],
  );
  const primaryChildSessionPreview = useMemo(
    () => getPrimaryChildSessionPreview(preview.childSessionsPreview),
    [preview.childSessionsPreview],
  );
  const databaseOperationModeHint = useMemo(
    () => getDatabaseOperationModeHint(preview),
    [preview],
  );
  const compactionHeadline = useMemo(() => buildCompactionHeadline(preview), [preview]);
  const compactionDetail = useMemo(() => buildCompactionDetail(preview), [preview]);
  const visibleDialogHistory = useMemo(() => {
    if (preview.dialogHistory.length <= visibleMessageCount) {
      return preview.dialogHistory;
    }
    return preview.dialogHistory.slice(-visibleMessageCount);
  }, [preview.dialogHistory, visibleMessageCount]);

  useEffect(() => {
    setVisibleMessageCount(CHANNEL_MESSAGE_WINDOW_SIZE);
  }, [preview.sessionId, preview.dialogHistory.length]);

  return (
    <div className={compact ? "flex min-h-0 flex-1 flex-col gap-2.5" : "space-y-3"}>
      {!hideHeader && (
        <div className={`rounded-2xl border border-sky-500/15 bg-sky-500/5 ${compact ? "px-3.5 py-2.5" : "px-4 py-3"}`}>
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Users className="h-4 w-4 text-sky-600" />
                <span className="text-[13px] font-semibold text-[var(--color-text)]">
                  {preview.displayLabel || "IM 会话"}
                </span>
                <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700">
                  只读预览
                </span>
                <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                  {getIMRuntimeStatusLabel(preview.status, {
                    hasPendingApproval: hasPendingApprovalPreview(preview),
                  })}
                </span>
                {isDatabaseOperationMode(preview) && (
                  <span className="rounded-full border border-fuchsia-500/20 bg-fuchsia-500/8 px-2 py-0.5 text-[10px] text-fuchsia-700">
                    数据库操作模式
                  </span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                {[preview.displayDetail, preview.topicId].filter(Boolean).join(" · ")}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
                <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5">
                  {getRuntimeAgentCount(preview.actors)} 个 Agent
                </span>
                <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5">
                  {preview.dialogHistory.length} 条消息
                </span>
                <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5">
                  最近更新 {formatSessionStripTime(preview.updatedAt)}
                </span>
                {buildCollaborationMetaPills({
                  executionStrategy: preview.executionStrategy,
                  pendingInteractionCount: preview.pendingInteractionCount,
                  queuedFollowUpCount: preview.queuedFollowUpCount,
                  childSessionCount: preview.childSessionsPreview.length,
                  contractState: preview.contractState,
                }).map((pill) => (
                  <span
                    key={pill}
                    className="rounded-full border border-[var(--color-border)] px-2 py-0.5"
                  >
                    {pill}
                  </span>
                ))}
              </div>
            </div>
            {currentRoomSessionId && onReturnToCurrentRoom && (
              <button
                onClick={onReturnToCurrentRoom}
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-[var(--color-bg)] px-3 py-1 text-[10px] text-sky-700 hover:border-sky-500/35 hover:bg-sky-500/10 transition-colors"
              >
                返回当前房间
              </button>
            )}
          </div>
        </div>
      )}

      {databaseOperationModeHint && (
        <div className="rounded-2xl border border-fuchsia-500/18 bg-fuchsia-500/8 px-3 py-2 text-[11px] text-fuchsia-900">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-fuchsia-500/20 bg-white/80 px-2 py-0.5 text-[10px] font-medium text-fuchsia-800">
              当前处于数据库操作模式
            </span>
          </div>
          <div className="mt-1 leading-relaxed">{databaseOperationModeHint}</div>
        </div>
      )}

      {hasPendingApprovalPreview(preview) && (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-[11px] text-amber-900">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-amber-500/25 bg-white/75 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              {getApprovalHeadline(preview)}
            </span>
          </div>
          {preview.approvalSummary && (
            <div className="mt-1 leading-relaxed">{preview.approvalSummary}</div>
          )}
          {preview.pendingApprovalReason && preview.pendingApprovalReason !== preview.approvalSummary && (
            <div className="mt-1 text-[10px] leading-relaxed text-amber-800/85">
              {preview.pendingApprovalReason}
            </div>
          )}
        </div>
      )}
      {compactionHeadline && (
        <div className="rounded-2xl border border-emerald-500/18 bg-emerald-500/8 px-3 py-2 text-[11px] text-emerald-900">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-emerald-500/20 bg-white/80 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
              {compactionHeadline}
            </span>
            {preview.roomCompactionUpdatedAt ? (
              <span className="text-[10px] text-emerald-800/75">
                {formatSessionStripTime(preview.roomCompactionUpdatedAt)}
              </span>
            ) : null}
          </div>
          {compactionDetail && (
            <div className="mt-1 leading-relaxed">{compactionDetail}</div>
          )}
        </div>
      )}
      {primaryChildSessionPreview && (
        <div className="rounded-2xl border border-sky-500/15 bg-white/75 px-3 py-2 text-[11px] text-[var(--color-text)]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-sky-500/20 bg-sky-500/8 px-2 py-0.5 text-[10px] font-medium text-sky-700">
              后台线程
            </span>
            <span className="text-[10px] font-medium text-[var(--color-text-secondary)]">
              {primaryChildSessionPreview.label}
            </span>
          </div>
          {primaryChildSessionPreview.statusSummary && (
            <div className="mt-1 leading-relaxed">
              {primaryChildSessionPreview.statusSummary}
            </div>
          )}
          {primaryChildSessionPreview.nextStepHint && (
            <div className="mt-1 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
              下一步：{primaryChildSessionPreview.nextStepHint}
            </div>
          )}
        </div>
      )}

      {preview.dialogHistory.length === 0 ? (
        <div className={`rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 text-center text-[12px] text-[var(--color-text-secondary)] ${compact ? "flex min-h-[220px] flex-1 items-center justify-center px-3.5 py-3.5" : "px-4 py-4"}`}>
          这个 IM 会话还没有可展示的 Dialog 内容。
        </div>
      ) : (
        <div className={compact ? "min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" : "space-y-3"}>
          {preview.dialogHistory.length > visibleDialogHistory.length && (
            <button
              onClick={() => {
                setVisibleMessageCount((current) => Math.min(
                  preview.dialogHistory.length,
                  current + CHANNEL_MESSAGE_WINDOW_SIZE,
                ));
              }}
              className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]/80 px-3 py-2 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-sky-500/20 hover:text-[var(--color-text)]"
            >
              加载更早的 {preview.dialogHistory.length - visibleDialogHistory.length} 条消息
            </button>
          )}
          {visibleDialogHistory.map((msg) => {
            const isUser = msg.from === "user";
            const actorIdx = actorIdToIndex.get(msg.from) ?? 0;
            const actor = actorById.get(msg.from);
            const actorName = isUser ? "你" : (actor?.roleName ?? msg.from);
            const targetName = msg.to
              ? (msg.to === "user" ? "你" : (actorById.get(msg.to)?.roleName ?? msg.to))
              : undefined;

            return (
              <div key={msg.id} className="max-w-full">
                {renderMessageBubble({
                  message: msg,
                  actorIndex: actorIdx,
                  actorName,
                  targetName,
                  isUser,
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RuntimeSessionPreviewPlaceholder({
  sessionId,
  runtimeRecord,
  currentRoomSessionId,
  onReturnToCurrentRoom,
  compact = false,
  hideHeader = false,
}: {
  sessionId: string;
  runtimeRecord?: RuntimeSessionRecord | null;
  currentRoomSessionId?: string | null;
  onReturnToCurrentRoom?: (() => void) | null;
  compact?: boolean;
  hideHeader?: boolean;
}) {
  const label = runtimeRecord?.displayLabel?.trim() || "外部会话";
  const detail = runtimeRecord?.displayDetail?.trim() || "会话已切换，但还没有同步到可展示的预览内容。";
  const statusLabel = runtimeRecord ? getRuntimeIndicatorStatus(runtimeRecord) : "等待同步";
  const updatedAt = runtimeRecord?.updatedAt ?? 0;

  return (
    <div className={compact ? "flex min-h-0 flex-1 flex-col gap-2.5" : "space-y-3"}>
      {!hideHeader && (
        <div className={`rounded-2xl border border-sky-500/15 bg-sky-500/5 ${compact ? "px-3.5 py-2.5" : "px-4 py-3"}`}>
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Users className="h-4 w-4 text-sky-600" />
                <span className="text-[13px] font-semibold text-[var(--color-text)]">{label}</span>
                <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700">
                  已切换会话
                </span>
              </div>
              <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{detail}</div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
                <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5">
                  {statusLabel}
                </span>
                {updatedAt > 0 && (
                  <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5">
                    最近更新 {formatSessionStripTime(updatedAt)}
                  </span>
                )}
                <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5">
                  {sessionId}
                </span>
              </div>
            </div>
            {currentRoomSessionId && onReturnToCurrentRoom && (
              <button
                onClick={onReturnToCurrentRoom}
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-[var(--color-bg)] px-3 py-1 text-[10px] text-sky-700 hover:border-sky-500/35 hover:bg-sky-500/10 transition-colors"
              >
                返回当前房间
              </button>
            )}
          </div>
        </div>
      )}

      <div className={`rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 text-center ${compact ? "flex min-h-[220px] flex-1 items-center justify-center px-3.5 py-3.5" : "px-4 py-4"}`}>
        <div className="text-[13px] font-medium text-[var(--color-text)]">会话已经切换</div>
        <div className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
          当前外部会话还没有同步到可展示的历史内容，或者这条记录只保留了运行时状态。
          <br />
          如果这是一个刚启动的会话，等首条消息写入后这里会自动出现预览。
        </div>
      </div>
    </div>
  );
}

export function ChannelSessionBoard({
  group,
  selectedConversationKey,
  currentRoomSessionId,
  onSelectConversation,
  onClearExtraConversations,
  onReturnToCurrentRoom,
  renderMessageBubble,
}: {
  group: DialogChannelGroup;
  selectedConversationKey?: string | null;
  currentRoomSessionId?: string | null;
  onSelectConversation: (conversationKey: string) => void;
  onClearExtraConversations?: (() => void) | null;
  onReturnToCurrentRoom?: (() => void) | null;
  renderMessageBubble: (params: {
    message: DialogMessage;
    actorIndex: number;
    actorName: string;
    targetName?: string;
    isUser: boolean;
  }) => React.ReactNode;
}) {
  const selectedConversation = group.conversations.find((item) => item.key === selectedConversationKey)
    ?? group.conversations[0]
    ?? null;

  if (group.conversations.length === 0) {
    return (
      <div className="rounded-[26px] border border-sky-500/15 bg-[linear-gradient(135deg,rgba(14,165,233,0.10),rgba(255,255,255,0.65)_55%)] px-4 py-4 shadow-[0_20px_45px_-38px_rgba(14,165,233,0.55)]">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Users className="h-4 w-4 text-sky-600" />
              <span className="text-[13px] font-semibold text-[var(--color-text)]">{group.label}</span>
              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700">
                暂无会话
              </span>
            </div>
            <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
              等该渠道收到消息后，这里会显示最近的会话和预览内容。
            </div>
          </div>
          {currentRoomSessionId && onReturnToCurrentRoom && (
            <button
              onClick={onReturnToCurrentRoom}
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-[var(--color-bg)] px-3 py-1 text-[10px] text-sky-700 hover:border-sky-500/35 hover:bg-sky-500/10 transition-colors"
            >
              返回本机
            </button>
          )}
        </div>
      </div>
    );
  }

  if (group.conversations.length === 1 && selectedConversation) {
    const singleConversationInDatabaseMode = isDatabaseOperationMode(
      selectedConversation.preview ?? selectedConversation.conversation,
    );
    return (
      <div className="flex min-h-full flex-col gap-2.5">
        <div className="rounded-[24px] border border-sky-500/15 bg-[linear-gradient(135deg,rgba(14,165,233,0.09),rgba(255,255,255,0.76)_58%)] px-3.5 py-3 shadow-[0_18px_40px_-36px_rgba(14,165,233,0.55)]">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Users className="h-4 w-4 text-sky-600" />
                <span className="text-[13px] font-semibold text-[var(--color-text)]">{group.label}</span>
                <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700">
                  1 个会话
                </span>
                <span className="rounded-full border border-white/80 bg-white/75 px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                  {selectedConversation.statusLabel}
                </span>
                {singleConversationInDatabaseMode && (
                  <span className="rounded-full border border-fuchsia-500/18 bg-fuchsia-500/8 px-2 py-0.5 text-[10px] text-fuchsia-700">
                    当前处于数据库操作模式
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
                <span>{selectedConversation.label}</span>
                <span>·</span>
                <span>{selectedConversation.detail}</span>
                <span>·</span>
                <span>{formatSessionStripTime(selectedConversation.updatedAt)}</span>
              </div>
              {singleConversationInDatabaseMode && (
                <div className="mt-2 rounded-[16px] border border-fuchsia-500/15 bg-fuchsia-500/8 px-2.5 py-1.5 text-[10px] text-fuchsia-800">
                  发送“退出数据库操作”可返回普通对话
                </div>
              )}
            </div>
            {currentRoomSessionId && onReturnToCurrentRoom && (
              <button
                onClick={onReturnToCurrentRoom}
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-[var(--color-bg)] px-3 py-1 text-[10px] text-sky-700 hover:border-sky-500/35 hover:bg-sky-500/10 transition-colors"
              >
                返回本机
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {selectedConversation.preview ? (
            <RuntimeSessionPreview
              preview={selectedConversation.preview}
              currentRoomSessionId={currentRoomSessionId}
              onReturnToCurrentRoom={onReturnToCurrentRoom}
              compact
              hideHeader
              renderMessageBubble={renderMessageBubble}
            />
          ) : (
            <RuntimeSessionPreviewPlaceholder
              sessionId={selectedConversation.activeSessionId || selectedConversation.conversationId}
              runtimeRecord={selectedConversation.runtimeRecord}
              currentRoomSessionId={currentRoomSessionId}
              onReturnToCurrentRoom={onReturnToCurrentRoom}
              compact
              hideHeader
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-full gap-3 xl:grid-cols-[300px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col rounded-[26px] border border-sky-500/15 bg-[linear-gradient(145deg,rgba(14,165,233,0.10),rgba(255,255,255,0.70)_58%)] p-3 shadow-[0_20px_45px_-38px_rgba(14,165,233,0.55)]">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Users className="h-4 w-4 text-sky-600" />
              <span className="text-[13px] font-semibold text-[var(--color-text)]">{group.label}</span>
              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700">
                {group.conversations.length} 个会话
              </span>
            </div>
            <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{group.detail}</div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
              <span className="rounded-full border border-white/70 bg-white/60 px-2 py-0.5">
                当前状态 {group.statusLabel}
              </span>
              {group.updatedAt > 0 && (
                <span className="rounded-full border border-white/70 bg-white/60 px-2 py-0.5">
                  最近更新 {formatSessionStripTime(group.updatedAt)}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {group.conversations.length > 1 && onClearExtraConversations && (
              <button
                onClick={onClearExtraConversations}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-[var(--color-bg)] px-3 py-1 text-[10px] text-amber-700 hover:border-amber-500/35 hover:bg-amber-500/10 transition-colors"
              >
                清理多余会话
              </button>
            )}
            {currentRoomSessionId && onReturnToCurrentRoom && (
              <button
                onClick={onReturnToCurrentRoom}
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-[var(--color-bg)] px-3 py-1 text-[10px] text-sky-700 hover:border-sky-500/35 hover:bg-sky-500/10 transition-colors"
              >
                返回本机
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 flex min-h-0 flex-1 flex-col rounded-[22px] border border-white/70 bg-white/70 p-2.5 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[10px] font-medium tracking-[0.02em] text-[var(--color-text-secondary)]">
              会话列表
            </span>
            <span className="text-[10px] text-[var(--color-text-tertiary)]">
              选择后在右侧查看
            </span>
          </div>
          <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {group.conversations.map((conversation) => {
              const isSelected = conversation.key === selectedConversation?.key;
              const topicHint = conversation.backgroundTopicCount > 0
                ? ` · ${conversation.backgroundTopicCount} 个后台话题`
                : "";
              const approvalHeadline = getApprovalHeadline(
                conversation.preview ?? conversation.conversation,
              );
              const approvalText = conversation.preview?.approvalSummary
                ?? conversation.conversation.approvalSummary
                ?? conversation.preview?.pendingApprovalReason
                ?? conversation.conversation.pendingApprovalReason
                ?? "";
              const childSessionPreviewText = buildChildSessionPreviewText(
                conversation.preview?.childSessionsPreview
                  ?? conversation.conversation.childSessionsPreview,
              );
              const compactionHeadline = buildCompactionHeadline(
                conversation.preview ?? conversation.conversation,
              );
              const compactionDetail = buildCompactionDetail(
                conversation.preview ?? conversation.conversation,
              );
              return (
                <button
                  key={conversation.key}
                  onClick={() => onSelectConversation(conversation.key)}
                  className={`w-full rounded-[20px] border px-3 py-2.5 text-left transition-all ${
                    isSelected
                      ? "border-sky-500/35 bg-sky-500/12 shadow-[0_14px_28px_-24px_rgba(14,165,233,0.65)]"
                      : "border-[var(--color-border)] bg-[var(--color-bg)]/90 hover:border-sky-500/20 hover:bg-[var(--color-bg)]"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${isSelected ? "bg-sky-500" : "bg-[var(--color-border)]"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-semibold text-[var(--color-text)]">
                        {conversation.label}
                      </div>
                      <div className="mt-1 truncate text-[10px] text-[var(--color-text-secondary)]">
                        {conversation.detail}
                      </div>
                      <div className="mt-1 truncate text-[9px] text-[var(--color-text-tertiary)]">
                        当前话题 {conversation.activeTopicId}{topicHint}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[9px] text-[var(--color-text-tertiary)]">
                        <span>{conversation.statusLabel}</span>
                        <span>·</span>
                        <span>{formatSessionStripTime(conversation.updatedAt)}</span>
                      </div>
                      {isDatabaseOperationMode(conversation.preview ?? conversation.conversation) && (
                        <div className="mt-1.5 rounded-[14px] border border-fuchsia-500/18 bg-fuchsia-500/7 px-2 py-1 text-[9px] leading-relaxed text-fuchsia-900">
                          <span className="font-medium">数据库操作模式：</span>
                          <span>发送“退出数据库操作”可返回普通对话</span>
                        </div>
                      )}
                      {approvalHeadline && (
                        <div className="mt-1.5 rounded-[14px] border border-amber-500/20 bg-amber-500/8 px-2 py-1 text-[9px] leading-relaxed text-amber-800">
                          <span className="font-medium">{approvalHeadline}</span>
                          {approvalText ? <span className="ml-1">{approvalText}</span> : null}
                        </div>
                      )}
                      {childSessionPreviewText && (
                        <div className="mt-1.5 rounded-[14px] border border-sky-500/15 bg-sky-500/6 px-2 py-1 text-[9px] leading-relaxed text-sky-900">
                          <span className="font-medium">后台线程：</span>
                          <span>{childSessionPreviewText}</span>
                        </div>
                      )}
                      {compactionHeadline && (
                        <div className="mt-1.5 rounded-[14px] border border-emerald-500/15 bg-emerald-500/7 px-2 py-1 text-[9px] leading-relaxed text-emerald-900">
                          <span className="font-medium">{compactionHeadline}</span>
                          {compactionDetail ? <span className="ml-1">{compactionDetail}</span> : null}
                        </div>
                      )}
                      {buildCollaborationMetaPills({
                        executionStrategy: conversation.conversation.executionStrategy,
                        pendingInteractionCount: conversation.conversation.pendingInteractionCount,
                        queuedFollowUpCount: conversation.conversation.queuedFollowUpCount,
                        childSessionCount: conversation.conversation.childSessionsPreview.length,
                        contractState: conversation.conversation.contractState,
                      }).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          {buildCollaborationMetaPills({
                            executionStrategy: conversation.conversation.executionStrategy,
                            pendingInteractionCount: conversation.conversation.pendingInteractionCount,
                            queuedFollowUpCount: conversation.conversation.queuedFollowUpCount,
                            childSessionCount: conversation.conversation.childSessionsPreview.length,
                            contractState: conversation.conversation.contractState,
                          }).map((pill) => (
                            <span
                              key={`${conversation.key}-${pill}`}
                              className="rounded-full border border-[var(--color-border)]/80 px-1.5 py-0.5 text-[9px] text-[var(--color-text-tertiary)]"
                            >
                              {pill}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="min-w-0 min-h-0 flex">
        {selectedConversation?.preview ? (
          <RuntimeSessionPreview
            preview={selectedConversation.preview}
            currentRoomSessionId={currentRoomSessionId}
            onReturnToCurrentRoom={onReturnToCurrentRoom}
            compact
            renderMessageBubble={renderMessageBubble}
          />
        ) : selectedConversation ? (
          <RuntimeSessionPreviewPlaceholder
            sessionId={selectedConversation.activeSessionId || selectedConversation.conversationId}
            runtimeRecord={selectedConversation.runtimeRecord}
            currentRoomSessionId={currentRoomSessionId}
            onReturnToCurrentRoom={onReturnToCurrentRoom}
            compact
          />
        ) : null}
      </div>
    </div>
  );
}
