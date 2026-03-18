import {
  buildMemoryPromptBlock,
  extractMemoryCandidates,
  ingestAutomaticMemorySignals,
  ingestMemoryCandidates,
  recallMemories,
  saveAutomaticStructuredMemory,
  semanticRecall,
  type AIMemoryCandidate,
  type AIMemoryCandidateMode,
  type AIMemoryItem,
} from "./memory-store";
import { summarizeAISessionRuntimeText } from "./ai-session-runtime";

export interface AssistantMemoryRecallOptions {
  conversationId?: string;
  workspaceId?: string;
  topK?: number;
  timeoutMs?: number;
  preferSemantic?: boolean;
  enableTranscriptFallback?: boolean;
  transcriptTopK?: number;
}

export interface AssistantMemoryPromptBundle {
  prompt: string;
  memories: AIMemoryItem[];
  memoryIds: string[];
  memoryPreview: string[];
  searched: boolean;
  hitCount: number;
  transcriptPrompt: string;
  transcriptPreview: string[];
  transcriptSearched: boolean;
  transcriptHitCount: number;
}

interface AssistantTranscriptCandidate {
  id: string;
  source: "ask" | "agent" | "cluster" | "dialog";
  content: string;
  timestamp: number;
}

interface AssistantTranscriptRecallResult {
  prompt: string;
  preview: string[];
  searched: boolean;
  hitCount: number;
}

const TRANSCRIPT_SOURCE_LABELS: Record<AssistantTranscriptCandidate["source"], string> = {
  ask: "Ask",
  agent: "Agent",
  cluster: "Cluster",
  dialog: "Dialog",
};

const TRANSCRIPT_FALLBACK_QUERY_HINTS =
  /(继续|接着|刚才|刚刚|前面|上次|之前|这个|那个|上述|当前进度|为什么|哪里|哪一步|还差什么|你刚才|上文|本轮|本次|这个任务|这个项目|这个页面)/;

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

  const result = await ingestMemoryCandidates(validCandidates, {
    autoConfirm: false,
  });
  await syncAssistantMemoryCandidateStore();
  return result.confirmed + result.queued;
}

export async function queueAssistantMemoryCandidates(
  text: string,
  opts?: { conversationId?: string; workspaceId?: string; sourceMode?: AIMemoryCandidateMode },
): Promise<number> {
  const normalized = String(text || "").trim();
  if (!normalized) return 0;

  const autoSaved = await saveAutomaticStructuredMemory(normalized, {
    conversationId: opts?.conversationId,
    workspaceId: opts?.workspaceId,
  });
  if (autoSaved) {
    return 1;
  }

  const explicitCandidates = extractMemoryCandidates(normalized, {
    conversationId: opts?.conversationId,
    workspaceId: opts?.workspaceId,
    source: "user",
    sourceMode: opts?.sourceMode ?? "ask",
    evidence: normalized,
  });
  if (explicitCandidates.length > 0) {
    const result = await ingestMemoryCandidates(explicitCandidates, {
      autoConfirm: true,
    });
    await syncAssistantMemoryCandidateStore();
    return result.confirmed + result.queued;
  }

  const result = await ingestAutomaticMemorySignals(normalized, {
    conversationId: opts?.conversationId,
    workspaceId: opts?.workspaceId,
    source: "user",
    sourceMode: opts?.sourceMode ?? "ask",
    evidence: normalized,
    autoConfirm: true,
  });
  await syncAssistantMemoryCandidateStore();
  return result.confirmed + result.queued;
}

function normalizeSearchText(input: string): string {
  return String(input || "").trim().toLowerCase();
}

function buildSearchTerms(input: string): string[] {
  const normalized = normalizeSearchText(input);
  const alphaNumericParts = normalized
    .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
    .split(/\s+/)
    .filter((part) => part.length >= 2);

  const cjkJoined = normalized.replace(/[^\u4e00-\u9fa5]/g, "");
  const cjkNgrams: string[] = [];
  for (let n = 2; n <= 3; n += 1) {
    for (let i = 0; i <= cjkJoined.length - n; i += 1) {
      cjkNgrams.push(cjkJoined.slice(i, i + n));
    }
  }

  return [...new Set([...alphaNumericParts, ...cjkNgrams])];
}

function compactTranscriptContent(content: string, maxLength = 180): string {
  return summarizeAISessionRuntimeText(content, maxLength) || String(content || "").trim();
}

function buildTranscriptPreview(
  source: AssistantTranscriptCandidate["source"],
  content: string,
): string {
  return `${TRANSCRIPT_SOURCE_LABELS[source]}：${compactTranscriptContent(content, 72)}`;
}

