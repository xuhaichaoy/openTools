import type { ToolDefinition } from '../actor/types';

export const WEB_FETCH_TOOL_NAME = 'web_fetch';

export interface WebFetchInput {
  url: string;
  prompt: string;
}

export function createWebFetchTool(): ToolDefinition {
  return {
    name: WEB_FETCH_TOOL_NAME,
    description: 'Fetch web content',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['url', 'prompt'],
    },
    handler: async (input: WebFetchInput) => {
      return {
        content: '',
        message: 'Web fetch not implemented',
      };
    },
  };
}
