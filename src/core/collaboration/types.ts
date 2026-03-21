import type {
  AgentCapability,
  ApprovalMode,
  DialogExecutionPlan,
  DialogExecutionPlanEdge,
  DialogMessage,
  ExecutionPolicy,
  MiddlewareOverrides,
  PendingInteraction,
  SessionUploadRecord,
  SpawnMode,
  SpawnedTaskRoleBoundary,
  ThinkingLevel,
  ToolPolicy,
} from "@/core/agent/actor/types";

export type CollaborationSurface = "local_dialog" | "im_conversation";
export type ExecutionStrategy = "direct" | "coordinator" | "smart" | "broadcast";
export type FollowUpPolicy = "queue" | "steer" | "interrupt";
export type ExecutionContractState = "sealed" | "active" | "completed" | "failed" | "superseded";
export type CollaborationFollowUpContractStatus = "ready" | "needs_reapproval" | "missing";

export interface CollaborationActorPair {
  fromActorId: string;
  toActorId: string;
}

export interface CollaborationActorRosterEntry {
  actorId: string;
  roleName?: string;
  capabilities?: AgentCapability[];
  executionPolicy?: ExecutionPolicy;
  workspace?: string;
}

export interface CollaborationRosterActor {
  id: string;
  roleName?: string;
  capabilities?: { tags?: string[] } | string[];
  toolPolicy?: unknown;
  executionPolicy?: ExecutionPolicy;
  workspace?: string;
  thinkingLevel?: string;
  middlewareOverrides?: unknown;
}

export interface CollaborationInputDescriptor {
  content: string;
  briefContent?: string;
  images?: string[];
  attachmentPaths?: string[];
}

export interface CollaborationPlannedDelegation {
  id: string;
  targetActorId: string;
  targetActorName?: string;
  task: string;
  label?: string;
  context?: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
  createIfMissing?: boolean;
  childDescription?: string;
  childCapabilities?: AgentCapability[];
  childWorkspace?: string;
  childMaxIterations?: number;
}

export interface ExecutionContractDraft {
  draftId: string;
  surface: CollaborationSurface;
  executionStrategy: ExecutionStrategy;
  executionPolicy?: ExecutionPolicy;
  summary: string;
  createdAt: number;
  coordinatorActorId?: string;
  sourcePlanId?: string;
  sourceClusterPlanId?: string;
  input: CollaborationInputDescriptor;
  actorRoster: CollaborationActorRosterEntry[];
  inputHash: string;
  actorRosterHash: string;
  initialRecipientActorIds: string[];
  participantActorIds: string[];
  allowedMessagePairs: CollaborationActorPair[];
  allowedSpawnPairs: CollaborationActorPair[];
  plannedDelegations: CollaborationPlannedDelegation[];
}

export interface ExecutionContract {
  contractId: string;
  surface: CollaborationSurface;
  executionStrategy: ExecutionStrategy;
  executionPolicy?: ExecutionPolicy;
  summary: string;
  coordinatorActorId?: string;
  sourcePlanId?: string;
  sourceClusterPlanId?: string;
  inputHash: string;
  actorRosterHash: string;
  initialRecipientActorIds: string[];
  participantActorIds: string[];
  allowedMessagePairs: CollaborationActorPair[];
  allowedSpawnPairs: CollaborationActorPair[];
  plannedDelegations: CollaborationPlannedDelegation[];
  approvedAt: number;
  state: ExecutionContractState;
}

export interface CollaborationChildExecutionSettingsInput {
  roleBoundary?: SpawnedTaskRoleBoundary;
  parentToolPolicy?: ToolPolicy;
  parentExecutionPolicy?: ExecutionPolicy;
  parentWorkspace?: string;
  parentThinkingLevel?: ThinkingLevel;
  parentMiddlewareOverrides?: MiddlewareOverrides;
  boundaryToolPolicy?: ToolPolicy;
  boundaryExecutionPolicy?: ExecutionPolicy;
  overrideToolPolicy?: ToolPolicy;
  overrideExecutionPolicy?: ExecutionPolicy;
  overrideWorkspace?: string;
  overrideThinkingLevel?: ThinkingLevel;
  overrideMiddlewareOverrides?: MiddlewareOverrides;
}

