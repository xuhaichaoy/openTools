import { describe, expect, it, vi } from "vitest";
import type { ActorRunContext } from "../actor-middleware";
import { PromptBuildMiddleware } from "./prompt-build-middleware";

const hoisted = vi.hoisted(() => ({
  buildAgentExecutionContextPlan: vi.fn(async () => ({
    scope: {
      previousWorkspaceRoot: undefined,
      workspaceRoot: "/repo",
      attachmentPaths: [],
      imagePaths: ["/repo/assets/mock.png"],
      handoffPaths: [],
      pathHints: ["/repo/assets/mock.png"],
      queryIntent: "coding" as const,
      explicitReset: true,
    },
    continuity: {
      strategy: "soft_reset" as const,
      reason: "explicit_new_task" as const,
      carrySummary: false,
      carryRecentSteps: false,
      carryFiles: false,
      carryHandoff: false,
    },
    effectiveWorkspaceRoot: "/repo",
    workspaceRootToPersist: "/repo",
    promptSourceHandoff: undefined,
    shouldResetInheritedContext: true,
  })),
  assembleAgentExecutionContext: vi.fn(async () => ({
    sessionContextMessages: [],
    bootstrapContext: null,
    promptContextSnapshot: {
      continuityStrategy: "soft_reset",
      continuityReason: "explicit_new_task",
      workspaceReset: true,
      memoryItemCount: 0,
    },
    promptContextPrompt: "## 当前执行上下文",
    extraSystemPrompt: "GLOBAL_PROMPT\n\nBOOTSTRAP:/repo\n\n## 当前执行上下文",
    effectiveFiles: [],
    currentTurnFiles: [],
    sessionFiles: [],
    bootstrapFilePaths: ["/repo/assets/mock.png"],
    bootstrapHandoffPaths: [],
    effectiveWorkspaceRoot: "/repo",
    promptSourceHandoff: undefined,
    shouldResetInheritedContext: true,
  })),
}));

vi.mock("@/core/agent/context-runtime", () => ({
  buildAgentExecutionContextPlan: hoisted.buildAgentExecutionContextPlan,
  assembleAgentExecutionContext: hoisted.assembleAgentExecutionContext,
}));

vi.mock("@/core/ai/assistant-config", () => ({
  buildAssistantSupplementalPrompt: () => "GLOBAL_PROMPT",
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => ({
      config: {
        system_prompt: "global-system",
      },
    }),
  },
}));

function createContext(): ActorRunContext {
  return {
    query: "重新开始一个新任务",
    images: ["/repo/assets/mock.png"],
    actorId: "actor-1",
    role: {
      id: "builder",
      name: "Builder",
      systemPrompt: "ROLE_PROMPT",
    } as any,
    maxIterations: 8,
    workspace: "/repo",
    extraTools: [],
    tools: [],
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "",
    contextMessages: [],
  } as ActorRunContext;
}

describe("PromptBuildMiddleware", () => {
  it("keeps explicit workspace-root bootstrap even when query asks to restart", async () => {
    const ctx = createContext();

    await new PromptBuildMiddleware().apply(ctx);

    expect(hoisted.buildAgentExecutionContextPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitWorkspaceRoot: "/repo",
        query: "重新开始一个新任务",
      }),
    );
    expect(hoisted.assembleAgentExecutionContext).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "重新开始一个新任务",
        supplementalSystemPrompt: "GLOBAL_PROMPT",
      }),
    );
    expect(ctx.rolePrompt).toContain("GLOBAL_PROMPT");
    expect(ctx.rolePrompt).toContain("BOOTSTRAP:/repo");
    expect(ctx.rolePrompt).toContain("## 当前执行上下文");
    expect(ctx.rolePrompt).toContain("你的工作目录为: /repo");
  });

  it("summarizes the active contract and avoids mandatory immediate wait wording", async () => {
    const ctx = createContext();
    ctx.actorSystem = {
      size: 2,
      getAll: () => [
        { id: "actor-1", role: { name: "Builder" } },
        { id: "actor-2", role: { name: "Reviewer" } },
      ],
      getCoordinator: () => ({ id: "actor-1" }),
      getActiveExecutionContract: () => ({
        contractId: "contract-1",
        surface: "local_dialog",
        executionStrategy: "coordinator",
        summary: "Builder 负责统筹，Reviewer 做独立审查",
        inputHash: "input-hash",
        actorRosterHash: "roster-hash",
        initialRecipientActorIds: ["actor-1"],
        participantActorIds: ["actor-1", "actor-2"],
        allowedMessagePairs: [],
        allowedSpawnPairs: [],
        plannedDelegations: [
          {
            id: "delegation-1",
            targetActorId: "actor-2",
            targetActorName: "Reviewer",
            task: "独立审查本轮改动",
            label: "独立审查",
          },
        ],
        approvedAt: 1,
        state: "active" as const,
      }),
    } as ActorRunContext["actorSystem"];

    await new PromptBuildMiddleware().apply(ctx);

    expect(ctx.rolePrompt).toContain("## 当前执行契约");
    expect(ctx.rolePrompt).toContain("独立审查 -> Reviewer");
    expect(ctx.rolePrompt).toContain("已批准建议委派只是许可与建议");
    expect(ctx.rolePrompt).toContain("当你的下一步明确依赖子任务结果时");
    expect(ctx.rolePrompt).not.toContain("务必立刻调用 `wait_for_spawned_tasks`");
    expect(ctx.rolePrompt).not.toContain("请**必须调用 `wait_for_spawned_tasks`");
  });
});
