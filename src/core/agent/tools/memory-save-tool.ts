import type { ToolDefinition } from '../actor/types';
import { useAgentMemoryStore } from '@/store/agent-memory-store';

export const MEMORY_SAVE_TOOL_NAME = 'memory_save';

export interface MemorySaveInput {
  content: string;
  type: 'preference' | 'fact' | 'goal' | 'constraint' | 'context';
  scope?: 'global' | 'workspace' | 'conversation';
  tags?: string[];
}

export function createMemorySaveTool(): ToolDefinition {
  return {
    name: MEMORY_SAVE_TOOL_NAME,
    description: 'Save important information to long-term memory',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Memory content to save' },
        type: {
          type: 'string',
          enum: ['preference', 'fact', 'goal', 'constraint', 'context'],
          description: 'Type of memory'
        },
        scope: {
          type: 'string',
          enum: ['global', 'workspace', 'conversation'],
          description: 'Memory scope',
          default: 'workspace'
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' }
      },
      required: ['content', 'type']
    },
    handler: async (input: MemorySaveInput) => {
      const store = useAgentMemoryStore.getState();
      const memoryKey = `${input.type}:${input.content.slice(0, 32)}`;
      const category = input.type === "preference"
        ? "preference"
        : input.type === "fact" || input.type === "context"
          ? "fact"
          : "pattern";
      await store.addMemory(
        memoryKey,
        input.content,
        category,
      );

      return { success: true, memory_id: memoryKey };
    }
  };
}
