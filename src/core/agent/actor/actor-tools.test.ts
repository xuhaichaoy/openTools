import { describe, expect, it, vi } from "vitest";
import { createActorCommunicationTools } from "./actor-tools";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "path_exists") return true;
    throw new Error(`unexpected invoke: ${command}`);
  }),
}));

describe("createActorCommunicationTools", () => {
  it("reads inherited images lazily when spawn_task executes", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-1",
      mode: "run" as const,
      label: "实现页面",
      targetActorId: "specialist",
    }));

    let latestImages = ["/tmp/initial-design.png"];
    const system = {
      get: (id: string) => ({ id, role: { name: id === "specialist" ? "Specialist" : "Coordinator" } }),
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system, {
      getInheritedImages: () => latestImages,
    });
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    await spawnTool.execute({
      target_agent: "specialist",
      task: "根据最新设计稿实现页面",
    });
    expect(spawnTask).toHaveBeenLastCalledWith(
      "coordinator",
      "specialist",
      "根据最新设计稿实现页面",
      expect.objectContaining({
        images: ["/tmp/initial-design.png"],
      }),
    );

    latestImages = ["/tmp/revised-design.png"];
    await spawnTool.execute({
      target_agent: "specialist",
      task: "继续按更新设计稿修正细节",
    });
    expect(spawnTask).toHaveBeenLastCalledWith(
      "coordinator",
      "specialist",
      "继续按更新设计稿修正细节",
      expect.objectContaining({
        images: ["/tmp/revised-design.png"],
      }),
    );
  });

  it("passes through temporary-agent creation options for spawn_task", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-2",
      mode: "run" as const,
      label: "独立审查",
      targetActorId: "spawned-reviewer",
      roleBoundary: "reviewer" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-reviewer") return { id, role: { name: "Independent Reviewer" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    await spawnTool.execute({
      target_agent: "Independent Reviewer",
      task: "独立审查 patch 的边界条件和回归风险",
      create_if_missing: true,
      agent_description: "只负责独立审查 patch",
      agent_capabilities: "code_review,testing,unknown_capability",
      role_boundary: "reviewer",
      override_tools_allow: "read_file,search",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "Independent Reviewer",
      "独立审查 patch 的边界条件和回归风险",
      expect.objectContaining({
        createIfMissing: true,
        createChildSpec: {
          description: "只负责独立审查 patch",
          capabilities: ["code_review", "testing"],
          workspace: undefined,
        },
        roleBoundary: "reviewer",
        overrides: expect.objectContaining({
          toolPolicy: {
            allow: ["read_file", "search"],
          },
        }),
      }),
    );
  });

  it("derives a temporary agent target from the label when create_if_missing omits target_agent", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-derive-target-1",
      mode: "run" as const,
      label: "技术方向课程生成",
      targetActorId: "spawned-tech-worker",
      roleBoundary: "executor" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-tech-worker") return { id, role: { name: "技术方向课程生成" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    await spawnTool.execute({
      task: "基于技术方向主题生成课程名称和课程介绍",
      label: "技术方向课程生成",
      create_if_missing: true,
      role_boundary: "executor",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "技术方向课程生成",
      "基于技术方向主题生成课程名称和课程介绍",
      expect.objectContaining({
        label: "技术方向课程生成",
        createIfMissing: true,
        roleBoundary: "executor",
      }),
    );
  });

  it("returns structured task metadata for spawn_task", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-structured-1",
      mode: "run" as const,
      label: "并行验证",
      targetActorId: "validator",
      roleBoundary: "validator" as const,
      runtime: {
        subtaskId: "run-structured-1",
        profile: "validator" as const,
        startedAt: 1,
        timeoutSeconds: 600,
        eventCount: 1,
      },
    }));

    const system = {
      get: (id: string) => ({ id, role: { name: id === "validator" ? "Validator" : "Coordinator" } }),
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    const result = await spawnTool.execute({
      target_agent: "validator",
      task: "执行回归验证",
      role_boundary: "validator",
    });

    expect(result).toEqual(expect.objectContaining({
      spawned: true,
      task_id: "run-structured-1",
      subtask_id: "run-structured-1",
      profile: "validator",
      role_boundary: "validator",
      runId: "run-structured-1",
    }));
  });

  it("queues overflow spawn_task requests instead of dropping them", async () => {
    const spawnTask = vi.fn();
    const enqueueDeferredSpawnTask = vi.fn(() => ({
      id: "queued-1",
      profile: "executor" as const,
      roleBoundary: "executor" as const,
      mode: "run" as const,
    }));

    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : "Executor" } }),
      getAll: () => [],
      spawnTask,
      getActiveSpawnedTasks: () => ([
        { runId: "run-a" },
        { runId: "run-b" },
        { runId: "run-c" },
      ]),
      getPendingDeferredSpawnTaskCount: vi.fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      enqueueDeferredSpawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    const result = await spawnTool.execute({
      target_agent: "executor",
      task: "补齐剩余课程分组",
      role_boundary: "executor",
      __queue_if_busy: true,
      __spawn_limit: 3,
    });

    expect(enqueueDeferredSpawnTask).toHaveBeenCalledWith(
      "coordinator",
      "executor",
      "补齐剩余课程分组",
      expect.objectContaining({
        roleBoundary: "executor",
      }),
    );
    expect(spawnTask).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      spawned: false,
      queued: true,
      dispatch_status: "queued",
      queue_id: "queued-1",
      pending_dispatch_count: 1,
      profile: "executor",
      role_boundary: "executor",
    }));
  });

  it("returns structured runtime state for wait_for_spawned_tasks", async () => {
    const buildWaitForSpawnedTasksResult = vi.fn(() => ({
      wait_complete: true,
      summary: "所有已派发子任务均已完成。请基于结构化结果做最终整合。",
      pending_count: 0,
      completed_count: 1,
      failed_count: 1,
      buffered_terminal_count: 2,
      aggregation_ready: true,
      tasks: [
        {
          task_id: "run-ok",
          subtask_id: "run-ok",
          target_actor_id: "executor",
          target_actor_name: "Executor",
          task: "实现修复",
          mode: "run",
          profile: "executor",
          status: "completed",
          terminal_result: "已完成修复并补充验证。",
          started_at: 1,
          completed_at: 2,
          event_count: 3,
        },
        {
          task_id: "run-failed",
          subtask_id: "run-failed",
          target_actor_id: "validator",
          target_actor_name: "Validator",
          task: "执行回归验证",
          mode: "run",
          profile: "validator",
          status: "error",
          terminal_error: "测试未通过",
          started_at: 3,
          completed_at: 4,
          event_count: 2,
        },
      ],
    }));

    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id }, status: "running" }),
      getAll: () => [],
      buildWaitForSpawnedTasksResult,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const waitTool = tools.find((tool) => tool.name === "wait_for_spawned_tasks");

    expect(waitTool).toBeTruthy();
    if (!waitTool) return;

    const result = await waitTool.execute({});

    expect(buildWaitForSpawnedTasksResult).toHaveBeenCalledWith("coordinator");
    expect(result).toEqual(expect.objectContaining({
      wait_complete: true,
      pending_count: 0,
      completed_count: 1,
      failed_count: 1,
      buffered_terminal_count: 2,
      aggregation_ready: true,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          task_id: "run-ok",
          profile: "executor",
          terminal_result: "已完成修复并补充验证。",
        }),
        expect.objectContaining({
          task_id: "run-failed",
          profile: "validator",
          terminal_error: "测试未通过",
        }),
      ]),
    }));
  });

  it("waits for runtime task updates instead of sleeping blindly", async () => {
    const buildWaitForSpawnedTasksResult = vi.fn()
      .mockReturnValueOnce({
        wait_complete: false,
        summary: "仍有 1 个子任务运行中，继续等待其结构化结果。",
        pending_count: 1,
        completed_count: 0,
        failed_count: 0,
        buffered_terminal_count: 0,
        aggregation_ready: false,
        tasks: [],
      })
      .mockReturnValueOnce({
        wait_complete: true,
        summary: "所有已派发子任务均已完成。请基于结构化结果做最终整合。",
        pending_count: 0,
        completed_count: 1,
        failed_count: 0,
        buffered_terminal_count: 1,
        aggregation_ready: true,
        tasks: [
          {
            task_id: "run-finished",
            subtask_id: "run-finished",
            target_actor_id: "executor",
            target_actor_name: "Executor",
            task: "实现修复",
            mode: "run",
            profile: "executor",
            status: "completed",
            terminal_result: "done",
            started_at: 1,
            completed_at: 2,
            event_count: 2,
          },
        ],
      });
    const waitForSpawnedTaskUpdate = vi.fn(async () => ({ reason: "task_update" as const }));

    const system = {
      get: (id: string) => ({ id, role: { name: "Coordinator" }, status: "running" }),
      getAll: () => [],
      buildWaitForSpawnedTasksResult,
      waitForSpawnedTaskUpdate,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const waitTool = tools.find((tool) => tool.name === "wait_for_spawned_tasks");

    expect(waitTool).toBeTruthy();
    if (!waitTool) return;

    const result = await waitTool.execute({});

    expect(waitForSpawnedTaskUpdate).toHaveBeenCalledWith("coordinator", 30_000);
    expect(buildWaitForSpawnedTasksResult).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      wait_complete: true,
      completed_count: 1,
    }));
  });

  it("returns the latest pending snapshot after one runtime wake instead of blocking indefinitely", async () => {
    const buildWaitForSpawnedTasksResult = vi.fn()
      .mockReturnValueOnce({
        wait_complete: false,
        summary: "仍有 1 个子任务运行中，继续等待其结构化结果。",
        pending_count: 1,
        completed_count: 0,
        failed_count: 0,
        buffered_terminal_count: 0,
        aggregation_ready: false,
        tasks: [],
      })
      .mockReturnValueOnce({
        wait_complete: false,
        summary: "仍有 1 个子任务运行中，已收到最新进度。",
        pending_count: 1,
        completed_count: 1,
        failed_count: 0,
        buffered_terminal_count: 1,
        aggregation_ready: false,
        tasks: [
          {
            task_id: "run-still-running",
            subtask_id: "run-still-running",
            target_actor_id: "executor",
            target_actor_name: "Executor",
            task: "实现修复",
            mode: "run",
            profile: "executor",
            status: "running",
            progress_summary: "已完成主要修改，正在补验证",
            started_at: 1,
            event_count: 4,
          },
        ],
      });
    const waitForSpawnedTaskUpdate = vi.fn(async () => ({ reason: "task_update" as const }));

    const system = {
      get: (id: string) => ({ id, role: { name: "Coordinator" }, status: "running" }),
      getAll: () => [],
      buildWaitForSpawnedTasksResult,
      waitForSpawnedTaskUpdate,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const waitTool = tools.find((tool) => tool.name === "wait_for_spawned_tasks");

    expect(waitTool).toBeTruthy();
    if (!waitTool) return;

    const result = await waitTool.execute({});

    expect(waitForSpawnedTaskUpdate).toHaveBeenCalledWith("coordinator", 30_000);
    expect(buildWaitForSpawnedTasksResult).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      wait_complete: false,
      pending_count: 1,
      completed_count: 1,
      buffered_terminal_count: 1,
      aggregation_ready: false,
    }));
  });

  it("continues waiting when there are queued child tasks even if no worker is currently running", async () => {
    const buildWaitForSpawnedTasksResult = vi.fn()
      .mockReturnValueOnce({
        wait_complete: false,
        summary: "当前有 1 个子任务排队待派发，系统会在空位出现后自动补派。",
        pending_count: 0,
        completed_count: 0,
        failed_count: 0,
        buffered_terminal_count: 0,
        aggregation_ready: false,
        pending_dispatch_count: 1,
        tasks: [],
      })
      .mockReturnValueOnce({
        wait_complete: true,
        summary: "所有已派发子任务均已完成。请基于结构化结果做最终整合。",
        pending_count: 0,
        completed_count: 1,
        failed_count: 0,
        buffered_terminal_count: 1,
        aggregation_ready: true,
        pending_dispatch_count: 0,
        tasks: [
          {
            task_id: "run-queued-finished",
            subtask_id: "run-queued-finished",
            target_actor_id: "executor",
            target_actor_name: "Executor",
            task: "实现修复",
            mode: "run",
            profile: "executor",
            status: "completed",
            terminal_result: "done",
            started_at: 1,
            completed_at: 2,
            event_count: 2,
          },
        ],
      });
    const waitForSpawnedTaskUpdate = vi.fn(async () => ({ reason: "task_update" as const }));

    const system = {
      get: (id: string) => ({ id, role: { name: "Coordinator" }, status: "running" }),
      getAll: () => [],
      buildWaitForSpawnedTasksResult,
      waitForSpawnedTaskUpdate,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const waitTool = tools.find((tool) => tool.name === "wait_for_spawned_tasks");

    expect(waitTool).toBeTruthy();
    if (!waitTool) return;

    const result = await waitTool.execute({});

    expect(waitForSpawnedTaskUpdate).toHaveBeenCalledWith("coordinator", 30_000);
    expect(buildWaitForSpawnedTasksResult).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      wait_complete: true,
      completed_count: 1,
      aggregation_ready: true,
    }));
  });

  it("surfaces explicit task lineage in agents list output", async () => {
    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : "Reviewer" } }),
      getAll: () => [{ id: "reviewer", role: { name: "Reviewer" }, status: "running", currentTask: null, modelOverride: undefined }],
      getCoordinatorId: () => "coordinator",
      getDescendantTasks: () => ([
        {
          runId: "run-review",
          parentRunId: "run-root",
          rootRunId: "run-root",
          roleBoundary: "reviewer" as const,
          spawnerActorId: "coordinator",
          targetActorId: "reviewer",
          label: "独立审查",
          status: "running",
          depth: 1,
          task: "独立审查 patch 的回归风险",
          result: undefined,
          error: undefined,
          mode: "run" as const,
          cleanup: "keep" as const,
          expectsCompletionMessage: true,
        },
      ]),
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const agentsTool = tools.find((tool) => tool.name === "agents");

    expect(agentsTool).toBeTruthy();
    if (!agentsTool) return;

    const result = await agentsTool.execute({ action: "list" });

    expect(result.task_tree).toEqual([
      expect.objectContaining({
        runId: "run-review",
        parentRunId: "run-root",
        rootRunId: "run-root",
        roleBoundary: "reviewer",
      }),
    ]);
  });

  it("stages explicit local media for the next external IM reply", async () => {
    const recordArtifact = vi.fn();
    const stageResultMedia = vi.fn();
    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getCoordinatorId: () => "coordinator",
      getDialogHistory: () => ([
        {
          id: "msg-user-1",
          from: "user",
          kind: "user_input",
          externalChannelType: "dingtalk",
        },
      ]),
      getSessionUploadsSnapshot: () => ([
        { id: "upload-1", name: "poster.png", path: "/repo/assets/poster.png" },
      ]),
      recordArtifact,
      stageResultMedia,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system, {
      getInheritedImages: () => ["/tmp/current-image.png"],
    });
    const sendTool = tools.find((tool) => tool.name === "send_local_media");

    expect(sendTool).toBeTruthy();
    if (!sendTool) return;

    const result = await sendTool.execute({
      attachment_name: "poster.png",
      use_current_images: true,
    });

    expect(result).toEqual(expect.objectContaining({
      queued: true,
      count: 2,
    }));
    expect(stageResultMedia).toHaveBeenCalledWith(
      "coordinator",
      expect.objectContaining({
        images: expect.arrayContaining([
          "/repo/assets/poster.png",
          "/tmp/current-image.png",
        ]),
      }),
    );
    expect(recordArtifact).toHaveBeenCalledTimes(2);
  });

  it("treats non-visual local paths as IM attachments", async () => {
    const stageResultMedia = vi.fn();
    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getCoordinatorId: () => "coordinator",
      getDialogHistory: () => ([
        {
          id: "msg-user-file",
          from: "user",
          kind: "user_input",
          externalChannelType: "feishu",
        },
      ]),
      getSessionUploadsSnapshot: () => [],
      recordArtifact: vi.fn(),
      stageResultMedia,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const sendTool = tools.find((tool) => tool.name === "send_local_media");

    expect(sendTool).toBeTruthy();
    if (!sendTool) return;

    const result = await sendTool.execute({
      path: "/Users/haichao/Downloads/file",
    });

    expect(result).toEqual(expect.objectContaining({
      queued: true,
      count: 1,
      attachments: [{ path: "/Users/haichao/Downloads/file", fileName: "file" }],
    }));
    expect(stageResultMedia).toHaveBeenCalledWith(
      "coordinator",
      expect.objectContaining({
        attachments: [{ path: "/Users/haichao/Downloads/file", fileName: "file" }],
      }),
    );
  });
});
