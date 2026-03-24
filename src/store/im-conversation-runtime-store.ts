import { create } from "zustand";
import type {
  ActorStatus,
  DialogMessage,
  ApprovalRequestDetail,
  ApprovalDecisionOption,
} from "@/core/agent/actor/types";
import type {
  CollaborationChildSessionPreview,
  ExecutionContractState,
  ExecutionStrategy,
} from "@/core/collaboration/types";
import type { ChannelType, ChannelIncomingMessage } from "@/core/channels/types";
import { createLogger } from "@/core/logger";

export type IMConversationRuntimeStatus = "idle" | "running" | "waiting" | "queued";
export type IMConversationApprovalStatus = "none" | "awaiting_user" | "approved" | "rejected";
export type IMConversationMode = "normal" | "database_operation";

const log = createLogger("IMConversationOverlay");
const EXTERNAL_EXPORT_TOPIC_ID = "export";
const EXTERNAL_EXPORT_ACTOR_ID = "agent-data-export";
const EXTERNAL_EXPORT_DIALOG_WINDOW_SIZE = 100;

export interface IMConversationSessionActorPreview {
  id: string;
  roleName: string;
  status: ActorStatus;
}

export interface IMConversationApprovalPreview {
  approvalStatus?: IMConversationApprovalStatus;
  approvalSummary?: string;
  approvalRiskLabel?: string;
  pendingApprovalReason?: string;
}

export interface IMConversationCompactionPreview {
  roomCompactionSummaryPreview?: string;
  roomCompactionUpdatedAt?: number;
  roomCompactionMessageCount?: number;
  roomCompactionTaskCount?: number;
  roomCompactionArtifactCount?: number;
  roomCompactionPreservedIdentifiers?: string[];
}

export interface IMConversationSessionPreview extends IMConversationApprovalPreview, IMConversationCompactionPreview {
  sessionId: string;
  runtimeKey: string;
  channelId: string;
  channelType: ChannelType;
  conversationId: string;
  conversationType: ChannelIncomingMessage["conversationType"];
  topicId: string;
  displayLabel: string;
  displayDetail: string;
  status: IMConversationRuntimeStatus;
  queueLength: number;
  executionStrategy?: ExecutionStrategy | null;
  pendingInteractionCount: number;
  childSessionsPreview: CollaborationChildSessionPreview[];
  queuedFollowUpCount: number;
  contractState?: ExecutionContractState | null;
  startedAt: number;
  updatedAt: number;
  lastInputText?: string;
  conversationMode?: IMConversationMode;
  actors: IMConversationSessionActorPreview[];
  dialogHistory: DialogMessage[];
}

export interface IMConversationTopicSnapshot extends IMConversationApprovalPreview, IMConversationCompactionPreview {
  runtimeKey: string;
  topicId: string;
  sessionId: string;
  status: IMConversationRuntimeStatus;
  queueLength: number;
  pendingInteractionCount: number;
  queuedFollowUpCount: number;
  contractState?: ExecutionContractState | null;
  updatedAt: number;
  startedAt: number;
  lastInputText?: string;
  conversationMode?: IMConversationMode;
}

export interface IMConversationSnapshot extends IMConversationApprovalPreview, IMConversationCompactionPreview {
  key: string;
  channelId: string;
  channelType: ChannelType;
  conversationId: string;
  conversationType: ChannelIncomingMessage["conversationType"];
  displayLabel: string;
  displayDetail: string;
  activeTopicId: string;
  nextTopicSeq: number;
  updatedAt: number;
  activeSessionId?: string;
  activeStatus: IMConversationRuntimeStatus;
  activeQueueLength: number;
  executionStrategy?: ExecutionStrategy | null;
  pendingInteractionCount: number;
  childSessionsPreview: CollaborationChildSessionPreview[];
  queuedFollowUpCount: number;
  contractState?: ExecutionContractState | null;
  backgroundTopicCount: number;
  conversationMode?: IMConversationMode;
  topics: IMConversationTopicSnapshot[];
}

interface ExternalConversationOverlay {
  conversation: IMConversationSnapshot;
  sessionPreview: IMConversationSessionPreview;
}

interface IMConversationRuntimeStoreState {
  conversations: IMConversationSnapshot[];
  sessionPreviews: Record<string, IMConversationSessionPreview>;
  externalConversationOverlays: Record<string, ExternalConversationOverlay>;
  replaceRuntimeData: (params: {
    conversations: IMConversationSnapshot[];
    sessionPreviews: IMConversationSessionPreview[];
  }) => void;
  upsertExternalConversationTurn: (params: {
    channelId: string;
    channelType: ChannelType;
    conversationId: string;
    conversationType: ChannelIncomingMessage["conversationType"];
    content: string;
    from: "user" | "assistant";
    status?: IMConversationRuntimeStatus;
    messageId?: string;
    timestamp?: number;
    displayLabel?: string;
    displayDetail?: string;
    conversationMode?: IMConversationMode;
    images?: string[];
    attachments?: { path: string; fileName?: string }[];
  }) => void;
  clearExternalConversation: (channelId: string, conversationId: string) => void;
  clearChannel: (channelId: string) => void;
  reset: () => void;
}

