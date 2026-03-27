import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActor, DIALOG_FULL_ROLE } from "./agent-actor";

vi.mock("./actor-memory", () => ({
  autoExtractMemories: vi.fn(async () => undefined),
}));

type ActorTestInternals = {
  _status: "idle" | "running" | "waiting" | "paused" | "stopped";
  inbox: Array<{
    id: string;
    from: string;
    content: string;
    timestamp: number;
    priority: string;
    images?: string[];
  }>;
  askUser: (questions: Array<{
    id: string;
    question: string;
    type: string;
  }>) => Promise<Record<string, string>>;
  wakeUpForInbox: () => void;
  setStatus: (status: "idle" | "running" | "waiting" | "paused" | "stopped") => void;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentActor askUser image replies", () => {
  it("queues image replies into the inbox so the next model turn can see them", async () => {
    const actor = new AgentActor({
      id: "lead",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        askUserInChat: async () => ({
          interactionId: "interaction-1",
          interactionType: "question",
          status: "answered" as const,
          content: "图片内容相关的",
          message: {
            id: "reply-1",
            from: "user",
            content: "图片内容相关的",
            timestamp: Date.now(),
            priority: "normal" as const,
            images: ["/tmp/reference-image.png"],
          },
        }),
      } as never,
    });
    const actorInternals = actor as unknown as ActorTestInternals;
    actorInternals._status = "waiting";

    const answers = await actorInternals.askUser([{
      id: "q1",
      question: "图片里主要是什么内容？",
      type: "text",
    }]);

    expect(answers["图片里主要是什么内容？"]).toBe("图片内容相关的");

    const inbox = actor.drainInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.images).toEqual(["/tmp/reference-image.png"]);
    expect(inbox[0]?.content).toContain("ask_user 图片补充");
  });
});

describe("AgentActor updateConfig", () => {
  it("promotes legacy middleware approval compatibility into first-class executionPolicy", () => {
    const actor = new AgentActor({
      id: "reviewer",
      role: { ...DIALOG_FULL_ROLE, name: "Reviewer" },
      middlewareOverrides: { approvalLevel: "strict" },
    });

    expect(actor.executionPolicy).toEqual({
      accessMode: "auto",
      approvalMode: "strict",
    });
    expect(actor.normalizedExecutionPolicy).toEqual({
      accessMode: "auto",
      approvalMode: "strict",
    });
  });

  it("can clear workspace and policy fields when patch explicitly provides undefined", () => {
    const actor = new AgentActor({
      id: "editor",
      role: { ...DIALOG_FULL_ROLE, name: "Editor" },
      workspace: "/tmp/demo",
      toolPolicy: { deny: ["run_shell_command"] },
      executionPolicy: { accessMode: "full_access", approvalMode: "permissive" },
      middlewareOverrides: { approvalLevel: "permissive", disable: ["Clarification"] },
      thinkingLevel: "high",
      capabilities: { tags: ["code_write"] },
    });

    actor.updateConfig({
      workspace: undefined,
      toolPolicy: undefined,
      executionPolicy: undefined,
      middlewareOverrides: undefined,
      thinkingLevel: undefined,
      capabilities: undefined,
    });

    expect(actor.workspace).toBeUndefined();
    expect(actor.toolPolicyConfig).toBeUndefined();
    expect(actor.executionPolicy).toBeUndefined();
    expect(actor.middlewareOverrides).toBeUndefined();
    expect(actor.thinkingLevel).toBeUndefined();
    expect(actor.capabilities).toBeUndefined();
  });
});

describe("AgentActor inbox wake-up", () => {
  it("re-wakes queued inbox messages after returning to idle", () => {
    const actor = new AgentActor({
      id: "lead",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    });
    const actorInternals = actor as unknown as ActorTestInternals;
    const wakeUpSpy = vi
      .spyOn(actorInternals, "wakeUpForInbox")
      .mockImplementation(() => undefined);

    actorInternals._status = "running";
    actorInternals.inbox.push({
      id: "msg-1",
      from: "user",
      content: "后续补充",
      timestamp: Date.now(),
      priority: "normal",
    });

    actorInternals.setStatus("idle");

    expect(wakeUpSpy).toHaveBeenCalledTimes(1);
  });
});

