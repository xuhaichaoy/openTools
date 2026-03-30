import { describe, expect, it, vi } from "vitest";

import {
  DialogSubtaskRuntime,
  type DialogStructuredSubtaskResult,
} from "./dialog-subtask-runtime";
import type { SpawnedTaskRecord } from "./types";

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
    targetActorId: overrides.targetActorId ?? "worker",
    dispatchSource: overrides.dispatchSource ?? "manual",
    parentRunId: overrides.parentRunId,
    rootRunId: overrides.rootRunId ?? "run-1",
    roleBoundary: overrides.roleBoundary ?? "executor",
    resultContract: overrides.resultContract,
    deliveryTargetId: overrides.deliveryTargetId,
    deliveryTargetLabel: overrides.deliveryTargetLabel,
    sheetName: overrides.sheetName,
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
