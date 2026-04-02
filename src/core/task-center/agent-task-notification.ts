import type { AgentTask, AgentTaskNotification } from "./agent-task-types";

function buildNotificationId(taskId: string, suffix: string): string {
  return `${taskId}:${suffix}`;
}

export function buildAgentTaskNotification(params: {
  task: AgentTask;
  previous?: AgentTask;
}): AgentTaskNotification | null {
  const { task, previous } = params;
  if (previous?.status === task.status) {
    return null;
  }

  const createdAt = task.completedAt ?? task.lastActiveAt ?? task.startedAt ?? task.createdAt;
  const taskLabel = task.targetName ?? task.title;

  switch (task.status) {
    case "running":
      return {
        id: buildNotificationId(task.taskId, "running"),
        taskId: task.taskId,
        level: "info",
        title: `${taskLabel} 已启动`,
        message: task.recentActivitySummary ?? task.description,
        createdAt,
        read: false,
        status: task.status,
      };
    case "completed":
      return {
        id: buildNotificationId(task.taskId, "completed"),
        taskId: task.taskId,
        level: "success",
        title: `${taskLabel} 已完成`,
        message: task.outputSummary ?? task.description,
        createdAt,
        read: false,
        status: task.status,
      };
    case "failed":
      return {
        id: buildNotificationId(task.taskId, "failed"),
        taskId: task.taskId,
        level: "error",
        title: `${taskLabel} 执行失败`,
        message: task.error ?? task.outputSummary ?? task.description,
        createdAt,
        read: false,
        status: task.status,
      };
    case "aborted":
      return {
        id: buildNotificationId(task.taskId, "aborted"),
        taskId: task.taskId,
        level: "warning",
        title: `${taskLabel} 已中止`,
        message: task.error ?? task.outputSummary ?? task.description,
        createdAt,
        read: false,
        status: task.status,
      };
    default:
      return null;
  }
}
