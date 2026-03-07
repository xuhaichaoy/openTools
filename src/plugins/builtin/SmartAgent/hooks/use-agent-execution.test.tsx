/* @vitest-environment jsdom */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useAgentExecution } from "./use-agent-execution";
import type { AgentTool } from "../core/react-agent";

// React 19 tests require explicit act environment flag when using raw createRoot harnesses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
  fakeStoreState: {
    sessions: [] as Array<{
      id: string;
      createdAt: number;
      tasks: Array<{
        id: string;
        steps: Array<{ type: string; content: string; timestamp: number }>;
        answer: string | null;
      }>;
    }>,
    currentSessionId: null as string | null,
  },
  latestHistorySteps: [] as Array<{ type: string; content: string; timestamp: number }>,
  latestOnStep: null as null | ((step: { type: string; content: string; timestamp: number; streaming?: boolean }) => void),
  runMode: "success" as "success" | "abort" | "timeout",
}));

vi.mock("../core/react-agent", () => ({
  ReActAgent: class {
    constructor(
      _ai: unknown,
      _tools: unknown,
      _options: unknown,
      onStep: ((step: { type: string; content: string; timestamp: number; streaming?: boolean }) => void) | undefined,
      historySteps: Array<{ type: string; content: string; timestamp: number }>,
      _depth?: number,
    ) {
      hoisted.latestHistorySteps = historySteps;
      hoisted.latestOnStep = onStep || null;
    }

    async run(_query: string, signal?: AbortSignal) {
      if (hoisted.runMode === "abort") {
        throw new Error("Aborted");
      }
      if (hoisted.runMode === "timeout") {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("Aborted"));
            },
            { once: true },
          );
        });
        return "mock-timeout";
      }
      hoisted.latestOnStep?.({
        type: "answer",
        content: "streaming-answer",
        timestamp: Date.now(),
        streaming: true,
      });
      return "mock-result";
    }
  },
}));

vi.mock("@/core/agent/fc-compatibility", () => ({
  buildAgentFCCompatibilityKey: () => "mock-fc-key",
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => ({ config: {} }),
  },
}));

vi.mock("@/store/agent-store", () => ({
  useAgentStore: Object.assign(() => ({}), {
    getState: () => hoisted.fakeStoreState,
  }),
}));

interface HarnessProps {
  params: Parameters<typeof useAgentExecution>[0];
  onReady: (value: ReturnType<typeof useAgentExecution>) => void;
}

function HookHarness({ params, onReady }: HarnessProps) {
  const value = useAgentExecution(params);
  onReady(value);
  return null;
}

