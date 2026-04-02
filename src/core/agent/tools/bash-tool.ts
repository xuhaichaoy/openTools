import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../actor/types';

const execAsync = promisify(exec);

export const BASH_TOOL_NAME = 'bash';

export interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export function createBashTool(): ToolDefinition {
  return {
    name: BASH_TOOL_NAME,
    description: 'Execute bash command',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        description: { type: 'string', description: 'Command description' },
        timeout: { type: 'number', description: 'Timeout in ms' },
        run_in_background: { type: 'boolean' },
      },
      required: ['command'],
    },
    handler: async (input: BashInput) => {
      const { stdout, stderr } = await execAsync(input.command, {
        timeout: input.timeout || 120000,
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        stdout: stdout || '',
        stderr: stderr || '',
        success: true,
      };
    },
  };
}
