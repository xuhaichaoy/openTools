import type { ToolDefinition } from '../actor/types';
import { useSkillStore } from '@/store/skill-store';

export const SKILL_EXECUTE_TOOL_NAME = 'skill_execute';

export interface SkillExecuteInput {
  skill_id: string;
  args?: string;
}

export function createSkillExecuteTool(): ToolDefinition {
  return {
    name: SKILL_EXECUTE_TOOL_NAME,
    description: 'Execute a specific skill by ID with optional arguments',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Skill ID to execute' },
        args: { type: 'string', description: 'Optional arguments for the skill' }
      },
      required: ['skill_id']
    },
    handler: async (input: SkillExecuteInput) => {
      const state = useSkillStore.getState();
      const skill = state.skills.find(s => s.id === input.skill_id);

      if (!skill) {
        throw new Error(`Skill not found: ${input.skill_id}`);
      }

      if (!skill.enabled) {
        throw new Error(`Skill is disabled: ${skill.name}`);
      }

      return {
        skill_id: skill.id,
        skill_name: skill.name,
        system_prompt: skill.systemPrompt,
        args: input.args
      };
    }
  };
}
