import { describe, expect, it } from "vitest";

import type { ActorRunContext } from "../actor-middleware";
import { LoopDetectionMiddleware } from "./loop-detection-middleware";

function createContext(): ActorRunContext {
  return {
    query: "test",
    actorId: "actor-loop",
    role: {
      id: "role-1",
      name: "Lead",
      systemPrompt: "",
      capabilities: [],
      maxIterations: 10,
      temperature: 0.2,
    },
    maxIterations: 10,
    extraTools: [],
    tools: [],
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "loop-detection-test",
    contextMessages: [],
  } as unknown as ActorRunContext;
}

describe("LoopDetectionMiddleware", () => {
  it("injects runtime loop detection config into the actor context", async () => {
    const ctx = createContext();

    await new LoopDetectionMiddleware({
      repeatThreshold: 2,
      exemptTools: ["custom_safe_tool"],
    }).apply(ctx);

    expect(ctx.loopDetectionConfig).toMatchObject({
      repeatThreshold: 2,
      consecutiveFailureLimit: 3,
      consecutiveSameToolLimit: 3,
    });
    expect(ctx.loopDetectionConfig?.exemptTools).toEqual(
      expect.arrayContaining(["calculate", "custom_safe_tool"]),
    );
  });
});
