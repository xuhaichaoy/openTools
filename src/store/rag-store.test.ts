import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen,
}));

vi.mock("@/core/errors", () => ({
  handleError: vi.fn(),
}));

import { useRAGStore, cleanupRAGListener } from "./rag-store";

describe("rag-store search", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  afterEach(() => {
    cleanupRAGListener();
  });

  it("should call rag_search by default", async () => {
    const results = [
      {
        chunk: {
          id: "c1",
          docId: "d1",
          content: "hello",
          index: 0,
          tokenCount: 1,
          metadata: { source: "doc.md" },
        },
        score: 0.9,
      },
    ];

    invoke.mockResolvedValue(results);

    const data = await useRAGStore.getState().search("hello");

    expect(data).toEqual(results);
    expect(invoke).toHaveBeenCalledWith(
      "rag_search",
      expect.objectContaining({ query: "hello" }),
    );
  });

  it("should fallback to rag_keyword_search when rag_search fails", async () => {
    const fallback = [
      {
        chunk: {
          id: "c2",
          docId: "d2",
          content: "fallback",
          index: 0,
          tokenCount: 1,
          metadata: { source: "doc2.md" },
        },
        score: 0.6,
      },
    ];

    invoke
      .mockRejectedValueOnce(new Error("vector unavailable"))
      .mockResolvedValueOnce(fallback);

    const data = await useRAGStore.getState().search("fallback query");

    expect(data).toEqual(fallback);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "rag_search",
      expect.objectContaining({ query: "fallback query" }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "rag_keyword_search",
      expect.objectContaining({ query: "fallback query" }),
    );
  });
});
