import { getResolvedAIConfigForMode } from "@/core/ai/resolved-ai-config-store";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

/**
 * FCCompatibilityMiddleware — resolves the function-calling compatibility key
 * based on the current AI provider config.
 */
export class FCCompatibilityMiddleware implements ActorMiddleware {
  readonly name = "FCCompatibility";

  async apply(ctx: ActorRunContext): Promise<void> {
    ctx.fcCompatibilityKey = buildAgentFCCompatibilityKey(
      getResolvedAIConfigForMode("dialog"),
    );
  }
}
