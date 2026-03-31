export { ToolResolverMiddleware } from "./tool-resolver";
export { SkillMiddleware } from "./skill-middleware";
export { MemoryMiddleware } from "./memory-middleware";
export { PromptBuildMiddleware } from "./prompt-build-middleware";
export { ToolPolicyMiddleware } from "./tool-policy-middleware";
export { FCCompatibilityMiddleware } from "./fc-compatibility-middleware";
export { SpawnLimitMiddleware } from "./spawn-limit-middleware";
export {
  HumanApprovalMiddleware,
  clearSessionApprovals,
  getSessionApprovalsSnapshot,
  preApproveToolForSession,
  restoreSessionApprovals,
} from "./human-approval-middleware";
export type { ApprovalPolicy, ApprovalRule } from "./human-approval-middleware";
export { ModelRetryMiddleware, withRetry, isRetryableError, extractRetryAfter } from "./model-retry-middleware";
export type { RetryConfig } from "./model-retry-middleware";
export { KnowledgeBaseMiddleware, registerKnowledgeBase, unregisterKnowledgeBase, getRegisteredKnowledgeBases } from "./knowledge-base-middleware";
export type { KnowledgeBaseRef } from "./knowledge-base-middleware";
export { TodoListMiddleware, clearActorTodos, clearAllTodos, getActorTodoList, replaceActorTodoList } from "./todo-list-middleware";
export type { TodoItem } from "./todo-list-middleware";
export { PatchToolCallsMiddleware } from "./patch-tool-calls-middleware";
export { DialogRoomCompactionMiddleware } from "./dialog-room-compaction-middleware";
export { SummarizationMiddleware } from "./summarization-middleware";
export type { SummarizationConfig } from "./summarization-middleware";
export { SuggestionsMiddleware } from "./suggestions-middleware";
export { TelemetryMiddleware, getSessionStats, getRecentToolCalls, getAggregateStats, clearTelemetry } from "./telemetry-middleware";
export type { ToolCallRecord, AgentSessionStats } from "./telemetry-middleware";
export { DanglingToolCallMiddleware } from "./dangling-tool-call-middleware";
export { LoopDetectionMiddleware, getDefaultLoopDetectionConfig } from "./loop-detection-middleware";
export { ThreadDataMiddleware, buildThreadDataPaths } from "./thread-data-middleware";
export { ToolErrorHandlingMiddleware } from "./tool-error-handling-middleware";
export { TitleMiddleware, onSessionTitleUpdate, resetTitleGeneration } from "./title-middleware";
export type { TitleUpdateCallback } from "./title-middleware";
export { ClarificationMiddleware, ClarificationInterrupt } from "./clarification-middleware";
export { SessionUploadsMiddleware } from "./session-uploads-middleware";

import type { ActorMiddleware } from "../actor-middleware";
import { ToolResolverMiddleware } from "./tool-resolver";
import { FCCompatibilityMiddleware } from "./fc-compatibility-middleware";
import { MemoryMiddleware } from "./memory-middleware";
import { SkillMiddleware } from "./skill-middleware";
import { ToolPolicyMiddleware } from "./tool-policy-middleware";
import { SpawnLimitMiddleware } from "./spawn-limit-middleware";
import { PromptBuildMiddleware } from "./prompt-build-middleware";
import { HumanApprovalMiddleware } from "./human-approval-middleware";
import { ModelRetryMiddleware } from "./model-retry-middleware";
import { KnowledgeBaseMiddleware } from "./knowledge-base-middleware";
import { TodoListMiddleware } from "./todo-list-middleware";
import { PatchToolCallsMiddleware } from "./patch-tool-calls-middleware";
import { DialogRoomCompactionMiddleware } from "./dialog-room-compaction-middleware";
import { SummarizationMiddleware } from "./summarization-middleware";
import { SuggestionsMiddleware } from "./suggestions-middleware";
import { TelemetryMiddleware } from "./telemetry-middleware";
import { DanglingToolCallMiddleware } from "./dangling-tool-call-middleware";
import { LoopDetectionMiddleware } from "./loop-detection-middleware";
import { ThreadDataMiddleware } from "./thread-data-middleware";
import { ToolErrorHandlingMiddleware } from "./tool-error-handling-middleware";
import { TitleMiddleware } from "./title-middleware";
import { ClarificationMiddleware } from "./clarification-middleware";
import { SessionUploadsMiddleware } from "./session-uploads-middleware";

export function createSharedRuntimeMiddlewares(): ActorMiddleware[] {
  return [
    new TitleMiddleware(),
    new ToolResolverMiddleware(),
    new FCCompatibilityMiddleware(),
    new PatchToolCallsMiddleware(),
    new MemoryMiddleware(),
    new KnowledgeBaseMiddleware(),
    new ThreadDataMiddleware(),
    new SessionUploadsMiddleware(),
    new DialogRoomCompactionMiddleware(),
    new SkillMiddleware(),
    new TodoListMiddleware(),
    new ClarificationMiddleware(),
    new SuggestionsMiddleware(),
    new ToolPolicyMiddleware(),
    new HumanApprovalMiddleware(),
    new ToolErrorHandlingMiddleware(),
    new TelemetryMiddleware(),
    new ModelRetryMiddleware(),
    new SpawnLimitMiddleware(),
  ];
}

export function createLeadRuntimeMiddlewares(): ActorMiddleware[] {
  return [
    ...createSharedRuntimeMiddlewares(),
    new DanglingToolCallMiddleware(),
    new LoopDetectionMiddleware(),
    new SummarizationMiddleware(),
    new PromptBuildMiddleware(),
  ];
}

export function createSubagentRuntimeMiddlewares(): ActorMiddleware[] {
  return [
    ...createSharedRuntimeMiddlewares(),
    new SummarizationMiddleware(),
    new PromptBuildMiddleware(),
  ];
}

/**
 * Default middleware chain order:
 *
 * Lead:
 *   SharedRuntime → DanglingToolCall → LoopDetection → Summarization → PromptBuild
 *
 * Subagent:
 *   SharedRuntime → Summarization → PromptBuild
 */
export function createDefaultMiddlewares(params?: {
  isSubagent?: boolean;
}): ActorMiddleware[] {
  return params?.isSubagent
    ? createSubagentRuntimeMiddlewares()
    : createLeadRuntimeMiddlewares();
}
