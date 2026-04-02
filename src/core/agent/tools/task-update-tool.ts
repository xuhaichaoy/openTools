import type { ToolDefinition } from "../actor/types";
import { getTaskQueue } from "@/core/task-center";

export const TASK_UPDATE_TOOL_NAME = 'task_update';

export interface TaskUpdateInput {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: "pending" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "deleted";
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown> | null;
}

function mergeUnique(values: Array<string | undefined>, existing?: readonly string[]): string[] {
  const set = new Set<string>(existing ?? []);
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      set.add(normalized);
    }
  }
  return [...set];
}

export function createTaskUpdateTool(): ToolDefinition {
  return {
    name: TASK_UPDATE_TOOL_NAME,
    description: 'Update task status',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'deleted'],
        },
        addBlocks: { type: 'array', items: { type: 'string' } },
        addBlockedBy: { type: 'array', items: { type: 'string' } },
        owner: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['taskId'],
    },
    handler: async (input: TaskUpdateInput) => {
      const queue = getTaskQueue();
      const task = queue.get(input.taskId);

      if (!task) {
        return {
          success: false,
          taskId: input.taskId,
          updatedFields: [],
          error: "Task not found",
        };
      }

      if (input.status === "deleted") {
        return {
          success: queue.remove(input.taskId),
          taskId: input.taskId,
          updatedFields: ["deleted"],
          statusChange: {
            from: task.status,
            to: "deleted",
          },
        };
      }

      const updatedFields: string[] = [];
      const patch: Partial<typeof task> = {};

      if (input.subject !== undefined && input.subject !== task.title) {
        patch.title = input.subject;
        updatedFields.push("subject");
      }
      if (input.description !== undefined && input.description !== task.description) {
        patch.description = input.description;
        updatedFields.push("description");
      }
      if (input.owner !== undefined && input.owner !== task.assignee) {
        patch.assignee = input.owner;
        updatedFields.push("owner");
      }

      const nextParams = { ...(task.params ?? {}) } as Record<string, unknown>;
      if (input.activeForm !== undefined && input.activeForm !== nextParams.activeForm) {
        nextParams.activeForm = input.activeForm;
        updatedFields.push("activeForm");
      }
      if (input.metadata !== undefined) {
        const previousMetadata = (
          nextParams.metadata && typeof nextParams.metadata === "object"
            ? nextParams.metadata as Record<string, unknown>
            : {}
        );
        nextParams.metadata = {
          ...previousMetadata,
          ...(input.metadata ?? {}),
        };
        updatedFields.push("metadata");
      }

      if (input.addBlockedBy?.length) {
        patch.dependencies = mergeUnique(input.addBlockedBy, task.dependencies);
        updatedFields.push("blockedBy");
      }

      if (Object.keys(nextParams).length > 0) {
        patch.params = nextParams;
      }

      let statusChange:
        | {
            from: string;
            to: string;
          }
        | undefined;
      if (input.status && input.status !== task.status) {
        statusChange = { from: task.status, to: input.status };
        switch (input.status) {
          case "completed":
            queue.complete(input.taskId, task.result);
            break;
          case "failed":
            queue.fail(input.taskId, task.error ?? "Task marked as failed");
            break;
          case "cancelled":
            queue.cancel(input.taskId);
            break;
          default:
            patch.status = input.status;
            if (input.status === "running" && !task.startedAt) {
              patch.startedAt = Date.now();
            }
            if (input.status === "paused") {
              patch.completedAt = undefined;
            }
            updatedFields.push("status");
        }
      }

      if (Object.keys(patch).length > 0) {
        queue.update(input.taskId, patch);
      }

      if (input.addBlocks?.length) {
        for (const blockedTaskId of input.addBlocks) {
          const blockedTask = queue.get(blockedTaskId);
          if (!blockedTask) continue;
          queue.update(blockedTaskId, {
            dependencies: mergeUnique([input.taskId], blockedTask.dependencies),
          });
        }
        updatedFields.push("blocks");
      }

      return {
        success: true,
        taskId: input.taskId,
        updatedFields,
        ...(statusChange ? { statusChange } : {}),
      };
    },
  };
}
