import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

const PRESERVED_COORDINATION_TOOL_NAMES = new Set([
  "spawn_task",
  "send_message",
  "agents",
  "ask_user",
  "ask_clarification",
  "send_local_media",
]);

function matchesGlob(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
    if (p.startsWith("*")) return name.endsWith(p.slice(1));
    return name === p;
  });
}

function applyToolPolicy(tools: AgentTool[], policy: { allow?: string[]; deny?: string[] }): AgentTool[] {
  const { allow, deny } = policy;
  return tools.filter((t) => {
    if (deny?.length && matchesGlob(t.name, deny)) return false;
    if (!allow?.length && PRESERVED_COORDINATION_TOOL_NAMES.has(t.name)) return true;
    if (allow?.length && !matchesGlob(t.name, allow)) return false;
    return true;
  });
}

/**
 * ToolPolicyMiddleware — applies allow/deny filtering from the actor's ToolPolicy.
 * 仅保留最小协调类工具（spawn_task / send_message / ask_user 等）；
 * session_history、memory_* 这类上下文检索工具仍受 allow/deny 严格约束。
 */
export class ToolPolicyMiddleware implements ActorMiddleware {
  readonly name = "ToolPolicy";

  async apply(ctx: ActorRunContext): Promise<void> {
    if (!ctx.toolPolicy) return;
    ctx.tools = applyToolPolicy(ctx.tools, ctx.toolPolicy);
  }
}
