import { getMToolsAI } from "@/core/ai/mtools-ai";
import { useAIStore } from "@/store/ai-store";
import { useAgentMemoryStore } from "@/store/agent-memory-store";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import { registry } from "@/core/plugin-system/registry";
import {
  ReActAgent,
  pluginActionToTool,
  type AgentTool,
  type AgentStep,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
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
  const ai = getMToolsAI();
  return registry.getAllActions().map(({ pluginId, pluginName, action }) =>
    pluginActionToTool(pluginId, pluginName, action, ai),
  );
}

function getBuiltinTools(askUser?: AskUserCallback): { tools: AgentTool[]; resetPerRunState: () => void } {
  const confirmHostFallback = async () => true;
  return createBuiltinAgentTools(confirmHostFallback, askUser);
}

export function buildAllTools(askUser?: AskUserCallback): AgentTool[] {
  return [...getPluginTools(), ...getBuiltinTools(askUser).tools];
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
    const ai = getMToolsAI();
    const builtinResult = getBuiltinTools(this.askUser);
    builtinResult.resetPerRunState();
    const allTools = [...getPluginTools(), ...builtinResult.tools];
    const role = options?.role;
    const tools = role ? filterToolsForRole(allTools, role) : allTools;

    const fcCompatibilityKey = buildAgentFCCompatibilityKey(
      useAIStore.getState().config,
    );

    const { _images: contextImages, ...contextForText } = context;
    const images = Array.isArray(contextImages) && contextImages.length > 0
      ? (contextImages as string[])
      : undefined;
    const contextStr = Object.keys(contextForText).length > 0
      ? `\n\n## 前置步骤的输出结果\n${formatContextForAgent(contextForText)}`
      : "";

    const rolePrompt = role?.systemPrompt ?? "";
    const fullQuery = `${task}${contextStr}`;

    const memoryStore = useAgentMemoryStore.getState();
    if (!memoryStore.loaded) {
      try { await memoryStore.load(); } catch { /* ignore */ }
    }
    const userMemory = memoryStore.getMemoriesForPrompt();

    const memoryParts: string[] = [];
    if (rolePrompt) memoryParts.push(`## 角色设定\n${rolePrompt}`);
    if (userMemory) memoryParts.push(`## 用户偏好\n${userMemory}`);
    const combinedMemory = memoryParts.length > 0
      ? "\n\n" + memoryParts.join("\n\n")
      : undefined;

    const collectedSteps: AgentStep[] = [];
    this.abortController = new AbortController();
    const signal = options?.signal
      ? anySignal([options.signal, this.abortController.signal])
      : this.abortController.signal;

    const agent = new ReActAgent(
      ai,
      tools,
      {
        maxIterations: options?.maxIterations ?? role?.maxIterations ?? 10,
        verbose: true,
        fcCompatibilityKey,
        temperature: role?.temperature,
        initialMode: role?.readonly ? "plan" : "execute",
        userMemoryPrompt: combinedMemory,
        dangerousToolPatterns: ["write_file", "run_shell_command", "native_"],
        confirmDangerousAction: this.confirmDangerousAction,
      },
      (step) => {
        collectedSteps.push(step);
        options?.onStep?.(step);
      },
    );

    try {
      const answer = await retryAsync(
        () => agent.run(fullQuery, signal, images),
        { maxRetries: 2, baseDelayMs: 1000, signal },
      );
      return { answer, steps: collectedSteps };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (error === "Aborted" || signal.aborted) {
        return { answer: "", steps: collectedSteps, error: "已取消" };
      }
      return { answer: "", steps: collectedSteps, error };
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
