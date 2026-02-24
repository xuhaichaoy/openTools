/* @vitest-environment jsdom */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRunActions } from "./use-agent-run-actions";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  onReady: (value: ReturnType<typeof useAgentRunActions>) => void;
  params: Parameters<typeof useAgentRunActions>[0];
}

function HookHarness({ onReady, params }: HarnessProps) {
  const value = useAgentRunActions(params);
  onReady(value);
  return null;
}

describe("useAgentRunActions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  it("calls executeAgentTask directly for any input", async () => {
    const executeAgentTask = vi.fn(async () => undefined);
    let hookValue: ReturnType<typeof useAgentRunActions> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            input: "看一下桌面红楼内容",
            pendingImages: [],
            setInput: vi.fn(),
            clearAssets: vi.fn(),
            executeAgentTask,
            stopExecution: vi.fn(),
          }}
        />,
      );
    });

    await act(async () => {
      await hookValue!.handleRun();
    });

    expect(executeAgentTask).toHaveBeenCalledTimes(1);
    expect(executeAgentTask).toHaveBeenCalledWith("看一下桌面红楼内容");
  });

  it("calls executeAgentTask for complex requirements (no plan routing)", async () => {
    const executeAgentTask = vi.fn(async () => undefined);
    let hookValue: ReturnType<typeof useAgentRunActions> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            input: "给我一个完整实施计划，包含里程碑和排期",
            pendingImages: [],
            setInput: vi.fn(),
            clearAssets: vi.fn(),
            executeAgentTask,
            stopExecution: vi.fn(),
          }}
        />,
      );
    });

    await act(async () => {
      await hookValue!.handleRun();
    });

    expect(executeAgentTask).toHaveBeenCalledTimes(1);
    expect(executeAgentTask).toHaveBeenCalledWith(
      "给我一个完整实施计划，包含里程碑和排期",
    );
  });

  it("allows follow-up while busy (no busy guard)", async () => {
    const executeAgentTask = vi.fn(async () => undefined);
    let hookValue: ReturnType<typeof useAgentRunActions> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            input: "追问内容",
            pendingImages: [],
            setInput: vi.fn(),
            clearAssets: vi.fn(),
            executeAgentTask,
            stopExecution: vi.fn(),
          }}
        />,
      );
    });

    await act(async () => {
      await hookValue!.handleRun();
    });

    expect(executeAgentTask).toHaveBeenCalledTimes(1);
    expect(executeAgentTask).toHaveBeenCalledWith("追问内容");
  });

  it("appends image info to query when images are provided", async () => {
    const executeAgentTask = vi.fn(async () => undefined);
    let hookValue: ReturnType<typeof useAgentRunActions> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            input: "分析这张图",
            pendingImages: ["/tmp/test.png"],
            setInput: vi.fn(),
            clearAssets: vi.fn(),
            executeAgentTask,
            stopExecution: vi.fn(),
          }}
        />,
      );
    });

    await act(async () => {
      await hookValue!.handleRun();
    });

    expect(executeAgentTask).toHaveBeenCalledTimes(1);
    const calledQuery = executeAgentTask.mock.calls[0][0];
    expect(calledQuery).toContain("分析这张图");
    expect(calledQuery).toContain("/tmp/test.png");
  });
});
