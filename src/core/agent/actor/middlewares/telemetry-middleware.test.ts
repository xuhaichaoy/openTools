import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorRunContext } from "../actor-middleware";
import { TelemetryMiddleware, clearTelemetry, getSessionStats } from "./telemetry-middleware";

function createContext(tool: AgentTool): ActorRunContext {
  return {
    query: "test",
    actorId: "actor-telemetry",
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
    tools: [tool],
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "telemetry-test",
    contextMessages: [],
  } as unknown as ActorRunContext;
}

afterEach(() => {
  clearTelemetry();
});

describe("TelemetryMiddleware", () => {
  it("records structured tool-error payloads as failed calls", async () => {
    const ctx = createContext({
      name: "failing_tool",
      description: "failing tool",
      execute: async () => ({
        error: "tool failed",
      }),
    });

    await new TelemetryMiddleware().apply(ctx);
    await ctx.tools[0].execute({});

    const stat = getSessionStats("actor-telemetry")[0];
    expect(stat?.totalToolCalls).toBe(1);
    expect(stat?.failedCalls).toBe(1);
    expect(stat?.successfulCalls).toBe(0);
  });
});
