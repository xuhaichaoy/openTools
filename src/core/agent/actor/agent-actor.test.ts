import { afterEach, describe, expect, it, vi } from "vitest";
import { WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { AgentActor, DIALOG_FULL_ROLE } from "./agent-actor";
import type { DialogStructuredSubtaskResult } from "./dialog-subtask-runtime";
import { enableStructuredDeliveryAdapter, resolveStructuredDeliveryManifest } from "./structured-delivery-strategy";

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
    relatedRunId?: string;
    spawnedTaskResult?: DialogStructuredSubtaskResult;
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

describe("AgentActor dialog execution mode", () => {
  it("keeps the base lead prompt agent-first instead of orchestration-first", () => {
    expect(DIALOG_FULL_ROLE.systemPrompt).toContain("默认先自己完成");
    expect(DIALOG_FULL_ROLE.systemPrompt).toContain("必要时才协作");
    expect(DIALOG_FULL_ROLE.systemPrompt).not.toContain("spawn_task");
    expect(DIALOG_FULL_ROLE.systemPrompt).not.toContain("wait_for_spawned_tasks");
    expect(DIALOG_FULL_ROLE.systemPrompt).not.toContain("send_message");
  });

  it("applies plan-mode runtime restrictions without mutating persisted config", () => {
    const actor = new AgentActor({
      id: "lead-plan",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      toolPolicy: { deny: ["delete_file"] },
      executionPolicy: { accessMode: "full_access", approvalMode: "normal" },
    });

    actor.setDialogExecutionMode("plan");

    expect(actor.dialogExecutionMode).toBe("plan");
    expect(actor.executionPolicy).toEqual({
      accessMode: "read_only",
      approvalMode: "strict",
    });
    expect(actor.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "delete_file",
      "spawn_task",
      "wait_for_spawned_tasks",
      "send_message",
    ]));
    expect(actor.persistedExecutionPolicy).toEqual({
      accessMode: "full_access",
      approvalMode: "normal",
    });
    expect(actor.persistedToolPolicyConfig).toEqual({
      deny: ["delete_file"],
    });
  });

  it("rejects execution-mode switches while a run is active", () => {
    const actor = new AgentActor({
      id: "lead-plan-busy",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    });
    const actorInternals = actor as unknown as ActorTestInternals;
    actorInternals._status = "running";

    expect(() => actor.setDialogExecutionMode("plan")).toThrow("Cannot change dialog execution mode while running");
  });

  it("hides orchestration tools by default when dialog subagent mode is off", () => {
    const actor = new AgentActor({
      id: "lead-subagent-off",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        getDialogSubagentEnabled: () => false,
        hasLiveDialogSubagentContext: () => false,
      } as never,
    });

    expect(actor.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "wait_for_spawned_tasks",
      "send_message",
      "agents",
    ]));
  });

  it("keeps orchestration tools available when dialog subagent mode is on", () => {
    const actor = new AgentActor({
      id: "lead-subagent-on",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        getDialogSubagentEnabled: () => true,
        hasLiveDialogSubagentContext: () => false,
      } as never,
    });

    expect(actor.toolPolicyConfig).toBeUndefined();
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
          structuredTaskCount: number;
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
        structuredTaskCount: 0,
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
    expect(followUpRunOverride?.toolPolicy?.deny).toEqual(
      expect.arrayContaining(["spawn_task", "wait_for_spawned_tasks", "ask_user", "ask_clarification", "send_message", "agents"]),
    );
    expect(followUpRunOverride?.systemPromptAppend).toContain("主 Agent 接管模式");
    expect(followUpRunOverride?.systemPromptAppend).toContain("直接按原要求完成");
    expect(actorInternals.runWithClarifications).toHaveBeenCalledTimes(2);
    expect(publishResult).toHaveBeenCalled();
  });

  it("validates content-executor children with the spawned-task partial contract", async () => {
    const publishResult = vi.fn();
    const actor = new AgentActor({
      id: "worker-content-contract",
      role: { ...DIALOG_FULL_ROLE, name: "Worker" },
    }, {
      actorSystem: {
        sessionId: "session-child-contract",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => [],
        getPendingDeferredSpawnTaskCount: () => 0,
        getSpawnedTasksSnapshot: () => [{
          runId: "run-child-1",
          subtaskId: "subtask-child-1",
          targetActorId: "worker-content-contract",
          targetActorName: "Worker",
          spawnerActorId: "lead",
          task: "根据课程主题生成课程清单，最终给我一个 Excel 文件",
          label: "课程生成A",
          mode: "run" as const,
          profile: "executor" as const,
          roleBoundary: "executor" as const,
          executionIntent: "content_executor" as const,
          status: "running" as const,
          spawnedAt: 1000,
          lastActiveAt: 1500,
        }],
      } as never,
    });

    const actorInternals = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };

    actorInternals.runWithClarifications = vi.fn(async (query: string) => ({
      result: query === "根据课程主题生成课程清单，最终给我一个 Excel 文件"
        ? [
            "已生成 12 门课程候选，以下为课程名称和课程介绍：",
            "- 课程名称：AI 安全治理实战",
            "  课程介绍：围绕企业 AI 安全治理流程、权限边界与风险识别展开。",
          ].join("\n")
        : "unexpected",
      finalQuery: query,
    }));

    const task = await actor.assignTask("根据课程主题生成课程清单，最终给我一个 Excel 文件", undefined, {
      publishResult: false,
    });

    expect(task.status).toBe("completed");
    expect(task.result).toContain("已生成 12 门课程候选");
    expect(actorInternals.runWithClarifications).toHaveBeenCalledTimes(1);
    expect(publishResult).not.toHaveBeenCalled();
  });

  it("blocks export_spreadsheet during spreadsheet failure follow-up", async () => {
    const publishResult = vi.fn();
    const actor = new AgentActor({
      id: "lead-failure-export-guard",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-failure-export-guard",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorInternals = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
      buildFollowUpFromMessages: ReturnType<typeof vi.fn>;
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
        structuredTaskCount: 0,
        hasTaskFailure: true,
        hasTaskCompletion: false,
        failedTaskLabels: ["课程生成B"],
        completedTaskLabels: [],
      },
    }));
    actorInternals.runWithClarifications = vi.fn(async (query: string) => {
      queries.push(query);
      return {
        result: query === "根据课程主题生成课程清单，最终给我一个 Excel 文件"
          ? "已派发子任务，等待结果"
          : "阻塞原因：子任务失败，当前未生成 xlsx 文件。",
        finalQuery: query,
      };
    });

    await actor.assignTask("根据课程主题生成课程清单，最终给我一个 Excel 文件");

    expect(queries).toContain("FOLLOWUP_FAILURE");
    const followUpRunOverride = actorInternals.runWithClarifications.mock.calls[1]?.[3];
    expect(followUpRunOverride?.toolPolicy?.allow).toEqual(["task_done"]);
    expect(followUpRunOverride?.toolPolicy?.allow).not.toContain("export_spreadsheet");
  });

  it("buffers failed child follow-ups until all active children are terminal", async () => {
    const publishResult = vi.fn();
    const actor = new AgentActor({
      id: "lead-buffered-failure",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-buffered-failure",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorInternals = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
      buildFollowUpFromMessages: ReturnType<typeof vi.fn>;
    };

    let activeChildCount = 2;
    let waitRound = 0;
    let deliveredFailure = false;
    const queries: string[] = [];

    (
      actor as unknown as {
        actorSystem: {
          getActiveSpawnedTasks: (actorId: string) => unknown[];
          collectStructuredSpawnedTaskResults: (actorId: string, opts?: unknown) => unknown[];
        };
      }
    ).actorSystem.getActiveSpawnedTasks = () => Array.from({ length: activeChildCount }, (_, index) => ({
      runId: `run-${index + 1}`,
      spawnedAt: 1,
      lastActiveAt: Date.now(),
    }));
    (
      actor as unknown as {
        actorSystem: {
          collectStructuredSpawnedTaskResults: (actorId: string, opts?: unknown) => unknown[];
        };
      }
    ).actorSystem.collectStructuredSpawnedTaskResults = () => {
      if (waitRound === 1 && !deliveredFailure) {
        deliveredFailure = true;
        return [{
          runId: "run-failed-1",
          subtaskId: "run-failed-1",
          targetActorId: "worker-a",
          targetActorName: "Worker A",
          label: "课程生成A",
          task: "课程生成A",
          mode: "run" as const,
          roleBoundary: "executor" as const,
          profile: "executor" as const,
          status: "aborted" as const,
          terminalError: "Idle timeout after 120s",
          startedAt: 1,
          completedAt: 2,
          timeoutSeconds: 600,
          eventCount: 3,
        }];
      }
      return [];
    };

    actorInternals.waitForInbox = vi.fn(async () => {
      waitRound += 1;
      if (waitRound >= 2) {
        activeChildCount = 0;
      }
    });
    actorInternals.buildFollowUpFromMessages = vi.fn(() => ({
      mode: "spawn_failure",
      prompt: "FOLLOWUP_FAILURE",
      summary: {
        userMessageCount: 0,
        userImageCount: 0,
        actorMessageCount: 1,
        structuredTaskCount: 1,
        hasTaskFailure: true,
        hasTaskCompletion: false,
        failedTaskLabels: ["课程生成A"],
        completedTaskLabels: [],
      },
    }));
    actorInternals.runWithClarifications = vi.fn(async (query: string) => {
      queries.push(query);
      if (query === "根据课程主题生成课程清单，最终给我一个 Excel 文件") {
        return {
          result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
          finalQuery: query,
        };
      }
      return {
        result: "已导出 Excel 文件：/Users/demo/Downloads/final.xlsx",
        finalQuery: query,
      };
    });

    await actor.assignTask("根据课程主题生成课程清单，最终给我一个 Excel 文件", undefined, {
      publishResult: false,
    });

    expect(queries).not.toContain("FOLLOWUP_FAILURE");
    expect(actorInternals.runWithClarifications).toHaveBeenCalledTimes(2);
    expect(publishResult).not.toHaveBeenCalled();
  });

  it("injects structured child terminal results into the final synthesis without waiting for announce text", async () => {
    const publishResult = vi.fn();
    let active = true;
    let deliveredStructuredResult = false;

    const actor = new AgentActor({
      id: "lead-structured",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-structured",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => (active ? [{ runId: "run-structured-1" }] : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-structured-1",
            subtaskId: "run-structured-1",
            targetActorId: "worker-a",
            targetActorName: "Worker A",
            label: "实现页面",
            task: "实现页面",
            mode: "run" as const,
            roleBoundary: "executor" as const,
            profile: "executor" as const,
            status: "completed" as const,
            progressSummary: "已完成页面实现",
            terminalResult: "已创建 /Users/demo/Downloads/index.html",
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-a"
          ? { id, role: { name: "Worker A" } }
          : { id, role: { name: "Lead" } }),
      } as never,
    });

    const actorInternals = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };

    const queries: string[] = [];
    actorInternals.waitForInbox = vi.fn(async () => {
      active = false;
    });
    actorInternals.runWithClarifications = vi.fn(async (query: string) => {
      queries.push(query);
      return {
        result: query === "原始任务"
          ? "已派发子任务，等待结果"
          : "已整合子任务结果，最终产物：/Users/demo/Downloads/index.html",
        finalQuery: query,
      };
    });

    await actor.assignTask("原始任务");

    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("结构化子任务摘要");
    expect(queries[1]).toContain("Worker A");
    expect(queries[1]).toContain("/Users/demo/Downloads/index.html");
    expect(publishResult).toHaveBeenCalled();
  });

  it("reuses structured child-result payloads carried by announce messages", async () => {
    const publishResult = vi.fn();
    let active = true;
    let deliveredAnnounce = false;

    const actor = new AgentActor({
      id: "lead-announce-structured",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-announce-structured",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => {
          if (active) return [{ runId: "run-announce-1" }];
          if (!deliveredAnnounce) {
            deliveredAnnounce = true;
            actorInternals.inbox.push({
              id: "msg-completed",
              from: "worker-b",
              content: "[Task completed: 实现页面]\n\n已创建 /Users/demo/Downloads/index.html",
              timestamp: Date.now(),
              priority: "normal",
              relatedRunId: "run-announce-1",
              spawnedTaskResult: {
                runId: "run-announce-1",
                subtaskId: "run-announce-1",
                targetActorId: "worker-b",
                targetActorName: "Worker B",
                label: "实现页面",
                task: "实现页面",
                mode: "run",
                roleBoundary: "executor",
                profile: "executor",
                status: "completed",
                progressSummary: "已完成页面实现",
                terminalResult: "已创建 /Users/demo/Downloads/index.html",
                startedAt: 1,
                completedAt: 2,
                timeoutSeconds: 600,
                eventCount: 3,
              },
            });
          }
          return [];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-b"
          ? { id, role: { name: "Worker B" } }
          : { id, role: { name: "Lead" } }),
      } as never,
    });

    const actorInternals = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };

    const queries: string[] = [];
    actorInternals.waitForInbox = vi.fn(async () => {
      active = false;
    });
    actorInternals.runWithClarifications = vi.fn(async (query: string) => {
      queries.push(query);
      return {
        result: query === "原始任务"
          ? "已派发子任务，等待结果"
          : "已整合 announce 里的结构化结果，最终产物：/Users/demo/Downloads/index.html",
        finalQuery: query,
      };
    });

    await actor.assignTask("原始任务");

    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("结构化子任务摘要");
    expect(queries[1]).toContain("Worker B");
    expect(queries[1]).toContain("/Users/demo/Downloads/index.html");
    expect(publishResult).toHaveBeenCalled();
  });

  it("buffers successful child results until all active children are terminal before aggregating", async () => {
    const publishResult = vi.fn();
    let activeChildren = 2;
    let deliveredFirstStructured = false;
    let deliveredSecondStructured = false;

    const actor = new AgentActor({
      id: "lead-buffered-success",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-buffered-success",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getPendingDeferredSpawnTaskCount: () => 0,
        dispatchDeferredSpawnTasks: () => 0,
        getActiveSpawnedTasks: () => Array.from({ length: activeChildren }, (_, index) => ({ runId: `run-${index + 1}` })),
        collectStructuredSpawnedTaskResults: (_actorId: string, opts?: { excludeRunIds?: Iterable<string> }) => {
          const excluded = new Set(opts?.excludeRunIds ?? []);
          if (activeChildren === 1 && !deliveredFirstStructured && !excluded.has("run-buffer-1")) {
            deliveredFirstStructured = true;
            return [{
              runId: "run-buffer-1",
              subtaskId: "run-buffer-1",
              targetActorId: "worker-a",
              targetActorName: "Worker A",
              label: "课程A",
              task: "生成课程A",
              mode: "run" as const,
              roleBoundary: "executor" as const,
              profile: "executor" as const,
              status: "completed" as const,
              progressSummary: "课程A 已完成",
              terminalResult: "已创建 /Users/demo/Downloads/a.docx",
              startedAt: 1,
              completedAt: 2,
              timeoutSeconds: 600,
              eventCount: 3,
            }];
          }
          if (activeChildren === 0 && !deliveredSecondStructured && !excluded.has("run-buffer-2")) {
            deliveredSecondStructured = true;
            return [{
              runId: "run-buffer-2",
              subtaskId: "run-buffer-2",
              targetActorId: "worker-b",
              targetActorName: "Worker B",
              label: "课程B",
              task: "生成课程B",
              mode: "run" as const,
              roleBoundary: "executor" as const,
              profile: "executor" as const,
              status: "completed" as const,
              progressSummary: "课程B 已完成",
              terminalResult: "已创建 /Users/demo/Downloads/b.docx",
              startedAt: 3,
              completedAt: 4,
              timeoutSeconds: 600,
              eventCount: 3,
            }];
          }
          return [];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => ({ id, role: { name: id === "worker-a" ? "Worker A" : id === "worker-b" ? "Worker B" : "Lead" } }),
      } as never,
    });

    const actorInternals = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };

    const queries: string[] = [];
    actorInternals.waitForInbox = vi.fn(async () => {
      activeChildren = Math.max(0, activeChildren - 1);
    });
    actorInternals.runWithClarifications = vi.fn(async (query: string) => {
      queries.push(query);
      return {
        result: query === "原始任务"
          ? "已派发子任务，等待结果"
          : "最终产物：/Users/demo/Downloads/a.docx 和 /Users/demo/Downloads/b.docx",
        finalQuery: query,
      };
    });

    await actor.assignTask("原始任务");

    expect(actorInternals.runWithClarifications).toHaveBeenCalledTimes(2);
    expect(queries[1]).toContain("结构化子任务摘要");
    expect(queries[1]).toContain("Worker A");
    expect(queries[1]).toContain("Worker B");
    expect(queries[1]).toContain("/Users/demo/Downloads/a.docx");
    expect(queries[1]).toContain("/Users/demo/Downloads/b.docx");
    expect(publishResult).toHaveBeenCalled();
  });

  it("forces a final synthesis rerun when structured child results only yield a status summary", async () => {
    const publishResult = vi.fn();
    let active = true;
    let deliveredStructuredResult = false;

    const actor = new AgentActor({
      id: "lead-structured-final",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-structured-final",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => (active ? [{ runId: "run-structured-final-1" }] : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-structured-final-1",
            subtaskId: "run-structured-final-1",
            targetActorId: "worker-c",
            targetActorName: "Worker C",
            label: "实现页面",
            task: "实现页面",
            mode: "run" as const,
            roleBoundary: "executor" as const,
            profile: "executor" as const,
            status: "completed" as const,
            progressSummary: "已完成页面实现",
            terminalResult: "已创建 /Users/demo/Downloads/index.html",
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-c"
          ? { id, role: { name: "Worker C" } }
          : { id, role: { name: "Lead" } }),
      } as never,
    });

    const actorInternals = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };

    const queries: string[] = [];
    actorInternals.waitForInbox = vi.fn(async () => {
      active = false;
    });
    actorInternals.runWithClarifications = vi.fn(async (query: string) => {
      queries.push(query);
      if (query === "生成网页") {
        return {
          result: "已派发子任务，等待结果",
          finalQuery: query,
        };
      }
      if (query.includes("结构化子任务摘要")) {
        return {
          result: "目前已收到各子任务反馈。",
          finalQuery: query,
        };
      }
      return {
        result: "最终产物：/Users/demo/Downloads/index.html",
        finalQuery: query,
      };
    });

    await actor.assignTask("生成网页");

    expect(queries).toHaveLength(3);
    expect(queries[1]).toContain("结构化子任务摘要");
    expect(queries[1]).toContain("Worker C");
    expect(queries[2]).toContain("你的上一条答复未通过结果校验");
    expect(queries[2]).toContain("结构化子任务摘要");
    expect(queries[2]).toContain("terminal_result");
    expect(queries[2]).toContain("/Users/demo/Downloads/index.html");
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

  it("pauses the main budget while waiting for spawned tasks", async () => {
    vi.useFakeTimers();
    let active = true;
    let deliveredStructuredResult = false;
    let waitCallCount = 0;
    const abortActiveRunSpawnedTasks = vi.fn();

    const actor = new AgentActor({
      id: "lead-waiting-budget",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 3,
      idleLeaseSeconds: 30,
    }, {
      actorSystem: {
        sessionId: "session-waiting-budget",
        publishResult: vi.fn(),
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => (active ? [{ runId: "run-child-1", spawnedAt: 1, lastActiveAt: Date.now() }] : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-1",
            subtaskId: "run-child-1",
            targetActorId: "worker-a",
            targetActorName: "Worker A",
            label: "实现页面",
            task: "实现页面",
            mode: "run" as const,
            roleBoundary: "executor" as const,
            profile: "executor" as const,
            status: "completed" as const,
            progressSummary: "已完成页面实现",
            terminalResult: "已创建 /Users/demo/Downloads/index.html",
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-a"
          ? { id, role: { name: "Worker A" } }
          : { id, role: { name: "Lead" } }),
        waitForSpawnedTaskUpdate: vi.fn(() => new Promise<{ reason: "task_update" | "timeout" }>((resolve) => {
          const delay = waitCallCount === 0 ? 6_000 : 1_000;
          const shouldComplete = waitCallCount === 1;
          waitCallCount += 1;
          setTimeout(() => {
            if (shouldComplete) active = false;
            resolve({ reason: "task_update" });
          }, delay);
        })),
        abortActiveRunSpawnedTasks,
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => ({
      result: query === "原始任务"
        ? "已派发子任务，等待结果"
        : "最终产物：/Users/demo/Downloads/index.html",
      finalQuery: query,
    }));

    const taskPromise = actor.assignTask("原始任务", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(6_200);
    const task = await taskPromise;

    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
    expect(abortActiveRunSpawnedTasks).not.toHaveBeenCalled();
  });

  it("pauses the main budget while wait_for_spawned_tasks tool is blocking", async () => {
    vi.useFakeTimers();
    const actor = new AgentActor({
      id: "lead-tool-wait",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 3,
      idleLeaseSeconds: 30,
    }, {
      actorSystem: {
        sessionId: "session-tool-wait",
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
    actorAny.runWithClarifications = vi.fn(async (query: string, _images, onStep) => {
      onStep?.({
        type: "action",
        content: "调用 wait_for_spawned_tasks",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        timestamp: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      onStep?.({
        type: "observation",
        content: "wait_for_spawned_tasks 返回最新结构化快照",
        toolName: "wait_for_spawned_tasks",
        toolOutput: { wait_complete: false, pending_count: 1 },
        timestamp: Date.now(),
      });
      return {
        result: `工具等待结束：${query}\n最终产物：/Users/demo/Downloads/index.html`,
        finalQuery: query,
      };
    });

    const taskPromise = actor.assignTask("原始任务", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(6_200);
    const task = await taskPromise;

    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
  });

  it("switches to runtime wait loop when wait_for_spawned_tasks defers the main run", async () => {
    vi.useFakeTimers();
    let active = true;
    let deliveredStructuredResult = false;

    const actor = new AgentActor({
      id: "lead-deferred-wait",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 30,
      idleLeaseSeconds: 30,
    }, {
      actorSystem: {
        sessionId: "session-deferred-wait",
        publishResult: vi.fn(),
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => (active ? [{ runId: "run-child", spawnedAt: 1, lastActiveAt: Date.now() }] : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child",
            subtaskId: "run-child",
            targetActorId: "worker-c",
            targetActorName: "Worker C",
            label: "实现页面",
            task: "实现页面",
            mode: "run" as const,
            roleBoundary: "executor" as const,
            profile: "executor" as const,
            status: "completed" as const,
            progressSummary: "已完成页面实现",
            terminalResult: "已创建 /Users/demo/Downloads/index.html",
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-c"
          ? { id, role: { name: "Worker C" } }
          : { id, role: { name: "Lead" } }),
        waitForSpawnedTaskUpdate: vi.fn(() => new Promise<{ reason: "task_update" | "timeout" }>((resolve) => {
          setTimeout(() => {
            active = false;
            resolve({ reason: "task_update" });
          }, 1_000);
        })),
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    let runCount = 0;
    actorAny.runWithClarifications = vi.fn(async (query: string) => {
      runCount += 1;
      if (runCount === 1) {
        return {
          result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
          finalQuery: query,
        };
      }
      return {
        result: "最终产物：/Users/demo/Downloads/index.html",
        finalQuery: query,
      };
    });

    const taskPromise = actor.assignTask("原始任务", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(1_200);
    const task = await taskPromise;

    expect(task.status).toBe("completed");
    expect(task.result).toContain("/Users/demo/Downloads/index.html");
    expect(actorAny.runWithClarifications).toHaveBeenCalledTimes(2);
  });

  it("uses idle lease instead of total budget while child-result aggregation is still running", async () => {
    vi.useFakeTimers();
    let active = true;
    let deliveredStructuredResult = false;
    let waitCallCount = 0;
    const abortActiveRunSpawnedTasks = vi.fn();

    const actor = new AgentActor({
      id: "lead-wait-then-budget",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 3,
      idleLeaseSeconds: 1,
    }, {
      actorSystem: {
        sessionId: "session-wait-then-budget",
        publishResult: vi.fn(),
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => (active ? [{ runId: "run-child-2", spawnedAt: 1, lastActiveAt: Date.now() }] : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-2",
            subtaskId: "run-child-2",
            targetActorId: "worker-b",
            targetActorName: "Worker B",
            label: "实现页面",
            task: "实现页面",
            mode: "run" as const,
            roleBoundary: "executor" as const,
            profile: "executor" as const,
            status: "completed" as const,
            progressSummary: "已完成页面实现",
            terminalResult: "已创建 /Users/demo/Downloads/index.html",
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-b"
          ? { id, role: { name: "Worker B" } }
          : { id, role: { name: "Lead" } }),
        waitForSpawnedTaskUpdate: vi.fn(() => new Promise<{ reason: "task_update" | "timeout" }>((resolve) => {
          const delay = waitCallCount === 0 ? 6_000 : 1_000;
          const shouldComplete = waitCallCount === 1;
          waitCallCount += 1;
          setTimeout(() => {
            if (shouldComplete) active = false;
            resolve({ reason: "task_update" });
          }, delay);
        })),
        abortActiveRunSpawnedTasks,
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn((query: string) => {
      if (query === "原始任务") {
        return Promise.resolve({
          result: "已派发子任务，等待结果",
          finalQuery: query,
        });
      }
      return new Promise(() => undefined);
    });

    const taskPromise = actor.assignTask("原始任务", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(10_200);
    const task = await taskPromise;

    expect(task.status).toBe("aborted");
    expect(task.error).toBe("Idle timeout after 1s");
    expect(abortActiveRunSpawnedTasks).toHaveBeenCalledWith("lead-wait-then-budget", "Idle timeout after 1s");
  });

  it("pauses the main budget while final synthesis is aggregating structured child results", async () => {
    vi.useFakeTimers();
    let active = true;
    let deliveredStructuredResult = false;

    const actor = new AgentActor({
      id: "lead-final-synthesis-budget",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 3,
      idleLeaseSeconds: 30,
    }, {
      actorSystem: {
        sessionId: "session-final-synthesis-budget",
        publishResult: vi.fn(),
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => (active ? [{ runId: "run-child-final", spawnedAt: 1, lastActiveAt: Date.now() }] : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-final",
            subtaskId: "run-child-final",
            targetActorId: "worker-final",
            targetActorName: "Worker Final",
            label: "实现页面",
            task: "实现页面",
            mode: "run" as const,
            roleBoundary: "executor" as const,
            profile: "executor" as const,
            status: "completed" as const,
            progressSummary: "已完成页面实现",
            terminalResult: "已创建 /Users/demo/Downloads/index.html",
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-final"
          ? { id, role: { name: "Worker Final" } }
          : { id, role: { name: "Lead" } }),
        waitForSpawnedTaskUpdate: vi.fn(() => new Promise<{ reason: "task_update" | "timeout" }>((resolve) => {
          setTimeout(() => {
            active = false;
            resolve({ reason: "task_update" });
          }, 1_000);
        })),
        abortActiveRunSpawnedTasks: vi.fn(),
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn((query: string) => {
      if (query === "原始任务") {
        return Promise.resolve({
          result: "已派发子任务，等待结果",
          finalQuery: query,
        });
      }
      if (query.includes("结构化子任务摘要")) {
        return Promise.resolve({
          result: "目前已收到各子任务反馈。",
          finalQuery: query,
        });
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            result: "最终产物：/Users/demo/Downloads/index.html",
            finalQuery: query,
          });
        }, 6_000);
      });
    });

    const taskPromise = actor.assignTask("原始任务", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(7_200);
    const task = await taskPromise;

    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
  });

  it("rewrites plan-like repair results into a concrete final spreadsheet reply", async () => {
    vi.useFakeTimers();
    let active = true;
    let deliveredStructuredResult = false;
    const artifacts: Array<Record<string, unknown>> = [];
    const engagedManifest = enableStructuredDeliveryAdapter(
      resolveStructuredDeliveryManifest("根据附件生成课程并给我一个 excel文件"),
      "planner",
    );

    const actor = new AgentActor({
      id: "lead-repair-rewrite",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 30,
      idleLeaseSeconds: 30,
    }, {
      actorSystem: {
        sessionId: "session-repair-rewrite",
        publishResult: vi.fn(),
        recordArtifact: vi.fn((artifact: Record<string, unknown>) => {
          artifacts.push(artifact);
        }),
        getArtifactRecordsSnapshot: () => artifacts as never,
        cancelPendingInteractionsForActor: () => undefined,
        getActiveSpawnedTasks: () => (active ? [{ runId: "run-child-spreadsheet", spawnedAt: 1, lastActiveAt: Date.now() }] : []),
        getActiveExecutionContract: () => ({
          structuredDeliveryManifest: engagedManifest,
        }),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-spreadsheet",
            subtaskId: "run-child-spreadsheet",
            targetActorId: "worker-spreadsheet",
            targetActorName: "Worker Spreadsheet",
            label: "课程候选",
            task: "生成课程候选",
            mode: "run" as const,
            roleBoundary: "executor" as const,
            profile: "executor" as const,
            status: "completed" as const,
            progressSummary: "已完成课程候选生成",
            terminalResult: "已生成 20 门课程候选，等待父 Agent 汇总导出。",
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-spreadsheet"
          ? { id, role: { name: "Worker Spreadsheet" } }
          : { id, role: { name: "Lead" } }),
        waitForSpawnedTaskUpdate: vi.fn(() => new Promise<{ reason: "task_update" | "timeout" }>((resolve) => {
          setTimeout(() => {
            active = false;
            resolve({ reason: "task_update" });
          }, 1_000);
        })),
        abortActiveRunSpawnedTasks: vi.fn(),
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    let runCount = 0;
    actorAny.runWithClarifications = vi.fn(async (query: string, _images, onStep, runOverrides) => {
      runCount += 1;
      if (runCount === 1) {
        return {
          result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
          finalQuery: query,
        };
      }
      if (query.includes("上一条答复未通过结果校验")) {
        expect(runOverrides?.toolPolicy).toEqual(expect.objectContaining({
          allow: expect.arrayContaining(["task_done", "export_spreadsheet"]),
          deny: expect.arrayContaining(["session_history", "session_list", "read_file_range", "run_shell_command"]),
        }));
        expect(runOverrides?.toolPolicy?.allow).not.toContain("send_local_media");
        expect(runOverrides?.toolPolicy?.allow).not.toContain("export_document");

        onStep?.({
          type: "action",
          content: "调用 export_spreadsheet",
          toolName: "export_spreadsheet",
          toolInput: {
            file_name: "AI培训课程候选汇总.xlsx",
          },
          timestamp: Date.now(),
        });
        onStep?.({
          type: "observation",
          content: "已导出 Excel 文件: /Users/demo/Downloads/AI培训课程候选汇总.xlsx",
          toolName: "export_spreadsheet",
          toolOutput: "已导出 Excel 文件: /Users/demo/Downloads/AI培训课程候选汇总.xlsx",
          timestamp: Date.now(),
        });
        onStep?.({
          type: "action",
          content: "调用 task_done",
          toolName: "task_done",
          toolInput: { summary: "已完成导出" },
          timestamp: Date.now(),
        });
        onStep?.({
          type: "observation",
          content: '{ "status": "done", "summary": "已完成导出" }',
          toolName: "task_done",
          toolOutput: { status: "done", summary: "已完成导出" },
          timestamp: Date.now(),
        });
        return {
          result: "执行计划：1. 汇总当前 run 结果。2. 导出 Excel。",
          finalQuery: query,
        };
      }
      if (query.includes("结构化子任务摘要")) {
        expect(runOverrides?.toolPolicy?.allow).toEqual(["task_done"]);
        expect(runOverrides?.toolPolicy?.allow).not.toContain("export_document");
        expect(runOverrides?.toolPolicy?.deny).toEqual(expect.arrayContaining(["read_file_range", "run_shell_command"]));
        return {
          result: "目前已收到各子任务反馈。",
          finalQuery: query,
        };
      }

      throw new Error(`unexpected query in rewrite test: ${query}`);
    });

    const taskPromise = actor.assignTask("根据附件生成课程并给我一个 excel文件", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(1_200);
    const task = await taskPromise;

    expect(task.status).toBe("completed");
    expect(task.result).toContain("已导出 Excel 文件：/Users/demo/Downloads/AI培训课程候选汇总.xlsx");
    expect(task.result).toContain("本轮已汇总 1 个子任务的结构化结果");
    expect(task.result).not.toContain("执行计划");
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

  it("ignores late step emissions after a timed-out run has already exited", async () => {
    vi.useFakeTimers();
    const published = vi.fn();
    const actor = new AgentActor({
      id: "lead-late-steps",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
      timeoutSeconds: 20,
      idleLeaseSeconds: 1,
    }, {
      actorSystem: {
        sessionId: "session-late-steps",
        publishResult: published,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        getActiveSpawnedTasks: () => [],
        getSpawnedTasksSnapshot: () => [],
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const stepEvents: Array<{ type: string; detail?: unknown }> = [];
    actor.on((event) => {
      if (event.type === "step") {
        stepEvents.push({ type: event.type, detail: event.detail });
      }
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn((_query: string, _images, onStep) => new Promise(() => {
      setTimeout(() => {
        onStep?.({
          type: "action",
          content: "调用 write_file",
          toolName: "write_file",
          toolInput: { path: "/tmp/late.json" },
          timestamp: Date.now(),
        });
      }, 5_500);
      setTimeout(() => {
        onStep?.({
          type: "observation",
          content: "late tool output",
          toolName: "write_file",
          toolOutput: "late tool output",
          timestamp: Date.now(),
        });
      }, 5_600);
    }));
    vi.spyOn(actor, "abort").mockImplementation(() => undefined);

    const taskPromise = actor.assignTask("卡住的长任务", undefined, {
      publishResult: false,
    });

    await vi.advanceTimersByTimeAsync(6_200);
    const task = await taskPromise;

    expect(task.status).toBe("aborted");
    expect(task.error).toBe("Idle timeout after 1s");
    expect(stepEvents).toHaveLength(0);
    expect(task.steps).toEqual([]);
    expect(published).not.toHaveBeenCalled();
  });

  it("aborts lingering child runs before publishing the final parent result", async () => {
    const publishResult = vi.fn();
    const abortActiveRunSpawnedTasks = vi.fn(() => 1);

    const actor = new AgentActor({
      id: "lead-orphan-cleanup",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        sessionId: "session-orphan-cleanup",
        publishResult,
        recordArtifact: vi.fn(),
        getArtifactRecordsSnapshot: () => [],
        getActiveSpawnedTasks: () => (actor.status === "idle"
          ? [
              {
                runId: "run-orphan",
                label: "遗留数据子任务",
                task: "生成数据课程",
              },
            ]
          : []),
        getSpawnedTasksSnapshot: () => [],
        abortActiveRunSpawnedTasks,
        cancelPendingInteractionsForActor: () => undefined,
      } as never,
    });

    const actorAny = actor as unknown as ActorTestInternals & {
      runWithClarifications: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => ({
      result: `最终产物：/Users/demo/Downloads/result.txt\n\n${query}`,
      finalQuery: query,
    }));

    const task = await actor.assignTask("输出最终结果", undefined, {
      publishResult: true,
    });

    expect(task.status).toBe("completed");
    expect(abortActiveRunSpawnedTasks).toHaveBeenCalledWith(
      "lead-orphan-cleanup",
      "主 Agent 已完成最终发布，终止遗留子任务。",
    );
    expect(publishResult).toHaveBeenCalledTimes(1);
    expect(
      abortActiveRunSpawnedTasks.mock.invocationCallOrder[0],
    ).toBeLessThan(
      publishResult.mock.invocationCallOrder[0],
    );
  });
});
