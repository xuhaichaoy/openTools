import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentScheduledTask } from "@/core/ai/types";

const invokeMock = vi.fn();
const applyPatchMock = vi.fn();

const aiState = {
  config: {
    agent_max_concurrency: 2,
    agent_retry_max: 3,
    agent_retry_backoff_ms: 5000,
  },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => aiState,
  },
}));

vi.mock("@/store/agent-store", () => ({
  useAgentStore: {
    getState: () => ({
      applyScheduledTaskPatch: applyPatchMock,
    }),
  },
}));

vi.mock("@/core/ai/mtools-ai", () => ({
  getMToolsAI: () => ({}),
}));

vi.mock("@/core/plugin-system/registry", () => ({
  registry: {
    getAllActions: () => [],
  },
}));

vi.mock("@/plugins/builtin/SmartAgent/core/react-agent", () => ({
  FunctionCallingRequiredError: class FunctionCallingRequiredError extends Error {},
  ReActAgent: class {},
  pluginActionToTool: () => ({
    name: "noop",
    description: "noop",
    execute: async () => ({}),
  }),
}));

import { AgentRunnerService } from "./agent-runner-service";

function mkTask(id: string): AgentScheduledTask {
  const now = Date.now();
  return {
    id,
    query: `task-${id}`,
    status: "pending",
    retry_count: 0,
    created_at: now,
    updated_at: now,
    schedule_type: "interval",
    schedule_value: "1000",
  };
}

async function flushTick() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AgentRunnerService", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(null);
    applyPatchMock.mockReset();
    invokeMock.mockClear();
    aiState.config.agent_max_concurrency = 2;
    aiState.config.agent_retry_max = 3;
    aiState.config.agent_retry_backoff_ms = 5000;
  });

  it("should respect max concurrency", async () => {
    const resolvers: Array<() => void> = [];
    const executeTask = vi.fn(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );

    const service = new AgentRunnerService({ executeTask });
    service.enqueue(mkTask("a"));
    service.enqueue(mkTask("b"));
    service.enqueue(mkTask("c"));

    await flushTick();
    expect(executeTask).toHaveBeenCalledTimes(2);

    resolvers[0]?.();
    await flushTick();
    expect(executeTask).toHaveBeenCalledTimes(3);
  });

  it("should retry with exponential backoff and finally succeed", async () => {
    const scheduled: Array<{ cb: () => void; delay: number }> = [];
    const executeTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce(undefined);

    const service = new AgentRunnerService({
      executeTask,
      setTimeoutFn: ((cb: () => void, delay: number) => {
        scheduled.push({ cb, delay });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });

    service.enqueue(mkTask("r1"));
    await flushTick();

    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(scheduled[0]?.delay).toBe(5000);

    scheduled[0]?.cb();
    await flushTick();

    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(scheduled[1]?.delay).toBe(10000);

    scheduled[1]?.cb();
    await flushTick();

    expect(executeTask).toHaveBeenCalledTimes(3);

    const statuses = applyPatchMock.mock.calls
      .map((call) => call[0]?.status)
      .filter(Boolean);
    expect(statuses).toContain("running");
    expect(statuses).toContain("pending");
    expect(statuses).toContain("success");
  });

  it("should ignore duplicated enqueue for same task id", async () => {
    const executeTask = vi.fn().mockResolvedValue(undefined);
    const service = new AgentRunnerService({ executeTask });
    const task = mkTask("dup");

    service.enqueue(task);
    service.enqueue(task);
    service.enqueue({ ...task });

    await flushTick();
    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it("should keep next_run_at for running and success patches", async () => {
    const executeTask = vi.fn().mockResolvedValue(undefined);
    const service = new AgentRunnerService({ executeTask });
    const task = {
      ...mkTask("next"),
      next_run_at: 1234567890,
    };

    service.enqueue(task);
    await flushTick();

    const runningPatch = applyPatchMock.mock.calls.find(
      (call) => call[0]?.status === "running",
    )?.[0];
    const successPatch = applyPatchMock.mock.calls.find(
      (call) => call[0]?.status === "success",
    )?.[0];

    expect(runningPatch?.next_run_at).toBe(task.next_run_at);
    expect(successPatch?.next_run_at).toBe(task.next_run_at);
  });
});
