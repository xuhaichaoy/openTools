import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  buildMemoryPromptBlockMock: vi.fn(() => "PROMPT_BLOCK"),
  extractMemoryCandidatesMock: vi.fn(() => []),
  ingestAutomaticMemorySignalsMock: vi.fn(async () => ({
    confirmed: 0,
    queued: 0,
  })),
  ingestMemoryCandidatesMock: vi.fn(async () => ({
    confirmed: 0,
    queued: 0,
  })),
  recallMemoriesMock: vi.fn(async () => []),
  saveAutomaticStructuredMemoryMock: vi.fn(async () => null),
  semanticRecallMock: vi.fn(async () => []),
  loadMemoryCandidatesMock: vi.fn(async () => undefined),
  conversations: [] as Array<{
    id: string;
    messages: Array<{
      id: string;
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      timestamp: number;
    }>;
  }>,
  agentSessions: [] as Array<{
    id: string;
    createdAt: number;
    lastSessionNotePreview?: string;
    compaction?: { summary?: string; lastCompactedAt?: number };
    tasks: Array<{
      id: string;
      query?: string;
      answer?: string | null;
      createdAt?: number;
      last_finished_at?: number;
    }>;
  }>,
}));

vi.mock("./memory-store", () => ({
  buildMemoryPromptBlock: hoisted.buildMemoryPromptBlockMock,
  extractMemoryCandidates: hoisted.extractMemoryCandidatesMock,
  ingestAutomaticMemorySignals: hoisted.ingestAutomaticMemorySignalsMock,
  ingestMemoryCandidates: hoisted.ingestMemoryCandidatesMock,
  recallMemories: hoisted.recallMemoriesMock,
  saveAutomaticStructuredMemory: hoisted.saveAutomaticStructuredMemoryMock,
  semanticRecall: hoisted.semanticRecallMock,
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => ({
      loadMemoryCandidates: hoisted.loadMemoryCandidatesMock,
      conversations: hoisted.conversations,
    }),
  },
}));

vi.mock("@/store/agent-store", () => ({
  useAgentStore: {
    getState: () => ({
      sessions: hoisted.agentSessions,
    }),
  },
  getVisibleAgentTasks: (session: { tasks: unknown[] }) => session.tasks,
}));

vi.mock("@/store/cluster-store", () => ({
  useClusterStore: {
    getState: () => ({
      sessions: [],
    }),
  },
}));

vi.mock("@/core/agent/actor/actor-transcript", () => ({
  readSessionHistory: vi.fn(async () => []),
}));

import {
  buildAssistantMemoryPromptBundleForQuery,
  queueAssistantMemoryCandidates,
} from "./assistant-memory";

