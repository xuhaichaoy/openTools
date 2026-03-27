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
import { getEnabledMcpAgentTools } from "@/core/mcp/mcp-agent-tools";
import { filterAssistantToolsByConfig } from "@/core/ai/assistant-config";
import { useAIStore } from "@/store/ai-store";
import { ensureMcpServersLoaded } from "@/store/mcp-store";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { createLogger } from "@/core/logger";

const log = createLogger("ToolResolver");

function getPluginTools(mode: "dialog" | "review" = "dialog"): AgentTool[] {
  const ai = getMToolsAI(mode);
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
    log.info("tool resolution start", {
      actorId: ctx.actorId,
      actorName: ctx.role.name,
      queryPreview: String(ctx.query ?? "").slice(0, 80),
      hasWorkspace: Boolean(ctx.workspace),
    });
    const productMode = ctx.actorSystem?.defaultProductMode ?? "dialog";
    const pluginTools = getPluginTools(productMode);
    const builtinResult = createBuiltinAgentTools(
      async () => true,
      ctx.askUser,
      {
        getCurrentQuery: () => ctx.query,
        scheduleClawHubResume: async (resumePrompt) => {
          const { useActorSystemStore } = await import("@/store/actor-system-store");
          useActorSystemStore.getState().enqueueFollowUp({
            content: resumePrompt,
            displayText: resumePrompt,
            routingMode: "smart",
          });
        },
      },
    );
    builtinResult.resetPerRunState();

    const commTools = ctx.actorSystem
      ? createActorCommunicationTools(ctx.actorId, ctx.actorSystem, {
        inheritedImages: ctx.images,
        getInheritedImages: ctx.getCurrentImages,
      })
      : [];
    const memoryTools = createActorMemoryTools(ctx.actorId, ctx.workspace);
    log.info("tool resolution base tools ready", {
      actorId: ctx.actorId,
      pluginToolCount: pluginTools.length,
      builtinToolCount: builtinResult.tools.length,
      extraToolCount: ctx.extraTools.length,
      commToolCount: commTools.length,
      memoryToolCount: memoryTools.length,
    });

    let codeSearchTools: AgentTool[] = [];
    if (ctx.workspace) {
      try {
        const projectId = ctx.workspace.replace(/[^a-zA-Z0-9]/g, "_").slice(-40);
        codeSearchTools = createCodeSearchTools(projectId, ctx.workspace);
      } catch { /* code index not available */ }
    }
    log.info("tool resolution before MCP load", {
      actorId: ctx.actorId,
      codeSearchToolCount: codeSearchTools.length,
    });
    await ensureMcpServersLoaded();
    const mcpTools = getEnabledMcpAgentTools();
    log.info("tool resolution after MCP load", {
      actorId: ctx.actorId,
      mcpToolCount: mcpTools.length,
    });

    const allTools = dedupeToolsByName([
      ...pluginTools,
      ...builtinResult.tools,
      ...ctx.extraTools,
      ...commTools,
      ...memoryTools,
      ...codeSearchTools,
      ...mcpTools,
    ]);
    ctx.tools = filterAssistantToolsByConfig(allTools, useAIStore.getState().config);

    ctx.notifyToolCalled = builtinResult.notifyToolCalled;
    log.info("tool resolution complete", {
      actorId: ctx.actorId,
      dedupedToolCount: allTools.length,
      enabledToolCount: ctx.tools.length,
    });
  }
}
