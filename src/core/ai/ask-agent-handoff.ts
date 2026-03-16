import type { ChatMessage, Conversation } from "@/core/ai/types";
import type { AICenterHandoff } from "@/store/app-store";
import {
  buildAICenterHandoffScopedFileRefs,
  normalizeAICenterHandoff,
  pickVisualAttachmentPaths,
} from "@/core/ai/ai-center-handoff";
import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";

const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 600;
const DEFAULT_MAX_CONTEXT_BLOCKS = 2;
const DEFAULT_MAX_CONTEXT_CHARS = 3000;

function summarizeMessage(message: ChatMessage, maxChars: number): string {
  const roleLabel =
    message.role === "user"
      ? "用户"
      : message.role === "assistant"
        ? "助手"
        : message.role === "tool"
          ? "工具"
          : "系统";
  const text = message.content.trim();
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  const lines = [`[${roleLabel}]: ${clipped || "（空）"}`];

  if (message.images?.length) {
    lines.push(`  [图片]: ${message.images.length} 张`);
  }

  if (message.toolCalls?.length) {
    const toolNames = message.toolCalls.map((toolCall) => toolCall.name).filter(Boolean);
    if (toolNames.length > 0) {
      lines.push(`  [工具调用]: ${toolNames.join(", ")}`);
    }
  }

  return lines.join("\n");
}

function collectMessageAttachmentPaths(message: ChatMessage): string[] {
  const paths = [
    ...(message.attachmentPaths || []),
    ...(message.images || []),
  ];
  return paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

export function buildAskAgentHandoff(
  conversation: Conversation | null,
  options?: {
    maxMessages?: number;
    maxCharsPerMessage?: number;
    maxContextBlocks?: number;
    maxContextChars?: number;
  },
): AICenterHandoff | null {
  if (!conversation || conversation.messages.length === 0) return null;

  const maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxCharsPerMessage = options?.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE;
  const maxContextBlocks = options?.maxContextBlocks ?? DEFAULT_MAX_CONTEXT_BLOCKS;
  const maxContextChars = options?.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const recentMessages = conversation.messages
    .filter((message) => !message.streaming)
    .slice(-maxMessages);
  if (recentMessages.length === 0) return null;

  const transcriptSummary = recentMessages
    .map((message) => summarizeMessage(message, maxCharsPerMessage))
    .join("\n");
  const attachmentPaths = Array.from(
    new Set(
      conversation.messages.flatMap((message) => collectMessageAttachmentPaths(message)),
    ),
  );
  const visualAttachmentPaths = pickVisualAttachmentPaths(attachmentPaths, 12) ?? [];
  const contextBlocks = Array.from(
    new Set(
      recentMessages
        .map((message) => message.contextPrefix?.trim())
        .filter((context): context is string => !!context),
    ),
  )
    .slice(-maxContextBlocks)
    .map((context, index) => {
      const clipped = context.length > maxContextChars
        ? `${context.slice(0, maxContextChars)}\n...`
        : context;
      return `### 原始附件上下文 ${index + 1}\n${clipped}`;
    });
  const intro = visualAttachmentPaths.length > 0
    ? "以下是之前的对话上下文，并已附带相关视觉参考图、文件或目录，请基于此继续执行任务："
    : attachmentPaths.length > 0
      ? "以下是之前的对话上下文，并已附带相关图片、文件或目录，请基于此继续执行任务："
    : "以下是之前的对话上下文，请基于此继续执行任务：";
  const querySections = [`${intro}\n\n${transcriptSummary}`];
  if (contextBlocks.length > 0) {
    querySections.push(`以下是最近一次对话里携带的原始附件/目录上下文摘录：\n\n${contextBlocks.join("\n\n")}`);
  }

  const summary = attachmentPaths.length > 0
    ? `Ask 对话上下文，附带 ${attachmentPaths.length} 个文件/图片/目录${visualAttachmentPaths.length > 0 ? `，其中 ${visualAttachmentPaths.length} 张为视觉参考图` : ""}`
    : "Ask 对话上下文";
  const latestUserMessage = [...recentMessages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim());
  const keyPoints = [
    `带入最近 ${recentMessages.length} 条 Ask 消息`,
    attachmentPaths.length > 0 ? `包含 ${attachmentPaths.length} 个附件路径` : "",
    visualAttachmentPaths.length > 0 ? `包含 ${visualAttachmentPaths.length} 张视觉参考图` : "",
    contextBlocks.length > 0 ? `附带 ${contextBlocks.length} 段原始附件上下文摘录` : "",
  ].filter(Boolean);
  const inferredCoding = inferCodingExecutionProfile({
    query: transcriptSummary,
    attachmentPaths,
  });

  return normalizeAICenterHandoff({
    query: querySections.join("\n\n---\n\n"),
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
    ...(visualAttachmentPaths.length > 0 ? { visualAttachmentPaths } : {}),
    title: conversation.title ? `延续 Ask 对话：${conversation.title}` : "延续 Ask 对话",
    goal: summarizeAISessionRuntimeText(latestUserMessage?.content, 120) || "延续 Ask 对话里的当前任务",
    intent: inferredCoding.profile.codingMode ? "coding" : "general",
    keyPoints,
    nextSteps: [
      "先阅读 Ask 对话与附件上下文，再继续处理任务",
      visualAttachmentPaths.length > 0 ? "优先查看已带入的视觉参考图，不必重新描述界面或截图" : "",
      attachmentPaths.length > 0 ? "优先利用已带入的图片、文件或目录，不必重新索要" : "",
    ].filter(Boolean),
    contextSections: contextBlocks.length > 0
      ? [
          {
            title: "原始附件上下文",
            items: contextBlocks.map((block) => summarizeAISessionRuntimeText(block, 160) || block),
          },
        ]
      : undefined,
    files: buildAICenterHandoffScopedFileRefs({
      attachmentPaths,
      visualAttachmentPaths,
      visualReason: "Ask 视觉参考图",
      attachmentReason: attachmentPaths.length > 0 ? "Ask 附件/目录上下文" : undefined,
    }),
    sourceMode: "ask",
    sourceSessionId: conversation.id,
    sourceLabel: "Ask 对话",
    summary,
  });
}
