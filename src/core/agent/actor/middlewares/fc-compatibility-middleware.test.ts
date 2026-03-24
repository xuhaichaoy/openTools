import { describe, expect, it, vi } from "vitest";
import type { ActorRunContext } from "../actor-middleware";
import { FCCompatibilityMiddleware } from "./fc-compatibility-middleware";

const hoisted = vi.hoisted(() => ({
  getResolvedAIConfigForMode: vi.fn(() => ({ source: "team", model: "kimi-k2.5" })),
  buildAgentFCCompatibilityKey: vi.fn(() => "fc-review"),
}));

vi.mock("@/core/ai/resolved-ai-config-store", () => ({
  getResolvedAIConfigForMode: hoisted.getResolvedAIConfigForMode,
}));

vi.mock("@/core/agent/fc-compatibility", () => ({
  buildAgentFCCompatibilityKey: hoisted.buildAgentFCCompatibilityKey,
}));

function createContext(): ActorRunContext {
  return {
    query: "请审查这个 PR",
    actorId: "actor-review",
    role: {
      id: "dialog-agent",
      name: "Reviewer",
      systemPrompt: "system",
      capabilities: [],
    },
    maxIterations: 8,
    actorSystem: { defaultProductMode: "review" } as never,
    extraTools: [],
    tools: [],
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "",
    contextMessages: [],
  };
}

describe("FCCompatibilityMiddleware", () => {
  it("resolves compatibility key from the active review mode config", async () => {
    const ctx = createContext();

    await new FCCompatibilityMiddleware().apply(ctx);

    expect(hoisted.getResolvedAIConfigForMode).toHaveBeenCalledWith("review");
    expect(hoisted.buildAgentFCCompatibilityKey).toHaveBeenCalled();
    expect(ctx.fcCompatibilityKey).toBe("fc-review");
  });
});
