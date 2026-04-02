import type { TaskRecord } from "@/core/task-center/types";

export interface QueueTaskToolView {
  id: string;
  subject: string;
  description: string;
  status: TaskRecord["status"];
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export function buildReverseDependencyMap(tasks: readonly TaskRecord[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const task of tasks) {
    for (const depId of task.dependencies ?? []) {
      const bucket = map.get(depId) ?? [];
      bucket.push(task.id);
      map.set(depId, bucket);
    }
  }
  return map;
}

export function normalizeQueueTaskForTool(params: {
  task: TaskRecord;
  reverseDependencyMap: ReadonlyMap<string, string[]>;
  resolvedTaskIds?: ReadonlySet<string>;
}): QueueTaskToolView {
  const blockedBy = (params.task.dependencies ?? [])
    .filter((id) => !params.resolvedTaskIds?.has(id));
  const blocks = (params.reverseDependencyMap.get(params.task.id) ?? [])
    .filter((id) => !params.resolvedTaskIds?.has(id));
  const metadata = params.task.params?.metadata;

  return {
    id: params.task.id,
    subject: params.task.title,
    description: params.task.description ?? "",
    status: params.task.status,
    owner: params.task.assignee,
    blockedBy,
    blocks,
    activeForm: typeof params.task.params?.activeForm === "string"
      ? params.task.params.activeForm
      : undefined,
    metadata: metadata && typeof metadata === "object"
      ? { ...(metadata as Record<string, unknown>) }
      : undefined,
  };
}
