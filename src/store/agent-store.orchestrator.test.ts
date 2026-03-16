import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentScheduledTask } from "@/core/ai/types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/core/errors", () => ({
  handleError: vi.fn(),
}));

import { getHiddenAgentTasks, getVisibleAgentTasks, useAgentStore } from "./agent-store";

function mkTask(id: string, status: AgentScheduledTask["status"] = "pending"): AgentScheduledTask {
  const now = Date.now();
  return {
    id,
    query: `task-${id}`,
    status,
    retry_count: 0,
    created_at: now,
    updated_at: now,
    schedule_type: "interval",
    schedule_value: "60000",
  };
}

function resetStore() {
  useAgentStore.setState({
    sessions: [],
    scheduledTasks: [],
    currentSessionId: null,
    historyLoaded: false,
  });
}

describe("agent-store orchestrator", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
  });

  it("should load and create scheduled tasks", async () => {
    const existing = mkTask("a");
    invokeMock.mockResolvedValueOnce([existing]);

    await useAgentStore.getState().loadScheduledTasks();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "agent_task_list");
    expect(useAgentStore.getState().scheduledTasks).toEqual([existing]);

    const created = mkTask("b");
    invokeMock.mockResolvedValueOnce(created);
    await useAgentStore.getState().createScheduledTask({
      query: created.query,
      scheduleType: "interval",
      scheduleValue: "60000",
      sessionId: "s-1",
    });

    expect(invokeMock).toHaveBeenNthCalledWith(2, "agent_task_create", {
      query: created.query,
      sessionId: "s-1",
      scheduleType: "interval",
      scheduleValue: "60000",
    });

    const tasks = useAgentStore.getState().scheduledTasks;
    expect(tasks.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("should support pause/resume/cancel and patch updates", async () => {
    const base = mkTask("x");
    useAgentStore.setState({ scheduledTasks: [base] });
    invokeMock.mockResolvedValue(null);

    await useAgentStore.getState().pauseScheduledTask("x");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "agent_task_pause", { taskId: "x" });
    expect(useAgentStore.getState().scheduledTasks[0]?.status).toBe("paused");

    await useAgentStore.getState().resumeScheduledTask("x");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "agent_task_resume", { taskId: "x" });
    expect(useAgentStore.getState().scheduledTasks[0]?.status).toBe("pending");

    await useAgentStore.getState().cancelScheduledTask("x");
    expect(invokeMock).toHaveBeenNthCalledWith(3, "agent_task_cancel", { taskId: "x" });
    expect(useAgentStore.getState().scheduledTasks[0]?.status).toBe("cancelled");

    useAgentStore.getState().upsertScheduledTask({
      ...base,
      query: "task-x-updated",
      status: "running",
    });
    expect(useAgentStore.getState().scheduledTasks[0]?.query).toBe("task-x-updated");
    expect(useAgentStore.getState().scheduledTasks[0]?.status).toBe("running");

    useAgentStore.getState().applyScheduledTaskPatch({
      task_id: "x",
      status: "error",
      retry_count: 2,
      next_run_at: 123456,
      last_error: "boom",
      last_started_at: 100,
      last_finished_at: 200,
      last_duration_ms: 100,
      last_result_status: "error",
      last_skip_reason: "manual_skip",
      updated_at: Date.now(),
    });

    const patched = useAgentStore.getState().scheduledTasks[0];
    expect(patched?.status).toBe("error");
    expect(patched?.retry_count).toBe(2);
    expect(patched?.next_run_at).toBe(123456);
    expect(patched?.last_error).toBe("boom");
    expect(patched?.last_duration_ms).toBe(100);
    expect(patched?.last_result_status).toBe("error");
    expect(patched?.last_skip_reason).toBe("manual_skip");

    useAgentStore.getState().applyScheduledTaskSkipped({
      task_id: "x",
      reason: "overlap_running",
      skipped_at: Date.now(),
      next_run_at: 999999,
    });
    expect(useAgentStore.getState().scheduledTasks[0]?.status).toBe("error");
    expect(useAgentStore.getState().scheduledTasks[0]?.last_result_status).toBe("skipped");
    expect(useAgentStore.getState().scheduledTasks[0]?.last_skip_reason).toBe("overlap_running");
    expect(useAgentStore.getState().scheduledTasks[0]?.next_run_at).toBe(999999);
  });

  it("should support revert, fork and follow-up queue on sessions", () => {
    vi.useFakeTimers();

    const store = useAgentStore.getState();
    const sessionId = store.createSession("第一步");
    store.addTask(sessionId, "第二步");
    store.setCurrentSession(sessionId);

    store.revertCurrentSessionToPreviousTask();
    const reverted = useAgentStore.getState().getCurrentSession();
    expect(getVisibleAgentTasks(reverted!)).toHaveLength(1);
    expect(getHiddenAgentTasks(reverted!)).toHaveLength(1);

    store.enqueueFollowUp(sessionId, {
      query: "完成后继续第三步",
      systemHint: "继续上下文",
    });
    expect(useAgentStore.getState().getCurrentSession()?.followUpQueue).toHaveLength(1);

    const forkedId = store.forkSession(sessionId, { visibleOnly: true });
    expect(forkedId).toBeTruthy();
    const forked = useAgentStore
      .getState()
      .sessions.find((session) => session.id === forkedId);
    expect(forked?.forkMeta?.parentSessionId).toBe(sessionId);
    expect(getVisibleAgentTasks(forked!)).toHaveLength(1);
    expect(forked?.followUpQueue).toEqual([]);

    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
});
