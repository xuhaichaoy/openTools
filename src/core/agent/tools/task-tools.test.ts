import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAgentTaskManager,
  resetAgentTaskManager,
  resetTaskQueue,
} from "@/core/task-center";
import type { AgentTask } from "@/core/task-center/agent-task-types";
import {
  ensureAgentTaskOutputFile,
  readAgentTaskOutputFile,
} from "@/core/task-center/agent-task-output-file";
import { resetBackgroundAgentRegistry } from "../actor/background-agent-registry";
import type { ActorSystem } from "../actor/actor-system";
import { createTaskCreateTool } from "./task-create-tool";
import { createTaskGetTool } from "./task-get-tool";
import { createTaskListTool } from "./task-list-tool";
import { createTaskOutputTool } from "./task-output-tool";
import { createTaskStopTool } from "./task-stop-tool";
import { createTaskUpdateTool } from "./task-update-tool";

describe("task tools", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAgentTaskManager();
    resetTaskQueue();
    resetBackgroundAgentRegistry();
  });

  it("returns not_ready for non-blocking running task output", async () => {
    const manager = getAgentTaskManager();
    const outputFile = await ensureAgentTaskOutputFile({
      sessionId: "session-task-output",
      taskId: "agent-task:running",
      agentName: "worker",
      title: "Running worker",
      description: "Running worker",
      prompt: "initial prompt",
    });

    manager.upsertTask({
      taskId: "agent-task:running",
      sessionId: "session-task-output",
      source: "background",
      backend: "in_process",
      status: "running",
      title: "Running worker",
      description: "Process data",
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      targetActorId: "agent-running",
      targetName: "worker",
      recentActivity: [],
      pendingMessageCount: 0,
      outputFile,
      metadata: {
        prompt: "initial prompt",
      },
    } satisfies AgentTask);

    const tool = createTaskOutputTool();
    const result = await tool.handler({
      task_id: "agent-task:running",
      block: false,
    }, {} as any);

    expect(result.retrieval_status).toBe("not_ready");
    expect(result.task).toEqual(expect.objectContaining({
      task_id: "agent-task:running",
      status: "running",
      task_type: "local_agent",
    }));
    expect(result.output_file).toBe(outputFile);
  });

  it("creates, lists, gets, and updates queue-backed tasks", async () => {
    const createTool = createTaskCreateTool();
    const first = await createTool.handler({
      subject: "Plan migration",
      description: "Review remaining Claude Code gaps",
      activeForm: "Reviewing gaps",
      metadata: { phase: "analysis" },
    }, {
      actorId: "lead",
    } as any);
    const second = await createTool.handler({
      subject: "Implement migration",
      description: "Apply the agreed changes",
    }, {
      actorId: "lead",
    } as any);

    const updateTool = createTaskUpdateTool();
    const updateResult = await updateTool.handler({
      taskId: first.task.id,
      owner: "worker",
      addBlocks: [second.task.id],
      status: "queued",
    }, {} as any);
    expect(updateResult.success).toBe(true);
    expect(updateResult.updatedFields).toEqual(expect.arrayContaining(["owner", "blocks", "status"]));

    const listTool = createTaskListTool();
    const listResult = await listTool.handler({}, {} as any);
    expect(listResult.tasks).toContainEqual(expect.objectContaining({
      id: first.task.id,
      subject: "Plan migration",
      status: "queued",
      owner: "worker",
      blocks: [second.task.id],
      blockedBy: [],
    }));
    expect(listResult.tasks).toContainEqual(expect.objectContaining({
      id: second.task.id,
      subject: "Implement migration",
      blockedBy: [first.task.id],
    }));

    const getTool = createTaskGetTool();
    const getResult = await getTool.handler({
      taskId: first.task.id,
    }, {} as any);
    expect(getResult.task).toEqual(expect.objectContaining({
      id: first.task.id,
      subject: "Plan migration",
      owner: "worker",
      blocks: [second.task.id],
      blockedBy: [],
      activeForm: "Reviewing gaps",
      metadata: { phase: "analysis" },
    }));
  });

  it("stops running background task with output note", async () => {
    const manager = getAgentTaskManager();
    const outputFile = await ensureAgentTaskOutputFile({
      sessionId: "session-task-stop",
      taskId: "agent-task:stop-me",
      agentName: "worker",
      title: "Stop worker",
      description: "Stop worker",
      prompt: "collect status",
    });

    manager.upsertTask({
      taskId: "agent-task:stop-me",
      sessionId: "session-task-stop",
      source: "background",
      backend: "in_process",
      status: "running",
      title: "Stop worker",
      description: "collect status",
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      spawnerActorId: "lead",
      spawnerName: "Lead",
      targetActorId: "agent-stop",
      targetName: "worker",
      recentActivity: [],
      pendingMessageCount: 2,
      outputFile,
      resumable: true,
      metadata: {
        prompt: "collect status",
      },
    } satisfies AgentTask);

    const stop = vi.fn();
    const actorSystem = {
      get: vi.fn(() => ({ stop })),
    } as unknown as ActorSystem;

    const stopTool = createTaskStopTool(actorSystem);
    const stopResult = await stopTool.handler({
      task_id: "agent-task:stop-me",
    }, {} as any);
    expect(stopResult.success).toBe(true);
    expect(stopResult.task_type).toBe("local_agent");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.get("agent-task:stop-me")?.status).toBe("aborted");
    expect(await readAgentTaskOutputFile(outputFile)).toContain("Stopped by task_stop request.");

    const outputTool = createTaskOutputTool();
    const outputResult = await outputTool.handler({
      task_id: "agent-task:stop-me",
      block: false,
    }, {} as any);
    expect(outputResult.retrieval_status).toBe("success");
    expect(outputResult.output).toContain("Stopped by task_stop request.");
  });
});
