import type { AgentTool, AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { AgentRole } from "@/core/agent/cluster/types";
import type { ActorSystem } from "./actor-system";
import type {
  DialogExecutionMode,
  ExecutionPolicy,
  InboxMessage,
  LoopDetectionConfig,
  ToolPolicy,
  MiddlewareOverrides,
} from "./types";
import type { AskUserCallback, ConfirmDangerousAction } from "./agent-actor";
import type {
  ToolResultReplacementSnapshot,
  ToolResultReplacementState,
} from "@/core/agent/runtime/tool-result-replacement";
import type { RuntimeTranscriptMessage } from "@/core/agent/runtime/transcript-messages";
import { createLogger } from "@/core/logger";

const log = createLogger("ActorMiddleware");

export interface ThreadDataContext {
  sessionId: string;
  rootPath: string;
  workspacePath: string;
  uploadsPath: string;
  outputsPath: string;
}

/**
 * ActorRunContext — shared mutable context flowing through the middleware chain.
 * Each middleware reads and enriches this context before the ReActAgent executes.
 */
export interface ActorRunContext {
  // ── Input (set by caller, read-only for middlewares) ──
  readonly query: string;
  readonly images?: string[];
  readonly getCurrentImages?: () => string[] | undefined;
  readonly onStep?: (step: AgentStep) => void;

  // ── Actor identity (set by caller) ──
  readonly actorId: string;
  readonly role: AgentRole;
  readonly modelOverride?: string;
  readonly maxIterations: number;
  readonly systemPromptOverride?: string;
  readonly workspace?: string;
  readonly contextTokens?: number;
  readonly toolPolicy?: ToolPolicy;
  readonly executionPolicy?: ExecutionPolicy;
  readonly executionMode?: DialogExecutionMode;
  readonly actorSystem?: ActorSystem;
  readonly askUser?: AskUserCallback;
  readonly confirmDangerousAction?: ConfirmDangerousAction;
  readonly extraTools: AgentTool[];
  /** Per-actor middleware override config */
  readonly middlewareOverrides?: MiddlewareOverrides;

  // ── Built by middlewares (mutable) ──
  tools: AgentTool[];
  rolePrompt: string;
  userMemoryPrompt?: string;
  memoryRecallAttempted?: boolean;
  appliedMemoryPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  appliedTranscriptPreview?: string[];
  skillsPrompt?: string;
  hasCodingWorkflowSkill: boolean;
  fcCompatibilityKey: string;
  contextMessages: Array<{ role: "user" | "assistant"; content: string }>;
  transcriptMessages?: RuntimeTranscriptMessage[];
  requireFunctionCalling?: boolean;
  patchDanglingToolCalls?: boolean;
  loopDetectionConfig?: LoopDetectionConfig;
  threadData?: ThreadDataContext;
  toolResultReplacementState?: ToolResultReplacementState;
  toolResultReplacementSnapshot?: ToolResultReplacementSnapshot;

  // ── Callbacks (set by middlewares) ──
  notifyToolCalled?: (toolName: string) => void;
  onConversationMessagesUpdated?: (messages: RuntimeTranscriptMessage[]) => void;
  inboxDrain?: () => Array<Pick<InboxMessage, "id" | "from" | "content" | "expectReply" | "replyTo" | "images">>;

  // ── Retry (set by ModelRetryMiddleware) ──
  retryConfig?: { maxRetries: number; initialDelayMs: number; maxDelayMs: number; backoffMultiplier: number; fallbackModels: string[]; toolTimeoutMs: number };
  withRetry?: <T>(fn: () => Promise<T>, config: ActorRunContext["retryConfig"] & Record<string, unknown>, label?: string) => Promise<T>;
}

/**
 * ActorMiddleware — a single-responsibility unit that prepares part of the run context.
 * Inspired by deer-flow's middleware chain (ThreadData → Uploads → Sandbox → ...).
 */
export interface ActorMiddleware {
  readonly name: string;
  apply(ctx: ActorRunContext): Promise<void>;
}

/**
 * Run the middleware chain sequentially. Each middleware mutates the shared context.
 * Respects `ctx.middlewareOverrides.disable` — skips middlewares whose name is in the list.
 */
export async function runMiddlewareChain(
  middlewares: readonly ActorMiddleware[],
  ctx: ActorRunContext,
): Promise<void> {
  const disableSet = ctx.middlewareOverrides?.disable
    ? new Set(ctx.middlewareOverrides.disable.map((n) => n.toLowerCase()))
    : null;

  for (const mw of middlewares) {
    if (disableSet?.has(mw.name.toLowerCase())) continue;
    const startedAt = Date.now();
    log.info("middleware start", {
      actorId: ctx.actorId,
      actorName: ctx.role.name,
      middleware: mw.name,
    });
    try {
      await mw.apply(ctx);
      log.info("middleware done", {
        actorId: ctx.actorId,
        actorName: ctx.role.name,
        middleware: mw.name,
        elapsedMs: Date.now() - startedAt,
        toolCount: ctx.tools.length,
      });
    } catch (error) {
      log.error("middleware failed", {
        actorId: ctx.actorId,
        actorName: ctx.role.name,
        middleware: mw.name,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
