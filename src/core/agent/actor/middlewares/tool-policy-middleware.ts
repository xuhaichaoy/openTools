import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

const COMM_TOOL_NAMES = new Set([
  "spawn_task", "send_message", "agents",
  "memory_search", "memory_get", "memory_save",
  "session_history", "session_list",
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
    if (COMM_TOOL_NAMES.has(t.name)) return true;
    if (allow?.length && !matchesGlob(t.name, allow)) return false;
    return true;
  });
}

/**
 * ToolPolicyMiddleware — applies allow/deny filtering from the actor's ToolPolicy.
 * Communication tools (spawn_task, send_message, etc.) are always preserved.
 */
export class ToolPolicyMiddleware implements ActorMiddleware {
  readonly name = "ToolPolicy";

  async apply(ctx: ActorRunContext): Promise<void> {
    if (!ctx.toolPolicy) return;
    ctx.tools = applyToolPolicy(ctx.tools, ctx.toolPolicy);
  }
}
