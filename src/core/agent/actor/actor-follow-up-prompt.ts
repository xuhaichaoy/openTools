import type { InboxMessage } from "./types";

const TASK_FAILED_PATTERN = /^\[(?:Task failed|任务失败):\s*([^\]\n]+)\]/iu;
const TASK_COMPLETED_PATTERN = /^\[(?:Task completed|任务完成):\s*([^\]\n]+)\]/iu;

export interface FollowUpMessageSummary {
  userMessageCount: number;
  userImageCount: number;
  actorMessageCount: number;
  hasTaskFailure: boolean;
  hasTaskCompletion: boolean;
  failedTaskLabels: string[];
  completedTaskLabels: string[];
}

export interface FollowUpPromptDescriptor {
  mode: "general" | "spawn_failure" | "spawn_completion";
  prompt: string;
  summary: FollowUpMessageSummary;
  images?: string[];
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function extractTaskLabel(content: string, pattern: RegExp): string | null {
  const match = pattern.exec(content);
  return match?.[1]?.trim() || null;
}

export function summarizeFollowUpMessages(
  drained: Array<Pick<InboxMessage, "from" | "content" | "images">>,
): FollowUpMessageSummary {
  const failedTaskLabels: string[] = [];
  const completedTaskLabels: string[] = [];
  let userMessageCount = 0;
  let userImageCount = 0;
  let actorMessageCount = 0;

  for (const message of drained) {
    if (message.from === "user") {
      userMessageCount++;
      userImageCount += message.images?.length ?? 0;
      continue;
    }

    actorMessageCount++;
    const failedLabel = extractTaskLabel(message.content, TASK_FAILED_PATTERN);
    if (failedLabel) {
      failedTaskLabels.push(failedLabel);
      continue;
    }

    const completedLabel = extractTaskLabel(message.content, TASK_COMPLETED_PATTERN);
    if (completedLabel) {
      completedTaskLabels.push(completedLabel);
    }
  }

  return {
    userMessageCount,
    userImageCount,
    actorMessageCount,
    hasTaskFailure: failedTaskLabels.length > 0,
    hasTaskCompletion: completedTaskLabels.length > 0,
    failedTaskLabels: uniqueNonEmpty(failedTaskLabels),
    completedTaskLabels: uniqueNonEmpty(completedTaskLabels),
  };
}

export function buildFollowUpPromptFromRenderedMessages(params: {
  renderedMessages: string[];
  summary: FollowUpMessageSummary;
}): FollowUpPromptDescriptor {
  const { renderedMessages, summary } = params;
  const messageBlock = renderedMessages.join("\n");
  const failedSummary = summary.failedTaskLabels.length
    ? `失败子任务：${summary.failedTaskLabels.join("、")}`
    : "存在子任务失败。";
  const completedSummary = summary.completedTaskLabels.length
    ? `已完成子任务：${summary.completedTaskLabels.join("、")}`
    : "";

  if (summary.hasTaskFailure) {
    return {
      mode: "spawn_failure",
      summary,
      prompt: [
        "你收到了新的协作消息，其中包含子任务失败。",
        failedSummary,
        completedSummary,
        "消息列表：",
        messageBlock,
        "",
        "请优先处理这个失败，不要回到泛化分析循环。",
        "要求：",
        "1. 先判断你是否已经有足够信息直接接管主任务；如果可以，立即使用工具继续完成，不要继续等待。",
        "2. 只有当失败明显来自任务描述不够具体时，才允许重新派发一次子任务；重试时必须补充明确的输出文件、保存路径和验收标准。",
        "3. 如果任务本质是生成网页、代码、文档或其他文件产物，优先直接产出可交付文件，不要只重复“先分析需求/代码结构”。",
        "4. 回复必须明确：失败原因、你采取的处理方式、当前最终结果或真实缺口。",
        "5. 不要输出“我先分析”“稍后汇总”“继续整理”这类中间态话术。",
      ].filter(Boolean).join("\n"),
    };
  }

  if (summary.hasTaskCompletion && summary.userMessageCount === 0) {
    return {
      mode: "spawn_completion",
      summary,
      prompt: [
        "你收到了新的协作消息，主要是子任务完成回报。",
        completedSummary,
        "消息列表：",
        messageBlock,
        "",
        "请直接整合这些结果并给出最终成果。",
        "要求：",
        "1. 直接输出最终结论和可交付内容，不要重新分析或重复分工。",
        "2. 明确列出已经完成的事项、产物位置和验证情况。",
        "3. 如果仍有真实缺口，只说明尚未完成的部分，不要使用中间态话术。",
      ].filter(Boolean).join("\n"),
    };
  }

  return {
    mode: "general",
    summary,
    prompt: `你收到了新消息：\n${messageBlock}\n\n请处理这些消息。如果所有子任务已完成，请整合结果并输出最终成果。`,
  };
}

export function buildFinalSynthesisPrompt(params?: {
  hadFailedSpawnFollowUp?: boolean;
  failedTaskLabels?: string[];
}): string {
  const failedTaskSummary = uniqueNonEmpty(params?.failedTaskLabels ?? []);
  const failureLine = params?.hadFailedSpawnFollowUp
    ? `注意：本轮至少有一个子任务失败${failedTaskSummary.length ? `（${failedTaskSummary.join("、")}）` : ""}。`
    : "";
  const takeoverLine = params?.hadFailedSpawnFollowUp
    ? "如果你已经接管并完成主任务，请直接给出接管后的最终产物；如果仍有缺口，只说明真实失败原因和剩余缺口。"
    : "";

  return [
    "你派发的子任务现在都已经结束。",
    failureLine,
    "请基于当前会话中的已有结果和刚收到的子任务反馈，输出给上游的最终综合答复。",
    "要求：",
    "1. 直接给结论，不要再说“稍后整理”“继续汇总”之类的中间态话术。",
    "2. 明确列出已经完成的部分与最终判断。",
    "3. 如果仍有缺口，只说明真实缺口，不要重复之前已经完成的工作。",
    takeoverLine,
  ].filter(Boolean).join("\n");
}
