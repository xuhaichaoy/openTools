import type { DialogExecutionPlan } from "./types";
import {
  buildExecutionContractFromDialogPlan,
  toDialogExecutionPlan,
} from "@/core/collaboration/execution-contract";
import type { ExecutionContract } from "@/core/collaboration/types";

export interface LegacyDialogExecutionPlanRuntimeState {
  activatedAt?: number;
  sourceMessageId?: string;
}

export function cloneLegacyDialogExecutionPlan(
  plan?: DialogExecutionPlan | null,
): DialogExecutionPlan | null {
  if (!plan) return null;
  return {
    ...plan,
    initialRecipientActorIds: [...plan.initialRecipientActorIds],
    participantActorIds: [...plan.participantActorIds],
    allowedMessagePairs: plan.allowedMessagePairs.map((edge) => ({ ...edge })),
    allowedSpawnPairs: plan.allowedSpawnPairs.map((edge) => ({ ...edge })),
    plannedSpawns: plan.plannedSpawns?.map((spawn) => ({
      ...spawn,
      ...(spawn.overrides ? { overrides: { ...spawn.overrides } } : {}),
    })),
  };
}

export function normalizeLegacyDialogExecutionPlan(
  plan: DialogExecutionPlan,
  options?: {
    preserveRuntimeState?: boolean;
    hasActor?: (actorId: string) => boolean;
  },
): DialogExecutionPlan {
  const dedupe = (values: string[]) => [...new Set(values.filter(Boolean))];
  const preserveRuntimeState = options?.preserveRuntimeState ?? false;
  const hasActor = options?.hasActor;

  return {
    ...plan,
    approvedAt: plan.approvedAt || Date.now(),
    initialRecipientActorIds: dedupe(plan.initialRecipientActorIds),
    participantActorIds: dedupe(plan.participantActorIds),
    coordinatorActorId: plan.coordinatorActorId && (!hasActor || hasActor(plan.coordinatorActorId))
      ? plan.coordinatorActorId
      : undefined,
    allowedMessagePairs: plan.allowedMessagePairs
      .filter((edge) => edge.fromActorId && edge.toActorId)
      .map((edge) => ({ ...edge })),
    allowedSpawnPairs: plan.allowedSpawnPairs
      .filter((edge) => edge.fromActorId && edge.toActorId)
      .map((edge) => ({ ...edge })),
    plannedSpawns: plan.plannedSpawns
      ?.filter((spawn) => spawn.targetActorId && spawn.task.trim())
      .map((spawn) => ({
        ...spawn,
        task: spawn.task.trim(),
        ...(spawn.overrides ? { overrides: { ...spawn.overrides } } : {}),
      })),
    state: preserveRuntimeState ? plan.state : "armed",
    activatedAt: preserveRuntimeState ? plan.activatedAt : undefined,
    sourceMessageId: preserveRuntimeState ? plan.sourceMessageId : undefined,
  };
}

export function buildLegacyDialogExecutionPlanFromContract(
  contract: ExecutionContract,
  options?: {
    runtimeState?: LegacyDialogExecutionPlanRuntimeState | null;
    hasActor?: (actorId: string) => boolean;
  },
): DialogExecutionPlan {
  const runtimeState = options?.runtimeState;
  return normalizeLegacyDialogExecutionPlan({
    ...toDialogExecutionPlan(contract),
    ...(runtimeState
      ? {
          activatedAt: runtimeState.activatedAt,
          sourceMessageId: runtimeState.sourceMessageId,
        }
      : {}),
  }, {
    preserveRuntimeState: true,
    hasActor: options?.hasActor,
  });
}

export function buildExecutionContractFromLegacyDialogExecutionPlan(params: {
  surface: ExecutionContract["surface"];
  plan: DialogExecutionPlan;
  hasActor?: (actorId: string) => boolean;
}): {
  contract: ExecutionContract;
  runtimeState: LegacyDialogExecutionPlanRuntimeState | null;
} {
  const normalizedPlan = normalizeLegacyDialogExecutionPlan(params.plan, {
    preserveRuntimeState: true,
    hasActor: params.hasActor,
  });
  const activatedAt = typeof normalizedPlan.activatedAt === "number" ? normalizedPlan.activatedAt : undefined;
  const sourceMessageId = normalizedPlan.sourceMessageId?.trim() || undefined;

  return {
    contract: buildExecutionContractFromDialogPlan({
      surface: params.surface,
      plan: normalizedPlan,
    }),
    runtimeState: activatedAt || sourceMessageId
      ? {
          activatedAt,
          sourceMessageId,
        }
      : null,
  };
}