function buildTranscriptPromptBlock(
  items: readonly AssistantTranscriptCandidate[],
): string {
  if (items.length === 0) return "";
  return [
    "以下是当前会话中与本轮问题相关的最近记录片段。它们优先用于补足同一会话内的连续性，不等同于长期记忆：",
    ...items.map((item) => `- [${TRANSCRIPT_SOURCE_LABELS[item.source]}] ${compactTranscriptContent(item.content, 200)}`),
  ].join("\n");
}

function scoreTranscriptCandidate(
  candidate: AssistantTranscriptCandidate,
  queryTerms: readonly string[],
  normalizedQuery: string,
): number {
  const candidateText = normalizeSearchText(candidate.content);
  if (!candidateText) return -1;
  if (!queryTerms.length) return -1;

  const hitCount = queryTerms.filter((term) => candidateText.includes(term)).length;
  const overlapScore = hitCount / queryTerms.length;
  const hitScore = Math.min(0.42, hitCount * 0.18);
  const exactScore = normalizedQuery && candidateText.includes(normalizedQuery) ? 0.22 : 0;
  const recencyScore = candidate.timestamp > 0
    ? Math.min(0.12, 0.12 / (1 + Math.max(0, Date.now() - candidate.timestamp) / 3_600_000))
    : 0;

  return overlapScore * 0.42 + hitScore + exactScore + recencyScore;
}

async function collectAskTranscriptCandidates(
  conversationId: string,
): Promise<AssistantTranscriptCandidate[]> {
  try {
    const { useAIStore } = await import("@/store/ai-store");
    const conversation = useAIStore.getState().conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) return [];
    return conversation.messages
      .filter((message) =>
        (message.role === "user" || message.role === "assistant")
        && typeof message.content === "string"
        && message.content.trim().length > 0,
      )
      .slice(-24)
      .map((message) => ({
        id: `ask:${message.id}`,
        source: "ask" as const,
        content:
          message.role === "user"
            ? `用户提问：${message.content}`
            : `助手回复：${message.content}`,
        timestamp: message.timestamp,
      }));
  } catch {
    return [];
  }
}

async function collectAgentTranscriptCandidates(
  conversationId: string,
): Promise<AssistantTranscriptCandidate[]> {
  try {
    const { useAgentStore, getVisibleAgentTasks } = await import("@/store/agent-store");
    const session = useAgentStore.getState().sessions.find((item) => item.id === conversationId);
    if (!session) return [];
    const candidates: AssistantTranscriptCandidate[] = [];

    if (session.compaction?.summary?.trim()) {
      candidates.push({
        id: `agent:${session.id}:compaction`,
        source: "agent",
        content: `历史摘要：${session.compaction.summary}`,
        timestamp: session.compaction.lastCompactedAt ?? session.createdAt,
      });
    }
    if (session.lastSessionNotePreview?.trim()) {
      candidates.push({
        id: `agent:${session.id}:note`,
        source: "agent",
        content: `最近会话笔记：${session.lastSessionNotePreview}`,
        timestamp: session.lastContextRuntimeReport?.generatedAt ?? session.createdAt,
      });
    }

    for (const task of getVisibleAgentTasks(session).slice(-10)) {
      if (task.query?.trim()) {
        candidates.push({
          id: `agent:${task.id}:query`,
          source: "agent",
          content: `用户任务：${task.query}`,
          timestamp: task.createdAt ?? session.createdAt,
        });
      }
      if (task.answer?.trim()) {
        candidates.push({
          id: `agent:${task.id}:answer`,
          source: "agent",
          content: `任务结果：${task.answer}`,
          timestamp: task.last_finished_at ?? task.createdAt ?? session.createdAt,
        });
      }
    }

    return candidates;
  } catch {
    return [];
  }
}

