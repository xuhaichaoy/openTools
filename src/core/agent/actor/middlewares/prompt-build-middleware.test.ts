import { describe, expect, it, vi } from "vitest";
import type { ActorRunContext } from "../actor-middleware";
import { PromptBuildMiddleware } from "./prompt-build-middleware";

const hoisted = vi.hoisted(() => ({
  buildBootstrapContextSnapshot: vi.fn(async (params: {
    workspaceRoot?: string;
  }) => ({
    workspaceRoot: params.workspaceRoot,
    files: [],
    prompt: params.workspaceRoot ? `BOOTSTRAP:${params.workspaceRoot}` : "",
  })),
}));

vi.mock("@/core/ai/bootstrap-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/ai/bootstrap-context")>();
  return {
    ...actual,
    buildBootstrapContextSnapshot: hoisted.buildBootstrapContextSnapshot,
  };
});

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

    expect(hoisted.buildBootstrapContextSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/repo",
      }),
    );
    expect(ctx.rolePrompt).toContain("GLOBAL_PROMPT");
    expect(ctx.rolePrompt).toContain("BOOTSTRAP:/repo");
    expect(ctx.rolePrompt).toContain("你的工作目录为: /repo");
  });
});
