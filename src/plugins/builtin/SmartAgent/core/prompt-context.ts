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
  currentTimeLabel: string;
  currentTimeIso: string;
  currentTimeTimezone?: string;
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
  compactionPreservedIdentifiers: string[];
  compactionPreservedToolNames: string[];
  compactionBootstrapRules: string[];
  bootstrapContextFileCount: number;
  bootstrapContextFileNames: string[];
  workspaceRoot?: string;
  workspaceReset: boolean;
  continuityStrategy?: string;
  continuityReason?: string;
  memoryItemCount: number;
  historyContextMessageCount: number;
  knowledgeContextMessageCount: number;
  lastSessionNotePreview?: string;
  lastTurnStatus?: string;
  lastTurnDurationMs?: number;
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

function describeLastTurnStatus(status?: string): string {
  switch (status) {
    case "success":
      return "成功";
    case "error":
      return "失败";
    case "cancelled":
      return "已中断";
    default:
      return status || "未知";
  }
}

function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function buildCurrentTimeSnapshot(now = new Date()): Pick<
  AgentPromptContextSnapshot,
  "currentTimeLabel" | "currentTimeIso" | "currentTimeTimezone"
> {
  let localLabel = now.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  if (!localLabel) {
    localLabel = now.toLocaleString();
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || undefined;
  const offset = formatUtcOffset(now);

  return {
    currentTimeLabel: `${localLabel}（${offset}${timezone ? ` / ${timezone}` : ""}）`,
    currentTimeIso: now.toISOString(),
    currentTimeTimezone: timezone,
  };
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
  workspaceRoot?: string;
  workspaceReset?: boolean;
  continuityStrategy?: string;
  continuityReason?: string;
  memoryItemCount?: number;
  historyContextMessageCount?: number;
  knowledgeContextMessageCount?: number;
  files?: AgentSessionFileInsight[];
  contextLines?: string[];
}): AgentPromptContextSnapshot {
  const session = params.session ?? null;
  const review = buildAgentSessionReview(session);
  const files = params.files ?? deriveAgentSessionFiles(session);
  const contextLines = params.contextLines ?? buildAgentSessionContextOutline(session);
  const currentTime = buildCurrentTimeSnapshot();

  return {
    generatedAt: Date.now(),
    currentTimeLabel: currentTime.currentTimeLabel,
    currentTimeIso: currentTime.currentTimeIso,
    currentTimeTimezone: currentTime.currentTimeTimezone,
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
    compactionPreservedIdentifiers: session?.compaction?.preservedIdentifiers?.slice(0, 8) ?? [],
    compactionPreservedToolNames: session?.compaction?.preservedToolNames?.slice(0, 6) ?? [],
    compactionBootstrapRules: session?.compaction?.bootstrapReinjectionPreview?.slice(0, 3) ?? [],
    bootstrapContextFileCount: Math.max(0, params.bootstrapContextFileNames?.length ?? 0),
    bootstrapContextFileNames: params.bootstrapContextFileNames?.filter(Boolean) ?? [],
    workspaceRoot: params.workspaceRoot?.trim() || undefined,
    workspaceReset: !!params.workspaceReset,
    continuityStrategy: params.continuityStrategy?.trim() || undefined,
    continuityReason: params.continuityReason?.trim() || undefined,
    memoryItemCount:
      typeof params.memoryItemCount === "number"
        ? Math.max(0, params.memoryItemCount)
        : countPromptItems(params.userMemoryPrompt),
    historyContextMessageCount: Math.max(0, params.historyContextMessageCount ?? 0),
    knowledgeContextMessageCount: Math.max(0, params.knowledgeContextMessageCount ?? 0),
    lastSessionNotePreview:
      summarizeAISessionRuntimeText(session?.lastSessionNotePreview || "", 160) || undefined,
    lastTurnStatus: session?.lastContextRuntimeReport?.execution.status,
    lastTurnDurationMs: session?.lastContextRuntimeReport?.execution.durationMs,
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
    `当前本地时间：${snapshot.currentTimeLabel} / ISO ${snapshot.currentTimeIso}`,
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
  if (snapshot.compactionPreservedIdentifiers.length > 0) {
    lines.push(`压缩护栏：保留 ${snapshot.compactionPreservedIdentifiers.join("、")}`);
  }
  if (snapshot.compactionPreservedToolNames.length > 0) {
    lines.push(`压缩后延续工具：${snapshot.compactionPreservedToolNames.join("、")}`);
  }
  if (snapshot.compactionBootstrapRules.length > 0) {
    lines.push(`AGENTS 回注规则：${snapshot.compactionBootstrapRules.join("；")}`);
  }
  if (snapshot.bootstrapContextFileCount > 0) {
    lines.push(
      `Bootstrap 上下文：${snapshot.bootstrapContextFileNames.slice(0, 5).join("、")}${snapshot.bootstrapContextFileCount > 5 ? ` 等 ${snapshot.bootstrapContextFileCount} 个文件` : ""}`,
    );
  }
  if (snapshot.workspaceRoot) {
    lines.push(
      `当前工作区：${snapshot.workspaceRoot}${snapshot.workspaceReset ? "（本轮已按新工作区重置历史上下文）" : ""}`,
    );
  }
  if (snapshot.continuityStrategy || snapshot.continuityReason) {
    lines.push(
      `连续性决策：${snapshot.continuityStrategy || "unknown"} / ${snapshot.continuityReason || "unknown"}`,
    );
  }
  if (snapshot.memoryItemCount > 0) {
    lines.push(`已召回记忆：${snapshot.memoryItemCount} 条`);
  }
  if (snapshot.lastTurnStatus) {
    lines.push(
      `最近运行：${describeLastTurnStatus(snapshot.lastTurnStatus)}${snapshot.lastTurnDurationMs ? ` / ${Math.max(1, Math.round(snapshot.lastTurnDurationMs / 1000))}s` : ""}`,
    );
  }
  if (snapshot.lastSessionNotePreview) {
    lines.push(`最近会话笔记：${snapshot.lastSessionNotePreview}`);
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
    `系统已提供当前本地时间：${snapshot.currentTimeLabel}；ISO 时间：${snapshot.currentTimeIso}。处理“今天 / 明天 / 当前 / 截止时间”等相对时间问题时，请优先基于这个时间判断；只有在需要更高精度或外部真实世界数据时再调用时间工具。`,
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
