import type { ToolDefinition } from '../actor/types';
import { getTaskQueue } from "@/core/task-center";

export const TASK_CREATE_TOOL_NAME = 'task_create';

export interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export function createTaskCreateTool(): ToolDefinition {
  return {
    name: TASK_CREATE_TOOL_NAME,
    description: 'Create a new task',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['subject', 'description'],
    },
    handler: async (input: TaskCreateInput, context) => {
      const queue = getTaskQueue();
      const task = queue.create({
        title: input.subject,
        description: input.description,
        type: "custom",
        priority: "normal",
        params: {
          ...(input.activeForm ? { activeForm: input.activeForm } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        createdBy: context.actorId || "assistant",
        dependencies: [],
      });

      return {
        task: {
          id: task.id,
          subject: task.title,
        },
        task_id: task.id,
        message: `Task created: ${task.title}`,
      };
    },
  };
}
