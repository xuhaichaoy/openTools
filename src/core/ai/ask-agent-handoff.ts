import type { ChatMessage, Conversation } from "@/core/ai/types";

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
): {
  query: string;
  attachmentPaths?: string[];
  sourceMode: "ask";
  sourceSessionId: string;
  sourceLabel: string;
  summary: string;
} | null {
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
  const intro = attachmentPaths.length > 0
    ? "以下是之前的对话上下文，并已附带相关图片、文件或目录，请基于此继续执行任务："
    : "以下是之前的对话上下文，请基于此继续执行任务：";
  const querySections = [`${intro}\n\n${transcriptSummary}`];
  if (contextBlocks.length > 0) {
    querySections.push(`以下是最近一次对话里携带的原始附件/目录上下文摘录：\n\n${contextBlocks.join("\n\n")}`);
  }

  const summary = attachmentPaths.length > 0
    ? `Ask 对话上下文，附带 ${attachmentPaths.length} 个文件/图片/目录`
    : "Ask 对话上下文";

  return {
    query: querySections.join("\n\n---\n\n"),
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
    sourceMode: "ask",
    sourceSessionId: conversation.id,
    sourceLabel: "Ask 对话",
    summary,
  };
}