function sortSnapshots(conversations: IMConversationSnapshot[]): IMConversationSnapshot[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

function buildConversationKey(channelId: string, conversationId: string): string {
  return `${channelId.trim()}::${conversationId.trim()}`;
}

function buildExternalSessionId(channelId: string, conversationId: string): string {
  return `im-export::${buildConversationKey(channelId, conversationId)}`;
}

function getExternalDisplayLabel(
  channelType: ChannelType,
  conversationType: ChannelIncomingMessage["conversationType"],
  displayLabel?: string,
): string {
  const normalized = displayLabel?.trim();
  if (normalized) return normalized;
  if (conversationType === "group") {
    return channelType === "dingtalk" ? "钉钉群会话" : "飞书群会话";
  }
  return channelType === "dingtalk" ? "钉钉会话" : "飞书会话";
}

function getExternalDisplayDetail(
  channelType: ChannelType,
  conversationType: ChannelIncomingMessage["conversationType"],
  displayDetail?: string,
): string {
  const normalized = displayDetail?.trim();
  if (normalized) return normalized;
  const platform = channelType === "dingtalk" ? "钉钉" : "飞书";
  const conversation = conversationType === "group" ? "群聊" : "私聊";
  return `${platform} · ${conversation}`;
}

function toExternalActorStatus(status: IMConversationRuntimeStatus): ActorStatus {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "queued":
      return "paused";
    default:
      return "idle";
  }
}

