import type { ToolDefinition } from '../actor/types';
import { executeMcpTool, buildMcpToolName } from '@/store/mcp-store';

export const MCP_CALL_TOOL_NAME = 'mcp_call_tool';

export interface McpCallToolInput {
  server_id: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
}

export function createMcpCallTool(): ToolDefinition {
  return {
    name: MCP_CALL_TOOL_NAME,
    description: 'Call a tool from an MCP server',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string', description: 'MCP server ID' },
        tool_name: { type: 'string', description: 'Tool name to call' },
        arguments: { type: 'object', description: 'Tool arguments as JSON object' }
      },
      required: ['server_id', 'tool_name']
    },
    handler: async (input: McpCallToolInput) => {
      const fullToolName = buildMcpToolName(input.server_id, input.tool_name);
      const argsJson = JSON.stringify(input.arguments || {});
      const result = await executeMcpTool(fullToolName, argsJson);

      if (!result.success) {
        throw new Error(result.result || `MCP tool call failed: ${fullToolName}`);
      }

      return result.result;
    }
  };
}
