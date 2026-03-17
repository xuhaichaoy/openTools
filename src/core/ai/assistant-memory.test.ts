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
    }),
  },
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