describe("AgentActor spawned-task follow-up handling", () => {
  it("records export_document outputs as artifacts", async () => {
    const recordArtifact = vi.fn();
    const publishResult = vi.fn();
    const actor = new AgentActor({
      id: "lead",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-1",
        recordArtifact,
        publishResult,
        getSpawnedTasksSnapshot: () => [],
        getActiveSpawnedTasks: () => [],
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: (query: string, images?: string[], onStep?: (step: {
        type: string;
        content: string;
        timestamp: number;
        toolName?: string;
        toolInput?: Record<string, unknown>;
      }) => void) => Promise<{ result: string; finalQuery: string }>;
    };

    actorAny.runWithClarifications = vi.fn(async (query, _images, onStep) => {
      onStep?.({
        type: "action",
        content: "导出课程方案",
        toolName: "export_document",
        toolInput: {
          path: "/Users/demo/Downloads/report.docx",
          content: "# 课程方案",
        },
        timestamp: Date.now(),
      });
      return {
        result: "已导出Word 文档到 /Users/demo/Downloads/report.docx",
        finalQuery: query,
      };
    });

    await actor.assignTask("把课程方案导出为 Word");

    expect(recordArtifact).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "lead",
      path: "/Users/demo/Downloads/report.docx",
      toolName: "export_document",
      source: "tool_write",
    }));
    expect(publishResult).toHaveBeenCalled();
  });

  it("records export_spreadsheet outputs as artifacts from tool results", async () => {
    const recordArtifact = vi.fn();
    const publishResult = vi.fn();
    const actor = new AgentActor({
      id: "lead",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-1b",
        recordArtifact,
        publishResult,
        getSpawnedTasksSnapshot: () => [],
        getActiveSpawnedTasks: () => [],
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: (query: string, images?: string[], onStep?: (step: {
        type: string;
        content: string;
        timestamp: number;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        toolOutput?: unknown;
      }) => void) => Promise<{ result: string; finalQuery: string }>;
    };

    actorAny.runWithClarifications = vi.fn(async (query, _images, onStep) => {
      onStep?.({
        type: "action",
        content: "导出课程表",
        toolName: "export_spreadsheet",
        toolInput: {
          file_name: "课程清单.xlsx",
          sheets: "[]",
        },
        timestamp: Date.now(),
      });
      onStep?.({
        type: "observation",
        content: "导出完成",
        toolName: "export_spreadsheet",
        toolOutput: "已导出 Excel 文件: /Users/demo/Downloads/课程清单.xlsx",
        timestamp: Date.now(),
      });
      return {
        result: "已导出 Excel 文件: /Users/demo/Downloads/课程清单.xlsx",
        finalQuery: query,
      };
    });

    await actor.assignTask("把课程方案导出为 Excel");

    expect(recordArtifact).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "lead",
      path: "/Users/demo/Downloads/课程清单.xlsx",
      toolName: "export_spreadsheet",
      source: "tool_write",
    }));
    expect(publishResult).toHaveBeenCalled();
  });

  it("flushes residual inbox failures after spawned-task wait ends", async () => {
    const publishResult = vi.fn();
    const actor = new AgentActor({
      id: "lead",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-2",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorInternals = actor as unknown as ActorTestInternals & {
      runWithClarifications: (query: string) => Promise<{ result: string; finalQuery: string }>;
      waitForInbox: (timeoutMs: number) => Promise<void>;
      buildFollowUpFromMessages: (messages: ActorTestInternals["inbox"]) => {
        mode: "spawn_failure";
        prompt: string;
        summary: {
          userMessageCount: number;
          userImageCount: number;
          actorMessageCount: number;
          hasTaskFailure: boolean;
          hasTaskCompletion: boolean;
          failedTaskLabels: string[];
          completedTaskLabels: string[];
        };
      };
    };

    let active = true;
    let deliveredResidualFailure = false;
    const queries: string[] = [];

    (
      actor as unknown as {
        actorSystem: {
          getActiveSpawnedTasks: (actorId: string) => unknown[];
        };
      }
    ).actorSystem.getActiveSpawnedTasks = () => {
      if (active) return [{ runId: "run-1" }];
      if (!deliveredResidualFailure) {
        deliveredResidualFailure = true;
        actorInternals.inbox.push({
          id: "msg-failed",
          from: "worker-a",
          content: "[Task failed: 课程生成B]\n\nError: 结果未通过校验",
          timestamp: Date.now(),
          priority: "normal",
        });
      }
      return [];
    };

    actorInternals.waitForInbox = vi.fn(async () => {
      active = false;
    });
    actorInternals.buildFollowUpFromMessages = vi.fn(() => ({
      mode: "spawn_failure",
      prompt: "FOLLOWUP_FAILURE",
      summary: {
        userMessageCount: 0,
        userImageCount: 0,
        actorMessageCount: 1,
        hasTaskFailure: true,
        hasTaskCompletion: false,
        failedTaskLabels: ["课程生成B"],
        completedTaskLabels: [],
      },
    }));
    actorInternals.runWithClarifications = vi.fn(async (query) => {
      queries.push(query);
      return {
        result: query === "原始任务"
          ? "已派发子任务，等待结果"
          : "已接管失败子任务并补齐最终结果 /Users/demo/Downloads/final.docx",
        finalQuery: query,
      };
    });

    await actor.assignTask("原始任务");

    expect(queries).toContain("FOLLOWUP_FAILURE");
    expect(actorInternals.buildFollowUpFromMessages).toHaveBeenCalledTimes(1);
    const followUpRunOverride = actorInternals.runWithClarifications.mock.calls[1]?.[3];
    const finalSynthesisRunOverride = actorInternals.runWithClarifications.mock.calls[2]?.[3];
    expect(followUpRunOverride?.toolPolicy?.deny).toEqual(
      expect.arrayContaining(["spawn_task", "wait_for_spawned_tasks", "ask_user", "ask_clarification"]),
    );
    expect(finalSynthesisRunOverride?.toolPolicy?.deny).toEqual(
      expect.arrayContaining(["spawn_task", "wait_for_spawned_tasks", "ask_user", "ask_clarification"]),
    );
    expect(followUpRunOverride?.systemPromptAppend).toContain("主 Agent 接管模式");
    expect(finalSynthesisRunOverride?.systemPromptAppend).toContain("主 Agent 接管模式");
    expect(followUpRunOverride?.systemPromptAppend).toContain("直接按原要求完成");
    expect(publishResult).toHaveBeenCalled();
  });
});

