/* @vitest-environment jsdom */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useAgentExecution } from "./use-agent-execution";
import type { AgentTool } from "../core/react-agent";
import type { AgentPromptContextSnapshot } from "../core/prompt-context";

// React 19 tests require explicit act environment flag when using raw createRoot harnesses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
  fakeStoreState: {
    sessions: [] as Array<{
      id: string;
      title?: string;
      createdAt: number;
      visibleTaskCount?: number;
      workspaceRoot?: string;
      lastActivePaths?: string[];
      sourceHandoff?: {
        attachmentPaths?: string[];
        visualAttachmentPaths?: string[];
        files?: Array<{ path: string }>;
      };
      compaction?: {
        summary?: string;
        compactedTaskCount?: number;
      };
      tasks: Array<{
        id: string;
        query?: string;
        createdAt?: number;
        attachmentPaths?: string[];
        images?: string[];
        last_started_at?: number;
        last_finished_at?: number;
        steps: Array<{ type: string; content: string; timestamp: number }>;
        answer: string | null;
      }>;
    }>,
    currentSessionId: null as string | null,
  },
  latestHistorySteps: [] as Array<{ type: string; content: string; timestamp: number }>,
  latestOnStep: null as null | ((step: { type: string; content: string; timestamp: number; streaming?: boolean }) => void),
  runMode: "success" as "success" | "abort" | "timeout" | "tool_round" | "retry_then_success" | "fc_retry_observation",
  runCallCount: 0,
  modelSupportsImageInput: true,
  shouldRecallAssistantMemory: false,
  memoryRecallBundle: {
    prompt: "",
    memories: [],
    memoryIds: [] as string[],
    memoryPreview: [] as string[],
    searched: false,
    hitCount: 0,
    transcriptPrompt: "",
    transcriptPreview: [] as string[],
    transcriptSearched: false,
    transcriptHitCount: 0,
  },
  latestRunQuery: "",
  runningStore: {
    info: null as null | {
      sessionId: string;
      query: string;
      startedAt: number;
      workspaceRoot?: string;
      waitingStage?: string;
    },
    abortFn: null as null | (() => void),
  },
}));

