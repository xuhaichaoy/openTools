import {
  appendMemoryCandidates,
  buildMemoryPromptBlock,
  extractMemoryCandidates,
  recallMemories,
  semanticRecall,
  type AIMemoryCandidate,
  type AIMemoryCandidateMode,
  type AIMemoryItem,
} from "./memory-store";

export interface AssistantMemoryRecallOptions {
  conversationId?: string;
  workspaceId?: string;
  topK?: number;
  timeoutMs?: number;
  preferSemantic?: boolean;
}

async function syncAssistantMemoryCandidateStore(): Promise<void> {
  try {
    const { useAIStore } = await import("@/store/ai-store");
    await useAIStore.getState().loadMemoryCandidates().catch(() => undefined);
  } catch {
    // Best-effort only: memory UI state is not critical for the caller.
  }
}

export async function appendAssistantMemoryCandidates(
  candidates: AIMemoryCandidate[],
): Promise<number> {
  const validCandidates = candidates.filter((candidate) =>
    String(candidate.content || "").trim(),
  );
  if (validCandidates.length === 0) return 0;

  await appendMemoryCandidates(validCandidates);
  await syncAssistantMemoryCandidateStore();
  return validCandidates.length;
}

export async function queueAssistantMemoryCandidates(
  text: string,
  opts?: { conversationId?: string; workspaceId?: string; sourceMode?: AIMemoryCandidateMode },
): Promise<number> {
  const normalized = String(text || "").trim();
  if (!normalized) return 0;

  const candidates = extractMemoryCandidates(normalized, {
    conversationId: opts?.conversationId,
    workspaceId: opts?.workspaceId,
    source: "user",
    sourceMode: opts?.sourceMode ?? "ask",
    evidence: normalized,
  });
  if (candidates.length === 0) return 0;

  return appendAssistantMemoryCandidates(candidates);
}

async function recallAssistantMemoriesInternal(
  query: string,
  opts?: AssistantMemoryRecallOptions,
): Promise<AIMemoryItem[]> {
  const topK = opts?.topK ?? 6;
  const recallOpts = {
    conversationId: opts?.conversationId,
    workspaceId: opts?.workspaceId,
    topK,
  };

  if (opts?.preferSemantic) {
    try {
      return await semanticRecall(query, recallOpts);
    } catch {
      return recallMemories(query, recallOpts);
    }
  }

  return recallMemories(query, recallOpts);
}

export async function recallAssistantMemories(
  query: string,
  opts?: AssistantMemoryRecallOptions,
): Promise<AIMemoryItem[]> {
  const timeoutMs = opts?.timeoutMs ?? 0;
  if (timeoutMs <= 0) {
    return recallAssistantMemoriesInternal(query, opts);
  }

  const recalled = await Promise.race([
    recallAssistantMemoriesInternal(query, opts),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  return recalled ?? [];
}

export async function buildAssistantMemoryPromptForQuery(
  query: string,
  opts?: AssistantMemoryRecallOptions,
): Promise<string> {
  const recalled = await recallAssistantMemories(query, opts);
  return buildMemoryPromptBlock(recalled);
}
