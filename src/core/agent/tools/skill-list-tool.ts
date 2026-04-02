import type { ToolDefinition } from '../actor/types';
import { useSkillStore } from '@/store/skill-store';

export const SKILL_LIST_TOOL_NAME = 'skill_list';

export function createSkillListTool(): ToolDefinition {
  return {
    name: SKILL_LIST_TOOL_NAME,
    description: 'List all available skills and their status',
    inputSchema: {
      type: 'object',
      properties: {
        enabled_only: { type: 'boolean', description: 'Only show enabled skills', default: true }
      }
    },
    handler: async (input: { enabled_only?: boolean }) => {
      const state = useSkillStore.getState();
      const skills = input.enabled_only
        ? state.skills.filter(s => s.enabled)
        : state.skills;

      return skills.map(skill => ({
        id: skill.id,
        name: skill.name,
        category: skill.category,
        enabled: skill.enabled,
        autoActivate: skill.autoActivate,
        description: skill.description
      }));
    }
  };
}
