import type { AgentTaskStatus } from "@/core/ai/types";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";

interface RecoverableAgentTask {
  steps: AgentStep[];
  answer?: string | null;
  status?: AgentTaskStatus;
  last_error?: string;
  last_finished_at?: number;
  last_result_status?: "success" | "error" | "skipped";
}

const STREAMING_FALLBACK_TEXT: Partial<Record<AgentStep["type"], string>> = {
  answer: "（已停止生成）",
  thinking: "（思考流已结束）",
  tool_streaming: "（工具参数流已结束）",
};

function shouldClearStreamingAnswersForStep(step: AgentStep): boolean {
  return step.type === "action";
}

export function applyIncomingAgentStep(
  steps: AgentStep[],
  step: AgentStep,
): AgentStep[] {
  const next = [...steps];
  const findLastIdx = (pred: (entry: AgentStep) => boolean) => {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (pred(next[i])) return i;
    }
    return -1;
  };
  const matchesStream = (entry: AgentStep) =>
    !!entry.streaming &&
    entry.type === step.type &&
    (entry.streamId ?? "") === (step.streamId ?? "");

  if (shouldClearStreamingAnswersForStep(step)) {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (next[i].type === "answer" && next[i].streaming) {
        next.splice(i, 1);
      }
    }
  }

  if (step.streaming) {
    const lastIdx = findLastIdx(matchesStream);
    if (lastIdx >= 0) {
      next[lastIdx] = step;
    } else {
      next.push(step);
    }
    return next;
  }

  const streamIdx = findLastIdx(matchesStream);
  if (streamIdx >= 0) {
    next.splice(streamIdx, 1);
  }
  next.push(step);
  return next;
}

function isTerminalAgentTaskStatus(status?: AgentTaskStatus): status is "success" | "error" | "cancelled" {
  return status === "success" || status === "error" || status === "cancelled";
}

export function finalizePersistedAgentSteps(steps: AgentStep[]): AgentStep[] {
  let changed = false;
  const normalized = steps.map((step) => {
    if (!step.streaming) return step;
    changed = true;
    return {
      ...step,
      streaming: false,
      content: step.content || STREAMING_FALLBACK_TEXT[step.type] || "（流式输出已结束）",
    };
  });
  return changed ? normalized : steps;
}

export function deriveRecoveredAgentTaskStatus(
  task: RecoverableAgentTask,
): AgentTaskStatus | undefined {
  if (task.status !== "running") return task.status;
  if (task.answer && task.answer.trim()) return "success";
  if (task.last_error && task.last_error.trim()) return "error";
  if (task.steps.length > 0) return "cancelled";
  return "pending";
}

export function buildRecoveredAgentTaskPatch(
  task: RecoverableAgentTask,
  finishedAt = Date.now(),
): Partial<RecoverableAgentTask> | null {
  const steps = finalizePersistedAgentSteps(task.steps);
  const status = deriveRecoveredAgentTaskStatus(task);
  const patch: Partial<RecoverableAgentTask> = {};

  if (steps !== task.steps) {
    patch.steps = steps;
  }
  if (status && status !== task.status) {
    patch.status = status;
  }
  if (
    isTerminalAgentTaskStatus(status) &&
    task.last_finished_at == null
  ) {
    patch.last_finished_at = finishedAt;
  }
  if (
    status === "success" &&
    task.last_result_status !== "success"
  ) {
    patch.last_result_status = "success";
  }
  if (
    status === "error" &&
    task.last_result_status !== "error"
  ) {
    patch.last_result_status = "error";
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
