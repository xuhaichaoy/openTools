import type { ToolDefinition } from '../actor/types';

export const WEB_SEARCH_TOOL_NAME = 'web_search';

export interface WebSearchInput {
  query: string;
}

export function createWebSearchTool(): ToolDefinition {
  return {
    name: WEB_SEARCH_TOOL_NAME,
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    handler: async (input: WebSearchInput) => {
      return {
        results: [],
        message: 'Web search not implemented',
      };
    },
  };
}
