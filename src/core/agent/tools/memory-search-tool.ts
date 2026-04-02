import type { ToolDefinition } from '../actor/types';
import { useAgentMemoryStore } from '@/store/agent-memory-store';

export const MEMORY_SEARCH_TOOL_NAME = 'memory_search';

export interface MemorySearchInput {
  query: string;
  limit?: number;
  type?: string;
}

export function createMemorySearchTool(): ToolDefinition {
  return {
    name: MEMORY_SEARCH_TOOL_NAME,
    description: 'Search long-term memory for relevant information',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results', default: 5 },
        type: { type: 'string', description: 'Filter by memory type' }
      },
      required: ['query']
    },
    handler: async (input: MemorySearchInput) => {
      const store = useAgentMemoryStore.getState();
      const bundle = await store.getMemoryRecallBundleAsync(input.query, {
        topK: input.limit || 5,
        preferSemantic: true
      });

      return {
        found: bundle.hitCount,
        memories: bundle.memories.map(m => ({
          content: m.content,
          type: m.kind,
          created: m.created_at
        }))
      };
    }
  };
}
