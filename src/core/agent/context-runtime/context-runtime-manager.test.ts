import { describe, expect, it } from "vitest";
import { buildAgentExecutionContextPlan } from "./context-runtime-manager";

describe("buildAgentExecutionContextPlan", () => {
  it("does not inherit previous workspace root when continuity forks for an unrelated new task", async () => {
    const plan = await buildAgentExecutionContextPlan({
      query: "新开一个完全无关的任务，从头开始",
      currentSession: {
        id: "session-1",
        title: "旧项目",
        createdAt: 1,
        workspaceRoot: "/workspace/legacy",
        tasks: [
          {
            id: "task-1",
            query: "分析旧项目",
            steps: [],
            answer: "done",
          },
        ],
      },
    });

    expect(plan.continuity.strategy).toBe("fork_session");
    expect(plan.effectiveWorkspaceRoot).toBeUndefined();
    expect(plan.workspaceRootToPersist).toBeUndefined();
  });

  it("keeps an explicit workspace root even when the query asks to restart", async () => {
    const plan = await buildAgentExecutionContextPlan({
      query: "重新开始一个新任务",
      explicitWorkspaceRoot: "/workspace/explicit",
    });

    expect(plan.effectiveWorkspaceRoot).toBe("/workspace/explicit");
    expect(plan.scope.workspaceRoot).toBe("/workspace/explicit");
  });
});
