import type {
  DialogMessage,
  PendingInteraction,
  SessionUploadRecord,
} from "@/core/agent/actor/types";
import { cloneCollaborationChildSession } from "./child-session";
import { cloneExecutionContract } from "./execution-contract";
import { buildCollaborationPresentationState } from "./presentation";
import type {
  CollaborationActorPair,
  CollaborationActorRosterEntry,
  CollaborationContractDelegation,
  CollaborationInputDescriptor,
  CollaborationPlannedDelegation,
  CollaborationPresentationState,
  CollaborationQueuedFollowUp,
  CollaborationSessionSnapshot,
  CollaborationSurface,
  ExecutionContractDraft,
} from "./types";

function cloneDialogMessage(message: DialogMessage): DialogMessage {
  return {
    ...message,
    ...(message.images ? { images: [...message.images] } : {}),
    ...(message.attachments ? { attachments: message.attachments.map((item) => ({ ...item })) } : {}),
    ...(message.options ? { options: [...message.options] } : {}),
    ...(message.appliedMemoryPreview ? { appliedMemoryPreview: [...message.appliedMemoryPreview] } : {}),
    ...(message.appliedTranscriptPreview ? { appliedTranscriptPreview: [...message.appliedTranscriptPreview] } : {}),
    ...(message.approvalRequest
      ? {
          approvalRequest: {
            ...message.approvalRequest,
            ...(message.approvalRequest.details
              ? { details: message.approvalRequest.details.map((detail) => ({ ...detail })) }
              : {}),
            ...(message.approvalRequest.decisionOptions
              ? {
                  decisionOptions: message.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                }
              : {}),
          },
        }
      : {}),
  };
}

function clonePendingInteraction(interaction: PendingInteraction): PendingInteraction {
  return {
    ...interaction,
    ...(interaction.options ? { options: [...interaction.options] } : {}),
    ...(interaction.approvalRequest
      ? {
          approvalRequest: {
            ...interaction.approvalRequest,
            ...(interaction.approvalRequest.details
              ? { details: interaction.approvalRequest.details.map((detail) => ({ ...detail })) }
              : {}),
            ...(interaction.approvalRequest.decisionOptions
              ? {
                  decisionOptions: interaction.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                }
              : {}),
          },
        }
      : {}),
  };
}

function cloneUploadRecord(record: SessionUploadRecord): SessionUploadRecord {
  return { ...record };
}

function cloneActorPairs(pairs: readonly CollaborationActorPair[]): CollaborationActorPair[] {
  return pairs.map((pair) => ({ ...pair }));
}

function cloneActorRoster(
  roster: readonly CollaborationActorRosterEntry[],
): CollaborationActorRosterEntry[] {
  return roster.map((entry) => ({
    ...entry,
    ...(entry.capabilities ? { capabilities: [...entry.capabilities] } : {}),
    ...(entry.executionPolicy ? { executionPolicy: { ...entry.executionPolicy } } : {}),
  }));
}

function cloneInputDescriptor(
  input: CollaborationInputDescriptor,
): CollaborationInputDescriptor {
  return {
    ...input,
    ...(input.images ? { images: [...input.images] } : {}),
    ...(input.attachmentPaths ? { attachmentPaths: [...input.attachmentPaths] } : {}),
  };
}

function clonePlannedDelegations(
  delegations: readonly CollaborationPlannedDelegation[],
): CollaborationPlannedDelegation[] {
  return delegations.map((delegation) => ({
    ...delegation,
    ...(delegation.childCapabilities ? { childCapabilities: [...delegation.childCapabilities] } : {}),
  }));
}

export function cloneExecutionContractDraft(
  draft: ExecutionContractDraft,
): ExecutionContractDraft {
  return {
    ...draft,
    input: cloneInputDescriptor(draft.input),
    actorRoster: cloneActorRoster(draft.actorRoster),
    initialRecipientActorIds: [...draft.initialRecipientActorIds],
    participantActorIds: [...draft.participantActorIds],
    allowedMessagePairs: cloneActorPairs(draft.allowedMessagePairs),
    allowedSpawnPairs: cloneActorPairs(draft.allowedSpawnPairs),
    plannedDelegations: clonePlannedDelegations(draft.plannedDelegations),
  };
}

export function cloneQueuedFollowUp(
  item: CollaborationQueuedFollowUp,
): CollaborationQueuedFollowUp {
  return {
    ...item,
    ...(item.images ? { images: [...item.images] } : {}),
    ...(item.attachmentPaths ? { attachmentPaths: [...item.attachmentPaths] } : {}),
    ...(item.uploadRecords ? { uploadRecords: item.uploadRecords.map((record) => cloneUploadRecord(record)) } : {}),
    ...(item.contract ? { contract: cloneExecutionContract(item.contract) } : {}),
  };
}

