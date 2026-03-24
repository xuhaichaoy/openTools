import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getMToolsAI: vi.fn(() => ({ streamWithTools: vi.fn() })),
}));

vi.mock("@/core/ai/mtools-ai", () => ({
  getMToolsAI: hoisted.getMToolsAI,
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => ({
      config: {
        agent_max_iterations: 25,
        temperature: 0.7,
      },
    }),
  },
}));

vi.mock("./middlewares", () => ({
  ClarificationInterrupt: class ClarificationInterrupt extends Error {},
  createDefaultMiddlewares: () => [],
}));

vi.mock("./actor-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./actor-middleware")>();
  return {
    ...actual,
    runMiddlewareChain: vi.fn(async () => undefined),
  };
});

vi.mock("@/plugins/builtin/SmartAgent/core/react-agent", () => ({
  ReActAgent: class MockReActAgent {
    async run() {
      return "done";
    }
  },
  pluginActionToTool: vi.fn(),
}));

import { AgentActor, DIALOG_FULL_ROLE } from "./agent-actor";

describe("AgentActor product mode", () => {
  it("uses review AI config when the actor system is in review mode", async () => {
    const actor = new AgentActor({
      id: "reviewer",
      role: { ...DIALOG_FULL_ROLE, name: "Reviewer" },
    }, {
      actorSystem: {
        defaultProductMode: "review",
        getAll: () => [],
        get: () => null,
        sessionId: "dialog-session-review",
      } as never,
    });

    const result = await (actor as unknown as {
      runWithInbox: (query: string) => Promise<string>;
    }).runWithInbox("帮我 review 这次改动");

    expect(result).toBe("done");
    expect(hoisted.getMToolsAI).toHaveBeenCalledWith("review");
  });
});
