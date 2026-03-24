import type { DialogDispatchPlanBundle } from "@/core/agent/actor/dialog-dispatch-plan";
import type {
  AgentCapability,
  MiddlewareOverrides,
  SpawnedTaskRoleBoundary,
  ToolPolicy,
} from "@/core/agent/actor/types";
import {
  buildMiddlewareOverridesForExecutionPolicy,
  deriveToolPolicyForAccessMode,
  normalizeExecutionPolicy,
  resolveExecutionPolicyInheritance,
} from "@/core/agent/actor/execution-policy";
import type {
  CollaborationActorPair,
  CollaborationActorRosterEntry,
  CollaborationChildExecutionSettings,
  CollaborationChildExecutionSettingsInput,
  CollaborationInputDescriptor,
  CollaborationPlannedDelegation,
  LegacyCompatibleDialogPlan,
  CollaborationRosterActor,
  CollaborationSurface,
  ExecutionContract,
  ExecutionContractDraft,
  ExecutionContractState,
  ExecutionStrategy,
} from "./types";

type RosterHashInput = CollaborationActorRosterEntry | CollaborationRosterActor;

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function hashString(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function mergeToolPolicies(
  base?: ToolPolicy,
  override?: ToolPolicy,
): ToolPolicy | undefined {
  if (!base && !override) return undefined;
  const allow = [...new Set([...(base?.allow ?? []), ...(override?.allow ?? [])])];
  const deny = [...new Set([...(base?.deny ?? []), ...(override?.deny ?? [])])];
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
  };
}

function mergeMiddlewareOverrides(
  base?: MiddlewareOverrides,
  override?: MiddlewareOverrides,
): MiddlewareOverrides | undefined {
  if (!base && !override) return undefined;
  const disable = [...new Set([...(base?.disable ?? []), ...(override?.disable ?? [])])];
  return {
    ...(disable.length > 0 ? { disable } : {}),
  };
}

function normalizeExecutionStrategy(strategy: string): ExecutionStrategy {
  switch (strategy) {
    case "direct":
    case "coordinator":
    case "smart":
    case "broadcast":
      return strategy;
    default:
      return "coordinator";
  }
}

function normalizeContractState(state: LegacyCompatibleDialogPlan["state"]): ExecutionContractState {
  switch (state) {
    case "armed":
      return "sealed";
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "sealed";
  }
}

