import type { ToolDefinition } from '../actor/types';

export const SLEEP_TOOL_NAME = 'sleep';

export interface SleepInput {
  ms: number;
}

export function createSleepTool(): ToolDefinition {
  return {
    name: SLEEP_TOOL_NAME,
    description: 'Sleep for specified milliseconds',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'number' },
      },
      required: ['ms'],
    },
    handler: async (input: SleepInput) => {
      await new Promise(resolve => setTimeout(resolve, input.ms));
      return { success: true };
    },
  };
}
