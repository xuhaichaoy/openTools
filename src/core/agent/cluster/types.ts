import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";

// ── Agent Role ──

export interface AgentRoleToolFilter {
  include?: string[];
  exclude?: string[];
}

export interface AgentRole {
  id: string;
  name: string;
  systemPrompt: string;
  toolFilter?: AgentRoleToolFilter;
  capabilities: string[];
  maxIterations?: number;
  temperature?: number;
  modelOverride?: string;
  readonly?: boolean;
}

// ── Cluster Plan ──

export type ClusterMode = "multi_role" | "parallel_split";

export interface ClusterStep {
  id: string;
  role: string;
  task: string;
  dependencies: string[];
  inputMapping?: Record<string, string>;
  outputKey?: string;
  /** 是否在执行后触发 Review-Fix 循环 */
  reviewAfter?: boolean;
  /** Review-Fix 最大重试次数 */
  maxReviewRetries?: number;
  /** 标记为关键步骤（默认 true）。关键步骤失败后其下游步骤将被跳过 */
  critical?: boolean;
}

export interface ClusterPlan {
  id: string;
  mode: ClusterMode;
  steps: ClusterStep[];
  sharedContext: Record<string, unknown>;
}

// ── Cluster Execution ──

export type AgentInstanceStatus = "idle" | "running" | "done" | "error" | "reviewing" | "skipped";

export interface AgentInstance {
  id: string;
  role: AgentRole;
  status: AgentInstanceStatus;
  stepId?: string;
  steps: AgentStep[];
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Review-Fix 循环计数 */
  reviewCount?: number;
  memoryRecallAttempted?: boolean;
  appliedMemoryPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  appliedTranscriptPreview?: string[];
}

export type ClusterSessionStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "dispatching"
  | "running"
  | "aggregating"
  | "done"
  | "error";

export interface ClusterResult {
  planId: string;
  mode: ClusterMode;
  finalAnswer: string;
  agentInstances: AgentInstance[];
  totalDurationMs: number;
}

// ── Message Bus ──

export type AgentMessageType = "result" | "request" | "feedback" | "status" | "review";

export interface AgentMessage {
  id: string;
  from: string;
  to?: string;
  type: AgentMessageType;
  payload: unknown;
  timestamp: number;
}

// ── Agent Bridge ──

export interface AgentBridgeResult {
  answer: string;
  steps: AgentStep[];
  error?: string;
  memoryRecallAttempted?: boolean;
  appliedMemoryPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  appliedTranscriptPreview?: string[];
}

export type AgentBridgeStatus = "online" | "offline" | "busy";

export interface AgentBridge {
  readonly id: string;
  readonly type: "local" | "mcp" | "http";
  run(
    task: string,
    context: Record<string, unknown>,
    options?: AgentBridgeRunOptions,
  ): Promise<AgentBridgeResult>;
  getStatus(): Promise<AgentBridgeStatus>;
  abort(): Promise<void>;
}

export interface AgentBridgeRunOptions {
  role?: AgentRole;
  signal?: AbortSignal;
  onStep?: (step: AgentStep) => void;
  maxIterations?: number;
  timeoutMs?: number;
  workspaceRoot?: string;
}

// ── Remote Agent ──

export interface RemoteAgentNode {
  id: string;
  type: "mcp" | "http";
  endpoint: string;
  role: AgentRole;
  capabilities: string[];
  status: AgentBridgeStatus;
}

// ── Review Feedback ──

export interface ReviewFeedback {
  passed: boolean;
  issues: ReviewIssue[];
  summary: string;
}

export interface ReviewIssue {
  severity: "critical" | "warning" | "suggestion";
  description: string;
  fix?: string;
}

// ── Progress Events ──

export type ClusterProgressEventType =
  | "plan_created"
  | "plan_approved"
  | "plan_retry"
  | "step_started"
  | "step_progress"
  | "step_completed"
  | "step_skipped"
  | "step_review"
  | "step_retry"
  | "aggregation_started"
  | "cluster_done"
  | "cluster_error";

export interface ClusterProgressEvent {
  type: ClusterProgressEventType;
  timestamp: number;
  stepId?: string;
  instanceId?: string;
  detail?: unknown;
}

// ── Model Routing ──

export interface ModelRoutingRule {
  roleId: string;
  modelId: string;
  reason?: string;
}

export interface ModelRoutingConfig {
  defaultModel?: string;
  rules: ModelRoutingRule[];
}

// ── Human-in-the-Loop ──

export type PlanApprovalStatus = "pending" | "approved" | "rejected" | "modified";

export interface PlanApprovalRequest {
  plan: ClusterPlan;
  status: PlanApprovalStatus;
  modifiedPlan?: ClusterPlan;
  reason?: string;
}