function mergeRuntimeDataWithExternalOverlays(
  conversations: IMConversationSnapshot[],
  sessionPreviewMap: Record<string, IMConversationSessionPreview>,
  overlays: Record<string, ExternalConversationOverlay>,
): {
  conversations: IMConversationSnapshot[];
  sessionPreviews: Record<string, IMConversationSessionPreview>;
} {
  const conversationMap = new Map(conversations.map((conversation) => [conversation.key, conversation] as const));
  const nextSessionPreviews = { ...sessionPreviewMap };

  for (const [key, overlay] of Object.entries(overlays)) {
    const current = conversationMap.get(key);
    const overlayConversation = overlay.conversation;
    const overlaySessionPreview = overlay.sessionPreview;
    const currentActiveSessionId = current?.activeSessionId?.trim() || "";
    const currentPreview = currentActiveSessionId
      ? nextSessionPreviews[currentActiveSessionId]
      : undefined;
    const mergedSessionId = overlaySessionPreview.sessionId?.trim()
      || currentActiveSessionId
      || buildExternalSessionId(overlayConversation.channelId, overlayConversation.conversationId);
    const mergedUpdatedAt = Math.max(
      current?.updatedAt ?? 0,
      currentPreview?.updatedAt ?? 0,
      overlayConversation.updatedAt,
      overlaySessionPreview.updatedAt,
    );
    const preferOverlayRuntime = overlaySessionPreview.updatedAt >= (currentPreview?.updatedAt ?? 0);
    const mergedStatus = preferOverlayRuntime
      ? overlaySessionPreview.status
      : (currentPreview?.status ?? overlaySessionPreview.status);
    const mergedQueueLength = preferOverlayRuntime
      ? overlaySessionPreview.queueLength
      : (currentPreview?.queueLength ?? overlaySessionPreview.queueLength);
    const mergedPendingInteractionCount = Math.max(
      current?.pendingInteractionCount ?? 0,
      currentPreview?.pendingInteractionCount ?? 0,
      overlayConversation.pendingInteractionCount,
      overlaySessionPreview.pendingInteractionCount,
      mergedStatus === "waiting" ? 1 : 0,
    );
    const mergedQueuedFollowUpCount = Math.max(
      current?.queuedFollowUpCount ?? 0,
      currentPreview?.queuedFollowUpCount ?? 0,
      overlayConversation.queuedFollowUpCount,
      overlaySessionPreview.queuedFollowUpCount,
    );
    const mergedTopicId = overlaySessionPreview.topicId?.trim()
      || currentPreview?.topicId?.trim()
      || current?.activeTopicId?.trim()
      || overlayConversation.activeTopicId;
    const mergedRuntimeKey = overlaySessionPreview.runtimeKey?.trim()
      || currentPreview?.runtimeKey?.trim()
      || `${key}::${mergedTopicId}`;
    const mergedPreview: IMConversationSessionPreview = {
      sessionId: mergedSessionId,
      runtimeKey: mergedRuntimeKey,
      channelId: current?.channelId ?? overlayConversation.channelId,
      channelType: current?.channelType ?? overlayConversation.channelType,
      conversationId: current?.conversationId ?? overlayConversation.conversationId,
      conversationType: current?.conversationType ?? overlayConversation.conversationType,
      topicId: mergedTopicId,
      displayLabel: overlaySessionPreview.displayLabel || currentPreview?.displayLabel || overlayConversation.displayLabel,
      displayDetail: overlaySessionPreview.displayDetail || currentPreview?.displayDetail || overlayConversation.displayDetail,
      status: mergedStatus,
      queueLength: mergedQueueLength,
      executionStrategy: currentPreview?.executionStrategy ?? overlaySessionPreview.executionStrategy ?? null,
      pendingInteractionCount: mergedPendingInteractionCount,
      childSessionsPreview: currentPreview?.childSessionsPreview ?? overlaySessionPreview.childSessionsPreview,
      queuedFollowUpCount: mergedQueuedFollowUpCount,
      contractState: currentPreview?.contractState ?? overlaySessionPreview.contractState ?? null,
      approvalStatus: currentPreview?.approvalStatus ?? overlaySessionPreview.approvalStatus,
      approvalSummary: currentPreview?.approvalSummary ?? overlaySessionPreview.approvalSummary,
      approvalRiskLabel: currentPreview?.approvalRiskLabel ?? overlaySessionPreview.approvalRiskLabel,
      pendingApprovalReason: currentPreview?.pendingApprovalReason ?? overlaySessionPreview.pendingApprovalReason,
      roomCompactionSummaryPreview: currentPreview?.roomCompactionSummaryPreview ?? overlaySessionPreview.roomCompactionSummaryPreview,
      roomCompactionUpdatedAt: currentPreview?.roomCompactionUpdatedAt ?? overlaySessionPreview.roomCompactionUpdatedAt,
      roomCompactionMessageCount: currentPreview?.roomCompactionMessageCount ?? overlaySessionPreview.roomCompactionMessageCount,
      roomCompactionTaskCount: currentPreview?.roomCompactionTaskCount ?? overlaySessionPreview.roomCompactionTaskCount,
      roomCompactionArtifactCount: currentPreview?.roomCompactionArtifactCount ?? overlaySessionPreview.roomCompactionArtifactCount,
      roomCompactionPreservedIdentifiers: currentPreview?.roomCompactionPreservedIdentifiers ?? overlaySessionPreview.roomCompactionPreservedIdentifiers,
      startedAt: Math.min(
        currentPreview?.startedAt ?? overlaySessionPreview.startedAt,
        overlaySessionPreview.startedAt,
      ),
      updatedAt: mergedUpdatedAt,
      conversationMode: overlaySessionPreview.conversationMode
        ?? currentPreview?.conversationMode
        ?? overlayConversation.conversationMode
        ?? current?.conversationMode,
      ...(overlaySessionPreview.lastInputText || currentPreview?.lastInputText
        ? { lastInputText: overlaySessionPreview.lastInputText ?? currentPreview?.lastInputText }
        : {}),
      actors: mergeActorPreviewLists(currentPreview?.actors, overlaySessionPreview.actors),
      dialogHistory: mergeDialogHistories(
        currentPreview?.dialogHistory ?? [],
        overlaySessionPreview.dialogHistory,
      ),
    };
    nextSessionPreviews[mergedSessionId] = mergedPreview;

    const baseTopics = current?.topics ?? [];
    const mergedTopics = baseTopics.length > 0
      ? baseTopics.map((topic) => (
        topic.topicId === (current?.activeTopicId ?? mergedTopicId)
          ? {
              ...topic,
              runtimeKey: mergedRuntimeKey,
              topicId: mergedTopicId,
              sessionId: mergedSessionId,
              status: mergedStatus,
              queueLength: mergedQueueLength,
              pendingInteractionCount: mergedPendingInteractionCount,
              queuedFollowUpCount: mergedQueuedFollowUpCount,
              contractState: mergedPreview.contractState ?? null,
              approvalStatus: mergedPreview.approvalStatus,
              approvalSummary: mergedPreview.approvalSummary,
              approvalRiskLabel: mergedPreview.approvalRiskLabel,
              pendingApprovalReason: mergedPreview.pendingApprovalReason,
              roomCompactionSummaryPreview: mergedPreview.roomCompactionSummaryPreview,
              roomCompactionUpdatedAt: mergedPreview.roomCompactionUpdatedAt,
              roomCompactionMessageCount: mergedPreview.roomCompactionMessageCount,
              roomCompactionTaskCount: mergedPreview.roomCompactionTaskCount,
              roomCompactionArtifactCount: mergedPreview.roomCompactionArtifactCount,
              roomCompactionPreservedIdentifiers: mergedPreview.roomCompactionPreservedIdentifiers,
              updatedAt: mergedUpdatedAt,
              startedAt: mergedPreview.startedAt,
              conversationMode: mergedPreview.conversationMode ?? topic.conversationMode,
              ...(mergedPreview.lastInputText ? { lastInputText: mergedPreview.lastInputText } : {}),
            }
          : topic
      ))
      : [{
          runtimeKey: mergedRuntimeKey,
          topicId: mergedTopicId,
          sessionId: mergedSessionId,
          status: mergedStatus,
          queueLength: mergedQueueLength,
          pendingInteractionCount: mergedPendingInteractionCount,
          queuedFollowUpCount: mergedQueuedFollowUpCount,
          contractState: mergedPreview.contractState ?? null,
          approvalStatus: mergedPreview.approvalStatus,
          approvalSummary: mergedPreview.approvalSummary,
          approvalRiskLabel: mergedPreview.approvalRiskLabel,
          pendingApprovalReason: mergedPreview.pendingApprovalReason,
          roomCompactionSummaryPreview: mergedPreview.roomCompactionSummaryPreview,
          roomCompactionUpdatedAt: mergedPreview.roomCompactionUpdatedAt,
          roomCompactionMessageCount: mergedPreview.roomCompactionMessageCount,
          roomCompactionTaskCount: mergedPreview.roomCompactionTaskCount,
          roomCompactionArtifactCount: mergedPreview.roomCompactionArtifactCount,
          roomCompactionPreservedIdentifiers: mergedPreview.roomCompactionPreservedIdentifiers,
          updatedAt: mergedUpdatedAt,
          startedAt: mergedPreview.startedAt,
          conversationMode: mergedPreview.conversationMode,
          ...(mergedPreview.lastInputText ? { lastInputText: mergedPreview.lastInputText } : {}),
        }];

    conversationMap.set(key, {
      key,
      channelId: current?.channelId ?? overlayConversation.channelId,
      channelType: current?.channelType ?? overlayConversation.channelType,
      conversationId: current?.conversationId ?? overlayConversation.conversationId,
      conversationType: current?.conversationType ?? overlayConversation.conversationType,
      displayLabel: overlaySessionPreview.displayLabel || current?.displayLabel || overlayConversation.displayLabel,
      displayDetail: overlaySessionPreview.displayDetail || current?.displayDetail || overlayConversation.displayDetail,
      activeTopicId: current?.activeTopicId ?? mergedTopicId,
      nextTopicSeq: current?.nextTopicSeq ?? overlayConversation.nextTopicSeq,
      updatedAt: mergedUpdatedAt,
      activeSessionId: mergedSessionId,
      activeStatus: mergedStatus,
      activeQueueLength: mergedQueueLength,
      executionStrategy: current?.executionStrategy ?? overlayConversation.executionStrategy ?? mergedPreview.executionStrategy ?? null,
      pendingInteractionCount: mergedPendingInteractionCount,
      childSessionsPreview: current?.childSessionsPreview ?? overlayConversation.childSessionsPreview,
      queuedFollowUpCount: mergedQueuedFollowUpCount,
      contractState: current?.contractState ?? overlayConversation.contractState ?? mergedPreview.contractState ?? null,
      approvalStatus: current?.approvalStatus ?? overlayConversation.approvalStatus ?? mergedPreview.approvalStatus,
      approvalSummary: current?.approvalSummary ?? overlayConversation.approvalSummary ?? mergedPreview.approvalSummary,
      approvalRiskLabel: current?.approvalRiskLabel ?? overlayConversation.approvalRiskLabel ?? mergedPreview.approvalRiskLabel,
      pendingApprovalReason: current?.pendingApprovalReason ?? overlayConversation.pendingApprovalReason ?? mergedPreview.pendingApprovalReason,
      roomCompactionSummaryPreview: current?.roomCompactionSummaryPreview ?? overlayConversation.roomCompactionSummaryPreview ?? mergedPreview.roomCompactionSummaryPreview,
      roomCompactionUpdatedAt: current?.roomCompactionUpdatedAt ?? overlayConversation.roomCompactionUpdatedAt ?? mergedPreview.roomCompactionUpdatedAt,
      roomCompactionMessageCount: current?.roomCompactionMessageCount ?? overlayConversation.roomCompactionMessageCount ?? mergedPreview.roomCompactionMessageCount,
      roomCompactionTaskCount: current?.roomCompactionTaskCount ?? overlayConversation.roomCompactionTaskCount ?? mergedPreview.roomCompactionTaskCount,
      roomCompactionArtifactCount: current?.roomCompactionArtifactCount ?? overlayConversation.roomCompactionArtifactCount ?? mergedPreview.roomCompactionArtifactCount,
      roomCompactionPreservedIdentifiers: current?.roomCompactionPreservedIdentifiers ?? overlayConversation.roomCompactionPreservedIdentifiers ?? mergedPreview.roomCompactionPreservedIdentifiers,
      backgroundTopicCount: current?.backgroundTopicCount ?? overlayConversation.backgroundTopicCount,
      conversationMode: overlayConversation.conversationMode
        ?? mergedPreview.conversationMode
        ?? current?.conversationMode,
      topics: mergedTopics,
    });
  }

  return {
    conversations: sortSnapshots([...conversationMap.values()]),
    sessionPreviews: nextSessionPreviews,
  };
}

