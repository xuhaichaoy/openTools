import * as fs from 'fs/promises';
import type { ToolDefinition } from '../actor/types';

export const TODO_WRITE_TOOL_NAME = 'todo_write';

export interface TodoWriteInput {
  content: string;
}

export function createTodoWriteTool(): ToolDefinition {
  return {
    name: TODO_WRITE_TOOL_NAME,
    description: 'Write TODO list',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
    },
    handler: async (input: TodoWriteInput) => {
      const todoPath = '.claude/todo.md';
      await fs.writeFile(todoPath, input.content, 'utf-8');
      return { success: true, path: todoPath };
    },
  };
}
