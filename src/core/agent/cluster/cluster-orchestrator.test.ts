import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  chatMock: vi.fn(),
  buildAgentExecutionContextPlan: vi.fn(async (params: {
    explicitWorkspaceRoot?: string;
    attachmentPaths?: readonly string[];
  }) => ({
    scope: {
      previousWorkspaceRoot: undefined,
      workspaceRoot: params.explicitWorkspaceRoot ?? "/repo",
      attachmentPaths: [...(params.attachmentPaths ?? [])],
      imagePaths: [],
      handoffPaths: [],
      pathHints: [...(params.attachmentPaths ?? [])],
      queryIntent: "coding" as const,
      explicitReset: false,
    },
    continuity: {
      strategy: "soft_reset" as const,
      reason: "explicit_new_task" as const,
      carrySummary: false,
      carryRecentSteps: false,
      carryFiles: false,
      carryHandoff: false,
    },
    effectiveWorkspaceRoot: params.explicitWorkspaceRoot ?? "/repo",
    workspaceRootToPersist: params.explicitWorkspaceRoot ?? "/repo",
    promptSourceHandoff: undefined,
    shouldResetInheritedContext: true,
  })),
  assembleAgentExecutionContext: vi.fn(async () => ({
    sessionContextMessages: [
      { role: "assistant" as const, content: "CTX_MESSAGE" },
    ],
    bootstrapContext: null,
    promptContextSnapshot: {
      continuityStrategy: "soft_reset",
      continuityReason: "explicit_new_task",
      workspaceReset: true,
      memoryItemCount: 0,
    },
    promptContextPrompt: "## 当前执行上下文",
    extraSystemPrompt: "ASSEMBLED_PROMPT",
    effectiveFiles: [],
    currentTurnFiles: [],
    sessionFiles: [],
    bootstrapFilePaths: [],
    bootstrapHandoffPaths: [],
    effectiveWorkspaceRoot: "/repo",
    promptSourceHandoff: undefined,
    shouldResetInheritedContext: true,
  })),
}));

vi.mock("@/core/ai/mtools-ai", () => ({
  getMToolsAI: () => ({
    chat: hoisted.chatMock,
  }),
  chatDirect: hoisted.chatMock,
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => ({
      config: {
        system_prompt: "global-system",
        protocol: "openai",
        model: "gpt-test",
        agent_retry_max: 0,
        agent_retry_backoff_ms: 100,
      },
    }),
  },
}));

vi.mock("@/core/ai/assistant-config", () => ({
  buildAssistantSupplementalPrompt: () => "GLOBAL_PROMPT",
}));

vi.mock("@/core/agent/context-runtime", () => ({
  buildAgentExecutionContextPlan: hoisted.buildAgentExecutionContextPlan,
  assembleAgentExecutionContext: hoisted.assembleAgentExecutionContext,
  collectContextPathHints: (text?: string) =>
    String(text || "").includes("/repo/src/app.tsx")
      ? ["/repo/src/app.tsx"]
      : [],
}));

vi.mock("@/core/ai/model-capabilities", () => ({
  modelSupportsImageInput: () => true,
}));

import { ClusterOrchestrator } from "./cluster-orchestrator";

describe("ClusterOrchestrator", () => {
  beforeEach(() => {
    hoisted.chatMock.mockReset();
    hoisted.buildAgentExecutionContextPlan.mockClear();
    hoisted.assembleAgentExecutionContext.mockClear();
  });

  it("injects assembled runtime context into planner chat", async () => {
    hoisted.chatMock.mockResolvedValueOnce({
      content: JSON.stringify({
        mode: "parallel_split",
        steps: [
          {
            id: "step_1",
            role: "researcher",
            task: "分析项目",
            dependencies: [],
          },
        ],
      }),
    });

    const orchestrator = new ClusterOrchestrator({ workspaceRoot: "/repo" }) as any;
    orchestrator.setProjectContext("请阅读 /repo/src/app.tsx 后再规划");

    const plan = await orchestrator.planPhase("分析项目");
    const chatCall = hoisted.chatMock.mock.calls[0]?.[0];

    expect(hoisted.buildAgentExecutionContextPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "分析项目",
        explicitWorkspaceRoot: "/repo",
        attachmentPaths: ["/repo/src/app.tsx"],
      }),
    );
    expect(hoisted.assembleAgentExecutionContext).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "分析项目",
        attachmentSummary: "路径线索 1 项",
        systemHint: "请阅读 /repo/src/app.tsx 后再规划",
        supplementalSystemPrompt: "GLOBAL_PROMPT",
      }),
    );
    expect(chatCall.messages[0].content).toContain("ASSEMBLED_PROMPT");
    expect(chatCall.messages[1]).toEqual({
      role: "assistant",
      content: "CTX_MESSAGE",
    });
    expect(chatCall.messages[2].content).toContain("## 项目上下文");
    expect(plan.steps).toHaveLength(1);
  });

  it("injects assembled runtime context into lightweight review", async () => {
    hoisted.chatMock.mockResolvedValueOnce({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "审查通过",
      }),
    });

    const orchestrator = new ClusterOrchestrator({ workspaceRoot: "/repo" }) as any;
    const feedback = await orchestrator.reviewStepLightweight(
      {
        id: "step_1",
        role: "coder",
        task: "实现设置页",
        dependencies: [],
        outputKey: "step_1_result",
      },
      "已修改设置页并完成验证",
    );
    const chatCall = hoisted.chatMock.mock.calls[0]?.[0];

    expect(chatCall.messages[0].content).toContain("ASSEMBLED_PROMPT");
    expect(chatCall.messages[1]).toEqual({
      role: "assistant",
      content: "CTX_MESSAGE",
    });
    expect(chatCall.messages[2].content).toContain("步骤 ID: step_1");
    expect(feedback.passed).toBe(true);
  });

  it("injects assembled runtime context into aggregate chat", async () => {
    hoisted.chatMock.mockResolvedValueOnce({
      content: "最终汇总结果",
    });

    const orchestrator = new ClusterOrchestrator({ workspaceRoot: "/repo" }) as any;
    const messageBus = orchestrator.getMessageBus();
    messageBus.setContext("research_result", "研究完成");
    messageBus.setContext("code_result", "代码已修改");

    const answer = await orchestrator.aggregatePhase("完成一个页面任务", {
      id: "plan-1",
      mode: "parallel_split",
      steps: [
        {
          id: "research",
          role: "researcher",
          task: "研究需求",
          dependencies: [],
          outputKey: "research_result",
        },
        {
          id: "coder",
          role: "coder",
          task: "实现页面",
          dependencies: [],
          outputKey: "code_result",
        },
      ],
      sharedContext: {},
    });
    const chatCall = hoisted.chatMock.mock.calls[0]?.[0];

    expect(chatCall.messages[0].content).toContain("ASSEMBLED_PROMPT");
    expect(chatCall.messages[1]).toEqual({
      role: "assistant",
      content: "CTX_MESSAGE",
    });
    expect(chatCall.messages[2].content).toContain("研究完成");
    expect(chatCall.messages[2].content).toContain("代码已修改");
    expect(answer).toBe("最终汇总结果");
  });
});
