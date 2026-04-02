import type { ToolDefinition } from '../actor/types';

export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';

export interface ExitPlanModeInput {
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}

export function createExitPlanModeTool(): ToolDefinition {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: 'Exit plan mode and request approval',
    inputSchema: {
      type: 'object',
      properties: {
        allowedPrompts: { type: 'array' },
      },
    },
    handler: async (input: ExitPlanModeInput) => {
      return {
        success: true,
        message: 'Plan submitted for approval',
      };
    },
  };
}