describe("AgentActor timeout guards", () => {
  it("marks the main agent as idle-timeout when no progress arrives within the lease", async () => {
    vi.useFakeTimers();
    const actor = new AgentActor({
      id: "lead-idle",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 20,
      idleLeaseSeconds: 1,
    }, {
      actorSystem: {
        sessionId: "session-idle",
        publishResult: vi.fn(),
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        getActiveSpawnedTasks: () => [],
        getSpawnedTasksSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(() => new Promise(() => undefined));
    vi.spyOn(actor, "abort").mockImplementation(() => undefined);

    const taskPromise = actor.assignTask("持续长任务", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(5_200);
    const task = await taskPromise;

    expect(task.status).toBe("aborted");
    expect(task.error).toBe("Idle timeout after 1s");
  });

  it("marks the main agent as budget exceeded when total runtime crosses the budget", async () => {
    vi.useFakeTimers();
    const actor = new AgentActor({
      id: "lead-budget",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 3,
      idleLeaseSeconds: 30,
    }, {
      actorSystem: {
        sessionId: "session-budget",
        publishResult: vi.fn(),
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        getActiveSpawnedTasks: () => [],
        getSpawnedTasksSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(() => new Promise(() => undefined));
    vi.spyOn(actor, "abort").mockImplementation(() => undefined);

    const taskPromise = actor.assignTask("预算测试", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(5_200);
    const task = await taskPromise;

    expect(task.status).toBe("aborted");
    expect(task.error).toBe("Budget exceeded after 3s");
  });

  it("times out promptly even when the in-flight run ignores abort", async () => {
    vi.useFakeTimers();
    const actor = new AgentActor({
      id: "lead-stuck",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 20,
      idleLeaseSeconds: 1,
    }, {
      actorSystem: {
        sessionId: "session-stuck",
        publishResult: vi.fn(),
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        getActiveSpawnedTasks: () => [],
        getSpawnedTasksSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(() => new Promise(() => undefined));
    vi.spyOn(actor, "abort").mockImplementation(() => undefined);

    const taskPromise = actor.assignTask("卡住的长任务", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(5_200);
    const task = await taskPromise;

    expect(task.status).toBe("aborted");
    expect(task.error).toBe("Idle timeout after 1s");
  });
});
