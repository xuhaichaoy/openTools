import type {
  DialogSubtaskExecutionIntent,
  SpawnMode,
  SpawnedTaskRoleBoundary,
  WorkerProfileId,
} from "@/core/agent/actor/types";

export type AgentTaskSource = "spawned" | "background" | "remote";
export type AgentTaskBackend = "in_process" | "background_process" | "worktree" | "remote";
export type AgentTaskStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type AgentTaskAttachState = "attached" | "detached";

export interface AgentTaskProgress {
  summary?: string;
  percent?: number;
  updatedAt: number;
  eventCount?: number;
  toolUseCount?: number;
  latestToolName?: string;
  latestToolAt?: number;
}

export interface AgentTaskActivity {
  id: string;
  kind: "lifecycle" | "progress" | "message" | "tool";
  summary: string;
  timestamp: number;
}

export interface AgentTaskNotification {
  id: string;
  taskId: string;
  level: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  createdAt: number;
  read: boolean;
  status?: AgentTaskStatus;
}

export interface AgentTaskOutputEntry {
  id: string;
  taskId: string;
  kind: "result" | "error" | "summary";
  content: string;
  createdAt: number;
  truncated?: boolean;
}

export interface AgentTask {
  taskId: string;
  sessionId: string;
  source: AgentTaskSource;
  backend: AgentTaskBackend;
  runId?: string;
  mode?: SpawnMode;
  status: AgentTaskStatus;
  title: string;
  description: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  lastActiveAt?: number;
  spawnerActorId?: string;
  spawnerName?: string;
  targetActorId?: string;
  targetName?: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
  workerProfileId?: WorkerProfileId;
  executionIntent?: DialogSubtaskExecutionIntent;
  progress?: AgentTaskProgress;
  recentActivity: AgentTaskActivity[];
  recentActivitySummary?: string;
  latestNotificationId?: string;
  outputSummary?: string;
  outputFile?: string;
  result?: string;
  error?: string;
  sessionOpen?: boolean;
  attachState?: AgentTaskAttachState;
  resumable?: boolean;
  pendingMessageCount: number;
  metadata?: Record<string, unknown>;
}

export interface DeferredAgentTaskRecord {
  queueId: string;
  sessionId: string;
  spawnerActorId: string;
  targetActorId: string;
  task: string;
  queuedAt: number;
  label?: string;
  mode?: SpawnMode;
  roleBoundary?: SpawnedTaskRoleBoundary;
  workerProfileId?: WorkerProfileId;
  executionIntent?: DialogSubtaskExecutionIntent;
  spawnerName?: string;
  targetName?: string;
  backend?: AgentTaskBackend;
  source?: AgentTaskSource;
  status?: Extract<AgentTaskStatus, "queued" | "running" | "failed">;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTaskFilter {
  sessionId?: string;
  status?: AgentTaskStatus[];
  source?: AgentTaskSource[];
  backend?: AgentTaskBackend[];
  actorId?: string;
  text?: string;
  includeCompleted?: boolean;
}

export type AgentTaskEvent =
  | { type: "task_upserted"; task: AgentTask; previous?: AgentTask }
  | { type: "task_removed"; taskId: string }
  | { type: "notification_added"; notification: AgentTaskNotification }
  | { type: "output_appended"; entry: AgentTaskOutputEntry };

export type AgentTaskEventHandler = (event: AgentTaskEvent) => void;

export function resolveAgentTaskIdFromRunId(runId: string): string {
  return `agent-task:${runId}`;
}

export function resolveDeferredAgentTaskIdFromQueueId(queueId: string): string {
  return `agent-task:deferred:${queueId}`;
}
