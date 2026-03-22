import type {
  CollaborationChildSession,
  CollaborationPresentationState,
  CollaborationQueuedFollowUp,
  CollaborationSurface,
  ExecutionContract,
  ExecutionContractDraft,
  ExecutionStrategy,
} from "./types";
import type { PendingInteraction } from "@/core/agent/actor/types";

function formatActorList(actorIds: readonly string[], limit = 3): string {
  if (actorIds.length === 0) return "无";
  if (actorIds.length <= limit) return actorIds.join(", ");
  return `${actorIds.slice(0, limit).join(", ")} +${actorIds.length - limit}`;
}

export function getExecutionStrategyLabel(strategy: ExecutionStrategy): string {
  switch (strategy) {
    case "direct":
      return "直达";
    case "coordinator":
      return "协调者";
    case "smart":
      return "智能路由";
    case "broadcast":
      return "广播";
    default:
      return strategy;
  }
}

function getSurfaceLabel(surface: CollaborationSurface): string {
  switch (surface) {
    case "local_dialog":
      return "本地 Dialog";
    case "im_conversation":
      return "IM 会话";
    default:
      return surface;
  }
}

function summarizeContractLike(
  subject: Pick<
    ExecutionContractDraft | ExecutionContract,
    "surface" | "summary" | "executionStrategy" | "initialRecipientActorIds" | "plannedDelegations"
  >,
): string {
  const delegationCount = subject.plannedDelegations.length;
  const strategyLabel = getExecutionStrategyLabel(subject.executionStrategy);
  const recipients = formatActorList(subject.initialRecipientActorIds);
  return `${getSurfaceLabel(subject.surface)} · ${strategyLabel} · 首发 ${recipients}${delegationCount ? ` · 预设委派 ${delegationCount}` : ""}\n${subject.summary}`;
}

export function buildExecutionContractDraftPresentationText(draft: ExecutionContractDraft): string {
  return summarizeContractLike(draft);
}

export function buildExecutionContractPresentationText(contract: ExecutionContract): string {
  return `${summarizeContractLike(contract)}\n状态: ${contract.state}`;
}

export function deriveCollaborationPresentationState(params: {
  surface: CollaborationSurface;
  activeContract: ExecutionContract | null;
  pendingInteractions: readonly PendingInteraction[];
  childSessions: readonly CollaborationChildSession[];
  queuedFollowUps: readonly CollaborationQueuedFollowUp[];
  focusedChildSessionId: string | null;
}): CollaborationPresentationState {
  const pendingApprovalCount = params.pendingInteractions.filter((interaction) => interaction.type === "approval").length;
  const pendingInteractionCount = params.pendingInteractions.length;
  const childSessionsPreview = params.childSessions.slice(0, 6).map((session) => ({
    id: session.id,
    label: session.label,
    targetActorId: session.targetActorId,
    status: session.status,
    mode: session.mode,
    focusable: session.focusable,
    resumable: session.resumable,
    statusSummary: session.statusSummary,
    nextStepHint: session.nextStepHint,
    updatedAt: session.updatedAt,
  }));

  let status: CollaborationPresentationState["status"] = "idle";
  if (pendingApprovalCount > 0) {
    status = "waiting_confirmation";
  } else if (pendingInteractionCount > pendingApprovalCount) {
    status = "waiting_reply";
  } else if (params.queuedFollowUps.length > 0) {
    status = "queued";
  } else if (
    params.activeContract
    || params.childSessions.some((session) => session.status === "running" || session.status === "waiting")
  ) {
    status = "processing";
  }

  return {
    surface: params.surface,
    status,
    pendingInteractionCount,
    pendingApprovalCount,
    childSessionsPreview,
    queuedFollowUpCount: params.queuedFollowUps.length,
    focusedChildSessionId: params.focusedChildSessionId,
    contractState: params.activeContract?.state ?? null,
    executionStrategy: params.activeContract?.executionStrategy ?? null,
  };
}

export const buildCollaborationPresentationState = deriveCollaborationPresentationState;
