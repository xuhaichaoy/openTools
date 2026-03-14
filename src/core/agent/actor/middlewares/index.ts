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
export { SummarizationMiddleware } from "./summarization-middleware";
export type { SummarizationConfig } from "./summarization-middleware";
export { SuggestionsMiddleware } from "./suggestions-middleware";
export { TelemetryMiddleware, getSessionStats, getRecentToolCalls, getAggregateStats, clearTelemetry } from "./telemetry-middleware";
export type { ToolCallRecord, AgentSessionStats } from "./telemetry-middleware";
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
import { SummarizationMiddleware } from "./summarization-middleware";
import { SuggestionsMiddleware } from "./suggestions-middleware";
import { TelemetryMiddleware } from "./telemetry-middleware";
import { TitleMiddleware } from "./title-middleware";
import { ClarificationMiddleware } from "./clarification-middleware";
import { SessionUploadsMiddleware } from "./session-uploads-middleware";

/**
 * Default middleware chain order (evolved from deer-flow + Yuxi-Know + cocoindex conventions):
 *
 *   ToolResolver → FCCompatibility → PatchToolCalls → Memory → KnowledgeBase
 *   → Skill → TodoList → Suggestions → ToolPolicy → HumanApproval
 *   → Telemetry → ModelRetry → SpawnLimit → Summarization → PromptBuild
 *
 * New additions:
 * - Summarization: Auto-compress context when approaching token limit (deer-flow)
 * - Suggestions: Generate follow-up question suggestions (deer-flow)
 * - Telemetry: Track tool call metrics for dashboard (Yuxi-Know)
 */
/**
 * Default middleware chain order:
 *
 *   Title → ToolResolver → FCCompatibility → PatchToolCalls → Memory → KnowledgeBase
 *   → SessionUploads → Skill → TodoList → Clarification → Suggestions → ToolPolicy → HumanApproval
 *   → Telemetry → ModelRetry → SpawnLimit → Summarization → PromptBuild
 *
 * New additions:
 * - Title: Auto-generate session title from first user message
 * - Clarification: Inject ask_clarification tool for agent-initiated interruptions
 */
export function createDefaultMiddlewares(): ActorMiddleware[] {
  return [
    new TitleMiddleware(),
    new ToolResolverMiddleware(),
    new FCCompatibilityMiddleware(),
    new PatchToolCallsMiddleware(),
    new MemoryMiddleware(),
    new KnowledgeBaseMiddleware(),
    new SessionUploadsMiddleware(),
    new SkillMiddleware(),
    new TodoListMiddleware(),
    new ClarificationMiddleware(),
    new SuggestionsMiddleware(),
    new ToolPolicyMiddleware(),
    new HumanApprovalMiddleware(),
    new TelemetryMiddleware(),
    new ModelRetryMiddleware(),
    new SpawnLimitMiddleware(),
    new SummarizationMiddleware(),
    new PromptBuildMiddleware(),
  ];
}
