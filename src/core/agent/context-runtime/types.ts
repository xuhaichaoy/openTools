import type { AICenterHandoff } from "@/store/app-store";
import type { AgentSession } from "@/store/agent-store";

export type AgentQueryIntent = "coding" | "research" | "delivery" | "general";

export interface TaskScopeSnapshot {
  previousWorkspaceRoot?: string;
  workspaceRoot?: string;
  attachmentPaths: string[];
  imagePaths: string[];
  handoffPaths: string[];
  pathHints: string[];
  queryPathHints?: string[];
  queryIntent: AgentQueryIntent;
  explicitReset: boolean;
  workspaceSource?: "explicit" | "attachment" | "handoff" | "query_path" | "locked_previous" | "none";
}

export type ContinuityReason =
  | "same_workspace"
  | "workspace_switch"
  | "path_focus_shift"
  | "query_topic_switch"
  | "explicit_new_task"
  | "force_new_session";

export type ContinuityStrategy =
  | "inherit_full"
  | "inherit_summary_only"
  | "inherit_recent_only"
  | "soft_reset"
  | "fork_session";

export interface ContinuityDecision {
  strategy: ContinuityStrategy;
  reason: ContinuityReason;
  carrySummary: boolean;
  carryRecentSteps: boolean;
  carryFiles: boolean;
  carryHandoff: boolean;
}

export interface ResolveTaskScopeParams {
  query: string;
  previousWorkspaceRoot?: string;
  explicitWorkspaceRoot?: string;
  attachmentPaths?: readonly string[];
  images?: readonly string[];
  sourceHandoff?: AICenterHandoff | null;
}

export interface DecideAgentSessionContinuityParams {
  scope: TaskScopeSnapshot;
  forceNewSession?: boolean;
  currentSession?: AgentSession | null;
}

export interface AgentExecutionContextPlan {
  scope: TaskScopeSnapshot;
  continuity: ContinuityDecision;
  effectiveWorkspaceRoot?: string;
  workspaceRootToPersist?: string;
  promptSourceHandoff?: AICenterHandoff;
  shouldResetInheritedContext: boolean;
}
