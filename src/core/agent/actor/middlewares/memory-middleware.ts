import { useAgentMemoryStore } from "@/store/agent-memory-store";
import { useAIStore } from "@/store/ai-store";
import { shouldRecallAssistantMemory } from "@/core/ai/assistant-config";
import { createLogger } from "@/core/logger";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import type { AssistantMemoryPromptBundle } from "@/core/ai/assistant-memory";

const log = createLogger("MemoryMiddleware");
const MEMORY_BOOTSTRAP_TIMEOUT_MS = 3000;
const MEMORY_RECALL_SOFT_TIMEOUT_MS = 5000;

const EMPTY_MEMORY_BUNDLE: AssistantMemoryPromptBundle = {
  prompt: "",
  memories: [],
  memoryIds: [],
  memoryPreview: [],
  searched: false,
  hitCount: 0,
  transcriptPrompt: "",
  transcriptPreview: [],
  transcriptSearched: false,
  transcriptHitCount: 0,
};

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
) : Promise<{ timedOut: boolean; value: T | null }> {
  return Promise.race<{ timedOut: boolean; value: T | null }>([
    promise.then((value) => ({ timedOut: false, value })),
    new Promise<{ timedOut: boolean; value: null }>((resolve) => {
      setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs);
    }),
  ]);
}

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
        const loadResult = await waitWithTimeout(
          memorySnap.load(),
          MEMORY_BOOTSTRAP_TIMEOUT_MS,
        );
        if (loadResult.timedOut) {
          log.warn("memory store bootstrap timed out; continuing without waiting", {
            actorId: ctx.actorId,
            actorName: ctx.role.name,
          });
        }
        memorySnap = useAgentMemoryStore.getState();
      } catch (err) {
        console.warn("[MemoryMiddleware] store unavailable, proceeding without memory:", err);
      }
    }

    const memoryResult = await waitWithTimeout(
      memorySnap.getMemoryRecallBundleAsync(ctx.query, {
        topK: 6,
        workspaceId: ctx.workspace,
        preferSemantic: true,
        conversationId: ctx.actorSystem?.sessionId,
        timeoutMs: MEMORY_RECALL_SOFT_TIMEOUT_MS,
      }),
      MEMORY_RECALL_SOFT_TIMEOUT_MS,
    );
    if (memoryResult.timedOut) {
      log.warn("memory recall timed out; continuing without memory prompt", {
        actorId: ctx.actorId,
        actorName: ctx.role.name,
        queryPreview: String(ctx.query ?? "").slice(0, 80),
      });
    }
    const resolvedBundle = memoryResult.value ?? EMPTY_MEMORY_BUNDLE;
    ctx.memoryRecallAttempted = resolvedBundle.searched;
    ctx.appliedMemoryPreview = resolvedBundle.memoryPreview.slice(0, 4);
    ctx.transcriptRecallAttempted = resolvedBundle.transcriptSearched;
    ctx.transcriptRecallHitCount = resolvedBundle.transcriptHitCount;
    ctx.appliedTranscriptPreview = resolvedBundle.transcriptPreview.slice(0, 4);
    ctx.userMemoryPrompt = resolvedBundle.prompt
      ? `\n\n## 用户偏好\n${resolvedBundle.prompt}`
      : undefined;
  }
}
