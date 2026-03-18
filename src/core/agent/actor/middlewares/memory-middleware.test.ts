import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorRunContext } from "../actor-middleware";
import { MemoryMiddleware } from "./memory-middleware";

const hoisted = vi.hoisted(() => ({
  shouldRecall: true,
  memoryBundle: {
    prompt: "用户偏好：默认中文回答",
    memories: [],
    memoryIds: ["memory-1"],
    memoryPreview: ["默认中文回答"],
    searched: true,
    hitCount: 1,
    transcriptPrompt: "最近会话轨迹：继续完善设置页",
    transcriptPreview: ["Dialog：继续完善设置页"],
    transcriptSearched: true,
    transcriptHitCount: 1,
  },
}));

vi.mock("@/core/ai/assistant-config", () => ({
  shouldRecallAssistantMemory: () => hoisted.shouldRecall,
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => ({ config: {} }),
  },
}));

vi.mock("@/store/agent-memory-store", () => ({
  useAgentMemoryStore: {
    getState: () => ({
      loaded: true,
      getMemoryRecallBundleAsync: vi.fn(async () => hoisted.memoryBundle),
    }),
  },
}));

function createContext(): ActorRunContext {
  return {
    query: "继续实现设置页",
    actorId: "actor-1",
    role: {
      id: "dialog-agent",
      name: "Agent",
      systemPrompt: "system",
      capabilities: [],
    },
    maxIterations: 8,
    workspace: "/repo",
    actorSystem: { sessionId: "dialog-session-1" } as never,
    extraTools: [],
    tools: [],
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "",
    contextMessages: [],
  };
}

describe("MemoryMiddleware", () => {
  beforeEach(() => {
    hoisted.shouldRecall = true;
  });

  it("stores memory and transcript recall metadata on the actor run context", async () => {
    const ctx = createContext();

    await new MemoryMiddleware().apply(ctx);

    expect(ctx.userMemoryPrompt).toContain("默认中文回答");
    expect(ctx.memoryRecallAttempted).toBe(true);
    expect(ctx.appliedMemoryPreview).toEqual(["默认中文回答"]);
    expect(ctx.transcriptRecallAttempted).toBe(true);
    expect(ctx.transcriptRecallHitCount).toBe(1);
    expect(ctx.appliedTranscriptPreview).toEqual(["Dialog：继续完善设置页"]);
  });

  it("clears recall metadata when memory recall is disabled", async () => {
    const ctx = createContext();
    hoisted.shouldRecall = false;

    await new MemoryMiddleware().apply(ctx);

    expect(ctx.userMemoryPrompt).toBeUndefined();
    expect(ctx.memoryRecallAttempted).toBe(false);
    expect(ctx.appliedMemoryPreview).toEqual([]);
    expect(ctx.transcriptRecallAttempted).toBe(false);
    expect(ctx.transcriptRecallHitCount).toBe(0);
    expect(ctx.appliedTranscriptPreview).toEqual([]);
  });
});
