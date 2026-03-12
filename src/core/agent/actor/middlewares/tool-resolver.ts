import { getMToolsAI } from "@/core/ai/mtools-ai";
import { registry } from "@/core/plugin-system/registry";
import {
  pluginActionToTool,
  type AgentTool,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import { createBuiltinAgentTools } from "@/plugins/builtin/SmartAgent/core/default-tools";
import { createActorCommunicationTools } from "../actor-tools";
import { createActorMemoryTools } from "../actor-memory";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

function getPluginTools(): AgentTool[] {
  const ai = getMToolsAI();
  return registry.getAllActions().map(({ pluginId, pluginName, action }) =>
    pluginActionToTool(pluginId, pluginName, action, ai),
  );
}

/**
 * ToolResolverMiddleware — collects all available tools:
 * builtin, plugin, extra, actor-communication, and memory tools.
 * Sets `ctx.tools` and `ctx.notifyToolCalled`.
 */
export class ToolResolverMiddleware implements ActorMiddleware {
  readonly name = "ToolResolver";

  async apply(ctx: ActorRunContext): Promise<void> {
    const builtinResult = createBuiltinAgentTools(
      async () => true,
      ctx.askUser,
    );
    builtinResult.resetPerRunState();

    const commTools = ctx.actorSystem
      ? createActorCommunicationTools(ctx.actorId, ctx.actorSystem)
      : [];
    const memoryTools = createActorMemoryTools(ctx.actorId);

    ctx.tools = [
      ...getPluginTools(),
      ...builtinResult.tools,
      ...ctx.extraTools,
      ...commTools,
      ...memoryTools,
    ];

    ctx.notifyToolCalled = builtinResult.notifyToolCalled;
  }
}
