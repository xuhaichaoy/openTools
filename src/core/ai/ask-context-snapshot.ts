import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { ChatMessage } from "@/core/ai/types";
import type { AICenterHandoff } from "@/store/app-store";

const MODE_LABELS: Record<NonNullable<AICenterHandoff["sourceMode"]>, string> = {
  ask: "Ask",
  agent: "Agent",
  cluster: "Cluster",
  dialog: "Dialog",
};

export interface AskContextSnapshot {
  generatedAt: number;
  conversationId?: string;
  title?: string;
  workspaceRoot?: string;
  sourceModeLabel?: string;
  sourceHandoffGoalPreview?: string;
  sourceHandoffSummary?: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  attachmentCount: number;
  imageCount: number;
  contextBlockCount: number;
  recalledMemoryCount: number;
  recalledTranscriptCount: number;
  latestUserPreview?: string;
  latestAssistantPreview?: string;
  draftInputPreview?: string;
  draftAttachmentCount: number;
  draftImageCount: number;
  draftHasContextBlock: boolean;
  lastSessionNotePreview?: string;
  lastRunStatus?: string;
  lastRunDurationMs?: number;
  isStreaming: boolean;
  contextLines: string[];
}

function compactText(text: string, maxLength: number): string | undefined {
  return summarizeAISessionRuntimeText(text, maxLength) || undefined;
}

export function buildAskSourceModeLabel(
  handoff?: AICenterHandoff | null,
): string | undefined {
  if (!handoff?.sourceMode) return undefined;
  return `${MODE_LABELS[handoff.sourceMode]} 模式`;
}

function buildAskSourceHandoffSummary(
  handoff?: AICenterHandoff | null,
): string | undefined {
  if (!handoff) return undefined;
  const parts: string[] = [];
  const modeLabel = buildAskSourceModeLabel(handoff);
  if (modeLabel) parts.push(`来源：${modeLabel}`);
  if (handoff.intent) parts.push(`意图：${handoff.intent}`);
  if (handoff.goal) {
    const goal = compactText(handoff.goal, 120);
    if (goal) parts.push(`目标：${goal}`);
  }
  if (handoff.summary) {
    const summary = compactText(handoff.summary, 140);
    if (summary) parts.push(`摘要：${summary}`);
  }
  return parts.join("；") || undefined;
}

function getUniqueMessageAttachmentStats(messages: readonly ChatMessage[]): {
  attachmentCount: number;
  imageCount: number;
  contextBlockCount: number;
} {
  const attachmentPaths = new Set<string>();
  const imagePaths = new Set<string>();
  let contextBlockCount = 0;

  for (const message of messages) {
    for (const path of message.attachmentPaths ?? []) {
      const normalized = path.trim();
      if (normalized) attachmentPaths.add(normalized);
    }
    for (const path of message.images ?? []) {
      const normalized = path.trim();
      if (normalized) imagePaths.add(normalized);
    }
    if (message.contextPrefix?.trim()) {
      contextBlockCount += 1;
    }
  }

  return {
    attachmentCount: attachmentPaths.size,
    imageCount: imagePaths.size,
    contextBlockCount,
  };
}

function getLatestMessagePreview(
  messages: readonly ChatMessage[],
  role: "user" | "assistant",
): string | undefined {
  const message = [...messages]
    .reverse()
    .find((item) => item.role === role && item.content.trim());
  return message ? compactText(message.content, 140) : undefined;
}

function getLatestRecalledMemoryCount(messages: readonly ChatMessage[]): number {
  const assistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!assistantMessage) return 0;
  return Math.max(
    assistantMessage.appliedMemoryIds?.length ?? 0,
    assistantMessage.appliedMemoryPreview?.length ?? 0,
  );
}

function getLatestTranscriptRecallCount(messages: readonly ChatMessage[]): number {
  const assistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!assistantMessage) return 0;
  return Math.max(
    assistantMessage.transcriptRecallHitCount ?? 0,
    assistantMessage.appliedTranscriptPreview?.length ?? 0,
  );
}

export function cloneAskContextSnapshot(
  snapshot?: AskContextSnapshot | null,
): AskContextSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    contextLines: [...snapshot.contextLines],
  };
}

