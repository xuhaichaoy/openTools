import { getMToolsAI } from "@/core/ai/mtools-ai";
import { registry } from "@/core/plugin-system/registry";
import {
  pluginActionToTool,
  type AgentTool,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import { createBuiltinAgentTools } from "@/plugins/builtin/SmartAgent/core/default-tools";
import { createActorCommunicationTools } from "../actor-tools";
import { createActorMemoryTools } from "../actor-memory";
import { createCodeSearchTools } from "@/core/code-index/code-search-tools";
import { filterAssistantToolsByConfig } from "@/core/ai/assistant-config";
import { useAIStore } from "@/store/ai-store";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

function getPluginTools(): AgentTool[] {
  const ai = getMToolsAI();
  return registry.getAllActions().map(({ pluginId, pluginName, action }) =>
    pluginActionToTool(pluginId, pluginName, action, ai),
  );
}

function dedupeToolsByName(tools: AgentTool[]): AgentTool[] {
  const deduped = new Map<string, AgentTool>();
  for (const tool of tools) {
    deduped.set(tool.name, tool);
  }
  return [...deduped.values()];
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
      ? createActorCommunicationTools(ctx.actorId, ctx.actorSystem, {
        inheritedImages: ctx.images,
        getInheritedImages: ctx.getCurrentImages,
      })
      : [];
    const memoryTools = createActorMemoryTools(ctx.actorId, ctx.workspace);

    let codeSearchTools: AgentTool[] = [];
    if (ctx.workspace) {
      try {
        const projectId = ctx.workspace.replace(/[^a-zA-Z0-9]/g, "_").slice(-40);
        codeSearchTools = createCodeSearchTools(projectId, ctx.workspace);
      } catch { /* code index not available */ }
    }

    const allTools = dedupeToolsByName([
      ...getPluginTools(),
      ...builtinResult.tools,
      ...ctx.extraTools,
      ...commTools,
      ...memoryTools,
      ...codeSearchTools,
    ]);
    ctx.tools = filterAssistantToolsByConfig(allTools, useAIStore.getState().config);

    ctx.notifyToolCalled = builtinResult.notifyToolCalled;
  }
}