export interface CollaborationChildExecutionSettings {
  toolPolicy?: ToolPolicy;
  executionPolicy: ExecutionPolicy;
  workspace?: string;
  thinkingLevel?: ThinkingLevel;
  middlewareOverrides?: MiddlewareOverrides;
  approvalMode?: ApprovalMode;
}

export type CollaborationChildSessionStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "aborted";

export interface CollaborationChildSession {
  id: string;
  runId: string;
  parentRunId?: string;
  ownerActorId: string;
  targetActorId: string;
  label: string;
  roleBoundary: SpawnedTaskRoleBoundary;
  mode: SpawnMode;
  status: CollaborationChildSessionStatus;
  focusable: boolean;
  resumable: boolean;
  announceToParent: boolean;
  lastResultSummary?: string;
  lastError?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface CollaborationChildSessionPreview {
  id: string;
  label: string;
  targetActorId: string;
  status: CollaborationChildSessionStatus;
  mode: SpawnMode;
  focusable: boolean;
  resumable: boolean;
}

export type CollaborationContractDelegationState =
  | "available"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stale";

export interface CollaborationContractDelegation {
  delegationId: string;
  targetActorId: string;
  label: string;
  state: CollaborationContractDelegationState;
  runId?: string;
}

export interface CollaborationQueuedFollowUp {
  id: string;
  displayText: string;
  content: string;
  briefContent?: string;
  images?: string[];
  attachmentPaths?: string[];
  uploadRecords?: SessionUploadRecord[];
  executionStrategy: ExecutionStrategy;
  createdAt: number;
  policy: FollowUpPolicy;
  contract?: ExecutionContract | null;
  contractStatus: CollaborationFollowUpContractStatus;
  focusedChildSessionId?: string | null;
}

export interface CollaborationPresentationState {
  surface: CollaborationSurface;
  status: "idle" | "processing" | "waiting_reply" | "waiting_confirmation" | "queued";
  pendingInteractionCount: number;
  pendingApprovalCount: number;
  childSessionsPreview: CollaborationChildSessionPreview[];
  queuedFollowUpCount: number;
  focusedChildSessionId: string | null;
  contractState: ExecutionContractState | null;
  executionStrategy: ExecutionStrategy | null;
}

export interface CollaborationSessionSnapshot {
  version: 1;
  surface: CollaborationSurface;
  sessionId?: string;
  activeContract: ExecutionContract | null;
  pendingInteractions: PendingInteraction[];
  childSessions: CollaborationChildSession[];
  contractDelegations: CollaborationContractDelegation[];
  queuedFollowUps: CollaborationQueuedFollowUp[];
  focusedChildSessionId: string | null;
  presentationState: CollaborationPresentationState;
  dialogMessages: DialogMessage[];
  updatedAt: number;
}

export interface CollaborationDispatchInput {
  content: string;
  briefContent?: string;
  displayText?: string;
  images?: string[];
  attachmentPaths?: string[];
  uploadRecords?: SessionUploadRecord[];
  externalChannelType?: DialogMessage["externalChannelType"];
  externalChannelId?: DialogMessage["externalChannelId"];
  externalConversationId?: DialogMessage["externalConversationId"];
  externalConversationType?: DialogMessage["externalConversationType"];
  externalSessionId?: DialogMessage["externalSessionId"];
  runtimeDisplayLabel?: DialogMessage["runtimeDisplayLabel"];
  runtimeDisplayDetail?: DialogMessage["runtimeDisplayDetail"];
}

export interface CollaborationDispatchOptions {
  contract?: ExecutionContract | null;
  policy?: FollowUpPolicy;
  selectedPendingMessageId?: string | null;
  forceAsNewMessage?: boolean;
  focusedChildSessionId?: string | null;
  steerTargetActorId?: string | null;
  directTargetActorId?: string | null;
  allowQueue?: boolean;
}

export interface CollaborationDispatchResult {
  disposition: "dispatched" | "replied" | "queued" | "steered" | "focused_child";
  followUpId?: string;
  messageId?: string;
  childSessionId?: string | null;
}

export interface LegacyCompatibleDialogPlan {
  id: string;
  routingMode: DialogExecutionPlan["routingMode"];
  summary: string;
  approvedAt: number;
  initialRecipientActorIds: string[];
  participantActorIds: string[];
  coordinatorActorId?: string;
  allowedMessagePairs: DialogExecutionPlanEdge[];
  allowedSpawnPairs: DialogExecutionPlanEdge[];
}
