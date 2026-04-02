import { beforeEach, describe, expect, it } from "vitest";

import { type SpawnedTaskRecord } from "@/core/agent/actor/types";
import {
  getAgentTaskManager,
  resetAgentTaskManager,
  resolveDeferredAgentTaskIdFromQueueId,
  resolveAgentTaskIdFromRunId,
} from "./index";

function createRecord(overrides: Partial<SpawnedTaskRecord> = {}): SpawnedTaskRecord {
  return {
    runId: overrides.runId ?? "run-1",
    spawnerActorId: overrides.spawnerActorId ?? "coordinator",
    targetActorId: overrides.targetActorId ?? "worker",
    dispatchSource: overrides.dispatchSource ?? "manual",
    parentRunId: overrides.parentRunId,
    rootRunId: overrides.rootRunId ?? (overrides.runId ?? "run-1"),
    roleBoundary: overrides.roleBoundary ?? "executor",
    workerProfileId: overrides.workerProfileId,
    executionIntent: overrides.executionIntent,
    resultContract: overrides.resultContract,
    deliveryTargetId: overrides.deliveryTargetId,
    deliveryTargetLabel: overrides.deliveryTargetLabel,
    sheetName: overrides.sheetName,
    sourceItemIds: overrides.sourceItemIds,
    sourceItemCount: overrides.sourceItemCount,
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

describe("AgentTaskManager", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAgentTaskManager();
  });

  it("creates stable agent tasks from spawned task lifecycle", () => {
    const manager = getAgentTaskManager();
    const running = createRecord({
      runId: "run-stable-1",
      runtime: {
        subtaskId: "run-stable-1",
        profile: "executor",
        progressSummary: "正在扫描项目结构",
        startedAt: 10,
        timeoutSeconds: 600,
        eventCount: 2,
        toolUseCount: 1,
        lastToolName: "read_file",
        lastToolAt: 18,
      },
      spawnedAt: 10,
      lastActiveAt: 20,
    });

    manager.syncSpawnedTask({
      sessionId: "session-1",
      record: running,
      spawnerName: "Coordinator",
      targetName: "Worker",
    });

    const taskId = resolveAgentTaskIdFromRunId("run-stable-1");
    expect(manager.getByRunId("run-stable-1")?.taskId).toBe(taskId);
    expect(manager.get(taskId)).toEqual(expect.objectContaining({
      taskId,
      sessionId: "session-1",
      status: "running",
      spawnerName: "Coordinator",
      targetName: "Worker",
      recentActivitySummary: "正在扫描项目结构",
      progress: expect.objectContaining({
        toolUseCount: 1,
        latestToolName: "read_file",
        latestToolAt: 18,
      }),
    }));
    expect(manager.listNotifications({ taskId })).toEqual([
      expect.objectContaining({
        taskId,
        status: "running",
      }),
    ]);

    manager.syncSpawnedTask({
      sessionId: "session-1",
      record: createRecord({
        ...running,
        status: "completed",
        completedAt: 80,
        result: "已完成实现并通过验证",
        runtime: {
          subtaskId: "run-stable-1",
          profile: "executor",
          startedAt: 10,
          completedAt: 80,
          terminalResult: "已完成实现并通过验证，产物：/tmp/index.html",
          timeoutSeconds: 600,
          eventCount: 5,
          toolUseCount: 3,
          lastToolName: "write_file",
          lastToolAt: 66,
        },
      }),
      spawnerName: "Coordinator",
      targetName: "Worker",
    });

    expect(manager.get(taskId)).toEqual(expect.objectContaining({
      status: "completed",
      result: "已完成实现并通过验证，产物：/tmp/index.html",
      outputSummary: "已完成实现并通过验证，产物：/tmp/index.html",
      outputFile: "/tmp/index.html",
    }));
    expect(manager.listOutputs(taskId)).toEqual([
      expect.objectContaining({
        taskId,
        kind: "result",
        content: "已完成实现并通过验证，产物：/tmp/index.html",
      }),
    ]);
    expect(manager.listNotifications({ taskId }).map((item) => item.status)).toEqual([
      "completed",
      "running",
    ]);
  });

  it("deduplicates same-status refreshes while keeping progress activity", () => {
    const manager = getAgentTaskManager();
    const record = createRecord({
      runId: "run-refresh-1",
      runtime: {
        subtaskId: "run-refresh-1",
        profile: "executor",
        progressSummary: "正在读取文件",
        startedAt: 1,
        timeoutSeconds: 600,
        eventCount: 1,
      },
      lastActiveAt: 2,
    });

    manager.syncSpawnedTask({
      sessionId: "session-2",
      record,
      targetName: "Worker",
    });
    manager.syncSpawnedTask({
      sessionId: "session-2",
      record: createRecord({
        ...record,
        lastActiveAt: 5,
        runtime: {
          subtaskId: "run-refresh-1",
          profile: "executor",
          progressSummary: "正在更新实现",
          startedAt: 1,
          timeoutSeconds: 600,
          eventCount: 2,
        },
      }),
      targetName: "Worker",
    });

    const task = manager.getByRunId("run-refresh-1");
    expect(task?.recentActivity.filter((item) => item.kind === "progress")).toEqual([
      expect.objectContaining({ summary: "正在更新实现" }),
    ]);
    expect(manager.listNotifications({ taskId: resolveAgentTaskIdFromRunId("run-refresh-1") })).toHaveLength(1);
  });

  it("records tool activity when tool usage changes", () => {
    const manager = getAgentTaskManager();

    manager.syncSpawnedTask({
      sessionId: "session-tools",
      record: createRecord({
        runId: "run-tools-1",
        runtime: {
          subtaskId: "run-tools-1",
          profile: "executor",
          progressSummary: "正在读取文件",
          startedAt: 1,
          timeoutSeconds: 600,
          eventCount: 1,
          toolUseCount: 1,
          lastToolName: "read_file",
          lastToolAt: 3,
        },
        lastActiveAt: 3,
      }),
      targetName: "Worker",
    });

    manager.syncSpawnedTask({
      sessionId: "session-tools",
      record: createRecord({
        runId: "run-tools-1",
        runtime: {
          subtaskId: "run-tools-1",
          profile: "executor",
          progressSummary: "正在写入结果",
          startedAt: 1,
          timeoutSeconds: 600,
          eventCount: 2,
          toolUseCount: 2,
          lastToolName: "write_file",
          lastToolAt: 6,
        },
        lastActiveAt: 6,
      }),
      targetName: "Worker",
    });

    const task = manager.getByRunId("run-tools-1");
    expect(task?.progress).toEqual(expect.objectContaining({
      toolUseCount: 2,
      latestToolName: "write_file",
      latestToolAt: 6,
    }));
    expect(task?.recentActivity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool",
        summary: "调用工具 write_file",
      }),
    ]));
  });

  it("tracks deferred queued tasks before they are dispatched", () => {
    const manager = getAgentTaskManager();

    manager.syncDeferredTask({
      queueId: "queued-1",
      sessionId: "session-queued",
      spawnerActorId: "coordinator",
      targetActorId: "planner",
      task: "先输出执行计划",
      queuedAt: 15,
      label: "执行计划",
      mode: "run",
      roleBoundary: "general",
      workerProfileId: "general_worker",
      executionIntent: "general",
      spawnerName: "Coordinator",
      targetName: "Planner",
    });

    const taskId = resolveDeferredAgentTaskIdFromQueueId("queued-1");
    expect(manager.get(taskId)).toEqual(expect.objectContaining({
      taskId,
      sessionId: "session-queued",
      status: "queued",
      targetName: "Planner",
      recentActivitySummary: "执行计划 等待派发",
    }));

    manager.failDeferredTask({
      queueId: "queued-1",
      sessionId: "session-queued",
      spawnerActorId: "coordinator",
      targetActorId: "planner",
      task: "先输出执行计划",
      queuedAt: 20,
      label: "执行计划",
      error: "Target planner not found",
    });

    expect(manager.get(taskId)).toEqual(expect.objectContaining({
      status: "failed",
      error: "Target planner not found",
    }));

    expect(manager.removeDeferredTask("queued-1")).toBe(true);
    expect(manager.get(taskId)).toBeUndefined();
  });
});