describe("useAgentExecution", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
    hoisted.latestHistorySteps = [];
    hoisted.latestOnStep = null;
    hoisted.runMode = "success";
    hoisted.fakeStoreState = {
      sessions: [],
      currentSessionId: null,
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  it("uses provided sessionId history instead of current session history", async () => {
    hoisted.fakeStoreState = {
      currentSessionId: "current",
      sessions: [
        {
          id: "current",
          createdAt: 1,
          tasks: [
            {
              id: "t_current",
              steps: [{ type: "thought", content: "CURRENT_STEP", timestamp: 1 }],
              answer: "CURRENT_ANSWER",
            },
          ],
        },
        {
          id: "target",
          createdAt: 2,
          tasks: [
            {
              id: "t_target",
              steps: [{ type: "thought", content: "TARGET_STEP", timestamp: 2 }],
              answer: "TARGET_ANSWER",
            },
          ],
        },
      ],
    };

    const updateTask = vi.fn();
    const setRunning = vi.fn();
    const setRunningPhase = vi.fn();
    let hookValue: ReturnType<typeof useAgentExecution> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            setRunning,
            setRunningPhase,
            setExecutionWaitingStage: vi.fn(),
            availableTools: [] as AgentTool[],
            currentSessionId: "current",
            createSession: vi.fn(() => "new_session"),
            addTask: vi.fn(() => "new_task"),
            updateTask,
            inputRef: { current: document.createElement("textarea") },
            scrollRef: {
              current: {
                scrollHeight: 100,
                scrollTo: vi.fn(),
              } as unknown as HTMLDivElement,
            },
            openDangerConfirm: vi.fn(async () => true),
            resetPerRunState: null,
          }}
        />,
      );
    });

    await act(async () => {
      await hookValue!.executeAgentTask("query", { sessionId: "target" });
    });

    const historyContents = hoisted.latestHistorySteps.map((step) => step.content).join("\n");
    expect(historyContents).toContain("TARGET_ANSWER");
    expect(historyContents).not.toContain("CURRENT_STEP");
    expect(historyContents).not.toContain("CURRENT_ANSWER");
  });

  it("marks task as cancelled when aborted by user", async () => {
    hoisted.runMode = "abort";
    hoisted.fakeStoreState = {
      currentSessionId: "target",
      sessions: [
        {
          id: "target",
          createdAt: 1,
          tasks: [],
        },
      ],
    };

    const updateTask = vi.fn();
    let hookValue: ReturnType<typeof useAgentExecution> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            setRunning: vi.fn(),
            setRunningPhase: vi.fn(),
            setExecutionWaitingStage: vi.fn(),
            availableTools: [] as AgentTool[],
            currentSessionId: "target",
            createSession: vi.fn(() => "target"),
            addTask: vi.fn(() => "task_abort"),
            updateTask,
            inputRef: { current: document.createElement("textarea") },
            scrollRef: {
              current: {
                scrollHeight: 100,
                scrollTo: vi.fn(),
              } as unknown as HTMLDivElement,
            },
            openDangerConfirm: vi.fn(async () => true),
            resetPerRunState: null,
          }}
        />,
      );
    });

    await act(async () => {
      await hookValue!.executeAgentTask("query", { sessionId: "target" });
    });

    const lastCall = updateTask.mock.calls.at(-1);
    expect(lastCall?.[2]?.status).toBe("cancelled");
    expect(lastCall?.[2]?.answer).toContain("停止");
  });

  it("does not overwrite final answer field during streaming answer steps", async () => {
    hoisted.fakeStoreState = {
      currentSessionId: "target",
      sessions: [
        {
          id: "target",
          createdAt: 1,
          tasks: [],
        },
      ],
    };

    const updateTask = vi.fn();
    let hookValue: ReturnType<typeof useAgentExecution> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            setRunning: vi.fn(),
            setRunningPhase: vi.fn(),
            setExecutionWaitingStage: vi.fn(),
            availableTools: [] as AgentTool[],
            currentSessionId: "target",
            createSession: vi.fn(() => "target"),
            addTask: vi.fn(() => "task_stream"),
            updateTask,
            inputRef: { current: document.createElement("textarea") },
            scrollRef: {
              current: {
                scrollHeight: 100,
                scrollTo: vi.fn(),
              } as unknown as HTMLDivElement,
            },
            openDangerConfirm: vi.fn(async () => true),
            resetPerRunState: null,
          }}
        />,
      );
    });

    await act(async () => {
      await hookValue!.executeAgentTask("query", { sessionId: "target" });
    });

    const hasStreamingAnswerUpdate = updateTask.mock.calls.some(
      (call) => call?.[2]?.answer === "streaming-answer",
    );
    expect(hasStreamingAnswerUpdate).toBe(false);
    const lastCall = updateTask.mock.calls.at(-1);
    expect(lastCall?.[2]?.answer).toBe("mock-result");
  });

  it("reports timeout or model-stall error when execution exceeds progress thresholds", async () => {
    vi.useFakeTimers();
    hoisted.runMode = "timeout";
    hoisted.fakeStoreState = {
      currentSessionId: "target",
      sessions: [
        {
          id: "target",
          createdAt: 1,
          tasks: [],
        },
      ],
    };

    const updateTask = vi.fn();
    let hookValue: ReturnType<typeof useAgentExecution> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            setRunning: vi.fn(),
            setRunningPhase: vi.fn(),
            setExecutionWaitingStage: vi.fn(),
            availableTools: [] as AgentTool[],
            currentSessionId: "target",
            createSession: vi.fn(() => "target"),
            addTask: vi.fn(() => "task_timeout"),
            updateTask,
            inputRef: { current: document.createElement("textarea") },
            scrollRef: {
              current: {
                scrollHeight: 100,
                scrollTo: vi.fn(),
              } as unknown as HTMLDivElement,
            },
            openDangerConfirm: vi.fn(async () => true),
            resetPerRunState: null,
          }}
        />,
      );
    });

    const runPromise = hookValue!.executeAgentTask("query", {
      sessionId: "target",
    });
    await vi.advanceTimersByTimeAsync(650_000);
    await act(async () => {
      await runPromise;
    });

    const timeoutOrStallMessageCall = updateTask.mock.calls.find((call) => {
      const answer = String(call?.[2]?.answer || "");
      return answer.includes("超时") || answer.includes("无响应");
    });
    expect(timeoutOrStallMessageCall).toBeTruthy();
    vi.useRealTimers();
  });
});
