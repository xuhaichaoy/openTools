import { describe, expect, it } from "vitest";

import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorRunContext } from "../actor-middleware";
import { ClarificationInterrupt } from "./clarification-middleware";
import { ToolErrorHandlingMiddleware, isToolFailureResult } from "./tool-error-handling-middleware";

function createContext(tool: AgentTool): ActorRunContext {
  return {
    query: "test",
    actorId: "actor-1",
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
    fcCompatibilityKey: "tool-error-handling-test",
    contextMessages: [],
  } as unknown as ActorRunContext;
}

describe("ToolErrorHandlingMiddleware", () => {
  it("degrades ordinary tool exceptions into structured error results", async () => {
    const ctx = createContext({
      name: "explode",
      description: "explode",
      execute: async () => {
        throw new Error("boom");
      },
    });

    await new ToolErrorHandlingMiddleware().apply(ctx);
    const result = await ctx.tools[0].execute({});

    expect(isToolFailureResult(result)).toBe(true);
    expect(result).toMatchObject({
      handledBy: "ToolErrorHandlingMiddleware",
      toolName: "explode",
      recoverable: true,
    });
    expect((result as { error: string }).error).toContain("boom");
  });

  it("preserves clarification interrupts", async () => {
    const ctx = createContext({
      name: "ask_clarification",
      description: "clarify",
      execute: async () => {
        throw new ClarificationInterrupt("需要补充信息");
      },
    });

    await new ToolErrorHandlingMiddleware().apply(ctx);

    await expect(ctx.tools[0].execute({})).rejects.toBeInstanceOf(ClarificationInterrupt);
  });

  it("preserves wait-for-spawned-tasks control-flow interrupts", async () => {
    const waitInterrupt = new Error("wait_for_spawned_tasks_deferred");
    waitInterrupt.name = "WaitForSpawnedTasksInterrupt";

    const ctx = createContext({
      name: "wait_for_spawned_tasks",
      description: "wait",
      execute: async () => {
        throw waitInterrupt;
      },
    });

    await new ToolErrorHandlingMiddleware().apply(ctx);

    await expect(ctx.tools[0].execute({})).rejects.toMatchObject({
      name: "WaitForSpawnedTasksInterrupt",
    });
  });
});
