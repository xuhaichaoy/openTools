import type { ToolDefinition } from "../actor/types";
import { getTaskQueue } from "@/core/task-center";
import {
  buildReverseDependencyMap,
  normalizeQueueTaskForTool,
} from "./task-queue-tool-utils";

export const TASK_LIST_TOOL_NAME = 'task_list';

export function createTaskListTool(): ToolDefinition {
  return {
    name: TASK_LIST_TOOL_NAME,
    description: "List all tasks",
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const queue = getTaskQueue();
      const rawTasks = queue.list();
      const resolvedTaskIds = new Set(
        rawTasks
          .filter((task) => task.status === "completed")
          .map((task) => task.id),
      );
      const reverseDependencyMap = buildReverseDependencyMap(rawTasks);
      const tasks = rawTasks.map((task) => normalizeQueueTaskForTool({
        task,
        reverseDependencyMap,
        resolvedTaskIds,
      }));
      return {
        tasks,
        count: tasks.length,
      };
    },
  };
}
