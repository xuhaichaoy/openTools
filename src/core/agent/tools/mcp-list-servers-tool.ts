import type { ToolDefinition } from '../actor/types';
import { useMcpStore } from '@/store/mcp-store';

export const MCP_LIST_SERVERS_TOOL_NAME = 'mcp_list_servers';

export function createMcpListServersTool(): ToolDefinition {
  return {
    name: MCP_LIST_SERVERS_TOOL_NAME,
    description: 'List all available MCP servers and their status',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => {
      const state = useMcpStore.getState();
      return state.servers.map(server => ({
        id: server.id,
        name: server.name,
        enabled: server.enabled,
        status: state.serverStatus[server.id] || 'unknown'
      }));
    }
  };
}