async function collectClusterTranscriptCandidates(
  conversationId: string,
): Promise<AssistantTranscriptCandidate[]> {
  try {
    const { useClusterStore } = await import("@/store/cluster-store");
    const session = useClusterStore.getState().sessions.find((item) => item.id === conversationId);
    if (!session) return [];
    const candidates: AssistantTranscriptCandidate[] = [];
    if (session.query?.trim()) {
      candidates.push({
        id: `cluster:${session.id}:query`,
        source: "cluster",
        content: `Cluster 任务：${session.query}`,
        timestamp: session.createdAt,
      });
    }
    if (session.result?.finalAnswer?.trim()) {
      candidates.push({
        id: `cluster:${session.id}:answer`,
        source: "cluster",
        content: `Cluster 结果：${session.result.finalAnswer}`,
        timestamp: session.finishedAt ?? session.createdAt,
      });
    }
    if (session.lastSessionNotePreview?.trim()) {
      candidates.push({
        id: `cluster:${session.id}:note`,
        source: "cluster",
        content: `Cluster 会话笔记：${session.lastSessionNotePreview}`,
        timestamp: session.lastContextRuntimeReport?.generatedAt ?? session.createdAt,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

async function collectDialogTranscriptCandidates(
  conversationId: string,
): Promise<AssistantTranscriptCandidate[]> {
  try {
    const { readSessionHistory } = await import("@/core/agent/actor/actor-transcript");
    const entries = await readSessionHistory(conversationId, {
      limit: 40,
      types: ["message", "announce"],
    });
    return entries.flatMap((entry) => {
      if (entry.type === "message" && typeof entry.data.content === "string") {
        return [{
          id: `dialog:${entry.timestamp}:message`,
          source: "dialog" as const,
          content: String(entry.data.content),
          timestamp: entry.timestamp,
        }];
      }
      if (entry.type === "announce") {
        const result = typeof entry.data.result === "string" ? entry.data.result : "";
        const error = typeof entry.data.error === "string" ? entry.data.error : "";
        const content = result || error;
        if (content.trim()) {
          return [{
            id: `dialog:${entry.timestamp}:announce`,
            source: "dialog" as const,
            content,
            timestamp: entry.timestamp,
          }];
        }
      }
      return [];
    });
  } catch {
    return [];
  }
}

async function recallAssistantTranscriptFallback(
  query: string,
  opts?: AssistantMemoryRecallOptions,
): Promise<AssistantTranscriptRecallResult> {
  const normalizedQuery = String(query || "").trim();
  const conversationId = opts?.conversationId?.trim();
  if (!normalizedQuery || !conversationId || opts?.enableTranscriptFallback !== true) {
    return {
      prompt: "",
      preview: [],
      searched: false,
      hitCount: 0,
    };
  }

  const candidates = [
    ...(await collectAskTranscriptCandidates(conversationId)),
    ...(await collectAgentTranscriptCandidates(conversationId)),
    ...(await collectClusterTranscriptCandidates(conversationId)),
    ...(await collectDialogTranscriptCandidates(conversationId)),
  ];
  const dedupedCandidates = [...new Map(
    candidates
      .filter((item) => item.content.trim().length > 0)
      .map((item) => [`${item.source}:${normalizeSearchText(item.content)}`, item]),
  ).values()];
  const queryTerms = buildSearchTerms(normalizedQuery);
  const topK = Math.max(1, Math.min(4, opts?.transcriptTopK ?? 3));
  const ranked = dedupedCandidates
    .map((candidate) => ({
      candidate,
      score: scoreTranscriptCandidate(candidate, queryTerms, normalizeSearchText(normalizedQuery)),
    }))
    .filter(({ score }) => score >= 0.16)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.candidate.timestamp - a.candidate.timestamp;
    })
    .slice(0, topK)
    .map(({ candidate }) => candidate);

  return {
    prompt: buildTranscriptPromptBlock(ranked),
    preview: ranked.map((item) => buildTranscriptPreview(item.source, item.content)),
    searched: true,
    hitCount: ranked.length,
  };
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
  const bundle = await buildAssistantMemoryPromptBundleForQuery(query, opts);
  return bundle.prompt;
}

export async function buildAssistantMemoryPromptBundleForQuery(
  query: string,
  opts?: AssistantMemoryRecallOptions,
): Promise<AssistantMemoryPromptBundle> {
  const normalizedQuery = String(query || "").trim();
  const recalled = normalizedQuery
    ? await recallAssistantMemories(normalizedQuery, opts)
    : [];
  const transcriptRecallShouldRun =
    normalizedQuery.length > 0
    && opts?.enableTranscriptFallback === true
    && !!opts?.conversationId
    && (
      recalled.length === 0
      || (recalled.length < 2 && TRANSCRIPT_FALLBACK_QUERY_HINTS.test(normalizedQuery))
    );
  const transcriptRecall = transcriptRecallShouldRun
    ? await recallAssistantTranscriptFallback(normalizedQuery, opts)
    : {
        prompt: "",
        preview: [],
        searched: false,
        hitCount: 0,
      };
  const memoryPrompt = buildMemoryPromptBlock(recalled);
  return {
    prompt: [memoryPrompt, transcriptRecall.prompt].filter(Boolean).join("\n\n"),
    memories: recalled,
    memoryIds: recalled.map((memory) => memory.id),
    memoryPreview: recalled
      .slice(0, 3)
      .map((memory) => summarizeAISessionRuntimeText(memory.content, 60) || memory.content),
    searched: normalizedQuery.length > 0,
    hitCount: recalled.length,
    transcriptPrompt: transcriptRecall.prompt,
    transcriptPreview: transcriptRecall.preview,
    transcriptSearched: transcriptRecall.searched,
    transcriptHitCount: transcriptRecall.hitCount,
  };
}
