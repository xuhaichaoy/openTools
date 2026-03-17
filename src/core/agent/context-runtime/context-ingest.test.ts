import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";

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

import { persistAgentTurnContextIngest } from "./context-ingest";

describe("context-ingest", () => {
  beforeEach(() => {
    hoisted.saveSessionMemoryNoteMock.mockClear();
  });

  it("persists a concise session note and debug report after a successful turn", async () => {
    const steps: AgentStep[] = [
      {
        type: "action",
        content: "读取设置页",
        toolName: "read_file",
        toolInput: { path: "/repo/app/src/settings.tsx" },
        timestamp: 1,
      },
      {
        type: "observation",
        content: "发现缺少字体缩放",
        timestamp: 2,
      },
    ];

    const result = await persistAgentTurnContextIngest({
      sessionId: "session-1",
      taskId: "task-1",
      query: "继续实现设置页字体缩放",
      steps,
      status: "success",
      durationMs: 18_000,
      answer: "已补充字体缩放和本地存储。",
      workspaceRoot: "/repo/app",
      workspaceReset: false,
      scope: {
        previousWorkspaceRoot: "/repo/app",
        workspaceRoot: "/repo/app",
        attachmentPaths: ["/repo/app/src/settings.tsx"],
        imagePaths: [],
        handoffPaths: [],
        pathHints: ["/repo/app/src/settings.tsx"],
        queryIntent: "coding",
        explicitReset: false,
      },
      continuity: {
        strategy: "inherit_full",
        reason: "same_workspace",
        carrySummary: true,
        carryRecentSteps: true,
        carryFiles: true,
        carryHandoff: true,
      },
      memoryAutoExtractionScheduled: true,
    });

    expect(hoisted.saveSessionMemoryNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("任务：继续实现设置页字体缩放"),
      {
        conversationId: "session-1",
        workspaceId: "/repo/app",
        source: "system",
      },
    );
    expect(result.sessionNoteSaved).toBe(true);
    expect(result.referencedPaths).toEqual(["/repo/app/src/settings.tsx"]);
    expect(result.debugReport.ingest.memoryAutoExtractionScheduled).toBe(true);
    expect(result.debugReport.execution.status).toBe("success");
    expect(result.debugReport.ingest.sessionNotePreview).toContain("字体缩放");
  });
});
