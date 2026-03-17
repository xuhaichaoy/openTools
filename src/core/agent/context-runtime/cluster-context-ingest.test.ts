import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterSession } from "@/store/cluster-store";
import type { AgentRole } from "@/core/agent/cluster/types";

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

import { persistClusterTurnContextIngest } from "./cluster-context-ingest";

describe("cluster-context-ingest", () => {
  beforeEach(() => {
    hoisted.saveSessionMemoryNoteMock.mockClear();
  });

  it("persists cluster turn note and debug report", async () => {
    const plannerRole: AgentRole = {
      id: "planner",
      name: "Planner",
      systemPrompt: "plan",
      capabilities: ["planning"],
    };
    const implementerRole: AgentRole = {
      id: "implementer",
      name: "Implementer",
      systemPrompt: "implement",
      capabilities: ["coding"],
    };
    const session: ClusterSession = {
      id: "cluster-1",
      query: "继续拆分首页改造任务",
      mode: "parallel_split",
      workspaceRoot: "/repo/app",
      status: "done",
      instances: [
        { id: "agent-1", role: plannerRole, status: "done", result: "ok", steps: [] },
        { id: "agent-2", role: implementerRole, status: "done", result: "ok", steps: [] },
      ],
      messages: [],
      plan: {
        id: "plan-1",
        mode: "parallel_split",
        steps: [
          { id: "step-1", role: "planner", task: "规划", dependencies: [] },
          { id: "step-2", role: "implementer", task: "实现", dependencies: ["step-1"] },
          { id: "step-3", role: "reviewer", task: "复查", dependencies: ["step-2"] },
        ],
        sharedContext: {},
      },
      result: {
        planId: "plan-1",
        mode: "parallel_split",
        finalAnswer: "已完成任务拆分并给出执行建议。",
        agentInstances: [],
        totalDurationMs: 22_000,
      },
      createdAt: 1,
      contextSnapshot: {
        generatedAt: 1,
        status: "done",
        statusLabel: "已完成",
        imageCount: 0,
        messageCount: 0,
        planStepCount: 3,
        instanceCount: 2,
        runningInstanceCount: 0,
        completedInstanceCount: 2,
        errorInstanceCount: 0,
        modeLabel: "并行分治",
        contextLines: [],
      },
    };

    const result = await persistClusterTurnContextIngest({
      session,
      status: "success",
      durationMs: 22_000,
      answer: "已完成任务拆分并给出执行建议。",
    });

    expect(hoisted.saveSessionMemoryNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("Cluster 任务：继续拆分首页改造任务"),
      {
        conversationId: "cluster-1",
        workspaceId: "/repo/app",
        source: "system",
      },
    );
    expect(result.sessionNoteSaved).toBe(true);
    expect(result.debugReport.planStepCount).toBe(3);
    expect(result.debugReport.execution.status).toBe("success");
    expect(result.debugReport.ingest.sessionNotePreview).toContain("Cluster 任务");
  });
});
