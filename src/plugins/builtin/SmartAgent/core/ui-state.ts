import type { AgentScheduledTask, AgentTaskStatus } from "@/core/ai/types";
import type { PlanThreadState } from "./plan-mode";

export type ScheduledFilterMode = "all" | "attention" | AgentTaskStatus;
export type ScheduledSortMode = "next_run_asc" | "updated_desc" | "created_desc";
export type WorkbenchTab = "tools" | "orchestrator";

export type PlanClarificationQuestion = {
  id: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  required: boolean;
  placeholder?: string;
};

export type PlanClarificationAnswer = {
  selectedOptions?: string[];
  customInput?: string;
};

export type PlanClarificationAnswers = Record<string, PlanClarificationAnswer>;

export type RunningPhase = "planning" | "executing";
export type PlanDirection = "new" | "linked";

export type PendingPlanClarificationState = {
  sessionId: string;
  taskId: string;
  query: string;
  questions: PlanClarificationQuestion[];
  direction: PlanDirection;
};

export type PendingPlanState = {
  sessionId: string;
  taskId: string;
  query: string;
  plan: string;
  version: number;
  sourceTaskId?: string;
  recentFollowup?: string;
};

export type PendingPlanLinkDecisionState = {
  sessionId: string;
  query: string;
  reason?: string;
};

export type PlanRelationCheckingState = {
  sessionId: string;
  content: string;
  streaming: boolean;
};

const PLAN_THREADS_STORAGE_KEY = "mtools.agent.plan_threads.v1";

function pickJsonPayload(text: string): string | null {
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

export function loadPlanThreadsFromStorage(): Record<string, PlanThreadState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PLAN_THREADS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const entries = Object.entries(parsed as Record<string, unknown>);
    const next: Record<string, PlanThreadState> = {};
    for (const [sessionId, value] of entries) {
      if (!value || typeof value !== "object") continue;
      const thread = value as Partial<PlanThreadState>;
      if (!thread.taskId || !thread.baseQuery) continue;
      next[sessionId] = {
        sessionId,
        taskId: thread.taskId,
        baseQuery: thread.baseQuery,
        latestPlan: thread.latestPlan || "",
        planVersion: Math.max(1, Number(thread.planVersion) || 1),
        phase: thread.phase || "drafting",
        lastUpdatedAt: Number(thread.lastUpdatedAt) || Date.now(),
        relationSourceTaskId: thread.relationSourceTaskId,
        latestFollowup: thread.latestFollowup,
      };
    }
    return next;
  } catch {
    return {};
  }
}

export function persistPlanThreadsToStorage(planThreads: Record<string, PlanThreadState>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PLAN_THREADS_STORAGE_KEY, JSON.stringify(planThreads));
  } catch {
    // ignore storage write errors
  }
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

export function shouldBypassPlan(query: string, imageCount: number): boolean {
  if (imageCount > 0) return true;
  const q = query.trim();
  if (!q) return false;

  const fastIntentPatterns = [
    /现在.*几点|当前.*时间|现在几号|今天几号|当前日期|what time|current time/i,
    /^(计算|算一下|帮我算|calc)\b/i,
    /^[\d\s+\-*/().%]+$/,
  ];

  return fastIntentPatterns.some((pattern) => pattern.test(q));
}

export function parsePlanClarificationQuestions(content: string): PlanClarificationQuestion[] {
  const payload = pickJsonPayload(content);
  if (!payload) return [];

  try {
    const parsed = JSON.parse(payload) as unknown;
    const rawQuestions = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { questions?: unknown }).questions)
        ? (parsed as { questions: unknown[] }).questions
        : [];

    const questions: PlanClarificationQuestion[] = [];
    rawQuestions.forEach((raw, idx) => {
      if (!raw || typeof raw !== "object") return;
      const item = raw as {
        id?: unknown;
        question?: unknown;
        title?: unknown;
        options?: unknown;
        choices?: unknown;
        multi_select?: unknown;
        multiSelect?: unknown;
        required?: unknown;
        placeholder?: unknown;
      };
      const question =
        typeof item.question === "string"
          ? item.question.trim()
          : typeof item.title === "string"
            ? item.title.trim()
            : "";
      if (!question) return;
      const id =
        typeof item.id === "string" && item.id.trim() ? item.id.trim() : `q_${idx + 1}`;
      const rawOptions = Array.isArray(item.options)
        ? item.options
        : Array.isArray(item.choices)
          ? item.choices
          : [];
      const options = Array.from(
        new Set(
          rawOptions
            .map((opt) => (typeof opt === "string" ? opt.trim() : ""))
            .filter((opt) => !!opt),
        ),
      ).slice(0, 6);
      if (options.length === 0) {
        options.push("按默认方案");
      }

      const nextQuestion: PlanClarificationQuestion = {
        id,
        question,
        options,
        multiSelect: item.multi_select === true || item.multiSelect === true,
        required: item.required !== false,
      };
      if (typeof item.placeholder === "string" && item.placeholder.trim()) {
        nextQuestion.placeholder = item.placeholder.trim();
      }
      questions.push(nextQuestion);
    });

    return questions.slice(0, 8);
  } catch {
    return [];
  }
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

export function findFirstIncompleteClarificationIndex(
  questions: PlanClarificationQuestion[],
  answers: PlanClarificationAnswers,
) {
  return questions.findIndex((question) => {
    if (!question.required) return false;
    const answer = answers[question.id];
    const selectedOptions = (answer?.selectedOptions || []).filter((option) => !!option);
    const custom = answer?.customInput?.trim() || "";
    return selectedOptions.length === 0 && custom.length === 0;
  });
}
