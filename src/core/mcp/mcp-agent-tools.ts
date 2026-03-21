import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { buildMcpToolName, executeMcpTool, useMcpStore } from "@/store/mcp-store";

function buildToolParameters(inputSchema: Record<string, unknown> | undefined): Record<string, { type: string; description?: string }> | undefined {
  if (!inputSchema || typeof inputSchema !== "object") return undefined;

  const schema = inputSchema as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const params: Record<string, { type: string; description?: string }> = {};

  for (const [key, value] of Object.entries(properties)) {
    params[key] = {
      type: value?.type ?? "string",
      description: value?.description,
    };
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

export function getEnabledMcpAgentTools(serverIds?: string[]): AgentTool[] {
  const state = useMcpStore.getState();
  const enabledServerSet = serverIds?.length ? new Set(serverIds) : null;
  const tools: AgentTool[] = [];

  for (const server of state.servers) {
    if (!server.enabled || state.serverStatus[server.id] !== "online") continue;
    if (enabledServerSet && !enabledServerSet.has(server.id)) continue;

    const defs = state.serverTools[server.id] ?? [];
    for (const def of defs) {
      const toolName = buildMcpToolName(server.id, def.name);
      tools.push({
        name: toolName,
        description: `[MCP:${server.name}] ${def.name}${def.description ? ` - ${def.description}` : ""}`,
        parameters: buildToolParameters(def.input_schema),
        // 直接透传 MCP 原始 JSON Schema 给模型，
        // 避免 buildToolParameters 的有损转换丢失 required/enum/default 等关键约束。
        rawParametersSchema: def.input_schema,
        execute: async (args) => {
          const result = await executeMcpTool(toolName, JSON.stringify(args ?? {}));
          if (!result.success) {
            throw new Error(result.result || `MCP 工具调用失败: ${toolName}`);
          }
          return result.result;
        },
      });
    }
  }

  return tools;
}
