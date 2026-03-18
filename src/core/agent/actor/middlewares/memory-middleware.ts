import { useAgentMemoryStore } from "@/store/agent-memory-store";
import { useAIStore } from "@/store/ai-store";
import { shouldRecallAssistantMemory } from "@/core/ai/assistant-config";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

/**
 * MemoryMiddleware — loads persistent user memory (preferences, facts, etc.)
 * and sets `ctx.userMemoryPrompt` for injection into the system prompt.
 */
export class MemoryMiddleware implements ActorMiddleware {
  readonly name = "Memory";

  async apply(ctx: ActorRunContext): Promise<void> {
    if (!shouldRecallAssistantMemory(useAIStore.getState().config)) {
      ctx.userMemoryPrompt = undefined;
      ctx.memoryRecallAttempted = false;
      ctx.appliedMemoryPreview = [];
      ctx.transcriptRecallAttempted = false;
      ctx.transcriptRecallHitCount = 0;
      ctx.appliedTranscriptPreview = [];
      return;
    }

    let memorySnap = useAgentMemoryStore.getState();
    if (!memorySnap.loaded) {
      try {
        await memorySnap.load();
        memorySnap = useAgentMemoryStore.getState();
      } catch (err) {
        console.warn("[MemoryMiddleware] store unavailable, proceeding without memory:", err);
      }
    }

    const memoryBundle = await memorySnap.getMemoryRecallBundleAsync(ctx.query, {
      topK: 6,
      workspaceId: ctx.workspace,
      preferSemantic: true,
      conversationId: ctx.actorSystem?.sessionId,
    });
    ctx.memoryRecallAttempted = memoryBundle.searched;
    ctx.appliedMemoryPreview = memoryBundle.memoryPreview.slice(0, 4);
    ctx.transcriptRecallAttempted = memoryBundle.transcriptSearched;
    ctx.transcriptRecallHitCount = memoryBundle.transcriptHitCount;
    ctx.appliedTranscriptPreview = memoryBundle.transcriptPreview.slice(0, 4);
    ctx.userMemoryPrompt = memoryBundle.prompt
      ? `\n\n## 用户偏好\n${memoryBundle.prompt}`
      : undefined;
  }
}
