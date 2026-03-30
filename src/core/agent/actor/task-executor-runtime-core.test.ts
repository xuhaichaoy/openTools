import { describe, expect, it, vi } from "vitest";

import {
  applyTaskExecutorLifecycle,
  ensureTaskExecutorRuntime,
  resetTaskExecutorRuntimeForResume,
  TaskExecutorRuntimeCore,
} from "./task-executor-runtime-core";

describe("TaskExecutorRuntimeCore", () => {
  it("stores records and prunes settled ones", () => {
    const core = new TaskExecutorRuntimeCore<{
      runId: string;
      status: "running" | "completed";
    }>();

    core.registerRecord({ runId: "run-1", status: "running" });
    core.registerRecord({ runId: "run-2", status: "completed" });

    const removed = core.pruneRecords((record) => record.status === "completed");

    expect(removed).toBe(1);
    expect(core.getRecord("run-1")).toEqual({ runId: "run-1", status: "running" });
    expect(core.getRecord("run-2")).toBeUndefined();
  });

  it("wakes owner waiters on updates", async () => {
    const core = new TaskExecutorRuntimeCore<{ runId: string }>();
    const waiting = core.waitForOwnerUpdate("lead", 1000);

    core.notifyOwnerUpdate("lead");

    await expect(waiting).resolves.toEqual({ reason: "task_update" });
  });

  it("throttles owner wake-ups when a minimum interval is configured", async () => {
    vi.useFakeTimers();
    const core = new TaskExecutorRuntimeCore<{ runId: string }>();
    const firstWait = core.waitForOwnerUpdate("lead", 1000);

    expect(core.notifyOwnerUpdate("lead", { minIntervalMs: 2_000 })).toBe(true);
    await expect(firstWait).resolves.toEqual({ reason: "task_update" });

    const secondWait = core.waitForOwnerUpdate("lead", 1000);
    expect(core.notifyOwnerUpdate("lead", { minIntervalMs: 2_000 })).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(secondWait).resolves.toEqual({ reason: "timeout" });
    vi.useRealTimers();
  });

  it("throttles duplicate streaming progress snapshots", () => {
    const core = new TaskExecutorRuntimeCore<{ runId: string }>();

    expect(core.shouldEmitProgressSnapshot({
      runId: "run-stream",
      summary: "正在处理页面",
      timestamp: 1000,
      streaming: true,
    })).toBe(true);

    expect(core.shouldEmitProgressSnapshot({
      runId: "run-stream",
      summary: "正在处理页面",
      timestamp: 1600,
      streaming: true,
    })).toBe(false);

    expect(core.shouldEmitProgressSnapshot({
      runId: "run-stream",
      summary: "正在处理页面并生成结果文件",
      timestamp: 2600,
      streaming: true,
    })).toBe(true);
  });

  it("detects budget and idle timeout triggers", () => {
    const core = new TaskExecutorRuntimeCore<{ runId: string }>();

    expect(core.detectTimeoutTrigger({
      now: 5000,
      isRunning: true,
      startedAt: 1000,
      lastActiveAt: 4500,
      budgetSeconds: 3,
      idleLeaseSeconds: 30,
    })).toEqual({
      reason: "budget",
      now: 5000,
      durationMs: 4000,
      thresholdSeconds: 3,
    });

    expect(core.detectTimeoutTrigger({
      now: 5000,
      isRunning: true,
      startedAt: 1000,
      lastActiveAt: 1500,
      budgetSeconds: 0,
      idleLeaseSeconds: 3,
    })).toEqual({
      reason: "idle",
      now: 5000,
      durationMs: 4000,
      thresholdSeconds: 3,
    });
  });

  it("attaches timeout monitors and settles terminal transitions once", async () => {
    vi.useFakeTimers();
    const core = new TaskExecutorRuntimeCore<{
      runId: string;
      timeoutId?: ReturnType<typeof setInterval>;
      status: "running" | "aborted";
      startedAt: number;
      lastActiveAt: number;
      budgetSeconds: number;
      idleLeaseSeconds: number;
    }>();
    const timeoutRecord = {
      runId: "run-timeout",
      status: "running" as const,
      startedAt: 1000,
      lastActiveAt: 1000,
      budgetSeconds: 0,
      idleLeaseSeconds: 2,
    };
    const onTimeout = vi.fn();

    core.attachTimeoutMonitor({
      record: timeoutRecord,
      intervalMs: 1000,
      isRunning: (item) => item.status === "running",
      getStartedAt: (item) => item.startedAt,
      getLastActiveAt: (item) => item.lastActiveAt,
      getBudgetSeconds: (item) => item.budgetSeconds,
      getIdleLeaseSeconds: (item) => item.idleLeaseSeconds,
      onTimeout: (trigger) => {
        onTimeout(trigger);
        timeoutRecord.status = "aborted";
        core.clearTimeoutMonitor(timeoutRecord);
      },
    });

    await vi.advanceTimersByTimeAsync(2100);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({
      reason: "idle",
      thresholdSeconds: 2,
    }));

    const settleRecord = {
      runId: "run-settle",
      status: "running" as "running" | "aborted",
      startedAt: 1000,
      lastActiveAt: 1000,
      budgetSeconds: 0,
      idleLeaseSeconds: 0,
    };
    let transitionCount = 0;
    const first = core.settleRecord({
      canTransition: () => settleRecord.status === "running",
      settledAt: 4000,
      apply: () => {
        transitionCount += 1;
        settleRecord.status = "aborted";
      },
    });
    const second = core.settleRecord({
      canTransition: () => settleRecord.status === "running",
      settledAt: 5000,
      apply: () => {
        transitionCount += 1;
      },
    });

    expect(first).toEqual({ transitioned: true, settledAt: 4000 });
    expect(second).toEqual({ transitioned: false, settledAt: 5000 });
    expect(transitionCount).toBe(1);

    core.clearTimeoutMonitor(timeoutRecord);
    vi.useRealTimers();
  });

  it("applies shared lifecycle patches and resets runtime snapshots", () => {
    const record = {
      runId: "run-lifecycle",
      status: "running" as "running" | "completed",
      spawnedAt: 10,
      budgetSeconds: 120,
      lastActiveAt: 10,
    };

    const runtime = ensureTaskExecutorRuntime(record, {
      subtaskId: "subtask-lifecycle",
      profile: "executor",
      timeoutSeconds: 120,
    });
    expect(runtime).toEqual({
      subtaskId: "subtask-lifecycle",
      profile: "executor",
      startedAt: 10,
      timeoutSeconds: 120,
      eventCount: 0,
    });

    applyTaskExecutorLifecycle(record, {
      progressSummary: "正在整理验证结果",
      lastActiveAt: 30,
    }, {
      fallbackProfile: "executor",
    });
    expect(record.runtime?.progressSummary).toBe("正在整理验证结果");
    expect(record.lastActiveAt).toBe(30);
    expect(record.runtime?.eventCount).toBe(1);

    applyTaskExecutorLifecycle(record, {
      status: "completed",
      completedAt: 80,
      terminalResult: "已输出最终报告",
    }, {
      fallbackProfile: "executor",
    });
    expect(record.status).toBe("completed");
    expect(record.completedAt).toBe(80);
    expect(record.result).toBe("已输出最终报告");
    expect(record.runtime?.terminalResult).toBe("已输出最终报告");

    resetTaskExecutorRuntimeForResume(record, {
      subtaskId: "subtask-lifecycle",
      profile: "executor",
      timeoutSeconds: 120,
    });
    expect(record.completedAt).toBeUndefined();
    expect(record.result).toBeUndefined();
    expect(record.error).toBeUndefined();
    expect(record.runtime?.completedAt).toBeUndefined();
    expect(record.runtime?.terminalResult).toBeUndefined();
    expect(record.runtime?.terminalError).toBeUndefined();
  });
});
