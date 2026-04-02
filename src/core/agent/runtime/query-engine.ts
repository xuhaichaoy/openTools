import { getMToolsAI } from "@/core/ai/mtools-ai";
import type { AICenterMode } from "@/core/ai/ai-mode-types";
import type { ActorMiddleware, ActorRunContext } from "@/core/agent/actor/actor-middleware";
import { runMiddlewareChain } from "@/core/agent/actor/actor-middleware";
import type { ThinkingLevel } from "@/core/agent/actor/types";
import {
  WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
  type AgentStep,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import {
  RuntimeMessageStore,
  type RuntimeInboxMessage,
} from "./runtime-message-store";
import {
  runRuntimeToolLoop,
  type RuntimeAgentFactory,
} from "./runtime-tool-loop";
import {
  MessageCompactor,
  type RuntimeContextMessage,
} from "./message-compactor";
import { AutoBackgroundManager } from "./auto-background-manager";
import { ProgressTracker } from "./progress-tracker";

const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
const MAX_CONTINUATION_TURNS = 2;
const MAX_COMPACTED_HISTORY_SUMMARY_CHARS = 3200;

type QueryEngineTransitionReason =
  | "context_recovery"
  | "token_budget_continuation"
  | "max_output_tokens_recovery";

interface QueryEngineLoopState {
  historySteps: AgentStep[];
  compactedHistorySummary?: string;
  pendingToolUseSummary?: string;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  stopHookActive?: boolean;
  turnCount: number;
  continuationCount: number;
  transition?: {
    reason: QueryEngineTransitionReason;
  };
}

function previewText(value: unknown, limit = 180): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(1, limit - 3)).trimEnd()}...`
    : normalized;
}

function isPersistentHistoryStep(step: AgentStep): boolean {
  if (step.streaming) return false;
  return (
    step.type === "action"
    || step.type === "observation"
    || step.type === "answer"
    || step.type === "error"
    || step.type === "checkpoint"
  );
}

function mergeHistorySummary(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  const parts = [previous, next]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const merged = parts.join("\n\n");
  if (merged.length <= MAX_COMPACTED_HISTORY_SUMMARY_CHARS) {
    return merged;
  }
  return [
    "[更早执行摘要已再次压缩]",
    merged.slice(merged.length - MAX_COMPACTED_HISTORY_SUMMARY_CHARS),
  ].join("\n");
}

function buildToolUseSummary(steps: readonly AgentStep[]): string | undefined {
  const toolCounts = new Map<string, number>();
  const observations: string[] = [];
  const answers: string[] = [];
  const errors: string[] = [];

  for (const step of steps) {
    if (!isPersistentHistoryStep(step)) continue;
    if (step.type === "action" && step.toolName) {
      toolCounts.set(step.toolName, (toolCounts.get(step.toolName) ?? 0) + 1);
    }
    if (step.type === "observation") {
      const preview = previewText(step.content, 160);
      if (preview) observations.push(preview);
    }
    if (step.type === "answer") {
      const preview = previewText(step.content, 160);
      if (preview) answers.push(preview);
    }
    if (step.type === "error") {
      const preview = previewText(step.content, 140);
      if (preview) errors.push(preview);
    }
  }

  const toolSummary = [...toolCounts.entries()]
    .slice(0, 6)
    .map(([toolName, count]) => (count > 1 ? `${toolName} ×${count}` : toolName))
    .join("、");

  const lines = [
    toolSummary ? `已执行工具：${toolSummary}` : "",
    observations.length > 0 ? `最近关键结果：${observations.slice(-2).join("；")}` : "",
    answers.length > 0 ? `上轮结论：${answers.slice(-1)[0]}` : "",
    errors.length > 0 ? `上轮错误：${errors.slice(-1)[0]}` : "",
  ].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function isLikelyIterationLimitResult(result: string): boolean {
  return /已达到最大执行步数/i.test(result);
}

function isLikelyMaxOutputTokensError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /max(?:imum)?[_\s-]*output[_\s-]*tokens?|finish_reason.{0,20}length|输出.{0,12}(?:截断|长度|token)|response.{0,20}(?:truncated|length)/i.test(
    message,
  );
}

function buildContinuationQuery(
  query: string,
  state: QueryEngineLoopState,
): string {
  switch (state.transition?.reason) {
    case "context_recovery":
      return [
        "请基于当前保留下来的上下文与上轮执行摘要继续完成原任务。",
        "不要从头开始，不要重复已经成功的工具调用，也不要重新派发等价子任务。",
        `原始任务：${query}`,
      ].join("\n");
    case "max_output_tokens_recovery":
      return [
        "请从上一轮中断的位置继续完成剩余输出。",
        "除非绝对必要，不要重复前面已经完成的分析、工具调用或铺垫描述。",
        `原始任务：${query}`,
      ].join("\n");
    case "token_budget_continuation":
      return [
        "继续完成刚才尚未收尾的部分。",
        "优先衔接上轮已经完成的工作，不要重复已成功的工具调用。",
        `原始任务：${query}`,
      ].join("\n");
    default:
      return query;
  }
}

function buildContinuationMessages(
  state: QueryEngineLoopState,
): RuntimeContextMessage[] {
  if (!state.transition) return [];

  const messages: RuntimeContextMessage[] = [];
  if (state.compactedHistorySummary) {
    messages.push({
      role: "assistant",
      content: `[较早执行摘要]\n${state.compactedHistorySummary}`,
    });
  }
  if (state.pendingToolUseSummary) {
    messages.push({
      role: "assistant",
      content: `[上轮工具与结果摘要]\n${state.pendingToolUseSummary}`,
    });
  }
  if (state.stopHookActive) {
    messages.push({
      role: "assistant",
      content: "[停机钩子摘要] 上一轮仍有阻塞项，请优先基于已保留上下文处理该阻塞项。",
    });
  }
  return messages;
}

export interface QueryEngineContextSnapshot {
  toolCount: number;
  contextMessageCount: number;
  hasSkillsPrompt: boolean;
  hasMemoryPrompt: boolean;
  hasRetry: boolean;
  memoryRecallAttempted: boolean;
  appliedMemoryPreview: string[];
  transcriptRecallAttempted: boolean;
  transcriptRecallHitCount: number;
  appliedTranscriptPreview: string[];
}

export interface QueryEngineRunResult {
  result: string;
  visibleToolNames: string[];
  status: "completed" | "spawn_wait";
  attempts: number;
  summary?: string;
  currentImages?: string[];
  capturedInboxUserQueries?: string[];
  ctxSnapshot: QueryEngineContextSnapshot;
}

export interface QueryEngineOptions {
  productMode: AICenterMode;
  modelOverride?: string;
  currentTaskId?: string;
  thinkingLevel?: ThinkingLevel;
  temperature: number;
  middlewares: readonly ActorMiddleware[];
  isTaskActive?: () => boolean;
  drainInbox: () => RuntimeInboxMessage[];
  resolveInboxSenderName: (from: string) => string;
  onTraceEvent?: (event: string, detail?: Record<string, unknown>) => void;
  onVisibleToolNames?: (toolNames: string[]) => void;
  onMiddlewareCompleted?: (snapshot: QueryEngineContextSnapshot) => void;
  onContextRecovery?: (error: unknown) => Promise<boolean>;
  runMiddlewares?: (
    middlewares: readonly ActorMiddleware[],
    ctx: ActorRunContext,
  ) => Promise<void>;
  createAgent?: RuntimeAgentFactory;
}

export class QueryEngine {
  private readonly options: QueryEngineOptions;
  private readonly runMiddlewares;
  private readonly compactor: MessageCompactor;
  private readonly autoBackground: AutoBackgroundManager;
  private readonly progressTracker: ProgressTracker;

  constructor(options: QueryEngineOptions) {
    this.options = options;
    this.runMiddlewares = options.runMiddlewares ?? runMiddlewareChain;
    this.compactor = new MessageCompactor();
    this.autoBackground = new AutoBackgroundManager();
    this.progressTracker = new ProgressTracker();
  }

  async run(params: {
    query: string;
    images?: string[];
    signal: AbortSignal;
    retryLabel?: string;
    allowContextRecovery?: boolean;
    createRunContext: (messageStore: RuntimeMessageStore) => ActorRunContext;
  }): Promise<QueryEngineRunResult> {
    const messageStore = new RuntimeMessageStore(params.images);
    const taskKey = this.options.currentTaskId || "query-engine";
    this.autoBackground.cancel(taskKey);
    this.autoBackground.scheduleAutoBackground(taskKey, () => {
      this.options.onTraceEvent?.("runtime_auto_background_threshold_reached", {
        task_id: this.options.currentTaskId,
      });
    });
    try {
      return await this.runInternal({
        ...params,
        messageStore,
        allowContextRecovery: params.allowContextRecovery !== false,
      });
    } finally {
      this.autoBackground.cancel(taskKey);
    }
  }

  private buildSnapshot(ctx: ActorRunContext): QueryEngineContextSnapshot {
    return {
      toolCount: ctx.tools.length,
      contextMessageCount: ctx.contextMessages.length,
      hasSkillsPrompt: Boolean(ctx.skillsPrompt),
      hasMemoryPrompt: Boolean(ctx.userMemoryPrompt),
      hasRetry: Boolean(ctx.withRetry && ctx.retryConfig),
      memoryRecallAttempted: ctx.memoryRecallAttempted === true,
      appliedMemoryPreview: [...(ctx.appliedMemoryPreview ?? [])],
      transcriptRecallAttempted: ctx.transcriptRecallAttempted === true,
      transcriptRecallHitCount: Math.max(0, ctx.transcriptRecallHitCount ?? 0),
      appliedTranscriptPreview: [...(ctx.appliedTranscriptPreview ?? [])],
    };
  }

  private mergeRuntimeContextMessages(
    baseMessages: readonly RuntimeContextMessage[],
    extraMessages: readonly RuntimeContextMessage[],
  ): RuntimeContextMessage[] {
    const merged = [...baseMessages, ...extraMessages];
    const compaction = this.compactor.compactContextMessages(merged);
    if (compaction.removedCount > 0) {
      this.options.onTraceEvent?.("runtime_context_compacted", {
        task_id: this.options.currentTaskId,
        removed_count: compaction.removedCount,
        summary: previewText(compaction.summary, 240),
      });
    }
    return compaction.compactedMessages;
  }

  private recordIterationHistory(
    state: QueryEngineLoopState,
    steps: readonly AgentStep[],
  ): void {
    const persistentSteps = steps.filter(isPersistentHistoryStep);
    if (persistentSteps.length === 0) return;

    state.pendingToolUseSummary = buildToolUseSummary(persistentSteps) ?? state.pendingToolUseSummary;
    const compaction = this.compactor.compactStepHistory([
      ...state.historySteps,
      ...persistentSteps,
    ]);
    state.historySteps = compaction.recentSteps;
    if (compaction.removedCount > 0) {
      state.compactedHistorySummary = mergeHistorySummary(
        state.compactedHistorySummary,
        compaction.summary,
      );
      this.options.onTraceEvent?.("runtime_history_compacted", {
        task_id: this.options.currentTaskId,
        removed_count: compaction.removedCount,
        summary: previewText(compaction.summary, 240),
      });
    }
  }

  private shouldContinueAfterIterationLimit(
    result: string,
    steps: readonly AgentStep[],
    state: QueryEngineLoopState,
  ): boolean {
    if (!isLikelyIterationLimitResult(result)) return false;
    if (state.continuationCount >= MAX_CONTINUATION_TURNS) return false;
    return steps.some((step) => (
      isPersistentHistoryStep(step)
      && (step.type === "action" || step.type === "observation" || step.type === "checkpoint")
    ));
  }

  private trackStep(taskKey: string, step: AgentStep): void {
    const message = step.toolName
      ? `${step.type}:${step.toolName}`
      : previewText(step.content, 120);
    const progress = step.type === "answer"
      ? 100
      : step.type === "observation"
        ? 70
        : step.type === "action"
          ? 50
          : undefined;
    this.progressTracker.track(taskKey, step.type, message, progress);
  }

  private async runInternal(params: {
    query: string;
    images?: string[];
    signal: AbortSignal;
    retryLabel?: string;
    allowContextRecovery: boolean;
    createRunContext: (messageStore: RuntimeMessageStore) => ActorRunContext;
    messageStore: RuntimeMessageStore;
  }): Promise<QueryEngineRunResult> {
    const taskKey = this.options.currentTaskId || "query-engine";
    const ensureTaskStillActive = () => {
      if (this.options.isTaskActive?.() === false) {
        throw new Error("Aborted");
      }
    };

    const state: QueryEngineLoopState = {
      historySteps: [],
      compactedHistorySummary: undefined,
      pendingToolUseSummary: undefined,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      stopHookActive: undefined,
      turnCount: 1,
      continuationCount: 0,
      transition: undefined,
    };
    let latestSnapshot: QueryEngineContextSnapshot | undefined;

    while (true) {
      const continuationMessages = buildContinuationMessages(state);
      const baseCtx = params.createRunContext(params.messageStore);
      const stepBuffer: AgentStep[] = [];
      const wrappedOnStep = (step: AgentStep) => {
        stepBuffer.push(step);
        this.trackStep(taskKey, step);
        baseCtx.onStep?.(step);
      };
      const ctx: ActorRunContext = {
        ...baseCtx,
        onStep: wrappedOnStep,
        contextMessages: this.mergeRuntimeContextMessages(
          baseCtx.contextMessages,
          continuationMessages,
        ),
      };
      const effectiveQuery = buildContinuationQuery(params.query, state);

      try {
        ensureTaskStillActive();
        this.progressTracker.track(taskKey, "turn_started", `turn ${state.turnCount}`);
        await this.runMiddlewares(this.options.middlewares, ctx);
        ensureTaskStillActive();

        ctx.contextMessages = this.mergeRuntimeContextMessages(ctx.contextMessages, []);
        latestSnapshot = this.buildSnapshot(ctx);
        this.options.onMiddlewareCompleted?.(latestSnapshot);

        const toolLoopResult = await runRuntimeToolLoop({
          ai: getMToolsAI(this.options.productMode),
          query: effectiveQuery,
          images: params.images,
          signal: params.signal,
          ctx,
          currentTaskId: this.options.currentTaskId,
          modelOverride: this.options.modelOverride,
          thinkingLevel: this.options.thinkingLevel,
          temperature: this.options.temperature,
          isTaskActive: this.options.isTaskActive,
          retryLabel: params.retryLabel,
          createAgent: this.options.createAgent,
          onTraceEvent: this.options.onTraceEvent,
          onVisibleToolNames: this.options.onVisibleToolNames,
          history: state.historySteps,
          inboxDrain: () =>
            params.messageStore.recordDrainedMessages(
              this.options.drainInbox(),
              this.options.resolveInboxSenderName,
            ),
        });

        this.recordIterationHistory(state, stepBuffer);

        if (toolLoopResult.status === "spawn_wait") {
          this.progressTracker.track(taskKey, "spawn_wait", toolLoopResult.summary, 90);
          return {
            result: toolLoopResult.result,
            visibleToolNames: toolLoopResult.visibleToolNames,
            status: toolLoopResult.status,
            attempts: toolLoopResult.attempts,
            summary: toolLoopResult.summary,
            currentImages: params.messageStore.getCurrentImages(),
            capturedInboxUserQueries: params.messageStore.consumeCapturedInboxUserQueries(),
            ctxSnapshot: latestSnapshot ?? this.buildSnapshot(ctx),
          };
        }

        if (this.shouldContinueAfterIterationLimit(toolLoopResult.result, stepBuffer, state)) {
          state.turnCount += 1;
          state.continuationCount += 1;
          state.transition = { reason: "token_budget_continuation" };
          this.options.onTraceEvent?.("runtime_query_continue", {
            task_id: this.options.currentTaskId,
            reason: state.transition.reason,
            turn_count: state.turnCount,
          });
          continue;
        }

        this.progressTracker.track(taskKey, "completed", previewText(toolLoopResult.result), 100);
        return {
          result: toolLoopResult.result,
          visibleToolNames: toolLoopResult.visibleToolNames,
          status: toolLoopResult.status,
          attempts: toolLoopResult.attempts,
          currentImages: params.messageStore.getCurrentImages(),
          capturedInboxUserQueries: params.messageStore.consumeCapturedInboxUserQueries(),
          ctxSnapshot: latestSnapshot ?? this.buildSnapshot(ctx),
        };
      } catch (error) {
        this.recordIterationHistory(state, stepBuffer);

        if (
          isLikelyMaxOutputTokensError(error)
          && state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
        ) {
          state.maxOutputTokensRecoveryCount += 1;
          state.turnCount += 1;
          state.transition = { reason: "max_output_tokens_recovery" };
          this.options.onTraceEvent?.("runtime_query_continue", {
            task_id: this.options.currentTaskId,
            reason: state.transition.reason,
            turn_count: state.turnCount,
          });
          continue;
        }

        if (
          params.allowContextRecovery
          && !state.hasAttemptedReactiveCompact
          && this.options.onContextRecovery
        ) {
          const recovered = await this.options.onContextRecovery(error);
          if (recovered) {
            state.hasAttemptedReactiveCompact = true;
            state.turnCount += 1;
            state.transition = { reason: "context_recovery" };
            this.options.onTraceEvent?.("runtime_query_continue", {
              task_id: this.options.currentTaskId,
              reason: state.transition.reason,
              turn_count: state.turnCount,
            });
            continue;
          }
        }

        this.progressTracker.track(
          taskKey,
          "failed",
          previewText(error instanceof Error ? error.message : String(error)),
        );
        throw error;
      }
    }
  }
}

export { WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT };
