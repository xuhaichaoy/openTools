import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getMToolsAI: vi.fn(() => ({ streamWithTools: vi.fn() })),
  visibleToolNames: [] as string[],
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

  const matchesGlob = (name: string, patterns: string[]) =>
    patterns.some((pattern) => {
      if (pattern === "*") return true;
      if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
      if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
      return name === pattern;
    });

  return {
    ...actual,
    runMiddlewareChain: vi.fn(async (_middlewares, ctx) => {
      const tools = [
        { name: "read_document", description: "", execute: vi.fn(async () => "") },
        { name: "spawn_task", description: "", execute: vi.fn(async () => "") },
        { name: "wait_for_spawned_tasks", description: "", execute: vi.fn(async () => "") },
        { name: "export_spreadsheet", description: "", execute: vi.fn(async () => "") },
        { name: "task_done", description: "", execute: vi.fn(async () => "") },
        { name: "write_file", description: "", execute: vi.fn(async () => "") },
        { name: "run_shell_command", description: "", execute: vi.fn(async () => "") },
        { name: "agents", description: "", execute: vi.fn(async () => "") },
      ];

      const allow = ctx.toolPolicy?.allow ?? [];
      const deny = ctx.toolPolicy?.deny ?? [];
      ctx.tools = tools.filter((tool) => {
        if (deny.length > 0 && matchesGlob(tool.name, deny)) return false;
        if (allow.length > 0) return matchesGlob(tool.name, allow);
        return true;
      });
    }),
  };
});

vi.mock("@/plugins/builtin/SmartAgent/core/react-agent", () => ({
  WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT: "__WAIT_FOR_SPAWNED_TASKS_DEFERRED__",
  WaitForSpawnedTasksInterrupt: class WaitForSpawnedTasksInterrupt extends Error {},
  ReActAgent: class MockReActAgent {
    private readonly tools: Array<{ name: string }>;

    constructor(_ai: unknown, tools: Array<{ name: string }>) {
      this.tools = tools;
      hoisted.visibleToolNames = tools.map((tool) => tool.name);
    }

    listVisibleToolNames(): string[] {
      return [...this.tools.map((tool) => tool.name)];
    }

    async run(): Promise<string> {
      return "done";
    }
  },
}));

import { AgentActor, DIALOG_FULL_ROLE } from "./agent-actor";

describe("AgentActor structured spreadsheet delivery isolation", () => {
  it("keeps spreadsheet orchestration prompt-driven on the first turn", async () => {
    const spawnTask = vi.fn((spawnerActorId: string, targetActorId: string, task: string, opts?: Record<string, unknown>) => ({
      runId: `${targetActorId}-run`,
      spawnerActorId,
      targetActorId,
      task,
      label: opts?.label,
      status: "running",
    }));
    const actor = new AgentActor({
      id: "lead-structured-delivery",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        defaultProductMode: "dialog",
        sessionId: "session-structured-delivery",
        getAll: () => [],
        get: () => null,
        getSpawnedTasksSnapshot: () => [],
        spawnTask,
      } as never,
    });

    const result = await (actor as unknown as {
      runWithInbox: (query: string) => Promise<string>;
    }).runWithInbox([
      "## 🗂️ 工作上下文 - 项目路径: `/Users/haichao/Downloads/AI培训课程需求.xlsx`",
      "以下是用户提供的文件内容（路径均为绝对路径），请根据用户指令进行处理。",
      "用户要求：根据这文件内 28 个课程主题、培训目标、培训对象生成尽可能多的课程，",
      "需要提供的字段只有课程名称和课程介绍，最终给我一个 excel 文件。",
    ].join("\n"));

    expect(result).toBe("done");
    expect(spawnTask).not.toHaveBeenCalled();
    expect(hoisted.visibleToolNames).toEqual([
      "read_document",
      "export_spreadsheet",
      "task_done",
      "write_file",
      "run_shell_command",
    ]);
  });
});
