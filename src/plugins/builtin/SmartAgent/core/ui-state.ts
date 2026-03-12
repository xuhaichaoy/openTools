import type { AgentScheduledTask, AgentTaskStatus } from "@/core/ai/types";

export type ScheduledFilterMode = "all" | "attention" | AgentTaskStatus;
export type ScheduledSortMode = "next_run_asc" | "updated_desc" | "created_desc";
export type WorkbenchTab = "tools" | "orchestrator" | "skills" | "tasks" | "graph";

export type RunningPhase = "executing";
export type ExecutionWaitingStage =
  | "model_first_token"
  | "model_generating"
  | "tool_waiting"
  | "user_confirm";

export function getExecutionWaitingStageLabel(stage: ExecutionWaitingStage): string {
  switch (stage) {
    case "model_first_token":
      return "模型首个响应";
    case "model_generating":
      return "模型生成回答";
    case "tool_waiting":
      return "工具执行返回";
    case "user_confirm":
      return "用户确认授权";
    default:
      return "模型或工具返回";
  }
}

export function pickJsonPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

export function sortScheduledTasks(tasks: AgentScheduledTask[], mode: ScheduledSortMode) {
  const sorted = [...tasks];
  sorted.sort((a, b) => {
    if (mode === "updated_desc") {
      return (b.updated_at || 0) - (a.updated_at || 0);
    }
    if (mode === "created_desc") {
      return (b.created_at || 0) - (a.created_at || 0);
    }

    const aNext =
      typeof a.next_run_at === "number" ? a.next_run_at : Number.MAX_SAFE_INTEGER;
    const bNext =
      typeof b.next_run_at === "number" ? b.next_run_at : Number.MAX_SAFE_INTEGER;
    if (aNext !== bNext) return aNext - bNext;
    return (b.updated_at || 0) - (a.updated_at || 0);
  });
  return sorted;
}

export function shouldAutoCollapseProcess(task: {
  status?: AgentTaskStatus;
  answer: string | null;
}) {
  if (task.status === "running" || task.status === "pending") return false;
  if (
    task.status === "success" ||
    task.status === "error" ||
    task.status === "cancelled"
  ) {
    return true;
  }
  return !!task.answer;
}
