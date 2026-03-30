/* @vitest-environment jsdom */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRunActions } from "./use-agent-run-actions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
  toast: vi.fn(),
  modelSupportsImageInput: vi.fn(() => true),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: hoisted.toast }),
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: (selector: (state: { config: { model: string; protocol?: string } }) => unknown) =>
    selector({ config: { model: "mock-model", protocol: "openai" } }),
}));

vi.mock("@/core/ai/model-capabilities", () => ({
  modelSupportsImageInput: hoisted.modelSupportsImageInput,
}));

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
    hoisted.toast.mockReset();
    hoisted.modelSupportsImageInput.mockReset();
    hoisted.modelSupportsImageInput.mockReturnValue(true);
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

  it("queues follow-up while busy instead of starting a new run", async () => {
    const executeAgentTask = vi.fn(async () => undefined);
    const enqueueFollowUp = vi.fn(() => "queued-1");
    let hookValue: ReturnType<typeof useAgentRunActions> | null = null;

    act(() => {
      root.render(
        <HookHarness
          onReady={(value) => {
            hookValue = value;
          }}
          params={{
            ai: {} as never,
            busy: true,
            currentSessionId: "session-1",
            input: "追问内容",
            imagePaths: [],
            fileContextBlock: "",
            attachmentSummary: "",
            enqueueFollowUp,
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

    expect(executeAgentTask).not.toHaveBeenCalled();
    expect(enqueueFollowUp).toHaveBeenCalledTimes(1);
    expect(enqueueFollowUp).toHaveBeenCalledWith("session-1", {
      query: "追问内容",
      images: undefined,
      systemHint: undefined,
      codingHint: undefined,
    });
  });

  it("passes image paths via execute options", async () => {
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

  it("warns immediately when current model does not support image input", async () => {
    hoisted.modelSupportsImageInput.mockReturnValue(false);
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
            input: "按图片实现一下页面",
            imagePaths: ["/tmp/mock.png"],
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

    expect(hoisted.toast).toHaveBeenCalledWith(
      "warning",
      "当前模型不支持图片识别，本次会忽略图片内容；如需看图，请切换到支持视觉输入的模型。",
    );
    expect(executeAgentTask).toHaveBeenCalledTimes(1);
  });

  it("uses image description prompt when only an image is provided", async () => {
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
            input: "",
            imagePaths: ["/tmp/mock.png"],
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

    expect(executeAgentTask).toHaveBeenCalledWith("请描述这张图片", {
      images: ["/tmp/mock.png"],
      systemHint: undefined,
    });
  });

  it("places attachment summary after the main user intent", async () => {
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
            input: "实现一下网页，保存到 Downloads",
            imagePaths: ["/tmp/mock.png"],
            fileContextBlock: "",
            attachmentSummary: "1 张图片",
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

    expect(executeAgentTask).toHaveBeenCalledWith(
      "实现一下网页，保存到 Downloads\n\n已附：1 张图片",
      expect.objectContaining({
        images: ["/tmp/mock.png"],
        systemHint: undefined,
      }),
    );
  });

  it("passes OpenClaw profile when enabled", async () => {
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
    const call = executeAgentTask.mock.calls[0] as unknown as [string, {
      runProfile?: {
        codingMode: boolean;
        largeProjectMode: boolean;
        openClawMode: boolean;
      };
      systemHint?: string;
      codingHint?: string;
    }?] | undefined;
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

    expect(hookValue).not.toBeNull();
    const readyHookValue = hookValue!;

    expect(readyHookValue.effectiveRunProfile.profile.codingMode).toBe(true);
    expect(readyHookValue.effectiveRunProfile.autoDetected).toBe(true);

    await act(async () => {
      await readyHookValue.handleRun();
    });

    const autoDetectedCall = executeAgentTask.mock.calls[0] as unknown as [string, {
      runProfile?: {
        codingMode: boolean;
        largeProjectMode: boolean;
        openClawMode: boolean;
      };
      codingHint?: string;
    }?] | undefined;
    const options = (autoDetectedCall?.[1] ?? {}) as {
      runProfile?: {
        codingMode: boolean;
        largeProjectMode: boolean;
        openClawMode: boolean;
      };
      codingHint?: string;
    };
    expect(options.runProfile).toBeUndefined();
    expect(options.codingHint).toBeUndefined();
  });

  it("starts a fresh session for standalone artifact tasks unrelated to a heavy project context", async () => {
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
            currentSessionId: "session-heavy",
            currentSession: {
              id: "session-heavy",
              title: "大型项目分析",
              createdAt: 1,
              sourceHandoff: {
                query: "分析这个大型项目",
                sourceMode: "ask",
                files: [{ path: "/tmp/project/src/App.tsx" }],
              },
              tasks: [
                { id: "t1", query: "先分析仓库结构", createdAt: 1, steps: [], answer: "", attachmentPaths: ["/tmp/project"], status: "success" },
                { id: "t2", query: "再看核心模块", createdAt: 2, steps: [], answer: "", status: "success" },
                { id: "t3", query: "总结架构", createdAt: 3, steps: [], answer: "", status: "success" },
              ],
            },
            input: "实现一个网页，保存到 Downloads",
            imagePaths: ["/tmp/mock.png"],
            fileContextBlock: "",
            attachmentSummary: "1 张图片",
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

    expect(executeAgentTask).toHaveBeenCalledWith(
      "实现一个网页，保存到 Downloads\n\n已附：1 张图片",
      expect.objectContaining({
        forceNewSession: true,
        images: ["/tmp/mock.png"],
      }),
    );
  });
});
