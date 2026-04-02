import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DialogSubtaskRuntime,
  type DialogStructuredSubtaskResult,
} from "./dialog-subtask-runtime";
import type { SpawnedTaskRecord } from "./types";
import {
  getAgentTaskManager,
  resetAgentTaskManager,
  resolveAgentTaskIdFromRunId,
} from "@/core/task-center";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeActor {
  status = "idle";
  persistent = false;
  timeoutSeconds?: number;
  idleLeaseSeconds?: number;
  pendingInboxCount = 0;
  assignTask = vi.fn(async () => ({
    status: "completed" as const,
    result: "ok",
  }));
  abort = vi.fn();

  private handlers: Array<(event: { type: string; actorId: string; timestamp: number; detail?: unknown }) => void> = [];

  constructor(
    readonly id: string,
    readonly role: { name: string },
  ) {}

  on(handler: (event: { type: string; actorId: string; timestamp: number; detail?: unknown }) => void) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((item) => item !== handler);
    };
  }

  emit(type: string, detail?: unknown, timestamp = Date.now()) {
    for (const handler of this.handlers) {
      handler({
        type,
        actorId: this.id,
        timestamp,
        detail,
      });
    }
  }

  getSessionHistory() {
    return [];
  }
}

function createRecord(overrides: Partial<SpawnedTaskRecord> = {}): SpawnedTaskRecord {
  return {
    runId: overrides.runId ?? "run-1",
    spawnerActorId: overrides.spawnerActorId ?? "coordinator",
    ownerTaskId: overrides.ownerTaskId,
    targetActorId: overrides.targetActorId ?? "worker",
    dispatchSource: overrides.dispatchSource ?? "manual",
    parentRunId: overrides.parentRunId,
    rootRunId: overrides.rootRunId ?? "run-1",
    roleBoundary: overrides.roleBoundary ?? "executor",
    resultContract: overrides.resultContract,
    deliveryTargetId: overrides.deliveryTargetId,
    deliveryTargetLabel: overrides.deliveryTargetLabel,
    sheetName: overrides.sheetName,
    scopedSourceItems: overrides.scopedSourceItems,
    task: overrides.task ?? "执行任务",
    label: overrides.label ?? "执行任务",
    images: overrides.images,
    status: overrides.status ?? "running",
    spawnedAt: overrides.spawnedAt ?? 1,
    completedAt: overrides.completedAt,
    result: overrides.result,
    error: overrides.error,
    timeoutReason: overrides.timeoutReason,
    budgetSeconds: overrides.budgetSeconds ?? 420,
    idleLeaseSeconds: overrides.idleLeaseSeconds ?? 120,
    timeoutId: overrides.timeoutId,
    mode: overrides.mode ?? "run",
    expectsCompletionMessage: overrides.expectsCompletionMessage ?? true,
    cleanup: overrides.cleanup ?? "keep",
    sessionHistoryStartIndex: overrides.sessionHistoryStartIndex ?? 0,
    sessionHistoryEndIndex: overrides.sessionHistoryEndIndex,
    sessionOpen: overrides.sessionOpen ?? false,
    lastActiveAt: overrides.lastActiveAt ?? 1,
    sessionClosedAt: overrides.sessionClosedAt,
    runtime: overrides.runtime,
    contractId: overrides.contractId,
    plannedDelegationId: overrides.plannedDelegationId,
  };
}

function createRuntimeHarness(params?: {
  artifacts?: Array<{
    id: string;
    actorId: string;
    path: string;
    fileName: string;
    directory: string;
    source: "approval" | "message" | "tool_write" | "tool_edit" | "upload";
    summary: string;
    timestamp: number;
    relatedRunId?: string;
    preview?: string;
  }>;
}) {
  const events: Array<{ type: string; detail?: unknown; timestamp: number }> = [];
  const actors = new Map<string, FakeActor>([
    ["coordinator", new FakeActor("coordinator", { name: "Coordinator" })],
    ["worker", new FakeActor("worker", { name: "Worker" })],
  ]);

  const appendAnnounceEvent = vi.fn();
  const announceWithRetry = vi.fn();
  const finalizeSpawnedTaskHistoryWindow = vi.fn();
  const onTaskSettled = vi.fn();
  const runtime = new DialogSubtaskRuntime({
    sessionId: "session-test",
    getActor: (actorId) => actors.get(actorId) as any,
    getActorName: (actorId) => actors.get(actorId)?.role.name ?? actorId,
    getActorNames: () => new Map([...actors.values()].map((actor) => [actor.id, actor.role.name] as const)),
    emitEvent: (event) => {
      events.push({
        type: event.type,
        detail: event.detail,
        timestamp: event.timestamp,
      });
    },
    appendSpawnEvent: vi.fn(),
    appendAnnounceEvent,
    announceWithRetry,
    finalizeSpawnedTaskHistoryWindow,
    cancelPendingInteractionsForActor: vi.fn(() => 0),
    killActor: vi.fn(),
    getArtifactRecordsSnapshot: () => params?.artifacts ?? [],
    onTaskSettled,
  });

  return {
    runtime,
    events,
    actors,
    appendAnnounceEvent,
    announceWithRetry,
    finalizeSpawnedTaskHistoryWindow,
    onTaskSettled,
  };
}