export function hasAskContextSnapshotContent(
  snapshot?: AskContextSnapshot | null,
): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.workspaceRoot
    || snapshot.sourceModeLabel
    || snapshot.messageCount > 0
    || snapshot.attachmentCount > 0
    || snapshot.imageCount > 0
    || snapshot.contextBlockCount > 0
    || snapshot.recalledMemoryCount > 0
    || snapshot.recalledTranscriptCount > 0
    || snapshot.draftInputPreview
    || snapshot.draftAttachmentCount > 0
    || snapshot.draftImageCount > 0
    || snapshot.draftHasContextBlock
    || snapshot.lastSessionNotePreview
    || snapshot.lastRunStatus
    || snapshot.isStreaming,
  );
}

function describeLastRunStatus(status?: string): string | null {
  switch (status) {
    case "success":
      return "最近一轮已完成";
    case "error":
      return "最近一轮失败";
    case "cancelled":
      return "最近一轮已中断";
    default:
      return null;
  }
}

export function buildAskContextNarrative(
  snapshot?: AskContextSnapshot | null,
): string {
  if (!snapshot) {
    return "当前会基于 Ask 最近对话继续回答。";
  }

  const parts: string[] = [];
  if (snapshot.workspaceRoot) {
    parts.push(`当前会优先沿用工作区 ${snapshot.workspaceRoot}`);
  }
  if (snapshot.sourceModeLabel) {
    parts.push(
      `已带入来自 ${snapshot.sourceModeLabel} 的接力上下文${snapshot.sourceHandoffGoalPreview ? `，目标是“${snapshot.sourceHandoffGoalPreview}”` : ""}`,
    );
  }
  if (snapshot.messageCount > 0) {
    parts.push(`当前 Ask 对话里已有 ${snapshot.messageCount} 条消息可继续参考`);
  }
  if (snapshot.recalledMemoryCount > 0) {
    parts.push(`最近一轮回答已引用 ${snapshot.recalledMemoryCount} 条长期记忆`);
  }
  if (snapshot.recalledTranscriptCount > 0) {
    parts.push(`最近一轮回答还回补了 ${snapshot.recalledTranscriptCount} 条会话轨迹`);
  }
  if (snapshot.lastRunStatus) {
    parts.push(
      `${describeLastRunStatus(snapshot.lastRunStatus) || "最近一轮已更新"}${snapshot.lastRunDurationMs ? `（约 ${Math.max(1, Math.round(snapshot.lastRunDurationMs / 1000))} 秒）` : ""}`,
    );
  }
  if (snapshot.lastSessionNotePreview) {
    parts.push("最近一轮已经沉淀为会话笔记");
  }
  if (snapshot.draftInputPreview || snapshot.draftAttachmentCount > 0 || snapshot.draftImageCount > 0) {
    parts.push("当前输入框中的草稿和附件也会一起参与下一轮处理");
  }
  if (snapshot.isStreaming) {
    parts.push("模型仍在生成中");
  }

  if (parts.length === 0) {
    return "当前会基于 Ask 最近对话继续回答。";
  }

  return `${parts.join("；")}。`;
}

