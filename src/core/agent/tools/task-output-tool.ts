import type { ToolDefinition } from "../actor/types";
import { getAgentTaskManager } from "@/core/task-center";
import { readAgentTaskOutputFile } from "@/core/task-center/agent-task-output-file";
import type { AgentTask } from "@/core/task-center/agent-task-types";

export const TASK_OUTPUT_TOOL_NAME = 'task_output';

export interface TaskOutputInput {
  task_id: string;
  block?: boolean;
  timeout?: number;
}

function inferTaskType(task: AgentTask): "local_agent" | "remote_agent" | "background_task" {
  if (task.backend === "remote") return "remote_agent";
  if (task.source === "background" || task.source === "spawned") return "local_agent";
  return "background_task";
}

async function buildTaskOutputPayload(task: AgentTask) {
  const manager = getAgentTaskManager();
  const outputs = manager.listOutputs(task.taskId);
  const latestOutput = outputs.at(-1);
  const outputFileContent = task.outputFile
    ? await readAgentTaskOutputFile(task.outputFile)
    : undefined;
  const output = outputFileContent?.trim()
    || latestOutput?.content
    || task.result
    || task.error
    || "";

  return {
    task_id: task.taskId,
    task_type: inferTaskType(task),
    status: task.status,
    description: task.description,
    output,
    output_file: task.outputFile,
    prompt: task.metadata && typeof task.metadata.prompt === "string" ? task.metadata.prompt : task.description,
    result: task.result,
    error: task.error,
    outputs,
  };
}

export function createTaskOutputTool(): ToolDefinition {
  return {
    name: TASK_OUTPUT_TOOL_NAME,
    description: 'DEPRECATED: Prefer using the Read tool on the task\'s output file path instead. Retrieves output from a running or completed task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to get output from' },
        block: { type: 'boolean', description: 'Whether to wait for completion', default: true },
        timeout: { type: 'number', description: 'Max wait time in ms', default: 30000, minimum: 0, maximum: 600000 }
      },
      required: ['task_id']
    },
    handler: async (input: TaskOutputInput) => {
      const { task_id, block = true, timeout = 30000 } = input;
      const manager = getAgentTaskManager();
      let task = manager.get(task_id);

      if (!task) throw new Error(`Task ${task_id} not found`);

      if (!block) {
        const payload = await buildTaskOutputPayload(task);
        const retrievalStatus = task.status === "running" || task.status === "queued"
          ? "not_ready"
          : "success";
        return {
          retrieval_status: retrievalStatus,
          task: payload,
          ...payload,
        };
      }

      const startTime = Date.now();
      while ((task.status === 'running' || task.status === 'queued') && Date.now() - startTime < timeout) {
        await new Promise(resolve => setTimeout(resolve, 100));
        task = manager.get(task_id);
        if (!task) {
          return {
            retrieval_status: "timeout",
            task: null,
            task_id,
            status: undefined,
            output: "",
            output_file: undefined,
            result: undefined,
            error: undefined,
            outputs: [],
          };
        }
      }

      const timedOut = Boolean(task && (task.status === 'running' || task.status === 'queued'));
      const payload = await buildTaskOutputPayload(task);

      return {
        retrieval_status: timedOut ? "timeout" : "success",
        task: timedOut ? null : payload,
        ...payload,
      };
    }
  };
}
