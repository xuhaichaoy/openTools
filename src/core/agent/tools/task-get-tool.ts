import type { ToolDefinition } from "../actor/types";
import { getTaskQueue } from "@/core/task-center";
import {
  buildReverseDependencyMap,
  normalizeQueueTaskForTool,
} from "./task-queue-tool-utils";

export const TASK_GET_TOOL_NAME = 'task_get';

export interface TaskGetInput {
  taskId: string;
}

export function createTaskGetTool(): ToolDefinition {
  return {
    name: TASK_GET_TOOL_NAME,
    description: 'Get task details',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
      },
      required: ['taskId'],
    },
    handler: async (input: TaskGetInput) => {
      const queue = getTaskQueue();
      const allTasks = queue.list();
      const task = queue.get(input.taskId);
      if (!task) {
        return {
          task: null,
        };
      }
      const resolvedTaskIds = new Set(
        allTasks
          .filter((item) => item.status === "completed")
          .map((item) => item.id),
      );
      const reverseDependencyMap = buildReverseDependencyMap(allTasks);
      return {
        task: normalizeQueueTaskForTool({
          task,
          reverseDependencyMap,
          resolvedTaskIds,
        }),
        raw_task: task,
      };
    },
  };
}