function findConversationBasePreview(
  conversations: readonly IMConversationSnapshot[],
  sessionPreviews: Record<string, IMConversationSessionPreview>,
  conversationKey: string,
): {
  conversation?: IMConversationSnapshot;
  preview?: IMConversationSessionPreview;
} {
  const conversation = conversations.find((item) => item.key === conversationKey);
  const activeSessionId = conversation?.activeSessionId?.trim() || "";
  const preview = activeSessionId ? sessionPreviews[activeSessionId] : undefined;
  return { conversation, preview };
}

function mergeActorPreviews(
  baseActors: readonly IMConversationSessionActorPreview[],
  nextActor: IMConversationSessionActorPreview,
): IMConversationSessionActorPreview[] {
  const seen = new Set<string>();
  const merged: IMConversationSessionActorPreview[] = [];
  for (const actor of [...baseActors, nextActor]) {
    if (!actor?.id || seen.has(actor.id)) continue;
    seen.add(actor.id);
    merged.push(actor);
  }
  return merged;
}

function mergeActorPreviewLists(
  ...groups: Array<readonly IMConversationSessionActorPreview[] | undefined>
): IMConversationSessionActorPreview[] {
  const seen = new Set<string>();
  const merged: IMConversationSessionActorPreview[] = [];
  for (const group of groups) {
    for (const actor of group ?? []) {
      if (!actor?.id || seen.has(actor.id)) continue;
      seen.add(actor.id);
      merged.push(actor);
    }
  }
  return merged;
}

function buildDialogMessageKey(message: DialogMessage): string {
  const normalizedId = String(message.id ?? "").trim();
  if (normalizedId) return normalizedId;
  return [message.from, message.timestamp, message.kind, message.content].join("::");
}

function mergeDialogMessageMedia(
  left?: DialogMessage["images"],
  right?: DialogMessage["images"],
): string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])].filter(Boolean);
  return merged.length ? merged : undefined;
}

function mergeDialogMessageAttachments(
  left?: DialogMessage["attachments"],
  right?: DialogMessage["attachments"],
): DialogMessage["attachments"] | undefined {
  const merged = new Map<string, { path: string; fileName?: string }>();
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    const path = String(item?.path ?? "").trim();
    if (!path) continue;
    merged.set(path, {
      path,
      ...(item?.fileName ? { fileName: item.fileName } : {}),
    });
  }
  const attachments = [...merged.values()];
  return attachments.length ? attachments : undefined;
}

