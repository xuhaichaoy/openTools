import { useAgentMemoryStore } from "@/store/agent-memory-store";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

/**
 * MemoryMiddleware — loads persistent user memory (preferences, facts, etc.)
 * and sets `ctx.userMemoryPrompt` for injection into the system prompt.
 */
export class MemoryMiddleware implements ActorMiddleware {
  readonly name = "Memory";

  async apply(ctx: ActorRunContext): Promise<void> {
    let memorySnap = useAgentMemoryStore.getState();
    if (!memorySnap.loaded) {
      try {
        await memorySnap.load();
        memorySnap = useAgentMemoryStore.getState();
      } catch (err) {
        console.warn("[MemoryMiddleware] store unavailable, proceeding without memory:", err);
      }
    }

    // Use async version to ensure fresh memories on first call
    const userMemory = await memorySnap.getMemoriesForPromptAsync();
    ctx.userMemoryPrompt = userMemory
      ? `\n\n## 用户偏好\n${userMemory}`
      : undefined;
  }
}
