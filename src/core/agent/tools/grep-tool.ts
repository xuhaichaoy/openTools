import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../actor/types';

const execAsync = promisify(exec);

export const GREP_TOOL_NAME = 'grep';

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
}

export function createGrepTool(): ToolDefinition {
  return {
    name: GREP_TOOL_NAME,
    description: 'Search file contents',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Directory to search' },
        glob: { type: 'string', description: 'File pattern like *.ts' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      },
      required: ['pattern'],
    },
    handler: async (input: GrepInput) => {
      const cwd = input.path || process.cwd();
      const mode = input.output_mode || 'files_with_matches';

      let cmd = `grep -r "${input.pattern}" ${cwd}`;
      if (input.glob) cmd += ` --include="${input.glob}"`;
      if (mode === 'files_with_matches') cmd += ' -l';
      if (mode === 'count') cmd += ' -c';

      try {
        const { stdout } = await execAsync(cmd);
        return { output: stdout.trim(), success: true };
      } catch {
        return { output: '', success: true };
      }
    },
  };
}
