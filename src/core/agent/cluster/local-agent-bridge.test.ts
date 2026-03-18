import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  reactAgentConfigs: [] as Array<Record<string, unknown>>,
  memoryRecallBundle: {
    prompt: "记住用户常驻上海",
    memories: [],
    memoryIds: ["memory-1"],
    memoryPreview: ["用户常驻上海"],
    searched: true,
    hitCount: 1,
    transcriptPrompt: "最近会话轨迹：继续做天气相关逻辑",
    transcriptPreview: ["Agent：继续做天气相关逻辑"],
    transcriptSearched: true,
    transcriptHitCount: 1,
  },
  buildAgentExecutionContextPlan: vi.fn(async (params: { explicitWorkspaceRoot?: string }) => ({
    scope: {
      previousWorkspaceRoot: undefined,
      workspaceRoot: params.explicitWorkspaceRoot ?? "/repo",
      attachmentPaths: ["/repo/src/page.tsx"],
      imagePaths: [],
      handoffPaths: [],
      pathHints: ["/repo/src/page.tsx"],
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
    sessionContextMessages: [],
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
    bootstrapFilePaths: ["/repo/src/page.tsx"],
    bootstrapHandoffPaths: [],
    effectiveWorkspaceRoot: "/repo",
    promptSourceHandoff: undefined,
    shouldResetInheritedContext: true,
  })),
}));

vi.mock("@/core/ai/mtools-ai", () => ({
  getMToolsAI: () => ({}),
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => ({
      config: {
        system_prompt: "global-system",
        temperature: 0.7,
        agent_max_iterations: 12,
        agent_retry_max: 0,
        agent_retry_backoff_ms: 100,
      },
    }),
  },
}));

vi.mock("@/store/agent-memory-store", () => ({
  useAgentMemoryStore: {
    getState: () => ({
      loaded: true,
      getMemoryRecallBundleAsync: vi.fn(async () => hoisted.memoryRecallBundle),
    }),
  },
}));

vi.mock("@/store/skill-store", () => ({
  loadAndResolveSkills: vi.fn(async () => ({
    mergedSystemPrompt: undefined,
    visibleSkillIds: [],
    mergedToolFilter: undefined,
  })),
}));

vi.mock("@/core/agent/skills/skill-resolver", () => ({
  applySkillToolFilter: (tools: unknown[]) => tools,
}));

vi.mock("@/core/agent/fc-compatibility", () => ({
  buildAgentFCCompatibilityKey: () => "fc-key",
}));

vi.mock("@/core/ai/assistant-config", () => ({
  buildAssistantSupplementalPrompt: () => "GLOBAL_PROMPT",
  filterAssistantToolsByConfig: (tools: unknown[]) => tools,
  shouldAutoSaveAssistantMemory: () => false,
  shouldRecallAssistantMemory: () => true,
}));

vi.mock("@/core/agent/actor/actor-memory", () => ({
  autoExtractMemories: vi.fn(async () => undefined),
}));

vi.mock("@/core/agent/actor/middlewares/knowledge-base-middleware", () => ({
  buildKnowledgeContextMessages: vi.fn(async () => [
    { role: "user" as const, content: "KB_CONTEXT" },
  ]),
}));

vi.mock("@/core/agent/context-runtime", () => ({
  buildAgentExecutionContextPlan: hoisted.buildAgentExecutionContextPlan,
  assembleAgentExecutionContext: hoisted.assembleAgentExecutionContext,
  collectContextPathHints: () => [],
  uniqueContextPaths: (paths: string[]) => [...new Set(paths.filter(Boolean))],
}));

vi.mock("@/core/plugin-system/registry", () => ({
  registry: {
    getAllActions: () => [],
  },
}));

vi.mock("@/plugins/builtin/SmartAgent/core/react-agent", () => ({
  ReActAgent: class {
    constructor(
      _ai: unknown,
      _tools: unknown,
      config: Record<string, unknown>,
    ) {
      hoisted.reactAgentConfigs.push(config);
    }

    async run() {
      return "bridge-done";
    }
  },
  pluginActionToTool: () => ({
    name: "noop",
    description: "noop",
    execute: async () => ({}),
  }),
}));

vi.mock("@/plugins/builtin/SmartAgent/core/agent-task-state", () => ({
  applyIncomingAgentStep: (steps: unknown[]) => steps,
}));

vi.mock("@/plugins/builtin/SmartAgent/core/default-tools", () => ({
  createBuiltinAgentTools: () => ({
    tools: [],
    resetPerRunState: () => undefined,
    notifyToolCalled: () => undefined,
  }),
}));

vi.mock("./agent-role", () => ({
  filterToolsByRole: (names: string[]) => names,
}));

import { LocalAgentBridge } from "./local-agent-bridge";

describe("LocalAgentBridge", () => {
  beforeEach(() => {
    hoisted.reactAgentConfigs.length = 0;
    hoisted.buildAgentExecutionContextPlan.mockClear();
    hoisted.assembleAgentExecutionContext.mockClear();
  });

  it("reuses assembled execution context for cluster agents", async () => {
    const bridge = new LocalAgentBridge("bridge-1");
    const result = await bridge.run(
      "实现设置页",
      {
        _workspaceRoot: "/repo",
        _attachmentPaths: ["/repo/src/page.tsx"],
        summary: "需要结合前置分析继续实现",
      },
      { workspaceRoot: "/repo" },
    );

    expect(hoisted.buildAgentExecutionContextPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitWorkspaceRoot: "/repo",
        attachmentPaths: ["/repo/src/page.tsx"],
      }),
    );
    expect(hoisted.assembleAgentExecutionContext).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("实现设置页"),
        attachmentSummary: "附件 1 项",
        supplementalSystemPrompt: "GLOBAL_PROMPT",
        knowledgeContextMessageCount: 1,
      }),
    );
    expect(hoisted.reactAgentConfigs[0]?.extraSystemPrompt).toBe(
      "ASSEMBLED_PROMPT\n\n## 工作目录\n你的工作目录为: /repo\n执行 shell 命令和文件操作时，请在此目录下进行。",
    );
    expect(hoisted.reactAgentConfigs[0]?.contextMessages).toEqual([
      { role: "user", content: "KB_CONTEXT" },
    ]);
    expect(result.memoryRecallAttempted).toBe(true);
    expect(result.appliedMemoryPreview).toEqual(["用户常驻上海"]);
    expect(result.transcriptRecallAttempted).toBe(true);
    expect(result.transcriptRecallHitCount).toBe(1);
    expect(result.appliedTranscriptPreview).toEqual(["Agent：继续做天气相关逻辑"]);
    expect(result.answer).toBe("bridge-done");
  });
});
