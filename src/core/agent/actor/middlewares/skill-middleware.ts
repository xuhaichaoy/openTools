import { loadAndResolveSkills } from "@/store/skill-store";
import { applySkillToolFilter } from "@/core/agent/skills/skill-resolver";
import { getEnabledMcpAgentTools } from "@/core/mcp/mcp-agent-tools";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

/**
 * SkillMiddleware — loads active skills, merges their system prompt,
 * and applies skill-based tool filtering.
 */
export class SkillMiddleware implements ActorMiddleware {
  readonly name = "Skill";

  async apply(ctx: ActorRunContext): Promise<void> {
    const skillCtx = await loadAndResolveSkills(ctx.query, ctx.role.id);
    const mcpTools = getEnabledMcpAgentTools(skillCtx.dependencyMcpNames);
    const mergedTools = [...ctx.tools];
    const existingNames = new Set(mergedTools.map((tool) => tool.name));
    for (const tool of mcpTools) {
      if (existingNames.has(tool.name)) continue;
      existingNames.add(tool.name);
      mergedTools.push(tool);
    }

    const toolFilter = skillCtx.mergedToolFilter.include?.length
      ? {
        ...skillCtx.mergedToolFilter,
        include: [...new Set([
          ...skillCtx.mergedToolFilter.include,
          ...skillCtx.dependencyToolNames,
          ...mcpTools.map((tool) => tool.name),
        ])],
      }
      : skillCtx.mergedToolFilter;

    ctx.skillsPrompt = skillCtx.mergedSystemPrompt || undefined;
    ctx.hasCodingWorkflowSkill = skillCtx.visibleSkillIds.includes("builtin-coding-workflow");
    ctx.tools = applySkillToolFilter(mergedTools, toolFilter);
  }
}