describe("DialogSubtaskRuntime", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAgentTaskManager();
  });

  it("isolates structured child results by ownerTaskId and prunes stale completed scope", () => {
    const { runtime } = createRuntimeHarness();
    runtime.registerRecord(createRecord({
      runId: "run-stale",
      ownerTaskId: "task-stale",
      status: "completed",
      resultContract: "inline_structured_result",
      result: JSON.stringify([
        { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "旧主题", coverageType: "direct", 课程名称: "旧课程", 课程介绍: "旧介绍" },
      ]),
      completedAt: 2,
      runtime: {
        subtaskId: "run-stale",
        profile: "executor",
        startedAt: 1,
        completedAt: 2,
        terminalResult: JSON.stringify([
          { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "旧主题", coverageType: "direct", 课程名称: "旧课程", 课程介绍: "旧介绍" },
        ]),
        timeoutSeconds: 420,
        eventCount: 1,
      },
    }));
    runtime.registerRecord(createRecord({
      runId: "run-current",
      ownerTaskId: "task-current",
      status: "completed",
      resultContract: "inline_structured_result",
      result: JSON.stringify([
        { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "新主题", coverageType: "direct", 课程名称: "新课程", 课程介绍: "新介绍" },
      ]),
      completedAt: 3,
      runtime: {
        subtaskId: "run-current",
        profile: "executor",
        startedAt: 1,
        completedAt: 3,
        terminalResult: JSON.stringify([
          { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "新主题", coverageType: "direct", 课程名称: "新课程", 课程介绍: "新介绍" },
        ]),
        timeoutSeconds: 420,
        eventCount: 1,
      },
    }));

    const filteredResults = runtime.collectStructuredSpawnedTaskResults("coordinator", {
      ownerTaskId: "task-current",
      terminalOnly: true,
    });
    expect(filteredResults.map((result) => result.runId)).toEqual(["run-current"]);

    const removedCount = runtime.pruneCompletedTasksForSpawner("coordinator", {
      excludeOwnerTaskId: "task-current",
    });
    expect(removedCount).toBe(1);
    expect(runtime.getSpawnedTasks("coordinator").map((record) => record.runId)).toEqual(["run-current"]);
  });

  it("aborts stale running child tasks outside the active owner scope", () => {
    const { runtime, actors } = createRuntimeHarness();
    const staleWorker = actors.get("worker");
    if (!staleWorker) throw new Error("missing stale worker");
    const currentWorker = new FakeActor("worker-current", { name: "Current Worker" });
    actors.set("worker-current", currentWorker);

    runtime.registerRecord(createRecord({
      runId: "run-stale-running",
      ownerTaskId: "task-stale",
      targetActorId: "worker",
      status: "running",
      mode: "run",
    }));
    runtime.registerRecord(createRecord({
      runId: "run-current-running",
      ownerTaskId: "task-current",
      targetActorId: "worker-current",
      status: "running",
      mode: "run",
    }));

    const abortedCount = runtime.abortActiveRunTasksForSpawner(
      "coordinator",
      "新的顶层任务已接管当前对话。",
      {
        excludeOwnerTaskId: "task-current",
      },
    );

    expect(abortedCount).toBe(1);
    expect(staleWorker.abort).toHaveBeenCalledWith("新的顶层任务已接管当前对话。");
    expect(currentWorker.abort).not.toHaveBeenCalled();
    expect(runtime.getSpawnedTask("run-stale-running")?.status).toBe("aborted");
    expect(runtime.getSpawnedTask("run-current-running")?.status).toBe("running");
  });

  it("projects streaming child progress into runtime state without waiting for a terminal step", async () => {
    const deferred = createDeferred<{ status: "completed"; result: string }>();
    const { runtime, events, actors } = createRuntimeHarness();
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    worker.assignTask = vi.fn(() => deferred.promise);

    const record = createRecord({
      runId: "run-streaming-1",
      status: "running",
      mode: "run",
    });
    runtime.startTask({
      record,
      target: worker as any,
      fullTask: "执行任务",
      runOverrides: {
        timeoutSeconds: 600,
        idleLeaseSeconds: 180,
      },
    });

    const progressWake = runtime.waitForSpawnedTaskUpdate("coordinator", 1_000);
    worker.emit("step", {
      step: {
        type: "answer",
        content: "正在汇总最终课程结果并生成 Excel 文件",
        streaming: true,
      },
    }, 20);
    await expect(progressWake).resolves.toEqual({ reason: "task_update" });
    expect(record.runtime?.progressSummary).toBe("正在整理表格结果");
    expect(events.find((event) => event.type === "spawned_task_running")).toBeTruthy();

    deferred.resolve({
      status: "completed",
      result: "已创建 /Users/demo/Downloads/courses.xlsx",
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("wakes waiters when progress and terminal results arrive", async () => {
    const deferred = createDeferred<{ status: "completed"; result: string }>();
    const { runtime, events, actors } = createRuntimeHarness();
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    worker.assignTask = vi.fn(() => deferred.promise);

    const record = createRecord({
      runId: "run-progress-1",
      status: "running",
      mode: "run",
    });
    runtime.startTask({
      record,
      target: worker as any,
      fullTask: "执行任务",
      runOverrides: {
        timeoutSeconds: 600,
        idleLeaseSeconds: 180,
      },
    });

    const progressWake = runtime.waitForSpawnedTaskUpdate("coordinator", 1_000);
    worker.emit("step", {
      step: {
        type: "thinking",
        content: "正在处理实现细节",
      },
    }, 20);
    await expect(progressWake).resolves.toEqual({ reason: "task_update" });
    expect(record.runtime?.progressSummary).toBe("正在处理实现细节");

    const terminalWake = runtime.waitForSpawnedTaskUpdate("coordinator", 1_000);
    deferred.resolve({
      status: "completed",
      result: "已创建 /Users/demo/Downloads/index.html",
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(terminalWake).resolves.toEqual({ reason: "task_update" });
    expect(record.status).toBe("completed");
    expect(record.runtime?.terminalResult).toBe("已创建 /Users/demo/Downloads/index.html");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "spawned_task_started",
      "spawned_task_running",
      "spawned_task_completed",
    ]));

    const taskId = resolveAgentTaskIdFromRunId("run-progress-1");
    expect(getAgentTaskManager().get(taskId)).toEqual(expect.objectContaining({
      taskId,
      status: "completed",
      targetName: "Worker",
      result: "已创建 /Users/demo/Downloads/index.html",
    }));
  });

  it("attaches current-run artifacts to structured child results", async () => {
    const { runtime, actors } = createRuntimeHarness({
      artifacts: [
        {
          id: "artifact-1",
          actorId: "worker",
          path: "/Users/demo/Downloads/index.html",
          fileName: "index.html",
          directory: "/Users/demo/Downloads",
          source: "tool_write",
          summary: "导出的网页",
          timestamp: 20,
          relatedRunId: "run-artifact-1",
        },
        {
          id: "artifact-2",
          actorId: "worker",
          path: "/Users/demo/Downloads/old.html",
          fileName: "old.html",
          directory: "/Users/demo/Downloads",
          source: "tool_write",
          summary: "旧网页",
          timestamp: 2,
          relatedRunId: "run-old",
        },
      ],
    });
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    worker.assignTask = vi.fn(async () => ({
      status: "completed" as const,
      result: "已创建 /Users/demo/Downloads/index.html",
    }));

    runtime.startTask({
      record: createRecord({
        runId: "run-artifact-1",
        status: "running",
        mode: "run",
        spawnedAt: 10,
        resultContract: "inline_structured_result",
        deliveryTargetLabel: "技术方向课程",
        sheetName: "技术方向课程",
      }),
      target: worker as any,
      fullTask: "执行任务",
      runOverrides: {
        timeoutSeconds: 600,
        idleLeaseSeconds: 180,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    const result = runtime.getStructuredSubtaskResult("run-artifact-1");
    expect(result?.resultContract).toBe("inline_structured_result");
    expect(result?.deliveryTargetLabel).toBe("技术方向课程");
    expect(result?.sheetName).toBe("技术方向课程");
    expect(result?.artifacts).toEqual([
      expect.objectContaining({
        path: "/Users/demo/Downloads/index.html",
        source: "tool_write",
        relatedRunId: "run-artifact-1",
      }),
    ]);
  });

  it("hydrates structured rows from current-run json artifacts before coordinator follow-up", async () => {
    const { runtime, actors } = createRuntimeHarness({
      artifacts: [
        {
          id: "artifact-json-1",
          actorId: "worker",
          path: "/Users/demo/Downloads/courses.json",
          fileName: "courses.json",
          directory: "/Users/demo/Downloads",
          source: "tool_write",
          summary: "课程 JSON",
          fullContent: JSON.stringify([
            {
              courseName: "AI应用知识库构建实战",
              courseIntro: "面向研发与运维的知识库课程",
              sourceItemId: "topic-1",
            },
            {
              courseName: "AI安全风险与防护体系",
              courseIntro: "覆盖常见安全风险与治理",
              sourceItemId: "topic-2",
            },
          ]),
          timestamp: 20,
          relatedRunId: "run-json-artifact-1",
        },
      ],
    });
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    worker.assignTask = vi.fn(async () => ({
      status: "completed" as const,
      result: "已生成文件：/Users/demo/Downloads/courses.json",
    }));

    runtime.startTask({
      record: createRecord({
        runId: "run-json-artifact-1",
        status: "running",
        mode: "run",
        spawnedAt: 10,
        resultContract: "inline_structured_result",
        deliveryTargetLabel: "技术方向课程",
        sheetName: "技术方向课程",
      }),
      target: worker as any,
      fullTask: "执行任务",
      runOverrides: {
        timeoutSeconds: 600,
        idleLeaseSeconds: 180,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    const result = runtime.getStructuredSubtaskResult("run-json-artifact-1");
    expect(result?.resultKind).toBe("structured_rows");
    expect(result?.rowCount).toBe(2);
    expect(result?.schemaFields).toEqual(expect.arrayContaining(["courseName", "courseIntro", "sourceItemId"]));
    expect(result?.structuredRows).toEqual([
      expect.objectContaining({
        courseName: "AI应用知识库构建实战",
        courseIntro: "面向研发与运维的知识库课程",
        sourceItemId: "topic-1",
      }),
      expect.objectContaining({
        courseName: "AI安全风险与防护体系",
        courseIntro: "覆盖常见安全风险与治理",
        sourceItemId: "topic-2",
      }),
    ]);
  });

  it("preserves scoped source shards in structured child results", async () => {
    const { runtime, actors } = createRuntimeHarness();
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    worker.assignTask = vi.fn(async () => ({
      status: "completed" as const,
      result: JSON.stringify({
        rows: [
          {
            sourceItemId: "source-item-7",
            topicIndex: 7,
            topicTitle: "银行AI解决方案咨询方法论",
            课程名称: "银行 AI 咨询方法论实战",
          },
        ],
      }),
    }));

    runtime.startTask({
      record: createRecord({
        runId: "run-scoped-shard-1",
        status: "running",
        mode: "run",
        spawnedAt: 10,
        resultContract: "inline_structured_result",
        deliveryTargetLabel: "技术方向课程",
        sheetName: "技术方向课程",
        scopedSourceItems: [
          {
            id: "source-item-7",
            label: "银行AI解决方案咨询方法论",
            order: 7,
            topicIndex: 7,
            topicTitle: "银行AI解决方案咨询方法论",
          },
        ],
      }),
      target: worker as any,
      fullTask: "执行任务",
      runOverrides: {
        timeoutSeconds: 600,
        idleLeaseSeconds: 180,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    const result = runtime.getStructuredSubtaskResult("run-scoped-shard-1");
    expect(result?.scopedSourceItems).toEqual([
      expect.objectContaining({
        id: "source-item-7",
        topicTitle: "银行AI解决方案咨询方法论",
      }),
    ]);
    expect(result?.structuredRows).toEqual([
      expect.objectContaining({
        sourceItemId: "source-item-7",
      }),
    ]);
  });

  it("does not treat summary-only inline structured results as valid coverage", async () => {
    const { runtime, actors } = createRuntimeHarness();
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    worker.assignTask = vi.fn(async () => ({
      status: "completed" as const,
      result: "已处理完毕，共 3 条，请协调者继续汇总。",
    }));

    runtime.startTask({
      record: createRecord({
        runId: "run-summary-only-1",
        status: "running",
        mode: "run",
        spawnedAt: 10,
        resultContract: "inline_structured_result",
        deliveryTargetLabel: "结果清单",
        sheetName: "结果清单",
      }),
      target: worker as any,
      fullTask: "执行任务",
      runOverrides: {
        timeoutSeconds: 600,
        idleLeaseSeconds: 180,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    const result = runtime.getStructuredSubtaskResult("run-summary-only-1");
    expect(result?.resultKind).toBe("blocker");
    expect(result?.structuredRows).toEqual([]);
    expect(result?.blocker).toContain("inline_structured_result");
  });

  it("keeps child completion announces compact once structured results are available", async () => {
    const { runtime, actors, announceWithRetry } = createRuntimeHarness({
      artifacts: [
        {
          id: "artifact-announce-1",
          actorId: "worker",
          path: "/Users/demo/Downloads/courses.xlsx",
          fileName: "courses.xlsx",
          directory: "/Users/demo/Downloads",
          source: "tool_write",
          summary: "导出的 Excel",
          timestamp: 20,
          relatedRunId: "run-announce-1",
        },
      ],
    });
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    worker.assignTask = vi.fn(async () => ({
      status: "completed" as const,
      result: "这里是很长很长的课程生成正文，这段内容不应该原样出现在父 Agent 的完成通知里，而应由结构化结果接管。",
    }));

    runtime.startTask({
      record: createRecord({
        runId: "run-announce-1",
        status: "running",
        mode: "run",
        spawnedAt: 10,
      }),
      target: worker as any,
      fullTask: "执行任务",
      runOverrides: {
        timeoutSeconds: 600,
        idleLeaseSeconds: 180,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(announceWithRetry).toHaveBeenCalledWith(
      "worker",
      "coordinator",
      expect.stringContaining("已完成，产物：/Users/demo/Downloads/courses.xlsx"),
      "run-announce-1",
    );
    expect(String(announceWithRetry.mock.calls[0]?.[2] ?? "")).toContain("结构化结果已回传协调者");
    expect(String(announceWithRetry.mock.calls[0]?.[2] ?? "")).not.toContain("很长很长的课程生成正文");
  });

  it("clears terminal fields when a spawned session is resumed and records the next terminal snapshot", () => {
    const { runtime } = createRuntimeHarness();
    const record = createRecord({
      runId: "run-session-1",
      targetActorId: "worker",
      mode: "session",
      sessionOpen: true,
      status: "completed",
      completedAt: 60,
      result: "旧结果",
      runtime: {
        subtaskId: "run-session-1",
        profile: "validator",
        startedAt: 10,
        completedAt: 60,
        terminalResult: "旧结果",
        timeoutSeconds: 600,
        eventCount: 2,
      },
    });

    runtime.restoreRecord(record);
    runtime.resetSessionTaskForResume(record, {
      timestamp: 80,
      label: "继续验证",
      reopenSession: true,
    });

    expect(record.status).toBe("running");
    expect(record.label).toBe("继续验证");
    expect(record.result).toBeUndefined();
    expect(record.error).toBeUndefined();
    expect(record.runtime?.terminalResult).toBeUndefined();
    expect(record.runtime?.terminalError).toBeUndefined();

    runtime.markSessionTaskEnded("worker", "completed", 120, {
      result: "新的验证结果",
    });

    expect(record.completedAt).toBe(120);
    expect(record.runtime?.terminalResult).toBe("新的验证结果");
  });

  it("reconciles restored running tasks into interrupted terminal states", () => {
    const { runtime, events, finalizeSpawnedTaskHistoryWindow, onTaskSettled } = createRuntimeHarness();
    const record = createRecord({
      runId: "run-restored-1",
      status: "running",
      mode: "run",
    });

    runtime.restoreRecord(record);

    expect(record.status).toBe("aborted");
    expect(record.error).toContain("无法自动续跑");
    expect(record.runtime?.terminalError).toContain("无法自动续跑");
    expect(finalizeSpawnedTaskHistoryWindow).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === "spawned_task_failed")).toBeTruthy();
    expect(onTaskSettled).toHaveBeenCalledWith(expect.objectContaining({
      record,
      status: "aborted",
    }));
    expect(getAgentTaskManager().getByRunId("run-restored-1")).toEqual(expect.objectContaining({
      status: "aborted",
      error: expect.stringContaining("无法自动续跑"),
    }));
  });

  it("rebinds projected task records when the runtime adopts a restored session id", () => {
    const { runtime } = createRuntimeHarness();
    const record = createRecord({
      runId: "run-rebind-session-1",
      status: "completed",
      completedAt: 5,
      result: "已完成",
    });

    runtime.restoreRecord(record);
    expect(getAgentTaskManager().getByRunId("run-rebind-session-1")).toEqual(expect.objectContaining({
      sessionId: "session-test",
      status: "completed",
    }));

    runtime.replaceSessionId("session-restored");

    expect(getAgentTaskManager().list({ sessionId: "session-test" })).toEqual([]);
    expect(getAgentTaskManager().getByRunId("run-rebind-session-1")).toEqual(expect.objectContaining({
      sessionId: "session-restored",
      status: "completed",
    }));
  });

  it("keeps restored child sessions open while marking interrupted execution as aborted", () => {
    const { runtime } = createRuntimeHarness();
    const record = createRecord({
      runId: "run-restored-session-1",
      status: "running",
      mode: "session",
      sessionOpen: true,
    });

    runtime.restoreRecord(record);

    expect(record.status).toBe("aborted");
    expect(record.sessionOpen).toBe(true);
    expect(record.error).toContain("可以继续向该子会话发送消息");

    runtime.resetSessionTaskForResume(record, {
      reopenSession: true,
    });
    expect(record.status).toBe("running");
    expect(record.runtime?.terminalError).toBeUndefined();
  });

  it("projects pending session messages into the agent task view", () => {
    const { runtime, actors } = createRuntimeHarness();
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    const record = createRecord({
      runId: "run-session-pending-1",
      targetActorId: "worker",
      mode: "session",
      sessionOpen: true,
      status: "completed",
      completedAt: 60,
    });

    runtime.restoreRecord(record);
    worker.pendingInboxCount = 2;
    runtime.refreshTaskProjection("run-session-pending-1");

    const taskId = resolveAgentTaskIdFromRunId("run-session-pending-1");
    expect(getAgentTaskManager().get(taskId)).toEqual(expect.objectContaining({
      pendingMessageCount: 2,
    }));

    worker.pendingInboxCount = 0;
    runtime.markSessionTaskStarted("worker", 90);

    expect(getAgentTaskManager().get(taskId)).toEqual(expect.objectContaining({
      status: "running",
      pendingMessageCount: 0,
      recentActivity: expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          summary: "待处理消息已清空",
        }),
      ]),
    }));
  });

  it("converts rejected child runs into structured failures", async () => {
    const deferred = createDeferred<never>();
    const { runtime, events, actors, appendAnnounceEvent } = createRuntimeHarness();
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    worker.assignTask = vi.fn(() => deferred.promise);

    const record = createRecord({
      runId: "run-reject-1",
      status: "running",
      mode: "run",
    });
    runtime.startTask({
      record,
      target: worker as any,
      fullTask: "执行任务",
      runOverrides: {
        timeoutSeconds: 600,
        idleLeaseSeconds: 180,
      },
    });

    deferred.reject(new Error("worker crashed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(record.status).toBe("error");
    expect(record.error).toBe("worker crashed");
    expect(appendAnnounceEvent).toHaveBeenCalledWith("run-reject-1", "error", undefined, "worker crashed");
    expect(events.find((event) => event.type === "spawned_task_failed")).toBeTruthy();
  });

  it("ignores duplicate aborts after a task has already reached a terminal state", () => {
    const { runtime, events, actors } = createRuntimeHarness();
    const worker = actors.get("worker");
    if (!worker) throw new Error("missing worker");
    const record = createRecord({
      runId: "run-abort-1",
      status: "running",
    });

    runtime.registerRecord(record);
    runtime.abortTask(record, {
      error: "手动终止",
      targetActor: worker as any,
    });
    runtime.abortTask(record, {
      error: "重复终止",
      targetActor: worker as any,
    });

    expect(worker.abort).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "spawned_task_failed")).toHaveLength(1);
    expect(record.error).toBe("手动终止");
  });
});