function mergeDialogMessage(
  current: DialogMessage | undefined,
  incoming: DialogMessage,
): DialogMessage {
  if (!current) {
    return {
      ...incoming,
      ...(incoming.images ? { images: [...incoming.images] } : {}),
      ...(incoming.attachments ? { attachments: incoming.attachments.map((item) => ({ ...item })) } : {}),
    };
  }

  return {
    ...current,
    ...incoming,
    ...(mergeDialogMessageMedia(current.images, incoming.images)
      ? { images: mergeDialogMessageMedia(current.images, incoming.images) }
      : {}),
    ...(mergeDialogMessageAttachments(current.attachments, incoming.attachments)
      ? { attachments: mergeDialogMessageAttachments(current.attachments, incoming.attachments) }
      : {}),
  };
}

function mergeDialogHistories(
  baseHistory: readonly DialogMessage[],
  overlayHistory: readonly DialogMessage[],
): DialogMessage[] {
  const merged = new Map<string, DialogMessage>();
  for (const message of [...baseHistory, ...overlayHistory]) {
    const key = buildDialogMessageKey(message);
    merged.set(key, mergeDialogMessage(merged.get(key), message));
  }
  return [...merged.values()]
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }
      return buildDialogMessageKey(left).localeCompare(buildDialogMessageKey(right));
    })
    .slice(-EXTERNAL_EXPORT_DIALOG_WINDOW_SIZE);
}

function areStringListsEqual(left?: readonly string[], right?: readonly string[]): boolean {
  const leftLength = left?.length ?? 0;
  const rightLength = right?.length ?? 0;
  if (leftLength !== rightLength) return false;
  for (let index = 0; index < leftLength; index += 1) {
    if (left?.[index] !== right?.[index]) return false;
  }
  return true;
}

function areApprovalRequestDetailsEqual(
  left?: ApprovalRequestDetail[],
  right?: ApprovalRequestDetail[],
): boolean {
  const leftLength = left?.length ?? 0;
  const rightLength = right?.length ?? 0;
  if (leftLength !== rightLength) return false;
  for (let index = 0; index < leftLength; index += 1) {
    const leftItem = left?.[index];
    const rightItem = right?.[index];
    if (
      !leftItem
      || !rightItem
      || leftItem.label !== rightItem.label
      || leftItem.value !== rightItem.value
      || leftItem.mono !== rightItem.mono
    ) {
      return false;
    }
  }
  return true;
}

function areApprovalDecisionOptionsEqual(
  left?: ApprovalDecisionOption[],
  right?: ApprovalDecisionOption[],
): boolean {
  const leftLength = left?.length ?? 0;
  const rightLength = right?.length ?? 0;
  if (leftLength !== rightLength) return false;
  for (let index = 0; index < leftLength; index += 1) {
    const leftItem = left?.[index];
    const rightItem = right?.[index];
    if (
      !leftItem
      || !rightItem
      || leftItem.label !== rightItem.label
      || leftItem.policy !== rightItem.policy
      || leftItem.cacheKey !== rightItem.cacheKey
      || leftItem.description !== rightItem.description
    ) {
      return false;
    }
  }
  return true;
}

function areApprovalRequestsEqual(
  left?: DialogMessage["approvalRequest"],
  right?: DialogMessage["approvalRequest"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.toolName === right.toolName
    && left.title === right.title
    && left.summary === right.summary
    && left.riskDescription === right.riskDescription
    && left.targetPath === right.targetPath
    && left.preview === right.preview
    && left.fullContent === right.fullContent
    && left.previewLabel === right.previewLabel
    && left.previewLanguage === right.previewLanguage
    && left.previewTruncated === right.previewTruncated
    && left.cacheScopeSummary === right.cacheScopeSummary
    && areApprovalRequestDetailsEqual(left.details, right.details)
    && areApprovalDecisionOptionsEqual(left.decisionOptions, right.decisionOptions);
}

function areDialogMessagesEqual(left: DialogMessage, right: DialogMessage): boolean {
  return left.id === right.id
    && left.from === right.from
    && left.to === right.to
    && left.content === right.content
    && left.timestamp === right.timestamp
    && left.priority === right.priority
    && left.expectReply === right.expectReply
    && left.replyTo === right.replyTo
    && left.kind === right.kind
    && left.interactionType === right.interactionType
    && left.interactionStatus === right.interactionStatus
    && left.interactionId === right.interactionId
    && left._briefContent === right._briefContent
    && left.externalChannelType === right.externalChannelType
    && left.externalConversationType === right.externalConversationType
    && left.runtimeDisplayLabel === right.runtimeDisplayLabel
    && left.runtimeDisplayDetail === right.runtimeDisplayDetail
    && left.relatedRunId === right.relatedRunId
    && left.memoryRecallAttempted === right.memoryRecallAttempted
    && left.transcriptRecallAttempted === right.transcriptRecallAttempted
    && left.transcriptRecallHitCount === right.transcriptRecallHitCount
    && areStringListsEqual(left.images, right.images)
    && areStringListsEqual(left.options, right.options)
    && areStringListsEqual(left.appliedMemoryPreview, right.appliedMemoryPreview)
    && areStringListsEqual(left.appliedTranscriptPreview, right.appliedTranscriptPreview)
    && areStringListsEqual(
      left.attachments?.map((a) => a.path),
      right.attachments?.map((a) => a.path),
    )
    && areApprovalRequestsEqual(left.approvalRequest, right.approvalRequest);
}

function areDialogMessageListsEqual(left: readonly DialogMessage[], right: readonly DialogMessage[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!areDialogMessagesEqual(left[index], right[index])) return false;
  }
  return true;
}

function areActorPreviewsEqual(
  left: IMConversationSessionActorPreview,
  right: IMConversationSessionActorPreview,
): boolean {
  return left.id === right.id
    && left.roleName === right.roleName
    && left.status === right.status;
}

function areActorPreviewListsEqual(
  left: readonly IMConversationSessionActorPreview[],
  right: readonly IMConversationSessionActorPreview[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!areActorPreviewsEqual(left[index], right[index])) return false;
  }
  return true;
}

