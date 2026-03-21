import { create } from "zustand";
import type {
  ActorStatus,
  DialogMessage,
  ApprovalRequestDetail,
  ApprovalDecisionOption,
} from "@/core/agent/actor/types";
import type { ChannelType, ChannelIncomingMessage } from "@/core/channels/types";

export type IMConversationRuntimeStatus = "idle" | "running" | "waiting" | "queued";

export interface IMConversationSessionActorPreview {
  id: string;
  roleName: string;
  status: ActorStatus;
}

export interface IMConversationSessionPreview {
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
  startedAt: number;
  updatedAt: number;
  lastInputText?: string;
  actors: IMConversationSessionActorPreview[];
  dialogHistory: DialogMessage[];
}

export interface IMConversationTopicSnapshot {
  runtimeKey: string;
  topicId: string;
  sessionId: string;
  status: IMConversationRuntimeStatus;
  queueLength: number;
  updatedAt: number;
  startedAt: number;
  lastInputText?: string;
}

export interface IMConversationSnapshot {
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
  backgroundTopicCount: number;
  topics: IMConversationTopicSnapshot[];
}

interface IMConversationRuntimeStoreState {
  conversations: IMConversationSnapshot[];
  sessionPreviews: Record<string, IMConversationSessionPreview>;
  replaceRuntimeData: (params: {
    conversations: IMConversationSnapshot[];
    sessionPreviews: IMConversationSessionPreview[];
  }) => void;
  clearChannel: (channelId: string) => void;
  reset: () => void;
}

function sortSnapshots(conversations: IMConversationSnapshot[]): IMConversationSnapshot[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
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

function areTopicSnapshotsEqual(left: IMConversationTopicSnapshot, right: IMConversationTopicSnapshot): boolean {
  return left.runtimeKey === right.runtimeKey
    && left.topicId === right.topicId
    && left.sessionId === right.sessionId
    && left.status === right.status
    && left.queueLength === right.queueLength
    && left.startedAt === right.startedAt
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
    && left.startedAt === right.startedAt
    && left.lastInputText === right.lastInputText
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
    && left.backgroundTopicCount === right.backgroundTopicCount
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

  replaceRuntimeData: ({ conversations, sessionPreviews }) => {
    set((state) => {
      const nextConversations = sortSnapshots(conversations);
      const nextSessionPreviews = Object.fromEntries(
        sessionPreviews.map((preview) => [preview.sessionId, preview] as const),
      );

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

  clearChannel: (channelId) => {
    set((state) => ({
      conversations: state.conversations.filter((item) => item.channelId !== channelId),
      sessionPreviews: Object.fromEntries(
        Object.entries(state.sessionPreviews).filter(
          ([, preview]) => preview.channelId !== channelId,
        ),
      ),
    }));
  },

  reset: () => {
    set({ conversations: [], sessionPreviews: {} });
  },
}));
