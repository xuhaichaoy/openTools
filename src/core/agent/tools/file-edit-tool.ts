import * as fs from 'fs/promises';
import type { ToolDefinition } from '../actor/types';

export const FILE_EDIT_TOOL_NAME = 'edit_file';

export interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export function createFileEditTool(): ToolDefinition {
  return {
    name: FILE_EDIT_TOOL_NAME,
    description: 'Edit file by replacing text',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    handler: async (input: FileEditInput) => {
      const content = await fs.readFile(input.file_path, 'utf-8');

      const newContent = input.replace_all
        ? content.replaceAll(input.old_string, input.new_string)
        : content.replace(input.old_string, input.new_string);

      await fs.writeFile(input.file_path, newContent, 'utf-8');
      return { success: true, message: 'File edited' };
    },
  };
}
