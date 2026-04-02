import {
  ReActAgent,
  WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
  WaitForSpawnedTasksInterrupt,
  type AgentConfig,
  type AgentStep,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorRunContext } from "@/core/agent/actor/actor-middleware";
import type { ThinkingLevel } from "@/core/agent/actor/types";
import type { RuntimeVisibleInboxMessage } from "./runtime-message-store";
import { executeRuntimeWithRetry } from "./runtime-retry-policy";

export interface RuntimeAgentLike {
  listVisibleToolNames(): string[];
  run(query: string, signal?: AbortSignal, images?: string[]): Promise<string>;
}

export type RuntimeAgentFactory = (
  ai: ConstructorParameters<typeof ReActAgent>[0],
  tools: ConstructorParameters<typeof ReActAgent>[1],
  config: ConstructorParameters<typeof ReActAgent>[2],
  onStep: ConstructorParameters<typeof ReActAgent>[3],
  history?: AgentStep[],
) => RuntimeAgentLike;

export type RuntimeToolLoopResult =
  | {
      result: string;
      visibleToolNames: string[];
      attempts: number;
      status: "completed";
    }
  | {
      result: typeof WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT;
      visibleToolNames: string[];
      attempts: number;
      status: "spawn_wait";
      summary?: string;
    };

const createDefaultRuntimeAgent: RuntimeAgentFactory = (
  ai,
  tools,
  config,
  onStep,
  history = [],
) => new ReActAgent(ai, tools, config, onStep, history);

export async function runRuntimeToolLoop(params: {
  ai: ConstructorParameters<typeof ReActAgent>[0];
  query: string;
  images?: string[];
  signal: AbortSignal;
  ctx: ActorRunContext;
  currentTaskId?: string;
  modelOverride?: string;
  thinkingLevel?: ThinkingLevel;
  temperature: number;
  isTaskActive?: () => boolean;
  inboxDrain: () => RuntimeVisibleInboxMessage[];
  onTraceEvent?: (event: string, detail?: Record<string, unknown>) => void;
  onVisibleToolNames?: (toolNames: string[]) => void;
  retryLabel?: string;
  createAgent?: RuntimeAgentFactory;
  history?: AgentStep[];
}): Promise<RuntimeToolLoopResult> {
  const createAgent = params.createAgent ?? createDefaultRuntimeAgent;
  const agentConfig: AgentConfig = {
    maxIterations: params.ctx.maxIterations,
    verbose: true,
    onTraceEvent: (event, detail) => {
      if (params.isTaskActive?.() === false) return;
      params.onTraceEvent?.(event, {
        task_id: params.currentTaskId,
        ...(detail ?? {}),
      });
    },
    fcCompatibilityKey: params.ctx.fcCompatibilityKey,
    temperature: params.temperature,
    initialMode: "execute",
    userMemoryPrompt: params.ctx.userMemoryPrompt,
    skillsPrompt: params.ctx.skillsPrompt,
    skipInternalCodingBlock: params.ctx.hasCodingWorkflowSkill,
    roleOverride: params.ctx.rolePrompt || undefined,
    dangerousToolPatterns: ["write_file", "run_shell_command", "native_"],
    confirmDangerousAction: params.ctx.confirmDangerousAction,
    onToolExecuted: params.ctx.notifyToolCalled,
    modelOverride: params.modelOverride,
    thinkingLevel: params.thinkingLevel,
    contextBudget: params.ctx.contextTokens,
    contextMessages: params.ctx.contextMessages,
    resumeMessages: params.ctx.transcriptMessages,
    requireFunctionCalling: params.ctx.requireFunctionCalling,
    patchDanglingToolCalls: params.ctx.patchDanglingToolCalls === true,
    loopDetection: params.ctx.loopDetectionConfig,
    authoritativeToolList: true,
    toolResultReplacementState: params.ctx.toolResultReplacementState,
    onConversationMessagesUpdated: params.ctx.onConversationMessagesUpdated,
    toolResultPersistenceDir: params.ctx.threadData
      ? `${params.ctx.threadData.outputsPath.replace(/[\\/]+$/g, "")}/tool-results`
      : undefined,
    inboxDrain: () => {
      if (params.isTaskActive?.() === false) return [];
      return params.inboxDrain();
    },
  };

  const agent = createAgent(
    params.ai,
    params.ctx.tools,
    agentConfig,
    (step: AgentStep) => {
      if (params.isTaskActive?.() === false) return;
      params.ctx.onStep?.(step);
    },
    params.history ?? [],
  );
  const visibleToolNames = agent.listVisibleToolNames();
  params.onVisibleToolNames?.(visibleToolNames);
  let attempts = 0;

  try {
    const retryResult = await executeRuntimeWithRetry({
      execute: () => agent.run(params.query, params.signal, params.images),
      retryConfig: params.ctx.retryConfig,
      withRetry: params.ctx.withRetry,
      retryLabel: params.retryLabel,
      onAttemptStarted: (attempt) => {
        attempts = attempt;
        if (attempt <= 1) return;
        params.onTraceEvent?.("llm_retry", {
          task_id: params.currentTaskId,
          count: attempt - 1,
          model: params.modelOverride ?? "default",
        });
      },
    });
    attempts = retryResult.attempts;
    return {
      result: retryResult.result,
      visibleToolNames,
      attempts,
      status: "completed",
    };
  } catch (error) {
    if (error instanceof WaitForSpawnedTasksInterrupt) {
      return {
        result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
        visibleToolNames,
        attempts: Math.max(1, attempts),
        status: "spawn_wait",
        summary: error.summary,
      };
    }
    throw error;
  }
}
