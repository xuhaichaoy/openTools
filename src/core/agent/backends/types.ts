import type {
  AgentCapability,
  SpawnTaskOverrides,
  SpawnedTaskRecord,
  SpawnedTaskRoleBoundary,
} from "../actor/types";

export type AgentBackendId = string;

export type AgentBackendKind =
  | "in_process"
  | "worktree"
  | "remote"
  | "custom";

export interface AgentBackendStatus {
  available: boolean;
  reason?: string;
}

export interface AgentBackendSummary extends AgentBackendStatus {
  id: AgentBackendId;
  kind: AgentBackendKind;
  label: string;
}

export interface AgentBackendTarget {
  actorId?: string;
  actorName?: string;
  name?: string;
  description?: string;
  capabilities?: AgentCapability[];
  workspace?: string;
  createIfMissing?: boolean;
}

export interface AgentBackendTaskRequest {
  senderActorId: string;
  teamId?: string;
  target: AgentBackendTarget;
  task: string;
  label?: string;
  context?: string;
  attachments?: string[];
  images?: string[];
  mode?: "run" | "session";
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  roleBoundary?: SpawnedTaskRoleBoundary;
  overrides?: SpawnTaskOverrides;
  plannedDelegationId?: string;
}

export interface AgentBackendMessageRequest {
  senderActorId: string;
  teamId?: string;
  target: AgentBackendTarget;
  content: string;
  replyTo?: string;
  relatedRunId?: string;
}

export interface AgentBackendMessageResult {
  sent: boolean;
  backendId: AgentBackendId;
  targetId?: string;
  targetName?: string;
  messageId?: string;
  error?: string;
}

export interface ExternalBackendTaskHandle {
  taskId: string;
  runId?: string;
  status?: "queued" | "running";
  summary?: string;
  outputPath?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentExecutorBackend {
  readonly id: AgentBackendId;
  readonly kind: AgentBackendKind;
  readonly label: string;

  getStatus(): AgentBackendStatus;
  dispatchTask(
    request: AgentBackendTaskRequest,
  ): Promise<SpawnedTaskRecord | ExternalBackendTaskHandle | { error: string }>;
  sendMessage(request: AgentBackendMessageRequest): Promise<AgentBackendMessageResult>;
}
