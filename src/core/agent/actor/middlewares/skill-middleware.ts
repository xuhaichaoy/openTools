import { loadAndResolveSkills } from "@/store/skill-store";
import { applySkillToolFilter } from "@/core/agent/skills/skill-resolver";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

/**
 * SkillMiddleware — loads active skills, merges their system prompt,
 * and applies skill-based tool filtering.
 */
export class SkillMiddleware implements ActorMiddleware {
  readonly name = "Skill";

  async apply(ctx: ActorRunContext): Promise<void> {
    const skillCtx = await loadAndResolveSkills(ctx.query, ctx.role.id);

    ctx.skillsPrompt = skillCtx.mergedSystemPrompt || undefined;
    ctx.hasCodingWorkflowSkill = skillCtx.activeSkillIds.includes("builtin-coding-workflow");
    ctx.tools = applySkillToolFilter(ctx.tools, skillCtx.mergedToolFilter);
  }
}
