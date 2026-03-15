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
            imagePaths: [],
            fileContextBlock: "",
            attachmentSummary: "",
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
    expect(executeAgentTask).toHaveBeenCalledWith("看一下桌面红楼内容", {
      images: undefined,
      systemHint: undefined,
    });
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
            imagePaths: [],
            fileContextBlock: "",
            attachmentSummary: "",
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
      {
        images: undefined,
        systemHint: undefined,
      },
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
            imagePaths: [],
            fileContextBlock: "",
            attachmentSummary: "",
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
    expect(executeAgentTask).toHaveBeenCalledWith("追问内容", {
      images: undefined,
      systemHint: undefined,
    });
  });

  it("passes image paths via execute options", async () => {
    const executeAgentTask = vi.fn(async (_query: string) => undefined);
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
            imagePaths: ["/tmp/test.png"],
            fileContextBlock: "",
            attachmentSummary: "",
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
    expect(executeAgentTask).toHaveBeenCalledWith("分析这张图", {
      images: ["/tmp/test.png"],
      systemHint: undefined,
    });
  });

  it("passes OpenClaw profile when enabled", async () => {
    const executeAgentTask = vi.fn(async (_query: string, _opts?: unknown) => undefined);
    let hookValue: ReturnType<typeof useAgentRunActions> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            input: "修复这个模块并验证",
            imagePaths: [],
            fileContextBlock: "",
            attachmentSummary: "",
            codingMode: true,
            largeProjectMode: true,
            openClawMode: true,
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
    const call = executeAgentTask.mock.calls[0];
    const options = (call?.[1] ?? {}) as {
      runProfile?: {
        codingMode: boolean;
        largeProjectMode: boolean;
        openClawMode: boolean;
      };
      systemHint?: string;
      codingHint?: string;
    };
    expect(call?.[0]).toBe("修复这个模块并验证");
    expect(options.runProfile).toEqual({
      codingMode: true,
      largeProjectMode: true,
      openClawMode: true,
    });
    expect(String(options.codingHint || "")).toContain("OpenClaw");
  });

  it("auto-detects coding profile from incoming handoff", async () => {
    const executeAgentTask = vi.fn(async (_query: string, _opts?: unknown) => undefined);
    let hookValue: ReturnType<typeof useAgentRunActions> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            input: "继续处理",
            imagePaths: [],
            fileContextBlock: "",
            attachmentSummary: "",
            pendingSourceHandoff: {
              query: "请修复构建错误",
              intent: "coding",
              files: [{ path: "/tmp/project/src/App.tsx" }],
              sourceMode: "ask",
            },
            setInput: vi.fn(),
            clearAssets: vi.fn(),
            executeAgentTask,
            stopExecution: vi.fn(),
          }}
        />,
      );
    });

    expect(hookValue?.effectiveRunProfile.profile.codingMode).toBe(true);
    expect(hookValue?.effectiveRunProfile.autoDetected).toBe(true);

    await act(async () => {
      await hookValue!.handleRun();
    });

    const options = (executeAgentTask.mock.calls[0]?.[1] ?? {}) as {
      runProfile?: {
        codingMode: boolean;
        largeProjectMode: boolean;
        openClawMode: boolean;
      };
      codingHint?: string;
    };
    expect(options.runProfile?.codingMode).toBe(true);
    expect(String(options.codingHint || "")).toContain("Coding Execution Policy");
  });
});