function areChildSessionPreviewEqual(
  left: CollaborationChildSessionPreview,
  right: CollaborationChildSessionPreview,
): boolean {
  return left.id === right.id
    && left.label === right.label
    && left.targetActorId === right.targetActorId
    && left.status === right.status
    && left.mode === right.mode
    && left.focusable === right.focusable
    && left.resumable === right.resumable
    && left.statusSummary === right.statusSummary
    && left.nextStepHint === right.nextStepHint
    && left.updatedAt === right.updatedAt;
}

function areChildSessionPreviewListsEqual(
  left: readonly CollaborationChildSessionPreview[],
  right: readonly CollaborationChildSessionPreview[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!areChildSessionPreviewEqual(left[index], right[index])) return false;
  }
  return true;
}

function areTopicSnapshotsEqual(left: IMConversationTopicSnapshot, right: IMConversationTopicSnapshot): boolean {
  return left.runtimeKey === right.runtimeKey
    && left.topicId === right.topicId
    && left.sessionId === right.sessionId
    && left.status === right.status
    && left.queueLength === right.queueLength
    && left.pendingInteractionCount === right.pendingInteractionCount
    && left.queuedFollowUpCount === right.queuedFollowUpCount
    && left.contractState === right.contractState
    && left.approvalStatus === right.approvalStatus
    && left.approvalSummary === right.approvalSummary
    && left.approvalRiskLabel === right.approvalRiskLabel
    && left.pendingApprovalReason === right.pendingApprovalReason
    && left.roomCompactionSummaryPreview === right.roomCompactionSummaryPreview
    && left.roomCompactionUpdatedAt === right.roomCompactionUpdatedAt
    && left.roomCompactionMessageCount === right.roomCompactionMessageCount
    && left.roomCompactionTaskCount === right.roomCompactionTaskCount
    && left.roomCompactionArtifactCount === right.roomCompactionArtifactCount
    && areStringListsEqual(left.roomCompactionPreservedIdentifiers, right.roomCompactionPreservedIdentifiers)
    && left.startedAt === right.startedAt
    && left.conversationMode === right.conversationMode
    && left.lastInputText === right.lastInputText;
}

function areTopicSnapshotListsEqual(
  left: readonly IMConversationTopicSnapshot[],
  right: readonly IMConversationTopicSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!areTopicSnapshotsEqual(left[index], right[index])) return false;
  }
  return true;
}

function areSessionPreviewsEqual(
  left: IMConversationSessionPreview,
  right: IMConversationSessionPreview,
): boolean {
  return left.sessionId === right.sessionId
    && left.runtimeKey === right.runtimeKey
    && left.channelId === right.channelId
    && left.channelType === right.channelType
    && left.conversationId === right.conversationId
    && left.conversationType === right.conversationType
    && left.topicId === right.topicId
    && left.displayLabel === right.displayLabel
    && left.displayDetail === right.displayDetail
    && left.status === right.status
    && left.queueLength === right.queueLength
    && left.executionStrategy === right.executionStrategy
    && left.pendingInteractionCount === right.pendingInteractionCount
    && left.queuedFollowUpCount === right.queuedFollowUpCount
    && left.contractState === right.contractState
    && left.approvalStatus === right.approvalStatus
    && left.approvalSummary === right.approvalSummary
    && left.approvalRiskLabel === right.approvalRiskLabel
    && left.pendingApprovalReason === right.pendingApprovalReason
    && left.roomCompactionSummaryPreview === right.roomCompactionSummaryPreview
    && left.roomCompactionUpdatedAt === right.roomCompactionUpdatedAt
    && left.roomCompactionMessageCount === right.roomCompactionMessageCount
    && left.roomCompactionTaskCount === right.roomCompactionTaskCount
    && left.roomCompactionArtifactCount === right.roomCompactionArtifactCount
    && areStringListsEqual(left.roomCompactionPreservedIdentifiers, right.roomCompactionPreservedIdentifiers)
    && left.startedAt === right.startedAt
    && left.conversationMode === right.conversationMode
    && left.lastInputText === right.lastInputText
    && areChildSessionPreviewListsEqual(left.childSessionsPreview, right.childSessionsPreview)
    && areActorPreviewListsEqual(left.actors, right.actors)
    && areDialogMessageListsEqual(left.dialogHistory, right.dialogHistory);
}

function areSessionPreviewMapsEqual(
  left: Record<string, IMConversationSessionPreview>,
  right: Record<string, IMConversationSessionPreview>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!(key in right)) return false;
    if (!areSessionPreviewsEqual(left[key], right[key])) return false;
  }
  return true;
}

