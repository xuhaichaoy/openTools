import type { ToolDefinition } from '../actor/types';
import { useMcpStore } from '@/store/mcp-store';

export const MCP_LIST_TOOLS_TOOL_NAME = 'mcp_list_tools';

export interface McpListToolsInput {
  server_id?: string;
}

export function createMcpListToolsTool(): ToolDefinition {
  return {
    name: MCP_LIST_TOOLS_TOOL_NAME,
    description: 'List all tools available from MCP servers. Optionally filter by server_id.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string', description: 'Optional server ID to filter tools' }
      }
    },
    handler: async (input: McpListToolsInput) => {
      const state = useMcpStore.getState();
      const results: Array<{ server: string; tool: string; description?: string }> = [];

      for (const server of state.servers) {
        if (input.server_id && server.id !== input.server_id) continue;
        if (!server.enabled || state.serverStatus[server.id] !== 'online') continue;

        const tools = state.serverTools[server.id] || [];
        for (const tool of tools) {
          results.push({
            server: server.name,
            tool: tool.name,
            description: tool.description
          });
        }
      }

      return results;
    }
  };
}