export function buildAskContextReport(
  snapshot: AskContextSnapshot,
): string[] {
  const lines: string[] = [];

  if (snapshot.workspaceRoot) {
    lines.push(`当前工作区：${snapshot.workspaceRoot}`);
  }
  if (snapshot.sourceHandoffSummary) {
    lines.push(`跨模式来源：${snapshot.sourceHandoffSummary}`);
  }
  if (snapshot.messageCount > 0) {
    lines.push(`对话上下文：当前共 ${snapshot.messageCount} 条消息（用户 ${snapshot.userMessageCount} / 助手 ${snapshot.assistantMessageCount}）`);
  }
  if (snapshot.attachmentCount > 0 || snapshot.imageCount > 0 || snapshot.contextBlockCount > 0) {
    lines.push(`带入材料：文件/目录 ${snapshot.attachmentCount} 项，图片 ${snapshot.imageCount} 张，原始上下文块 ${snapshot.contextBlockCount} 段`);
  }
  if (snapshot.recalledMemoryCount > 0) {
    lines.push(`长期记忆：最近一轮回答用了 ${snapshot.recalledMemoryCount} 条记忆`);
  }
  if (snapshot.recalledTranscriptCount > 0) {
    lines.push(`会话轨迹：最近一轮回答回补了 ${snapshot.recalledTranscriptCount} 条轨迹`);
  }
  if (snapshot.lastRunStatus) {
    lines.push(
      `最近运行：${describeLastRunStatus(snapshot.lastRunStatus) || snapshot.lastRunStatus}${snapshot.lastRunDurationMs ? ` / ${Math.max(1, Math.round(snapshot.lastRunDurationMs / 1000))}s` : ""}`,
    );
  }
  if (snapshot.lastSessionNotePreview) {
    lines.push(`最近会话笔记：${snapshot.lastSessionNotePreview}`);
  }
  if (snapshot.draftInputPreview || snapshot.draftAttachmentCount > 0 || snapshot.draftImageCount > 0 || snapshot.draftHasContextBlock) {
    lines.push(
      `当前草稿：${snapshot.draftInputPreview ? `输入“${snapshot.draftInputPreview}”` : "无文字草稿"}，附件 ${snapshot.draftAttachmentCount} 项，图片 ${snapshot.draftImageCount} 张${snapshot.draftHasContextBlock ? "，且带有原始文件上下文" : ""}`,
    );
  }
  if (snapshot.latestAssistantPreview) {
    lines.push(`最近回复：${snapshot.latestAssistantPreview}`);
  } else if (snapshot.latestUserPreview) {
    lines.push(`最近提问：${snapshot.latestUserPreview}`);
  }
  if (snapshot.isStreaming) {
    lines.push("运行状态：模型仍在生成中");
  }

  return lines;
}

export function buildAskContextSnapshot(params: {
  conversationId?: string;
  title?: string;
  workspaceRoot?: string;
  sourceHandoff?: AICenterHandoff | null;
  messages?: readonly ChatMessage[];
  draftInput?: string;
  draftAttachmentCount?: number;
  draftImageCount?: number;
  draftHasContextBlock?: boolean;
  lastSessionNotePreview?: string;
  lastRunStatus?: string;
  lastRunDurationMs?: number;
  isStreaming?: boolean;
}): AskContextSnapshot {
  const messages = params.messages ?? [];
  const attachmentStats = getUniqueMessageAttachmentStats(messages);
  const snapshot: AskContextSnapshot = {
    generatedAt: Date.now(),
    conversationId: params.conversationId?.trim() || undefined,
    title: params.title?.trim() || undefined,
    workspaceRoot: params.workspaceRoot?.trim() || undefined,
    sourceModeLabel: buildAskSourceModeLabel(params.sourceHandoff),
    sourceHandoffGoalPreview: params.sourceHandoff?.goal
      ? compactText(params.sourceHandoff.goal, 72)
      : undefined,
    sourceHandoffSummary: buildAskSourceHandoffSummary(params.sourceHandoff),
    messageCount: messages.length,
    userMessageCount: messages.filter((message) => message.role === "user").length,
    assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
    attachmentCount: attachmentStats.attachmentCount,
    imageCount: attachmentStats.imageCount,
    contextBlockCount: attachmentStats.contextBlockCount,
    recalledMemoryCount: getLatestRecalledMemoryCount(messages),
    recalledTranscriptCount: getLatestTranscriptRecallCount(messages),
    latestUserPreview: getLatestMessagePreview(messages, "user"),
    latestAssistantPreview: getLatestMessagePreview(messages, "assistant"),
    draftInputPreview: params.draftInput ? compactText(params.draftInput, 96) : undefined,
    draftAttachmentCount: Math.max(0, params.draftAttachmentCount ?? 0),
    draftImageCount: Math.max(0, params.draftImageCount ?? 0),
    draftHasContextBlock: !!params.draftHasContextBlock,
    lastSessionNotePreview: params.lastSessionNotePreview
      ? compactText(params.lastSessionNotePreview, 140)
      : undefined,
    lastRunStatus: params.lastRunStatus?.trim() || undefined,
    lastRunDurationMs:
      typeof params.lastRunDurationMs === "number"
        ? Math.max(0, params.lastRunDurationMs)
        : undefined,
    isStreaming: !!params.isStreaming,
    contextLines: [],
  };

  snapshot.contextLines = buildAskContextReport(snapshot);
  return snapshot;
}
