import type {
  AgentCapability,
  SpawnTaskOverrides,
  SpawnedTaskRoleBoundary,
  ThinkingLevel,
  ToolPolicy,
  WorkerProfileId,
} from "@/core/agent/actor/types";

export type BuiltinAgentId =
  | "general_purpose"
  | "plan_agent"
  | "verification_agent"
  | "explore_agent"
  | "implementation_agent"
  | "review_agent"
  | "spreadsheet_generation_agent";

export interface BuiltinAgentDefinition {
  id: BuiltinAgentId;
  label: string;
  defaultTargetName: string;
  description: string;
  whenToUse: string;
  roleBoundary: SpawnedTaskRoleBoundary;
  workerProfileId?: WorkerProfileId;
  capabilities: AgentCapability[];
  maxIterations?: number;
  thinkingLevel?: ThinkingLevel;
  resultContract?: SpawnTaskOverrides["resultContract"];
  toolPolicy?: ToolPolicy;
  systemPromptAppend: string;
  defaultAcceptance: string[];
}

export interface AppliedBuiltinAgentDefinition {
  definition?: BuiltinAgentDefinition;
  targetName?: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
  workerProfileId?: WorkerProfileId;
  childDescription?: string;
  childCapabilities?: AgentCapability[];
  overrides: SpawnTaskOverrides;
  defaultAcceptance: string[];
}
