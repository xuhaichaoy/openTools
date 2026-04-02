import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskQueue } from "./task-queue";

const STORAGE_KEY = "mtools_task_center";

describe("TaskQueue", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("does not schedule agent_spawn tasks for executor replay", () => {
    const queue = new TaskQueue();
    const execute = vi.fn(async () => undefined);
    queue.setExecutor({ execute });

    queue.create({
      id: "spawn-run-1",
      title: "结果清单生成（第1组）",
      description: "为主题1-6生成课程结果",
      type: "agent_spawn",
      priority: "normal",
      params: {
        runId: "run-1",
      },
      createdBy: "Lead",
      assignee: "Worker",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(queue.get("spawn-run-1")?.status).toBe("pending");

    queue.create({
      id: "chat-run-1",
      title: "普通任务",
      description: "继续处理用户问题",
      type: "agent_chat",
      priority: "normal",
      params: {},
      createdBy: "user",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.get("chat-run-1")?.status).toBe("running");
  });

  it("drops persisted agent_spawn tasks on restore", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      {
        id: "spawn-stale-1",
        title: "旧的子任务",
        description: "旧的 agent spawn",
        type: "agent_spawn",
        priority: "normal",
        params: { runId: "run-stale-1" },
        createdBy: "Lead",
        assignee: "Worker",
        status: "queued",
        createdAt: 1,
        retryCount: 0,
      },
      {
        id: "chat-stale-1",
        title: "恢复后的普通任务",
        description: "恢复执行",
        type: "agent_chat",
        priority: "normal",
        params: {},
        createdBy: "user",
        status: "running",
        createdAt: 2,
        retryCount: 0,
      },
    ]));

    const queue = new TaskQueue();

    expect(queue.get("spawn-stale-1")).toBeUndefined();
    expect(queue.get("chat-stale-1")).toEqual(expect.objectContaining({
      status: "queued",
    }));
  });
});
