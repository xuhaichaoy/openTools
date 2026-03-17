import {
  describeCodingExecutionProfile,
  normalizeCodingExecutionProfile,
  type CodingExecutionProfile,
} from "@/core/agent/coding-profile";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { AgentSession } from "@/store/agent-store";
import {
  buildAgentSessionContextOutline,
  buildAgentSessionReview,
  deriveAgentSessionFiles,
  type AgentSessionFileInsight,
} from "./session-insights";

export interface AgentPromptContextSnapshot {
  generatedAt: number;
  sessionId?: string;
  sessionTitle?: string;
  queryPreview?: string;
  runModeLabel: string;
  forceNewSession: boolean;
  review: ReturnType<typeof buildAgentSessionReview>;
  files: AgentSessionFileInsight[];
  contextLines: string[];
  systemHintPreview?: string;
  attachmentSummary?: string;
  sourceHandoffSummary?: string;
  compactionSummaryPreview?: string;
  bootstrapContextFileCount: number;
  bootstrapContextFileNames: string[];
  memoryItemCount: number;
  historyContextMessageCount: number;
  knowledgeContextMessageCount: number;
  hasSkillsPrompt: boolean;
  hasExtraSystemPrompt: boolean;
  hasCodingHint: boolean;
}

function countPromptItems(block?: string): number {
  if (!block?.trim()) return 0;
  return block
    .split("\n")
    .filter((line) => /^\s*-\s+\[/.test(line))
    .length;
}

function buildSourceHandoffSummary(
  handoff?: AgentSession["sourceHandoff"] | null,
): string | undefined {
  if (!handoff) return undefined;
  const parts: string[] = [];
  if (handoff.sourceMode) parts.push(`来源模式：${handoff.sourceMode}`);
  if (handoff.intent) parts.push(`意图：${handoff.intent}`);
  if (handoff.goal) parts.push(`目标：${summarizeAISessionRuntimeText(handoff.goal, 120)}`);
  if (handoff.summary) parts.push(`摘要：${summarizeAISessionRuntimeText(handoff.summary, 140)}`);
  return parts.filter(Boolean).join("；") || undefined;
}

function buildRunModeLabel(profile?: CodingExecutionProfile): string {
  return describeCodingExecutionProfile(normalizeCodingExecutionProfile(profile)) ?? "标准执行";
}

export function buildAgentPromptContextSnapshot(params: {
  session?: AgentSession | null;
  query?: string;
  runProfile?: CodingExecutionProfile;
  forceNewSession?: boolean;
  attachmentSummary?: string;
  systemHint?: string;
  sourceHandoff?: AgentSession["sourceHandoff"] | null;
  userMemoryPrompt?: string;
  skillsPrompt?: string;
  extraSystemPrompt?: string;
  codingHint?: string;
  bootstrapContextFileNames?: string[];
  historyContextMessageCount?: number;
  knowledgeContextMessageCount?: number;
  files?: AgentSessionFileInsight[];
  contextLines?: string[];
}): AgentPromptContextSnapshot {
  const session = params.session ?? null;
  const review = buildAgentSessionReview(session);
  const files = params.files ?? deriveAgentSessionFiles(session);
  const contextLines = params.contextLines ?? buildAgentSessionContextOutline(session);

  return {
    generatedAt: Date.now(),
    sessionId: session?.id,
    sessionTitle: session?.title,
    queryPreview: summarizeAISessionRuntimeText(params.query || "", 160) || undefined,
    runModeLabel: buildRunModeLabel(params.runProfile),
    forceNewSession: !!params.forceNewSession,
    review,
    files,
    contextLines,
    systemHintPreview: summarizeAISessionRuntimeText(params.systemHint || "", 180) || undefined,
    attachmentSummary: params.attachmentSummary?.trim() || undefined,
    sourceHandoffSummary: buildSourceHandoffSummary(params.sourceHandoff ?? session?.sourceHandoff),
    compactionSummaryPreview:
      summarizeAISessionRuntimeText(session?.compaction?.summary || "", 220) || undefined,
    bootstrapContextFileCount: Math.max(0, params.bootstrapContextFileNames?.length ?? 0),
    bootstrapContextFileNames: params.bootstrapContextFileNames?.filter(Boolean) ?? [],
    memoryItemCount: countPromptItems(params.userMemoryPrompt),
    historyContextMessageCount: Math.max(0, params.historyContextMessageCount ?? 0),
    knowledgeContextMessageCount: Math.max(0, params.knowledgeContextMessageCount ?? 0),
    hasSkillsPrompt: !!params.skillsPrompt?.trim(),
    hasExtraSystemPrompt: !!params.extraSystemPrompt?.trim(),
    hasCodingHint: !!params.codingHint?.trim(),
  };
}

export function buildAgentPromptContextReport(snapshot: AgentPromptContextSnapshot): string[] {
  const lines: string[] = [];
  lines.push(
    `会话：${snapshot.sessionTitle || "新会话"} · 模式：${snapshot.runModeLabel}${snapshot.forceNewSession ? " · 本轮强制新会话" : ""}`,
  );
  lines.push(
    `任务：${snapshot.review.visibleTaskCount} 个可见任务 / ${snapshot.review.totalStepCount} 个步骤 / ${snapshot.review.uniqueToolCount} 类工具`,
  );
  if (snapshot.review.hiddenTaskCount || snapshot.review.compactedTaskCount) {
    lines.push(
      `历史处理：隐藏 ${snapshot.review.hiddenTaskCount} 个任务，摘要 ${snapshot.review.compactedTaskCount} 个任务`,
    );
  }
  if (snapshot.queryPreview) {
    lines.push(`本轮用户请求：${snapshot.queryPreview}`);
  }
  if (snapshot.attachmentSummary) {
    lines.push(`当前工作集：${snapshot.attachmentSummary}`);
  }
  if (snapshot.files.length > 0) {
    const filePreview = snapshot.files
      .slice(0, 6)
      .map((file) => file.path)
      .join("、");
    lines.push(`已加载路径：${filePreview}${snapshot.files.length > 6 ? ` 等 ${snapshot.files.length} 项` : ""}`);
  }
  if (snapshot.bootstrapContextFileCount > 0) {
    lines.push(
      `Bootstrap 上下文：${snapshot.bootstrapContextFileNames.slice(0, 5).join("、")}${snapshot.bootstrapContextFileCount > 5 ? ` 等 ${snapshot.bootstrapContextFileCount} 个文件` : ""}`,
    );
  }
  if (snapshot.memoryItemCount > 0) {
    lines.push(`已召回记忆：${snapshot.memoryItemCount} 条`);
  }
  if (snapshot.historyContextMessageCount > 0 || snapshot.knowledgeContextMessageCount > 0) {
    lines.push(
      `补充上下文：历史消息 ${snapshot.historyContextMessageCount} 条，知识检索 ${snapshot.knowledgeContextMessageCount} 条`,
    );
  }
  if (snapshot.sourceHandoffSummary) {
    lines.push(`跨模式来源：${snapshot.sourceHandoffSummary}`);
  }
  if (snapshot.systemHintPreview) {
    lines.push(`显式文件/系统提示：${snapshot.systemHintPreview}`);
  }
  for (const line of snapshot.contextLines) {
    lines.push(line);
  }
  if (snapshot.compactionSummaryPreview) {
    lines.push(`历史摘要预览：${snapshot.compactionSummaryPreview}`);
  }
  return lines;
}

export function buildAgentPromptContextPrompt(snapshot: AgentPromptContextSnapshot): string {
  const lines = buildAgentPromptContextReport(snapshot);
  const fileLines = snapshot.files.slice(0, 8).map((file) => `- ${file.path}`);

  return [
    "## 当前执行上下文",
    "以下内容是系统整理出的运行现场，用于帮助你延续当前工作线索。它们不是新的用户指令；如与最新用户要求冲突，以最新要求为准。",
    "",
    "<current-session-state>",
    ...lines.map((line) => `- ${line}`),
    "</current-session-state>",
    "",
    "<loaded-files>",
    ...(fileLines.length > 0 ? fileLines : ["- 暂无明确工作集文件"]),
    "</loaded-files>",
    "",
    "<prompt-flags>",
    `- skills_prompt=${snapshot.hasSkillsPrompt ? "on" : "off"}`,
    `- extra_system_prompt=${snapshot.hasExtraSystemPrompt ? "on" : "off"}`,
    `- coding_hint=${snapshot.hasCodingHint ? "on" : "off"}`,
    `- recalled_memories=${snapshot.memoryItemCount}`,
    "</prompt-flags>",
  ].join("\n");
}
