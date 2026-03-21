import { getMToolsAI } from "@/core/ai/mtools-ai";
import { getResolvedAIConfigForMode } from "@/core/ai/resolved-ai-config-store";
import { useAIStore } from "@/store/ai-store";
import { useAgentMemoryStore } from "@/store/agent-memory-store";
import { loadAndResolveSkills } from "@/store/skill-store";
import { applySkillToolFilter } from "@/core/agent/skills/skill-resolver";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import {
  buildAssistantSupplementalPrompt,
  filterAssistantToolsByConfig,
  shouldAutoSaveAssistantMemory,
  shouldRecallAssistantMemory,
} from "@/core/ai/assistant-config";
import { autoExtractMemories } from "@/core/agent/actor/actor-memory";
import { buildKnowledgeContextMessages } from "@/core/agent/actor/middlewares/knowledge-base-middleware";
import { getEnabledMcpAgentTools } from "@/core/mcp/mcp-agent-tools";
import {
  assembleAgentExecutionContext,
  buildAgentExecutionContextPlan,
  collectContextPathHints,
  uniqueContextPaths,
} from "@/core/agent/context-runtime";
import { registry } from "@/core/plugin-system/registry";
import { ensureMcpServersLoaded } from "@/store/mcp-store";
import {
  ReActAgent,
  pluginActionToTool,
  type AgentTool,
  type AgentStep,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import { applyIncomingAgentStep } from "@/plugins/builtin/SmartAgent/core/agent-task-state";
import {
  createBuiltinAgentTools,
  type AskUserQuestion,
  type AskUserAnswers,
} from "@/plugins/builtin/SmartAgent/core/default-tools";
import { filterToolsByRole } from "./agent-role";
import type {
  AgentBridge,
  AgentBridgeResult,
  AgentBridgeRunOptions,
  AgentBridgeStatus,
  AgentRole,
} from "./types";

// ── Shared tool builder (reusable across single-agent and cluster) ──

export type AskUserCallback = (questions: AskUserQuestion[]) => Promise<AskUserAnswers>;

function getPluginTools(): AgentTool[] {
  const ai = getMToolsAI("cluster");
  return registry.getAllActions().map(({ pluginId, pluginName, action }) =>
    pluginActionToTool(pluginId, pluginName, action, ai),
  );
}

function getBuiltinTools(askUser?: AskUserCallback): { tools: AgentTool[]; resetPerRunState: () => void; notifyToolCalled: (toolName: string) => void } {
  const confirmHostFallback = async () => true;
  return createBuiltinAgentTools(confirmHostFallback, askUser);
}

export function buildAllTools(askUser?: AskUserCallback): AgentTool[] {
  const tools = [...getPluginTools(), ...getBuiltinTools(askUser).tools, ...getEnabledMcpAgentTools()];
  return filterAssistantToolsByConfig(tools, useAIStore.getState().config);
}

function filterToolsForRole(tools: AgentTool[], role: AgentRole): AgentTool[] {
  const allNames = tools.map((t) => t.name);
  const allowedNames = new Set(filterToolsByRole(allNames, role));
  let filtered = tools.filter((t) => allowedNames.has(t.name));
  if (role.readonly) {
    filtered = filtered.filter((t) => !t.dangerous);
    filtered = filtered.map((t) => ({ ...t, readonly: true }));
  }
  return filtered;
}

const MAX_CONTEXT_VALUE_LEN = 4000;

function formatContextForAgent(context: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    const strVal = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const truncated = strVal.length > MAX_CONTEXT_VALUE_LEN
      ? strVal.slice(0, MAX_CONTEXT_VALUE_LEN) + "\n...(内容已截断)"
      : strVal;
    parts.push(`### ${key}\n${truncated}`);
  }
  return parts.join("\n\n");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

// ── Local Agent Bridge ──

export type ConfirmDangerousAction = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<boolean>;

let nextBridgeId = 0;

export class LocalAgentBridge implements AgentBridge {
  readonly id: string;
  readonly type = "local" as const;

  private confirmDangerousAction?: ConfirmDangerousAction;
  private askUser?: AskUserCallback;
  private abortController: AbortController | null = null;

  constructor(id?: string, confirmDangerousAction?: ConfirmDangerousAction, askUser?: AskUserCallback) {
    this.id = id ?? `local-${nextBridgeId++}`;
    this.confirmDangerousAction = confirmDangerousAction;
    this.askUser = askUser;
  }

  async run(
    task: string,
    context: Record<string, unknown>,
    options?: AgentBridgeRunOptions,
  ): Promise<AgentBridgeResult> {
    const ai = getMToolsAI("cluster");
    const aiConfig = useAIStore.getState().config;
    await ensureMcpServersLoaded();
    const builtinResult = getBuiltinTools(this.askUser);
    builtinResult.resetPerRunState();
    const { notifyToolCalled } = builtinResult;
    const allTools = [...getPluginTools(), ...builtinResult.tools, ...getEnabledMcpAgentTools()];
    const role = options?.role;
    const configFilteredTools = filterAssistantToolsByConfig(allTools, aiConfig);
    const tools = role ? filterToolsForRole(configFilteredTools, role) : configFilteredTools;
    const globalMaxIterations = Math.max(
      1,
      Math.min(50, aiConfig.agent_max_iterations ?? 25),
    );
    const requestedMaxIterations = options?.maxIterations ?? role?.maxIterations ?? globalMaxIterations;
    const maxIterations = Math.max(1, Math.min(requestedMaxIterations, globalMaxIterations));

    const fcCompatibilityKey = buildAgentFCCompatibilityKey(
      getResolvedAIConfigForMode("cluster"),
    );

    const {
      _images: contextImages,
      _workspaceRoot: contextWorkspaceRoot,
      _attachmentPaths: contextAttachmentPaths,
      ...contextForText
    } = context;
    const images = Array.isArray(contextImages) && contextImages.length > 0
      ? (contextImages as string[])
      : undefined;
    const explicitWorkspaceRoot =
      typeof options?.workspaceRoot === "string" && options.workspaceRoot.trim().length > 0
        ? options.workspaceRoot
        : (typeof contextWorkspaceRoot === "string" ? contextWorkspaceRoot : undefined);
    const contextPathHints = uniqueContextPaths([
      ...normalizeStringArray(contextAttachmentPaths),
      ...collectContextPathHints(contextForText),
    ]);
    const contextStr = Object.keys(contextForText).length > 0
      ? `\n\n## 前置步骤的输出结果\n${formatContextForAgent(contextForText)}`
      : "";

    const rolePrompt = role?.systemPrompt ?? "";
    const fullQuery = `${task}${contextStr}`;

    let userMemoryPrompt: string | undefined;
    let memoryRecallAttempted = false;
    let appliedMemoryPreview: string[] = [];
    let transcriptRecallAttempted = false;
    let transcriptRecallHitCount = 0;
    let appliedTranscriptPreview: string[] = [];
    if (shouldRecallAssistantMemory(aiConfig)) {
      let memorySnap = useAgentMemoryStore.getState();
      if (!memorySnap.loaded) {
        try { await memorySnap.load(); memorySnap = useAgentMemoryStore.getState(); } catch { /* ignore */ }
      }
      const memoryBundle = await memorySnap.getMemoryRecallBundleAsync(task, {
        topK: 6,
        workspaceId: explicitWorkspaceRoot,
        preferSemantic: true,
      });
      memoryRecallAttempted = memoryBundle.searched;
      appliedMemoryPreview = memoryBundle.memoryPreview.slice(0, 4);
      transcriptRecallAttempted = memoryBundle.transcriptSearched;
      transcriptRecallHitCount = memoryBundle.transcriptHitCount;
      appliedTranscriptPreview = memoryBundle.transcriptPreview.slice(0, 4);
      userMemoryPrompt = memoryBundle.prompt
        ? `\n\n## 用户偏好\n${memoryBundle.prompt}`
        : undefined;
    }

    const skillCtx = await loadAndResolveSkills(task, role?.id);
    const skillsPrompt = skillCtx.mergedSystemPrompt || undefined;
    const hasCodingWorkflowSkill = skillCtx.visibleSkillIds.includes("builtin-coding-workflow");
    const toolsAfterSkills = applySkillToolFilter(tools, skillCtx.mergedToolFilter);
    const knowledgeContextMessages = await buildKnowledgeContextMessages(task);
    const attachmentSummary = [
      contextPathHints.length > 0 ? `附件 ${contextPathHints.length} 项` : "",
      images?.length ? `图片 ${images.length} 张` : "",
    ].filter(Boolean).join("，") || undefined;
    const executionContextPlan = await buildAgentExecutionContextPlan({
      query: fullQuery,
      explicitWorkspaceRoot,
      attachmentPaths: contextPathHints,
      images,
    });
    const assembledContext = await assembleAgentExecutionContext({
      query: fullQuery,
      executionContextPlan,
      attachmentSummary,
      userMemoryPrompt,
      skillsPrompt,
      supplementalSystemPrompt: buildAssistantSupplementalPrompt(aiConfig.system_prompt),
      knowledgeContextMessageCount: knowledgeContextMessages.length,
    });
    const effectiveWorkspaceRoot = assembledContext.effectiveWorkspaceRoot;
    const extraSystemPrompt = [
      assembledContext.extraSystemPrompt,
      effectiveWorkspaceRoot
        ? `## 工作目录\n你的工作目录为: ${effectiveWorkspaceRoot}\n执行 shell 命令和文件操作时，请在此目录下进行。`
        : "",
    ]
      .filter((block): block is string => typeof block === "string" && block.trim().length > 0)
      .join("\n\n");

    const collectedSteps: AgentStep[] = [];
    this.abortController = new AbortController();
    const signal = options?.signal
      ? anySignal([options.signal, this.abortController.signal])
      : this.abortController.signal;

    const agent = new ReActAgent(
      ai,
      toolsAfterSkills,
      {
        maxIterations,
        verbose: true,
        fcCompatibilityKey,
        temperature: role?.temperature ?? aiConfig.temperature ?? 0.7,
        initialMode: role?.readonly ? "plan" : "execute",
        userMemoryPrompt,
        skillsPrompt,
        extraSystemPrompt: extraSystemPrompt || undefined,
        skipInternalCodingBlock: hasCodingWorkflowSkill,
        roleOverride: rolePrompt || undefined,
        dangerousToolPatterns: ["write_file", "run_shell_command", "native_"],
        confirmDangerousAction: this.confirmDangerousAction,
        onToolExecuted: notifyToolCalled,
        modelOverride: role?.modelOverride,
        contextMessages: knowledgeContextMessages,
      },
      (step) => {
        const nextSteps = applyIncomingAgentStep(collectedSteps, step);
        collectedSteps.splice(0, collectedSteps.length, ...nextSteps);
        options?.onStep?.(step);
      },
    );

    try {
      const answer = await retryAsync(
        () => agent.run(fullQuery, signal, images),
        {
          maxRetries: Math.max(0, Math.min(10, aiConfig.agent_retry_max ?? 3)),
          baseDelayMs: Math.max(500, Math.min(60000, aiConfig.agent_retry_backoff_ms ?? 5000)),
          signal,
        },
      );
      if (shouldAutoSaveAssistantMemory(aiConfig)) {
        void autoExtractMemories(`${task}\n${answer}`, this.id, {
          sourceMode: "cluster",
        }).catch(() => undefined);
      }
      return {
        answer,
        steps: collectedSteps,
        memoryRecallAttempted,
        appliedMemoryPreview,
        transcriptRecallAttempted,
        transcriptRecallHitCount,
        appliedTranscriptPreview,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (error === "Aborted" || signal.aborted) {
        return {
          answer: "",
          steps: collectedSteps,
          error: "已取消",
          memoryRecallAttempted,
          appliedMemoryPreview,
          transcriptRecallAttempted,
          transcriptRecallHitCount,
          appliedTranscriptPreview,
        };
      }
      return {
        answer: "",
        steps: collectedSteps,
        error,
        memoryRecallAttempted,
        appliedMemoryPreview,
        transcriptRecallAttempted,
        transcriptRecallHitCount,
        appliedTranscriptPreview,
      };
    } finally {
      this.abortController = null;
    }
  }

  async getStatus(): Promise<AgentBridgeStatus> {
    return this.abortController ? "busy" : "online";
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
  }
}

const TRANSIENT_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /timeout/i,
  /ECONNRESET/,
  /fetch failed/i,
  /network/i,
  /5\d{2}/,
];

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg));
}

async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelayMs: number; signal?: AbortSignal },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (opts.signal?.aborted) throw e;
      if (!isTransientError(e) || attempt >= opts.maxRetries) throw e;
      const delay = opts.baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