function areConversationSnapshotsEqual(
  left: IMConversationSnapshot,
  right: IMConversationSnapshot,
): boolean {
  return left.key === right.key
    && left.channelId === right.channelId
    && left.channelType === right.channelType
    && left.conversationId === right.conversationId
    && left.conversationType === right.conversationType
    && left.displayLabel === right.displayLabel
    && left.displayDetail === right.displayDetail
    && left.activeTopicId === right.activeTopicId
    && left.nextTopicSeq === right.nextTopicSeq
    && left.activeSessionId === right.activeSessionId
    && left.activeStatus === right.activeStatus
    && left.activeQueueLength === right.activeQueueLength
    && left.executionStrategy === right.executionStrategy
    && left.pendingInteractionCount === right.pendingInteractionCount
    && left.queuedFollowUpCount === right.queuedFollowUpCount
    && left.contractState === right.contractState
    && left.approvalStatus === right.approvalStatus
    && left.approvalSummary === right.approvalSummary
    && left.approvalRiskLabel === right.approvalRiskLabel
    && left.pendingApprovalReason === right.pendingApprovalReason
    && left.roomCompactionSummaryPreview === right.roomCompactionSummaryPreview
    && left.roomCompactionUpdatedAt === right.roomCompactionUpdatedAt
    && left.roomCompactionMessageCount === right.roomCompactionMessageCount
    && left.roomCompactionTaskCount === right.roomCompactionTaskCount
    && left.roomCompactionArtifactCount === right.roomCompactionArtifactCount
    && areStringListsEqual(left.roomCompactionPreservedIdentifiers, right.roomCompactionPreservedIdentifiers)
    && left.backgroundTopicCount === right.backgroundTopicCount
    && left.conversationMode === right.conversationMode
    && areChildSessionPreviewListsEqual(left.childSessionsPreview, right.childSessionsPreview)
    && areTopicSnapshotListsEqual(left.topics, right.topics);
}

function areConversationSnapshotListsEqual(
  left: readonly IMConversationSnapshot[],
  right: readonly IMConversationSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!areConversationSnapshotsEqual(left[index], right[index])) return false;
  }
  return true;
}