function normalizeActorPairs(pairs: readonly CollaborationActorPair[]): CollaborationActorPair[] {
  const seen = new Set<string>();
  const normalized: CollaborationActorPair[] = [];
  for (const pair of pairs) {
    const fromActorId = pair.fromActorId.trim();
    const toActorId = pair.toActorId.trim();
    if (!fromActorId || !toActorId) continue;
    const key = `${fromActorId}->${toActorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ fromActorId, toActorId });
  }
  return normalized;
}

function normalizeCapabilities(
  capabilities: CollaborationActorRosterEntry["capabilities"] | CollaborationRosterActor["capabilities"],
): AgentCapability[] {
  if (!capabilities) return [];
  if (Array.isArray(capabilities)) {
    return unique(capabilities).sort() as AgentCapability[];
  }
  return unique(capabilities.tags).sort() as AgentCapability[];
}

function normalizeRosterEntries(
  roster: readonly RosterHashInput[],
): CollaborationActorRosterEntry[] {
  return roster
    .map((entry) => ({
      actorId: "actorId" in entry ? entry.actorId.trim() : entry.id.trim(),
      roleName: entry.roleName?.trim() || undefined,
      capabilities: normalizeCapabilities(entry.capabilities),
      executionPolicy: normalizeExecutionPolicy(
        "executionPolicy" in entry ? entry.executionPolicy : undefined,
      ),
      workspace: entry.workspace?.trim() || undefined,
    }))
    .filter((entry) => entry.actorId)
    .sort((left, right) => left.actorId.localeCompare(right.actorId));
}

function normalizeInputDescriptor(
  input: CollaborationInputDescriptor | string,
): CollaborationInputDescriptor {
  if (typeof input === "string") {
    return { content: input };
  }
  return {
    content: input.content,
    briefContent: input.briefContent?.trim() || undefined,
    images: unique(input.images).sort(),
    attachmentPaths: unique(input.attachmentPaths).sort(),
  };
}

function normalizePlannedDelegation(
  spawn: CollaborationPlannedDelegation,
): CollaborationPlannedDelegation | null {
  const id = spawn.id.trim();
  const targetActorId = spawn.targetActorId.trim();
  const task = spawn.task.trim();
  if (!id || !targetActorId || !task) return null;
  return {
    id,
    targetActorId,
    targetActorName: spawn.targetActorName?.trim() || undefined,
    task,
    label: spawn.label?.trim() || undefined,
    context: "context" in spawn ? spawn.context?.trim() || undefined : undefined,
    roleBoundary: spawn.roleBoundary as SpawnedTaskRoleBoundary | undefined,
    createIfMissing: spawn.createIfMissing,
    childDescription: spawn.childDescription?.trim() || undefined,
    childCapabilities: unique(spawn.childCapabilities).sort() as AgentCapability[],
    childWorkspace: spawn.childWorkspace?.trim() || undefined,
    childMaxIterations: spawn.childMaxIterations,
  };
}

function normalizePlannedDelegations(
  spawns: readonly CollaborationPlannedDelegation[] | undefined,
): CollaborationPlannedDelegation[] {
  return (spawns ?? [])
    .map((spawn) => normalizePlannedDelegation(spawn))
    .filter((spawn): spawn is CollaborationPlannedDelegation => Boolean(spawn));
}

function normalizeDraft(draft: ExecutionContractDraft): ExecutionContractDraft {
  return {
    ...draft,
    ...(draft.executionPolicy
      ? { executionPolicy: normalizeExecutionPolicy(draft.executionPolicy) }
      : {}),
    summary: draft.summary.trim(),
    input: normalizeInputDescriptor(draft.input),
    actorRoster: normalizeRosterEntries(draft.actorRoster),
    initialRecipientActorIds: unique(draft.initialRecipientActorIds),
    participantActorIds: unique(draft.participantActorIds),
    allowedMessagePairs: normalizeActorPairs(draft.allowedMessagePairs),
    allowedSpawnPairs: normalizeActorPairs(draft.allowedSpawnPairs),
    plannedDelegations: normalizePlannedDelegations(draft.plannedDelegations),
  };
}

export function buildInputHash(
  input: CollaborationInputDescriptor | string,
): string {
  return hashString(stableSerialize(normalizeInputDescriptor(input)));
}

export const buildExecutionInputHash = buildInputHash;

export function buildActorRosterHash(
  roster: readonly RosterHashInput[],
): string {
  return hashString(stableSerialize(normalizeRosterEntries(roster)));
}

export function buildExecutionContractDraftFromDialogBundle(params: {
  surface: CollaborationSurface;
  bundle: DialogDispatchPlanBundle;
  input: CollaborationInputDescriptor | string;
  actorRoster?: readonly RosterHashInput[];
  createdAt?: number;
  draftId?: string;
}): ExecutionContractDraft {
  const { runtimePlan, clusterPlan } = params.bundle;
  const actorRoster = params.actorRoster?.length
    ? normalizeRosterEntries(params.actorRoster)
    : runtimePlan.participantActorIds.map((actorId) => ({ actorId }));
  const normalizedInput = normalizeInputDescriptor(params.input);
  const draft: ExecutionContractDraft = {
    draftId: params.draftId ?? createId("draft"),
    surface: params.surface,
    executionStrategy: normalizeExecutionStrategy(runtimePlan.routingMode),
    executionPolicy: normalizeExecutionPolicy(undefined),
    summary: runtimePlan.summary || normalizedInput.briefContent || normalizedInput.content.slice(0, 140),
    createdAt: params.createdAt ?? Date.now(),
    coordinatorActorId: runtimePlan.coordinatorActorId,
    sourcePlanId: runtimePlan.id,
    sourceClusterPlanId: clusterPlan.id,
    input: normalizedInput,
    actorRoster,
    inputHash: buildInputHash(normalizedInput),
    actorRosterHash: buildActorRosterHash(actorRoster),
    initialRecipientActorIds: unique(runtimePlan.initialRecipientActorIds),
    participantActorIds: unique(runtimePlan.participantActorIds),
    allowedMessagePairs: normalizeActorPairs(runtimePlan.allowedMessagePairs),
    allowedSpawnPairs: normalizeActorPairs(runtimePlan.allowedSpawnPairs),
    plannedDelegations: normalizePlannedDelegations(runtimePlan.plannedSpawns),
  };
  return normalizeDraft(draft);
}

export function buildOpenExecutionContractDraft(params: {
  surface: CollaborationSurface;
  executionStrategy: ExecutionStrategy;
  actorIds: string[];
  coordinatorActorId?: string;
  summary?: string;
}): ExecutionContractDraft {
  const participantActorIds = unique(params.actorIds);
  const initialRecipientActorIds = params.coordinatorActorId && participantActorIds.includes(params.coordinatorActorId)
    ? [params.coordinatorActorId]
    : participantActorIds.slice(0, 1);
  const actorRoster = participantActorIds.map((actorId) => ({ actorId }));
  const allowedMessagePairs = participantActorIds.flatMap((fromActorId) =>
    participantActorIds
      .filter((toActorId) => toActorId !== fromActorId)
      .map((toActorId) => ({ fromActorId, toActorId })),
  );
  const allowedSpawnPairs = initialRecipientActorIds.flatMap((fromActorId) =>
    participantActorIds
      .filter((toActorId) => toActorId !== fromActorId)
      .map((toActorId) => ({ fromActorId, toActorId })),
  );
  return {
    draftId: createId("draft"),
    surface: params.surface,
    executionStrategy: params.executionStrategy,
    executionPolicy: normalizeExecutionPolicy(undefined),
    summary: params.summary ?? "Open execution contract",
    createdAt: Date.now(),
    coordinatorActorId: params.coordinatorActorId,
    input: { content: "" },
    actorRoster,
    inputHash: buildInputHash(""),
    actorRosterHash: buildActorRosterHash(actorRoster),
    initialRecipientActorIds,
    participantActorIds,
    allowedMessagePairs,
    allowedSpawnPairs,
    plannedDelegations: [],
  };
}

export function cloneExecutionContract(contract: ExecutionContract): ExecutionContract {
  return {
    ...contract,
    ...(contract.executionPolicy
      ? { executionPolicy: normalizeExecutionPolicy(contract.executionPolicy) }
      : {}),
    initialRecipientActorIds: [...contract.initialRecipientActorIds],
    participantActorIds: [...contract.participantActorIds],
    allowedMessagePairs: contract.allowedMessagePairs.map((pair) => ({ ...pair })),
    allowedSpawnPairs: contract.allowedSpawnPairs.map((pair) => ({ ...pair })),
    plannedDelegations: contract.plannedDelegations.map((delegation) => ({
      ...delegation,
      ...(delegation.childCapabilities
        ? { childCapabilities: [...delegation.childCapabilities] }
        : {}),
    })),
  };
}

export function resolveChildExecutionSettings(
  params: CollaborationChildExecutionSettingsInput,
): CollaborationChildExecutionSettings {
  const executionPolicy = resolveExecutionPolicyInheritance({
    parentPolicy: params.parentExecutionPolicy,
    boundaryPolicy: params.boundaryExecutionPolicy,
    overridePolicy: params.overrideExecutionPolicy,
    parentApprovalLevel: params.parentMiddlewareOverrides?.approvalLevel,
    overrideApprovalLevel: params.overrideMiddlewareOverrides?.approvalLevel,
  });
  const toolPolicy = mergeToolPolicies(
    mergeToolPolicies(
      mergeToolPolicies(
        deriveToolPolicyForAccessMode(executionPolicy.accessMode),
        params.parentToolPolicy,
      ),
      params.boundaryToolPolicy,
    ),
    params.overrideToolPolicy,
  );
  const middlewareOverrides = mergeMiddlewareOverrides(
    params.parentMiddlewareOverrides,
    params.overrideMiddlewareOverrides,
  );
  const nextMiddlewareOverrides: MiddlewareOverrides | undefined = buildMiddlewareOverridesForExecutionPolicy(
    executionPolicy,
    middlewareOverrides,
  );

  return {
    toolPolicy,
    executionPolicy,
    workspace: params.overrideWorkspace ?? params.parentWorkspace,
    thinkingLevel: params.overrideThinkingLevel ?? params.parentThinkingLevel,
    middlewareOverrides: nextMiddlewareOverrides,
    approvalMode: executionPolicy.approvalMode,
  };
}

export function sealExecutionContract(
  draft: ExecutionContractDraft,
  opts?: {
    contractId?: string;
    approvedAt?: number;
    state?: ExecutionContractState;
  },
): ExecutionContract;
export function sealExecutionContract(
  draft: ExecutionContractDraft,
  roster: readonly RosterHashInput[],
  input: CollaborationInputDescriptor | string,
  approvedAt?: number,
): ExecutionContract;
export function sealExecutionContract(
  draft: ExecutionContractDraft,
  arg2?: { contractId?: string; approvedAt?: number; state?: ExecutionContractState } | readonly RosterHashInput[],
  arg3?: CollaborationInputDescriptor | string,
  arg4?: number,
): ExecutionContract {
  const normalizedDraft = normalizeDraft(draft);
  const usingRuntimeInputs = Array.isArray(arg2);
  const runtimeRoster: readonly RosterHashInput[] = Array.isArray(arg2)
    ? arg2
    : normalizedDraft.actorRoster;
  const contractOptions = (
    Array.isArray(arg2)
      ? undefined
      : arg2
  ) as { contractId?: string; approvedAt?: number; state?: ExecutionContractState } | undefined;
  const approvedAt = usingRuntimeInputs
    ? (arg4 ?? Date.now())
    : (contractOptions?.approvedAt ?? Date.now());
  const inputHash = usingRuntimeInputs
    ? buildInputHash(arg3 ?? normalizedDraft.input)
    : normalizedDraft.inputHash;
  const actorRosterHash = usingRuntimeInputs
    ? buildActorRosterHash(runtimeRoster)
    : normalizedDraft.actorRosterHash;

  return {
    contractId: usingRuntimeInputs
      ? createId("contract")
      : (contractOptions?.contractId ?? createId("contract")),
    surface: normalizedDraft.surface,
    executionStrategy: normalizedDraft.executionStrategy,
    ...(normalizedDraft.executionPolicy
      ? { executionPolicy: normalizeExecutionPolicy(normalizedDraft.executionPolicy) }
      : {}),
    summary: normalizedDraft.summary,
    coordinatorActorId: normalizedDraft.coordinatorActorId,
    sourcePlanId: normalizedDraft.sourcePlanId,
    sourceClusterPlanId: normalizedDraft.sourceClusterPlanId,
    inputHash,
    actorRosterHash,
    initialRecipientActorIds: [...normalizedDraft.initialRecipientActorIds],
    participantActorIds: [...normalizedDraft.participantActorIds],
    allowedMessagePairs: normalizedDraft.allowedMessagePairs.map((pair) => ({ ...pair })),
    allowedSpawnPairs: normalizedDraft.allowedSpawnPairs.map((pair) => ({ ...pair })),
    plannedDelegations: normalizedDraft.plannedDelegations.map((delegation) => ({
      ...delegation,
      ...(delegation.childCapabilities
        ? { childCapabilities: [...delegation.childCapabilities] }
        : {}),
    })),
    approvedAt,
    state: usingRuntimeInputs ? "sealed" : (contractOptions?.state ?? "sealed"),
  };
}

export function doesExecutionContractMatchActorRoster(
  contract: Pick<ExecutionContract, "actorRosterHash">,
  actorRoster: readonly RosterHashInput[],
): boolean {
  return contract.actorRosterHash === buildActorRosterHash(actorRoster);
}

export const doesExecutionContractMatchRoster = doesExecutionContractMatchActorRoster;

export function buildExecutionContractFromDialogPlan(params: {
  surface: CollaborationSurface;
  plan: LegacyCompatibleDialogPlan;
  actorRoster?: readonly RosterHashInput[];
  input?: CollaborationInputDescriptor | string;
}): ExecutionContract {
  const actorRoster = params.actorRoster?.length
    ? normalizeRosterEntries(params.actorRoster)
    : params.plan.participantActorIds.map((actorId) => ({ actorId }));
  return {
    contractId: params.plan.id,
    surface: params.surface,
    executionStrategy: normalizeExecutionStrategy(params.plan.routingMode),
    executionPolicy: normalizeExecutionPolicy(undefined),
    summary: params.plan.summary,
    coordinatorActorId: params.plan.coordinatorActorId,
    sourcePlanId: params.plan.id,
    inputHash: buildInputHash(params.input ?? { content: params.plan.summary }),
    actorRosterHash: buildActorRosterHash(actorRoster),
    initialRecipientActorIds: unique(params.plan.initialRecipientActorIds),
    participantActorIds: unique(params.plan.participantActorIds),
    allowedMessagePairs: normalizeActorPairs(params.plan.allowedMessagePairs),
    allowedSpawnPairs: normalizeActorPairs(params.plan.allowedSpawnPairs),
    plannedDelegations: normalizePlannedDelegations(params.plan.plannedSpawns),
    approvedAt: params.plan.approvedAt,
    state: normalizeContractState(params.plan.state),
  };
}

export function buildExecutionContractDraftFromLegacyPlan(
  plan: LegacyCompatibleDialogPlan,
  surface: CollaborationSurface,
  actorRoster?: readonly RosterHashInput[],
  input?: CollaborationInputDescriptor | string,
): ExecutionContractDraft {
  const normalizedInput = normalizeInputDescriptor(input ?? { content: plan.summary });
  const normalizedRoster = actorRoster?.length
    ? normalizeRosterEntries(actorRoster)
    : plan.participantActorIds.map((actorId) => ({ actorId }));
  return normalizeDraft({
    draftId: createId("draft"),
    surface,
    executionStrategy: normalizeExecutionStrategy(plan.routingMode),
    executionPolicy: normalizeExecutionPolicy(undefined),
    summary: plan.summary || normalizedInput.briefContent || normalizedInput.content.slice(0, 140),
    createdAt: Date.now(),
    coordinatorActorId: plan.coordinatorActorId,
    sourcePlanId: plan.id,
    input: normalizedInput,
    actorRoster: normalizedRoster,
    inputHash: buildInputHash(normalizedInput),
    actorRosterHash: buildActorRosterHash(normalizedRoster),
    initialRecipientActorIds: unique(plan.initialRecipientActorIds),
    participantActorIds: unique(plan.participantActorIds),
    allowedMessagePairs: normalizeActorPairs(plan.allowedMessagePairs),
    allowedSpawnPairs: normalizeActorPairs(plan.allowedSpawnPairs),
    plannedDelegations: normalizePlannedDelegations(plan.plannedSpawns),
  });
}

export function markExecutionContractState(
  contract: ExecutionContract | null | undefined,
  state: ExecutionContractState,
): ExecutionContract | null {
  if (!contract) return null;
  return {
    ...cloneExecutionContract(contract),
    state,
  };
}

export function toDialogExecutionPlan(contract: ExecutionContract): LegacyCompatibleDialogPlan {
  const mapState = (): LegacyCompatibleDialogPlan["state"] => {
    switch (contract.state) {
      case "sealed":
        return "armed";
      case "active":
        return "active";
      case "completed":
        return "completed";
      case "failed":
      case "superseded":
        return "failed";
      default:
        return "armed";
    }
  };

  return {
    id: contract.contractId,
    routingMode: contract.executionStrategy,
    summary: contract.summary,
    approvedAt: contract.approvedAt,
    initialRecipientActorIds: [...contract.initialRecipientActorIds],
    participantActorIds: [...contract.participantActorIds],
    coordinatorActorId: contract.coordinatorActorId,
    allowedMessagePairs: contract.allowedMessagePairs.map((pair) => ({ ...pair })),
    allowedSpawnPairs: contract.allowedSpawnPairs.map((pair) => ({ ...pair })),
    plannedSpawns: contract.plannedDelegations.map((delegation) => ({
      id: delegation.id,
      targetActorId: delegation.targetActorId,
      targetActorName: delegation.targetActorName,
      task: delegation.task,
      label: delegation.label,
      context: delegation.context,
      roleBoundary: delegation.roleBoundary,
      createIfMissing: delegation.createIfMissing,
      childDescription: delegation.childDescription,
      childCapabilities: delegation.childCapabilities ? [...delegation.childCapabilities] : undefined,
      childWorkspace: delegation.childWorkspace,
      childMaxIterations: delegation.childMaxIterations,
    })),
    state: mapState(),
  };
}

export const mapExecutionContractToLegacyDialogPlan = toDialogExecutionPlan;
