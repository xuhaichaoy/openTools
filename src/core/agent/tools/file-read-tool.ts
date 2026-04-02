import * as fs from 'fs/promises';
import type { ToolDefinition } from '../actor/types';

export const FILE_READ_TOOL_NAME = 'read_file';

export interface FileReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export function createFileReadTool(): ToolDefinition {
  return {
    name: FILE_READ_TOOL_NAME,
    description: 'Read file contents',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute file path' },
        offset: { type: 'number', description: 'Line offset' },
        limit: { type: 'number', description: 'Number of lines' },
      },
      required: ['file_path'],
    },
    handler: async (input: FileReadInput) => {
      const content = await fs.readFile(input.file_path, 'utf-8');
      const lines = content.split('\n');

      const start = input.offset || 0;
      const end = input.limit ? start + input.limit : lines.length;

      return lines.slice(start, end).join('\n');
    },
  };
}
