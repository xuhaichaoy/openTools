import * as fs from 'fs/promises';
import type { ToolDefinition } from '../actor/types';

export const FILE_WRITE_TOOL_NAME = 'write_file';

export interface FileWriteInput {
  file_path: string;
  content: string;
}

export function createFileWriteTool(): ToolDefinition {
  return {
    name: FILE_WRITE_TOOL_NAME,
    description: 'Write content to file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['file_path', 'content'],
    },
    handler: async (input: FileWriteInput) => {
      await fs.writeFile(input.file_path, input.content, 'utf-8');
      return { success: true, message: `File written: ${input.file_path}` };
    },
  };
}
