import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/core/ai/types";

const hoisted = vi.hoisted(() => ({
  saveSessionMemoryNoteMock: vi.fn(async (content: string) => ({
    id: "note-1",
    content,
  })),
}));

vi.mock("@/core/ai/memory-store", () => ({
  saveSessionMemoryNote: hoisted.saveSessionMemoryNoteMock,
}));

vi.mock("@/core/ai/local-ai-debug-preferences", () => ({
  isAIDebugFlagEnabled: () => false,
}));

import { persistAskTurnContextIngest } from "./ask-context-ingest";

describe("ask-context-ingest", () => {
  beforeEach(() => {
    hoisted.saveSessionMemoryNoteMock.mockClear();
  });

  it("persists ask turn note and debug report", async () => {
    const conversation: Conversation = {
      id: "ask-1",
      title: "首页修复",
      createdAt: 1,
      workspaceRoot: "/repo/app",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "继续修复首页布局",
          timestamp: 1,
          attachmentPaths: ["/repo/app/src/App.tsx"],
        },
        {
          id: "a1",
          role: "assistant",
          content: "已完成移动端布局修复。",
          timestamp: 2,
          appliedMemoryIds: ["m1"],
        },
      ],
    };

    const result = await persistAskTurnContextIngest({
      conversation,
      query: "继续修复首页布局",
      status: "success",
      durationMs: 12_000,
      answer: "已完成移动端布局修复。",
      attachmentCount: 1,
      imageCount: 0,
      memoryAutoExtractionScheduled: true,
    });

    expect(hoisted.saveSessionMemoryNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("Ask 问题：继续修复首页布局"),
      {
        conversationId: "ask-1",
        workspaceId: "/repo/app",
        source: "system",
      },
    );
    expect(result.sessionNoteSaved).toBe(true);
    expect(result.debugReport.scope.recalledMemoryCount).toBe(1);
    expect(result.debugReport.execution.status).toBe("success");
    expect(result.debugReport.ingest.memoryAutoExtractionScheduled).toBe(true);
  });
});