vi.mock("../core/react-agent", () => ({
  ReActAgent: class {
    constructor(
      _ai: unknown,
      _tools: unknown,
      _options: unknown,
      onStep: ((step: { type: string; content: string; timestamp: number; streaming?: boolean }) => void) | undefined,
      historySteps: Array<{ type: string; content: string; timestamp: number }>,
    ) {
      hoisted.latestHistorySteps = historySteps;
      hoisted.latestOnStep = onStep || null;
    }

    async run(_query: string, signal?: AbortSignal) {
      hoisted.runCallCount += 1;
      hoisted.latestRunQuery = _query;
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
      if (hoisted.runMode === "tool_round") {
        hoisted.latestOnStep?.({
          type: "answer",
          content: "先写一大段临时内容",
          timestamp: Date.now(),
          streaming: true,
        });
        hoisted.latestOnStep?.({
          type: "action",
          content: "调用 write_file",
          timestamp: Date.now(),
        });
        hoisted.latestOnStep?.({
          type: "answer",
          content: "最终稳定答案",
          timestamp: Date.now(),
        });
        return "最终稳定答案";
      }
      if (hoisted.runMode === "retry_then_success") {
        if (hoisted.runCallCount < 3) {
          throw new Error("API 错误: 503 server error");
        }
        hoisted.latestOnStep?.({
          type: "answer",
          content: "retry-success-answer",
          timestamp: Date.now(),
        });
        return "retry-success-answer";
      }
      if (hoisted.runMode === "fc_retry_observation") {
        hoisted.latestOnStep?.({
          type: "observation",
          content: "网络/流传输错误，3秒后自动重试（第1次）...",
          timestamp: Date.now(),
        });
        return "mock-result";
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
    getState: () => ({ config: { model: "mock-model", protocol: "openai" } }),
  },
}));

vi.mock("@/store/skill-store", () => ({
  loadAndResolveSkills: async () => ({
    mergedSystemPrompt: "",
    visibleSkillIds: [],
    mergedToolFilter: null,
  }),
}));

vi.mock("@/core/ai/assistant-config", () => ({
  buildAssistantSupplementalPrompt: () => "",
  shouldAutoSaveAssistantMemory: () => false,
  shouldRecallAssistantMemory: () => hoisted.shouldRecallAssistantMemory,
}));

vi.mock("@/store/agent-memory-store", () => ({
  useAgentMemoryStore: {
    getState: () => ({
      loaded: true,
      load: vi.fn(async () => undefined),
      getMemoriesForQueryPromptAsync: vi.fn(async () => ""),
      getMemoryRecallBundleAsync: vi.fn(async () => hoisted.memoryRecallBundle),
    }),
  },
}));

vi.mock("@/core/agent/context-runtime/compaction-orchestrator", () => ({
  persistAgentSessionCompactionArtifacts: vi.fn(async () => ({
    flushText: null,
    transcript: null,
    noteSaved: false,
    memoryIngest: { confirmed: 0, queued: 0 },
  })),
}));

vi.mock("@/core/agent/context-runtime/context-ingest", () => ({
  persistAgentTurnContextIngest: vi.fn(async () => ({
    sessionNoteSaved: false,
    sessionNotePreview: undefined,
    referencedPaths: [],
    debugReport: {
      generatedAt: Date.now(),
      sessionId: "mock-session",
      taskId: "mock-task",
      workspaceReset: false,
      scope: {
        queryIntent: "general",
        attachmentCount: 0,
        imageCount: 0,
        handoffCount: 0,
        pathHintCount: 0,
        pathHintPreview: [],
      },
      prompt: {
        bootstrapFileCount: 0,
        bootstrapFileNames: [],
        historyContextMessageCount: 0,
        knowledgeContextMessageCount: 0,
        memoryItemCount: 0,
      },
      compaction: {
        compactedTaskCount: 0,
        preservedIdentifiers: [],
        bootstrapRules: [],
      },
      ingest: {
        sessionNoteSaved: false,
        referencedPaths: [],
        memoryAutoExtractionScheduled: false,
      },
      execution: {
        status: "success",
        durationMs: 0,
      },
    },
  })),
}));

vi.mock("@/core/agent/actor/middlewares/knowledge-base-middleware", () => ({
  buildKnowledgeContextMessages: async () => [],
}));

vi.mock("@/core/ai/model-capabilities", () => ({
  modelSupportsImageInput: () => hoisted.modelSupportsImageInput,
}));

vi.mock("@/store/agent-running-store", () => ({
  useAgentRunningStore: {
    getState: () => ({
      info: hoisted.runningStore.info,
      abortFn: hoisted.runningStore.abortFn,
      start: (
        info: { sessionId: string; query: string; startedAt: number; workspaceRoot?: string; waitingStage?: string },
        abortFn?: () => void,
      ) => {
        hoisted.runningStore.info = info;
        hoisted.runningStore.abortFn = abortFn ?? null;
      },
      patch: (updates: Partial<{ waitingStage?: string; workspaceRoot?: string }>) => {
        if (!hoisted.runningStore.info) return;
        hoisted.runningStore.info = {
          ...hoisted.runningStore.info,
          ...updates,
        };
      },
      stop: () => {
        hoisted.runningStore.info = null;
        hoisted.runningStore.abortFn = null;
      },
    }),
  },
}));

vi.mock("@/store/agent-store", () => ({
  getVisibleAgentTasks: (session: {
    tasks: Array<unknown>;
    visibleTaskCount?: number;
  }) => {
    const visibleCount =
      typeof session.visibleTaskCount === "number"
        ? Math.min(session.visibleTaskCount, session.tasks.length)
        : session.tasks.length;
    return session.tasks.slice(0, visibleCount);
  },
  getAgentSessionCompactedTaskCount: (session: {
    tasks: Array<unknown>;
    visibleTaskCount?: number;
    compaction?: { compactedTaskCount?: number };
  }) => {
    const visibleCount =
      typeof session.visibleTaskCount === "number"
        ? Math.min(session.visibleTaskCount, session.tasks.length)
        : session.tasks.length;
    return Math.max(
      0,
      Math.min(visibleCount, session.compaction?.compactedTaskCount ?? 0),
    );
  },
  getAgentSessionLiveTasks: (session: {
    tasks: Array<unknown>;
    visibleTaskCount?: number;
    compaction?: { compactedTaskCount?: number };
  }) => {
    const visibleCount =
      typeof session.visibleTaskCount === "number"
        ? Math.min(session.visibleTaskCount, session.tasks.length)
        : session.tasks.length;
    const compacted =
      Math.max(
        0,
        Math.min(visibleCount, session.compaction?.compactedTaskCount ?? 0),
      );
    return session.tasks.slice(compacted, visibleCount);
  },
  getHiddenAgentTasks: (session: {
    tasks: Array<unknown>;
    visibleTaskCount?: number;
  }) => {
    const visibleCount =
      typeof session.visibleTaskCount === "number"
        ? Math.min(session.visibleTaskCount, session.tasks.length)
        : session.tasks.length;
    return session.tasks.slice(visibleCount);
  },
  hasAgentSessionHiddenTasks: (session: {
    tasks: Array<unknown>;
    visibleTaskCount?: number;
  }) =>
    typeof session.visibleTaskCount === "number"
      ? session.visibleTaskCount < session.tasks.length
      : false,
  useAgentStore: Object.assign(() => ({}), {
    getState: () => hoisted.fakeStoreState,
  }),
}));

interface HarnessProps {
  params: Parameters<typeof useAgentExecution>[0];
  onReady: (value: ReturnType<typeof useAgentExecution>) => void;
}

type MockSession = (typeof hoisted.fakeStoreState.sessions)[number];
type MockTask = MockSession["tasks"][number];

function HookHarness({ params, onReady }: HarnessProps) {
  const value = useAgentExecution(params);
  onReady(value);
  return null;
}

function upsertMockSession(session: MockSession) {
  hoisted.fakeStoreState.sessions = [
    session,
    ...hoisted.fakeStoreState.sessions.filter((item) => item.id !== session.id),
  ];
  hoisted.fakeStoreState.currentSessionId = session.id;
}

function buildCreateSessionMock(prefix = "created-session") {
  return vi.fn((
    query: string,
    sourceHandoff?: MockSession["sourceHandoff"],
    initialTask?: Pick<MockTask, "images" | "attachmentPaths">,
  ) => {
    const id = `${prefix}-${hoisted.fakeStoreState.sessions.length + 1}`;
    const createdAt = Date.now();
    upsertMockSession({
      id,
      title: query.slice(0, 30) || "新任务",
      createdAt,
      sourceHandoff,
      tasks: query
        ? [
            {
              id: `${id}-task-1`,
              query,
              images: initialTask?.images,
              attachmentPaths: initialTask?.attachmentPaths,
              createdAt,
              steps: [],
              answer: null,
            },
          ]
        : [],
    });
    return id;
  });
}

function buildForkSessionMock(prefix = "forked-session") {
  return vi.fn((sessionId: string, options?: { title?: string; visibleOnly?: boolean }) => {
    const session = hoisted.fakeStoreState.sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const visibleCount =
      typeof session.visibleTaskCount === "number"
        ? Math.min(session.visibleTaskCount, session.tasks.length)
        : session.tasks.length;
    const sourceTasks =
      options?.visibleOnly === false
        ? session.tasks
        : session.tasks.slice(0, visibleCount);
    const createdAt = Date.now();
    const forkedId = `${prefix}-${sessionId}`;
    upsertMockSession({
      ...session,
      id: forkedId,
      title: options?.title ?? session.title,
      createdAt,
      visibleTaskCount: undefined,
      tasks: sourceTasks.map((task, index) => ({
        ...task,
        id: `${forkedId}-task-${index + 1}`,
        steps: task.steps.map((step) => ({ ...step })),
        images: task.images ? [...task.images] : undefined,
        attachmentPaths: task.attachmentPaths ? [...task.attachmentPaths] : undefined,
      })),
    });
    return forkedId;
  });
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
    hoisted.runCallCount = 0;
    hoisted.modelSupportsImageInput = true;
    hoisted.shouldRecallAssistantMemory = false;
    hoisted.memoryRecallBundle = {
      prompt: "",
      memories: [],
      memoryIds: [],
      memoryPreview: [],
      searched: false,
      hitCount: 0,
      transcriptPrompt: "",
      transcriptPreview: [],
      transcriptSearched: false,
      transcriptHitCount: 0,
    };
    hoisted.latestRunQuery = "";
    hoisted.fakeStoreState = {
      sessions: [],
      currentSessionId: null,
    };
    hoisted.runningStore = {
      info: null,
      abortFn: null,
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
            updateSession: vi.fn(),
            forkSession: vi.fn(() => null),
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

  it("creates an isolated session when execution switches to a new workspace", async () => {
    hoisted.fakeStoreState = {
      currentSessionId: "target",
      sessions: [
        {
          id: "target",
          title: "旧项目",
          createdAt: 2,
          workspaceRoot: "/prev-workspace",
          tasks: [
            {
              id: "t_target",
              query: "旧项目分析",
              createdAt: 2,
              steps: [{ type: "answer", content: "OLD_PROJECT_ANSWER", timestamp: 2 }],
              answer: "OLD_PROJECT_ANSWER",
            },
          ],
        },
      ],
    };

    const createSession = buildCreateSessionMock("workspace-switch");
    const addTask = vi.fn(() => "task_workspace_switch");
    const updateSession = vi.fn();
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
            createSession,
            addTask,
            updateTask: vi.fn(),
            updateSession,
            forkSession: vi.fn(() => null),
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
      await hookValue!.executeAgentTask("请在新目录生成一个页面", {
        sessionId: "target",
        attachmentPaths: ["/next-workspace/index.html"],
      });
    });

    expect(hoisted.latestHistorySteps).toEqual([]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addTask).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      "workspace-switch-2",
      expect.objectContaining({
        workspaceRoot: "/next-workspace",
        lastContinuityStrategy: "fork_session",
        lastContinuityReason: "workspace_switch",
      }),
    );
  });

  it("keeps visible-only fork behavior when the session contains hidden tasks", async () => {
    hoisted.fakeStoreState = {
      currentSessionId: "target",
      sessions: [
        {
          id: "target",
          title: "当前任务",
          createdAt: 2,
          visibleTaskCount: 1,
          tasks: [
            {
              id: "t_visible",
              query: "继续当前项目",
              createdAt: 2,
              steps: [{ type: "answer", content: "VISIBLE_STEP", timestamp: 2 }],
              answer: "VISIBLE_ANSWER",
            },
            {
              id: "t_hidden",
              query: "隐藏任务",
              createdAt: 3,
              steps: [{ type: "answer", content: "HIDDEN_STEP", timestamp: 3 }],
              answer: "HIDDEN_ANSWER",
            },
          ],
        },
      ],
    };

    const createSession = buildCreateSessionMock("hidden-fallback");
    const forkSession = buildForkSessionMock("visible-branch");
    const addTask = vi.fn(() => "task-visible-branch");
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
            createSession,
            addTask,
            updateTask: vi.fn(),
            updateSession: vi.fn(),
            forkSession,
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
      await hookValue!.executeAgentTask("继续修复当前项目里的按钮样式", {
        sessionId: "target",
      });
    });

    const historyContents = hoisted.latestHistorySteps.map((step) => step.content).join("\n");
    expect(forkSession).toHaveBeenCalledWith("target", {
      visibleOnly: true,
      title: "当前任务 · 分支",
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(addTask).toHaveBeenCalledWith(
      "visible-branch-target",
      "继续修复当前项目里的按钮样式",
      undefined,
      undefined,
    );
    expect(historyContents).toContain("VISIBLE_ANSWER");
    expect(historyContents).not.toContain("HIDDEN_ANSWER");
  });

  it("injects an explicit text-only warning when images are attached but model lacks vision", async () => {
    hoisted.modelSupportsImageInput = false;
    hoisted.fakeStoreState = {
      currentSessionId: "current",
      sessions: [
        {
          id: "current",
          createdAt: 1,
          tasks: [],
        },
      ],
    };
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
            currentSessionId: "current",
            createSession: vi.fn(() => "session-1"),
            addTask: vi.fn(() => "task-1"),
            updateTask: vi.fn(),
            updateSession: vi.fn(),
            forkSession: vi.fn(() => null),
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
      await hookValue!.executeAgentTask("根据图片实现页面", {
        images: ["/tmp/mock.png"],
      });
    });

    expect(hoisted.latestRunQuery).toContain("当前模型不支持直接识别图片内容");
    expect(hoisted.latestRunQuery).toContain("不要假装自己看到了图片");
  });

  it("persists recalled memory preview when agent memory recall is enabled", async () => {
    hoisted.shouldRecallAssistantMemory = true;
    hoisted.memoryRecallBundle = {
      prompt: "- [fact] 用户常驻上海\n- [preference] 回复尽量简洁",
      memories: [],
      memoryIds: ["memory-1", "memory-2"],
      memoryPreview: ["用户常驻上海", "回复尽量简洁"],
      searched: true,
      hitCount: 2,
      transcriptPrompt: "- [Agent] 用户任务：继续做天气默认按上海",
      transcriptPreview: ["Agent：用户任务：继续做天气默认按上海"],
      transcriptSearched: true,
      transcriptHitCount: 1,
    };
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
    const updateSession = vi.fn();
    let latestSnapshot: AgentPromptContextSnapshot | null = null;
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
            addTask: vi.fn(() => "task_memory"),
            updateTask,
            updateSession,
            forkSession: vi.fn(() => null),
            inputRef: { current: document.createElement("textarea") },
            scrollRef: {
              current: {
                scrollHeight: 100,
                scrollTo: vi.fn(),
              } as unknown as HTMLDivElement,
            },
            openDangerConfirm: vi.fn(async () => true),
            resetPerRunState: null,
            onPromptContextSnapshot: (snapshot) => {
              latestSnapshot = snapshot;
            },
          }}
        />,
      );
    });

    await act(async () => {
      await hookValue!.executeAgentTask("今天天气怎么样", { sessionId: "target" });
    });

    expect(
      updateTask.mock.calls.some(
        (call) =>
          call[0] === "target"
          && call[1] === "task_memory"
          && call[2]?.memoryRecallAttempted === true
          && call[2]?.appliedMemoryIds?.join(",") === "memory-1,memory-2"
          && call[2]?.appliedMemoryPreview?.join(",") === "用户常驻上海,回复尽量简洁",
      ),
    ).toBe(true);
    expect(
      updateTask.mock.calls.some(
        (call) =>
          call[0] === "target"
          && call[1] === "task_memory"
          && call[2]?.transcriptRecallAttempted === true
          && call[2]?.transcriptRecallHitCount === 1
          && call[2]?.appliedTranscriptPreview?.join(",") === "Agent：用户任务：继续做天气默认按上海",
      ),
    ).toBe(true);
    expect(updateSession).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({
        lastMemoryRecallAttempted: true,
        lastMemoryRecallPreview: ["用户常驻上海", "回复尽量简洁"],
        lastTranscriptRecallAttempted: true,
        lastTranscriptRecallHitCount: 1,
        lastTranscriptRecallPreview: ["Agent：用户任务：继续做天气默认按上海"],
      }),
    );
    expect(latestSnapshot?.memoryRecallAttempted).toBe(true);
    expect(latestSnapshot?.memoryRecallPreview).toEqual(["用户常驻上海", "回复尽量简洁"]);
    expect(latestSnapshot?.memoryItemCount).toBe(2);
    expect(latestSnapshot?.transcriptRecallAttempted).toBe(true);
    expect(latestSnapshot?.transcriptRecallHitCount).toBe(1);
    expect(latestSnapshot?.transcriptRecallPreview).toEqual(["Agent：用户任务：继续做天气默认按上海"]);
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
            updateSession: vi.fn(),
            forkSession: vi.fn(() => null),
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

  it("falls back to global running abort when local controller is gone", async () => {
    const setRunning = vi.fn();
    const setRunningPhase = vi.fn();
    const setExecutionWaitingStage = vi.fn();
    const globalAbort = vi.fn();
    let hookValue: ReturnType<typeof useAgentExecution> | null = null;

    hoisted.runningStore = {
      info: {
        sessionId: "target",
        query: "query",
        startedAt: Date.now(),
      },
      abortFn: globalAbort,
    };

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
            setExecutionWaitingStage,
            availableTools: [] as AgentTool[],
            currentSessionId: "target",
            createSession: vi.fn(() => "target"),
            addTask: vi.fn(() => "task_abort"),
            updateTask: vi.fn(),
            updateSession: vi.fn(),
            forkSession: vi.fn(() => null),
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

    act(() => {
      hookValue!.stopExecution();
    });

    expect(globalAbort).toHaveBeenCalledTimes(1);
    expect(setRunning).toHaveBeenCalledWith(false);
    expect(setRunningPhase).toHaveBeenCalledWith(null);
    expect(setExecutionWaitingStage).toHaveBeenCalledWith(null);
    expect(hoisted.runningStore.abortFn).toBeNull();
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
            updateSession: vi.fn(),
            forkSession: vi.fn(() => null),
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
            updateSession: vi.fn(),
            forkSession: vi.fn(() => null),
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

  it("drops provisional streaming answers after entering tool execution", async () => {
    hoisted.runMode = "tool_round";
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
            addTask: vi.fn(() => "task_tool_round"),
            updateTask,
            updateSession: vi.fn(),
            forkSession: vi.fn(() => null),
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

    const actionUpdate = updateTask.mock.calls.find((call) => {
      const steps = call?.[2]?.steps as Array<{ type: string; content: string; streaming?: boolean }> | undefined;
      return steps?.some((step) => step.type === "action");
    });
    const actionSteps = actionUpdate?.[2]?.steps as Array<{ type: string; content: string; streaming?: boolean }> | undefined;
    expect(actionSteps?.some((step) => step.type === "answer" && step.streaming)).toBe(false);
  });

  it("switches waiting stage to model_retrying when transport retry observation arrives", async () => {
    hoisted.runMode = "fc_retry_observation";
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

    const setExecutionWaitingStage = vi.fn();
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
            setExecutionWaitingStage,
            availableTools: [] as AgentTool[],
            currentSessionId: "target",
            createSession: vi.fn(() => "target"),
            addTask: vi.fn(() => "task_retry_obs"),
            updateTask: vi.fn(),
            updateSession: vi.fn(),
            forkSession: vi.fn(() => null),
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

    expect(setExecutionWaitingStage).toHaveBeenCalledWith(expect.any(Function));
    const updaterResults = setExecutionWaitingStage.mock.calls
      .map((call) => call?.[0])
      .filter((candidate): candidate is ((prev: string | null) => string | null) => typeof candidate === "function")
      .map((updater) => updater("model_first_token"));
    expect(updaterResults).toContain("model_retrying");
  });
});
