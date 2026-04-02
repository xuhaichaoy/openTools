import type { ToolDefinition } from '../actor/types';

export const ENTER_PLAN_MODE_TOOL_NAME = 'enter_plan_mode';

export interface EnterPlanModeInput {
  initialPlan?: string;
}

export function createEnterPlanModeTool(): ToolDefinition {
  return {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    description: 'Enter plan mode for implementation planning',
    inputSchema: {
      type: 'object',
      properties: {
        initialPlan: { type: 'string' },
      },
    },
    handler: async (input: EnterPlanModeInput) => {
      return {
        success: true,
        message: 'Entered plan mode',
        plan_file: '.claude/plans/current-plan.md',
        initial_plan: input.initialPlan?.trim() || undefined,
      };
    },
  };
}
