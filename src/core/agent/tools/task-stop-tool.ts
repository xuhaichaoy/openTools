import type { ToolDefinition } from "../actor/types";
import type { ActorSystem } from "../actor/actor-system";
import { getAgentTaskManager } from "@/core/task-center";
import { appendAgentTaskOutputFile } from "@/core/task-center/agent-task-output-file";
import { getBackgroundAgentRegistry } from "../actor/background-agent-registry";

export const TASK_STOP_TOOL_NAME = 'task_stop';

export interface TaskStopInput {
  task_id: string;
  shell_id?: string;
}

function inferTaskType(task: NonNullable<ReturnType<ReturnType<typeof getAgentTaskManager>["get"]>>): "local_agent" | "remote_agent" | "background_task" {
  if (task.backend === "remote") return "remote_agent";
  if (task.source === "background" || task.source === "spawned") return "local_agent";
  return "background_task";
}

export function createTaskStopTool(actorSystem: ActorSystem): ToolDefinition {
  return {
    name: TASK_STOP_TOOL_NAME,
    description: 'Stop a running task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        shell_id: { type: 'string' },
      },
      required: [],
    },
    handler: async (input: TaskStopInput) => {
      const resolvedTaskId = input.task_id ?? input.shell_id;
      if (!resolvedTaskId) {
        throw new Error("Missing required parameter: task_id");
      }

      const manager = getAgentTaskManager();
      const task = manager.get(resolvedTaskId);
      if (!task) throw new Error(`Task ${resolvedTaskId} not found`);
      if (task.status !== "running" && task.status !== "queued") {
        throw new Error(`Task ${resolvedTaskId} is not running (status: ${task.status})`);
      }

      if (task.targetActorId) {
        actorSystem.get(task.targetActorId)?.stop();
      }
      if (task.outputFile) {
        await appendAgentTaskOutputFile({
          outputFile: task.outputFile,
          status: "aborted",
          error: "Stopped by task_stop request.",
          timestamp: Date.now(),
        });
      }
      manager.updateTask(resolvedTaskId, {
        status: "aborted",
        completedAt: Date.now(),
        lastActiveAt: Date.now(),
        recentActivitySummary: "任务已停止",
        pendingMessageCount: 0,
      });
      getBackgroundAgentRegistry().abort(resolvedTaskId, "Stopped by task_stop request.");
      return {
        success: true,
        message: `Successfully stopped task: ${resolvedTaskId} (${task.description})`,
        task_id: resolvedTaskId,
        task_type: inferTaskType(task),
        command: task.description,
      };
    },
  };
}