function cloneContractDelegation(
  delegation: CollaborationContractDelegation,
): CollaborationContractDelegation {
  return { ...delegation };
}

export function clonePresentationState(
  state: CollaborationPresentationState,
): CollaborationPresentationState {
  return {
    ...state,
    childSessionsPreview: state.childSessionsPreview.map((preview) => ({ ...preview })),
  };
}

export function createEmptyCollaborationSnapshot(
  surface: CollaborationSurface,
): CollaborationSessionSnapshot {
  return {
    version: 1,
    surface,
    activeContract: null,
    pendingInteractions: [],
    childSessions: [],
    contractDelegations: [],
    queuedFollowUps: [],
    focusedChildSessionId: null,
    presentationState: buildCollaborationPresentationState({
      surface,
      activeContract: null,
      pendingInteractions: [],
      childSessions: [],
      queuedFollowUps: [],
      focusedChildSessionId: null,
    }),
    dialogMessages: [],
    updatedAt: Date.now(),
  };
}

export function cloneCollaborationSessionSnapshot(
  snapshot: CollaborationSessionSnapshot,
): CollaborationSessionSnapshot {
  return {
    version: 1,
    surface: snapshot.surface,
    ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    activeContract: snapshot.activeContract ? cloneExecutionContract(snapshot.activeContract) : null,
    pendingInteractions: snapshot.pendingInteractions.map((interaction) => clonePendingInteraction(interaction)),
    childSessions: snapshot.childSessions.map((session) => cloneCollaborationChildSession(session)),
    contractDelegations: (snapshot.contractDelegations ?? []).map((delegation) => cloneContractDelegation(delegation)),
    queuedFollowUps: snapshot.queuedFollowUps.map((item) => cloneQueuedFollowUp(item)),
    focusedChildSessionId: snapshot.focusedChildSessionId,
    presentationState: clonePresentationState(snapshot.presentationState),
    dialogMessages: snapshot.dialogMessages.map((message) => cloneDialogMessage(message)),
    updatedAt: snapshot.updatedAt,
  };
}

export function sanitizeCollaborationSessionSnapshot(
  snapshot: CollaborationSessionSnapshot,
): CollaborationSessionSnapshot {
  const cloned = cloneCollaborationSessionSnapshot(snapshot);
  const seenPending = new Set<string>();
  cloned.pendingInteractions = cloned.pendingInteractions.filter((interaction) => {
    if (!interaction.id || seenPending.has(interaction.id)) return false;
    seenPending.add(interaction.id);
    return true;
  });

  const seenChildren = new Set<string>();
  cloned.childSessions = cloned.childSessions.filter((session) => {
    if (!session.id || seenChildren.has(session.id)) return false;
    seenChildren.add(session.id);
    return true;
  });

  const seenFollowUps = new Set<string>();
  cloned.queuedFollowUps = cloned.queuedFollowUps.filter((item) => {
    if (!item.id || seenFollowUps.has(item.id)) return false;
    seenFollowUps.add(item.id);
    return true;
  });

  const seenDelegations = new Set<string>();
  cloned.contractDelegations = cloned.contractDelegations.filter((delegation) => {
    if (!delegation.delegationId || seenDelegations.has(delegation.delegationId)) return false;
    seenDelegations.add(delegation.delegationId);
    return true;
  });

  if (
    cloned.focusedChildSessionId
    && !cloned.childSessions.some((session) => session.id === cloned.focusedChildSessionId)
  ) {
    cloned.focusedChildSessionId = null;
  }

  cloned.presentationState = buildCollaborationPresentationState({
    surface: cloned.surface,
    activeContract: cloned.activeContract,
    pendingInteractions: cloned.pendingInteractions,
    childSessions: cloned.childSessions,
    queuedFollowUps: cloned.queuedFollowUps,
    focusedChildSessionId: cloned.focusedChildSessionId,
  });
  cloned.updatedAt = typeof cloned.updatedAt === "number" ? cloned.updatedAt : Date.now();
  return cloned;
}

export function sanitizeCollaborationSnapshot(
  input: unknown,
  surface: CollaborationSurface,
): CollaborationSessionSnapshot {
  if (!input || typeof input !== "object") {
    return createEmptyCollaborationSnapshot(surface);
  }
  const snapshot = input as Partial<CollaborationSessionSnapshot>;
  if (snapshot.version !== 1 || snapshot.surface !== surface) {
    return createEmptyCollaborationSnapshot(surface);
  }
  try {
    return sanitizeCollaborationSessionSnapshot(snapshot as CollaborationSessionSnapshot);
  } catch {
    return createEmptyCollaborationSnapshot(surface);
  }
}

export const cloneCollaborationSnapshot = cloneCollaborationSessionSnapshot;
