import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type {
  AgentSession,
  AgentSessionCompaction,
  AgentTask,
} from "@/store/agent-store";
import {
  getAgentSessionCompactedTaskCount,
  getVisibleAgentTasks,
} from "@/store/agent-store";

const DEFAULT_KEEP_RECENT_TASKS = 4;
const AGGRESSIVE_KEEP_RECENT_TASKS = 2;
const MIN_VISIBLE_TASKS_FOR_COMPACTION = 7;
const MIN_VISIBLE_STEPS_FOR_COMPACTION = 60;
const MAX_SUMMARY_CHARS = 2200;

function summarizeTask(task: AgentTask, index: number): string {
  const query = summarizeAISessionRuntimeText(task.query, 120) || "未命名任务";
  const answer = summarizeAISessionRuntimeText(task.answer || "", 160);
  const toolNames = Array.from(
    new Set(
      task.steps
        .filter((step) => step.type === "action" && step.toolName)
        .map((step) => String(step.toolName)),
    ),
  );
  const status = task.status || (task.answer ? "success" : "pending");
  const attachments = [
    ...(task.attachmentPaths ?? []),
    ...(task.images ?? []),
  ];
  const parts = [
    `任务 ${index + 1}`,
    `状态：${status}`,
    `需求：${query}`,
  ];

  if (toolNames.length > 0) {
    parts.push(`工具：${toolNames.slice(0, 5).join("、")}`);
  }
  if (attachments.length > 0) {
    parts.push(
      `工作集：${attachments
        .slice(0, 4)
        .map((path) => path.split("/").pop() || path)
        .join("、")}`,
    );
  }
  if (answer) {
    parts.push(`结果：${answer}`);
  }

  return parts.join("；");
}

function truncateSummary(lines: string[]): string {
  const joined = lines.join("\n");
  if (joined.length <= MAX_SUMMARY_CHARS) {
    return joined;
  }
  return `${joined.slice(0, MAX_SUMMARY_CHARS - 24).trimEnd()}\n...（历史摘要已截断）`;
}

function getVisibleStepCount(session: AgentSession): number {
  return getVisibleAgentTasks(session).reduce(
    (sum, task) => sum + task.steps.length,
    0,
  );
}

export function shouldAutoCompactAgentSession(session: AgentSession): {
  shouldCompact: boolean;
  reason?: AgentSessionCompaction["reason"];
  targetTaskCount: number;
} {
  const visibleTasks = getVisibleAgentTasks(session);
  const currentCompactedTaskCount = getAgentSessionCompactedTaskCount(session);
  const visibleStepCount = getVisibleStepCount(session);

  if (visibleTasks.length < MIN_VISIBLE_TASKS_FOR_COMPACTION) {
    return {
      shouldCompact: false,
      targetTaskCount: currentCompactedTaskCount,
    };
  }

  const reason: AgentSessionCompaction["reason"] | undefined =
    visibleStepCount >= MIN_VISIBLE_STEPS_FOR_COMPACTION
      ? "step_count"
      : visibleTasks.length >= MIN_VISIBLE_TASKS_FOR_COMPACTION
        ? "task_count"
        : undefined;
  const targetTaskCount = Math.max(
    currentCompactedTaskCount,
    visibleTasks.length - DEFAULT_KEEP_RECENT_TASKS,
  );

  return {
    shouldCompact: Boolean(reason) && targetTaskCount > currentCompactedTaskCount,
    reason,
    targetTaskCount,
  };
}

export function buildAgentSessionCompactionState(
  session: AgentSession,
  options?: {
    reason?: AgentSessionCompaction["reason"];
    aggressive?: boolean;
  },
): AgentSessionCompaction | null {
  const visibleTasks = getVisibleAgentTasks(session);
  if (visibleTasks.length < 2) {
    return null;
  }

  const existingCompactedTaskCount = getAgentSessionCompactedTaskCount(session);
  const keepRecentTasks = options?.aggressive
    ? AGGRESSIVE_KEEP_RECENT_TASKS
    : DEFAULT_KEEP_RECENT_TASKS;
  const targetTaskCount = Math.max(
    existingCompactedTaskCount,
    visibleTasks.length - keepRecentTasks,
  );

  if (targetTaskCount <= 0 || targetTaskCount <= existingCompactedTaskCount) {
    return session.compaction ?? null;
  }

  const compactedTasks = visibleTasks.slice(0, targetTaskCount);
  const lines = compactedTasks.map((task, index) => summarizeTask(task, index));
  const summary = truncateSummary(lines);
  if (!summary.trim()) {
    return null;
  }

  return {
    summary,
    compactedTaskCount: targetTaskCount,
    lastCompactedAt: Date.now(),
    reason: options?.reason ?? session.compaction?.reason ?? "task_count",
  };
}

export function buildAgentSessionContextMessages(
  session: AgentSession | null | undefined,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!session?.compaction?.summary?.trim()) {
    return [];
  }

  return [
    {
      role: "user",
      content:
        "以下是当前 Agent 会话中已整理过的历史摘要，请把它视为已完成上下文，并在后续执行中延续这些结论：\n"
        + session.compaction.summary,
    },
    {
      role: "assistant",
      content:
        "已接收历史摘要。后续仅需结合最近未压缩任务、当前工作集和最新用户要求继续执行。",
    },
  ];
}

export function isAgentContextPressureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    /maximum context length/i,
    /context length/i,
    /prompt is too long/i,
    /too many input tokens/i,
    /context window/i,
    /request too large/i,
    /max(?:imum)? tokens/i,
  ].some((pattern) => pattern.test(message));
}