describe("assistant-memory", () => {
  beforeEach(() => {
    hoisted.buildMemoryPromptBlockMock.mockClear();
    hoisted.extractMemoryCandidatesMock.mockClear();
    hoisted.ingestAutomaticMemorySignalsMock.mockClear();
    hoisted.ingestMemoryCandidatesMock.mockClear();
    hoisted.recallMemoriesMock.mockClear();
    hoisted.saveAutomaticStructuredMemoryMock.mockClear();
    hoisted.semanticRecallMock.mockClear();
    hoisted.loadMemoryCandidatesMock.mockClear();
    hoisted.conversations = [];
    hoisted.agentSessions = [];
  });

  it("builds a prompt bundle with ids and readable previews", async () => {
    hoisted.recallMemoriesMock.mockResolvedValueOnce([
      {
        id: "mem-1",
        content: "默认回答语言：中文",
        kind: "preference",
      },
      {
        id: "mem-2",
        content: "用户常驻地：杭州",
        kind: "fact",
      },
    ] as any);

    const bundle = await buildAssistantMemoryPromptBundleForQuery("今天杭州天气怎么样");

    expect(bundle.prompt).toBe("PROMPT_BLOCK");
    expect(bundle.memoryIds).toEqual(["mem-1", "mem-2"]);
    expect(bundle.memoryPreview).toEqual([
      "默认回答语言：中文",
      "用户常驻地：杭州",
    ]);
    expect(bundle.transcriptPrompt).toBe("");
    expect(bundle.transcriptHitCount).toBe(0);
  });

  it("falls back to recent agent transcript snippets when durable memory is insufficient", async () => {
    hoisted.agentSessions = [
      {
        id: "agent-session-1",
        createdAt: 1,
        lastSessionNotePreview: "上一轮已经把天气默认地点改成上海",
        tasks: [
          {
            id: "task-1",
            query: "以后天气默认按上海来回答",
            answer: "已记录并按上海处理天气问题",
            createdAt: 2,
            last_finished_at: 3,
          },
        ],
      },
    ];

    const bundle = await buildAssistantMemoryPromptBundleForQuery("今天天气怎么样", {
      conversationId: "agent-session-1",
      enableTranscriptFallback: true,
    });

    expect(bundle.hitCount).toBe(0);
    expect(bundle.transcriptHitCount).toBeGreaterThanOrEqual(2);
    expect(bundle.transcriptSearched).toBe(true);
    expect(bundle.transcriptPreview.some((item) => item.includes("上海"))).toBe(true);
    expect(bundle.prompt).toContain("当前会话中与本轮问题相关的最近记录片段");
  });

  it("stops after structured memory auto-save succeeds", async () => {
    hoisted.saveAutomaticStructuredMemoryMock.mockResolvedValueOnce({ id: "mem-1" } as any);

    const result = await queueAssistantMemoryCandidates(
      "请记住我以后默认用中文回答，并先给结论",
    );

    expect(result).toBe(1);
    expect(hoisted.ingestMemoryCandidatesMock).not.toHaveBeenCalled();
    expect(hoisted.ingestAutomaticMemorySignalsMock).not.toHaveBeenCalled();
  });

  it("keeps explicit user memories on the fast auto-confirm path", async () => {
    hoisted.extractMemoryCandidatesMock.mockReturnValueOnce([
      {
        id: "memc-1",
        content: "以后默认用中文回答",
        confidence: 0.9,
        created_at: Date.now(),
        kind: "preference",
        scope: "global",
        source: "user",
      },
    ] as any);
    hoisted.ingestMemoryCandidatesMock.mockResolvedValueOnce({
      confirmed: 1,
      queued: 0,
    });

    const result = await queueAssistantMemoryCandidates(
      "以后默认用中文回答",
      { conversationId: "conv-1" },
    );

    expect(result).toBe(1);
    expect(hoisted.ingestMemoryCandidatesMock).toHaveBeenCalledWith(
      expect.any(Array),
      { autoConfirm: true },
    );
    expect(hoisted.ingestAutomaticMemorySignalsMock).not.toHaveBeenCalled();
    expect(hoisted.loadMemoryCandidatesMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to automatic signal ingest for non-explicit durable user messages", async () => {
    hoisted.ingestAutomaticMemorySignalsMock.mockResolvedValueOnce({
      confirmed: 1,
      queued: 2,
    });

    const result = await queueAssistantMemoryCandidates(
      "我长期住在杭州，平时查天气默认按这里来",
      {
        conversationId: "conv-2",
        workspaceId: "/repo-a",
        sourceMode: "dialog",
      },
    );

    expect(result).toBe(3);
    expect(hoisted.ingestAutomaticMemorySignalsMock).toHaveBeenCalledWith(
      "我长期住在杭州，平时查天气默认按这里来",
      {
        conversationId: "conv-2",
        workspaceId: "/repo-a",
        source: "user",
        sourceMode: "dialog",
        evidence: "我长期住在杭州，平时查天气默认按这里来",
        autoConfirm: true,
      },
    );
    expect(hoisted.loadMemoryCandidatesMock).toHaveBeenCalledTimes(1);
  });
});