export const useIMConversationRuntimeStore = create<IMConversationRuntimeStoreState>((set) => ({
  conversations: [],
  sessionPreviews: {},
  externalConversationOverlays: {},

  replaceRuntimeData: ({ conversations, sessionPreviews }) => {
    set((state) => {
      const baseSessionPreviews = Object.fromEntries(
        sessionPreviews.map((preview) => [preview.sessionId, preview] as const),
      );
      const merged = mergeRuntimeDataWithExternalOverlays(
        conversations,
        baseSessionPreviews,
        state.externalConversationOverlays,
      );
      const nextConversations = merged.conversations;
      const nextSessionPreviews = merged.sessionPreviews;
      if (state.externalConversationOverlays && Object.keys(state.externalConversationOverlays).length > 0) {
        log.debug("replaceRuntimeData merged with external overlays", {
          incomingConversationCount: conversations.length,
          incomingSessionPreviewCount: sessionPreviews.length,
          overlayConversationKeys: Object.keys(state.externalConversationOverlays),
          mergedConversationCount: nextConversations.length,
          mergedSessionPreviewCount: Object.keys(nextSessionPreviews).length,
        });
      }

      if (
        areConversationSnapshotListsEqual(state.conversations, nextConversations)
        && areSessionPreviewMapsEqual(state.sessionPreviews, nextSessionPreviews)
      ) {
        return state;
      }

      return {
        conversations: nextConversations,
        sessionPreviews: nextSessionPreviews,
      };
    });
  },

  upsertExternalConversationTurn: (params) => {
    set((state) => {
      const timestamp = params.timestamp ?? Date.now();
      const conversationKey = buildConversationKey(params.channelId, params.conversationId);
      const existingOverlay = state.externalConversationOverlays[conversationKey];
      const existingPreview = existingOverlay?.sessionPreview;
      const base = existingOverlay
        ? {}
        : findConversationBasePreview(state.conversations, state.sessionPreviews, conversationKey);
      const basePreview = existingPreview ?? base.preview;
      const baseConversation = existingOverlay?.conversation ?? base.conversation;
      const displayLabel = getExternalDisplayLabel(
        params.channelType,
        params.conversationType,
        params.displayLabel ?? basePreview?.displayLabel ?? baseConversation?.displayLabel,
      );
      const displayDetail = getExternalDisplayDetail(
        params.channelType,
        params.conversationType,
        params.displayDetail ?? basePreview?.displayDetail ?? baseConversation?.displayDetail,
      );
      const conversationMode = params.conversationMode
        ?? existingPreview?.conversationMode
        ?? basePreview?.conversationMode
        ?? existingOverlay?.conversation.conversationMode
        ?? baseConversation?.conversationMode
        ?? "normal";
      const sessionId = existingPreview?.sessionId
        ?? base.preview?.sessionId
        ?? buildExternalSessionId(params.channelId, params.conversationId);
      const runtimeKey = existingPreview?.runtimeKey
        ?? base.preview?.runtimeKey
        ?? `${conversationKey}::${EXTERNAL_EXPORT_TOPIC_ID}`;
      const topicId = existingPreview?.topicId
        ?? base.preview?.topicId
        ?? baseConversation?.activeTopicId
        ?? EXTERNAL_EXPORT_TOPIC_ID;
      const status = params.status ?? existingPreview?.status ?? "idle";
      const agentActor = {
        id: EXTERNAL_EXPORT_ACTOR_ID,
        roleName: "数据导出助手",
        status: toExternalActorStatus(status),
      } satisfies IMConversationSessionActorPreview;
      const currentDialogHistory = existingPreview?.dialogHistory ?? [];
      const baseMessageId = params.messageId?.trim();
      const nextMessageId = params.from === "user"
        ? (baseMessageId || `${sessionId}::user::${timestamp}`)
        : `${sessionId}::assistant::${timestamp}::${currentDialogHistory.length + 1}`;
      const nextMessage: DialogMessage = {
        id: nextMessageId,
        from: params.from === "user" ? "user" : EXTERNAL_EXPORT_ACTOR_ID,
        content: params.content,
        timestamp,
        priority: "normal",
        kind: params.from === "user" ? "user_input" : "agent_result",
        externalChannelType: params.channelType,
        externalConversationType: params.conversationType,
        runtimeDisplayLabel: displayLabel,
        runtimeDisplayDetail: displayDetail,
        ...(params.images?.length ? { images: [...params.images] } : {}),
        ...(params.attachments?.length ? { attachments: params.attachments.map((item) => ({ ...item })) } : {}),
      };
      const dialogHistory = [...currentDialogHistory, nextMessage].slice(-EXTERNAL_EXPORT_DIALOG_WINDOW_SIZE);
      const lastInputText = params.from === "user"
        ? params.content
        : existingPreview?.lastInputText;
      const sessionPreview: IMConversationSessionPreview = {
        sessionId,
        runtimeKey,
        channelId: params.channelId,
        channelType: params.channelType,
        conversationId: params.conversationId,
        conversationType: params.conversationType,
        topicId,
        displayLabel,
        displayDetail,
        status,
        queueLength: 0,
        executionStrategy: existingPreview?.executionStrategy ?? "direct",
        pendingInteractionCount: status === "waiting" ? 1 : 0,
        childSessionsPreview: existingPreview?.childSessionsPreview ?? [],
        queuedFollowUpCount: 0,
        contractState: existingPreview?.contractState ?? null,
        startedAt: existingPreview?.startedAt ?? timestamp,
        updatedAt: timestamp,
        conversationMode,
        ...(lastInputText ? { lastInputText } : {}),
        actors: mergeActorPreviews(existingPreview?.actors ?? [], agentActor),
        dialogHistory,
      };
      const conversation: IMConversationSnapshot = {
        key: conversationKey,
        channelId: params.channelId,
        channelType: params.channelType,
        conversationId: params.conversationId,
        conversationType: params.conversationType,
        displayLabel,
        displayDetail,
        activeTopicId: topicId,
        nextTopicSeq: baseConversation?.nextTopicSeq ?? 2,
        updatedAt: timestamp,
        activeSessionId: sessionId,
        activeStatus: status,
        activeQueueLength: 0,
        executionStrategy: existingOverlay?.conversation.executionStrategy ?? baseConversation?.executionStrategy ?? "direct",
        pendingInteractionCount: status === "waiting" ? 1 : 0,
        childSessionsPreview: existingOverlay?.conversation.childSessionsPreview ?? baseConversation?.childSessionsPreview ?? [],
        queuedFollowUpCount: 0,
        contractState: existingOverlay?.conversation.contractState ?? baseConversation?.contractState ?? null,
        backgroundTopicCount: baseConversation?.backgroundTopicCount ?? 0,
        conversationMode,
        topics: [
          {
            runtimeKey,
            topicId,
            sessionId,
            status,
            queueLength: 0,
            pendingInteractionCount: status === "waiting" ? 1 : 0,
            queuedFollowUpCount: 0,
            contractState: existingPreview?.contractState ?? null,
            updatedAt: timestamp,
            startedAt: existingPreview?.startedAt ?? timestamp,
            conversationMode,
            ...(lastInputText ? { lastInputText } : {}),
          },
        ],
      };
      const externalConversationOverlays = {
        ...state.externalConversationOverlays,
        [conversationKey]: {
          conversation,
          sessionPreview,
        },
      };
      log.info("upserted export overlay turn", {
        conversationKey,
        channelId: params.channelId,
        conversationId: params.conversationId,
        overlaySessionId: sessionId,
        hasExistingOverlay: Boolean(existingOverlay),
        inheritedBaseSessionId: base.preview?.sessionId,
        status,
        from: params.from,
        dialogHistoryCount: dialogHistory.length,
        latestMessageId: nextMessage.id,
      });
      const merged = mergeRuntimeDataWithExternalOverlays(
        state.conversations,
        state.sessionPreviews,
        externalConversationOverlays,
      );

      return {
        externalConversationOverlays,
        conversations: merged.conversations,
        sessionPreviews: merged.sessionPreviews,
      };
    });
  },

  clearExternalConversation: (channelId, conversationId) => {
    set((state) => {
      const conversationKey = buildConversationKey(channelId, conversationId);
      if (!state.externalConversationOverlays[conversationKey]) {
        return state;
      }
      log.info("clearing export overlay conversation", {
        conversationKey,
        channelId,
        conversationId,
        overlaySessionId: state.externalConversationOverlays[conversationKey]?.sessionPreview.sessionId,
      });
      const externalConversationOverlays = { ...state.externalConversationOverlays };
      const removedSessionId = externalConversationOverlays[conversationKey]?.sessionPreview.sessionId;
      delete externalConversationOverlays[conversationKey];
      const merged = mergeRuntimeDataWithExternalOverlays(
        state.conversations.filter((item) => item.key !== conversationKey),
        Object.fromEntries(
          Object.entries(state.sessionPreviews).filter(([key]) => key !== removedSessionId),
        ),
        externalConversationOverlays,
      );
      return {
        externalConversationOverlays,
        conversations: merged.conversations,
        sessionPreviews: merged.sessionPreviews,
      };
    });
  },

  clearChannel: (channelId) => {
    set((state) => {
      const externalConversationOverlays = Object.fromEntries(
        Object.entries(state.externalConversationOverlays).filter(
          ([, overlay]) => overlay.conversation.channelId !== channelId,
        ),
      );
      const merged = mergeRuntimeDataWithExternalOverlays(
        state.conversations.filter((item) => item.channelId !== channelId),
        Object.fromEntries(
          Object.entries(state.sessionPreviews).filter(
            ([, preview]) => preview.channelId !== channelId,
          ),
        ),
        externalConversationOverlays,
      );
      return {
        externalConversationOverlays,
        conversations: merged.conversations,
        sessionPreviews: merged.sessionPreviews,
      };
    });
  },

  reset: () => {
    set({ conversations: [], sessionPreviews: {}, externalConversationOverlays: {} });
  },
}));
