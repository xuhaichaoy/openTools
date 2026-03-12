import type { AgentTool, AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { AgentRole } from "@/core/agent/cluster/types";
import type { ActorSystem } from "./actor-system";
import type { InboxMessage, ToolPolicy, MiddlewareOverrides } from "./types";
import type { AskUserCallback } from "./agent-actor";

/**
 * ActorRunContext — shared mutable context flowing through the middleware chain.
 * Each middleware reads and enriches this context before the ReActAgent executes.
 */
export interface ActorRunContext {
  // ── Input (set by caller, read-only for middlewares) ──
  readonly query: string;
  readonly images?: string[];
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
  readonly actorSystem?: ActorSystem;
  readonly askUser?: AskUserCallback;
  readonly confirmDangerousAction?: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
  readonly extraTools: AgentTool[];
  /** Per-actor middleware override config */
  readonly middlewareOverrides?: MiddlewareOverrides;

  // ── Built by middlewares (mutable) ──
  tools: AgentTool[];
  rolePrompt: string;
  userMemoryPrompt?: string;
  skillsPrompt?: string;
  hasCodingWorkflowSkill: boolean;
  fcCompatibilityKey: string;
  contextMessages: Array<{ role: "user" | "assistant"; content: string }>;

  // ── Callbacks (set by middlewares) ──
  notifyToolCalled?: (...args: unknown[]) => void;
  inboxDrain?: () => InboxMessage[];
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
    await mw.apply(ctx);
  }
}
