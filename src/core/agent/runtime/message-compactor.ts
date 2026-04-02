import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";

export interface CompactBoundary {
  type: "compact_boundary";
  beforeIndex: number;
  afterIndex: number;
  summary: string;
  timestamp: number;
}

export interface RuntimeContextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MessageCompactionResult<T = any> {
  compactedMessages: T[];
  boundary: CompactBoundary | null;
  removedCount: number;
  summary?: string;
}

export interface StepHistoryCompactionResult {
  recentSteps: AgentStep[];
  boundary: CompactBoundary | null;
  removedCount: number;
  summary?: string;
}

function previewText(value: unknown, limit = 160): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 3)).trimEnd()}...` : text;
}

export class MessageCompactor {
  private readonly maxMessages: number;
  private readonly compactThreshold: number;
  private readonly keepRecentMessages: number;
  private readonly maxHistorySteps: number;
  private readonly historyCompactThreshold: number;
  private readonly keepRecentSteps: number;

  constructor(
    maxMessages = 50,
    compactThreshold = Math.max(20, maxMessages - 10),
    maxHistorySteps = 48,
    historyCompactThreshold = Math.max(18, maxHistorySteps - 12),
  ) {
    this.maxMessages = maxMessages;
    this.compactThreshold = compactThreshold;
    this.keepRecentMessages = Math.max(12, Math.min(20, Math.floor(maxMessages / 2)));
    this.maxHistorySteps = maxHistorySteps;
    this.historyCompactThreshold = historyCompactThreshold;
    this.keepRecentSteps = Math.max(10, Math.min(18, Math.floor(maxHistorySteps / 2)));
  }

  shouldCompact(messages: readonly unknown[]): boolean {
    return messages.length > this.compactThreshold;
  }

  shouldCompactHistory(steps: readonly AgentStep[]): boolean {
    return steps.length > this.historyCompactThreshold;
  }

  compact(messages: any[]): MessageCompactionResult {
    if (!this.shouldCompact(messages)) {
      return {
        compactedMessages: messages,
        boundary: null,
        removedCount: 0,
      };
    }

    const compactEnd = Math.max(0, messages.length - this.keepRecentMessages);
    const toCompact = messages.slice(0, compactEnd);
    const toKeep = messages.slice(compactEnd);
    const summary = this.generateGenericSummary(toCompact);

    const boundary: CompactBoundary = {
      type: "compact_boundary",
      beforeIndex: 0,
      afterIndex: compactEnd,
      summary,
      timestamp: Date.now(),
    };

    return {
      compactedMessages: [boundary, ...toKeep],
      boundary,
      removedCount: toCompact.length,
      summary,
    };
  }

  compactContextMessages(
    messages: readonly RuntimeContextMessage[],
  ): MessageCompactionResult<RuntimeContextMessage> {
    if (!this.shouldCompact(messages)) {
      return {
        compactedMessages: [...messages],
        boundary: null,
        removedCount: 0,
      };
    }

    const compactEnd = Math.max(0, messages.length - this.keepRecentMessages);
    const toCompact = messages.slice(0, compactEnd);
    const toKeep = messages.slice(compactEnd);
    const summary = this.buildContextSummary(toCompact);

    const boundary: CompactBoundary = {
      type: "compact_boundary",
      beforeIndex: 0,
      afterIndex: compactEnd,
      summary,
      timestamp: Date.now(),
    };

    return {
      compactedMessages: [
        {
          role: "assistant",
          content: `[较早上下文已压缩]\n${summary}`,
        },
        ...toKeep,
      ],
      boundary,
      removedCount: toCompact.length,
      summary,
    };
  }

  compactStepHistory(
    steps: readonly AgentStep[],
  ): StepHistoryCompactionResult {
    if (!this.shouldCompactHistory(steps)) {
      return {
        recentSteps: [...steps],
        boundary: null,
        removedCount: 0,
      };
    }

    const compactEnd = Math.max(0, steps.length - this.keepRecentSteps);
    const toCompact = steps.slice(0, compactEnd);
    const recentSteps = steps.slice(compactEnd);
    const summary = this.buildStepSummary(toCompact);

    const boundary: CompactBoundary = {
      type: "compact_boundary",
      beforeIndex: 0,
      afterIndex: compactEnd,
      summary,
      timestamp: Date.now(),
    };

    return {
      recentSteps: [...recentSteps],
      boundary,
      removedCount: toCompact.length,
      summary,
    };
  }

  private generateGenericSummary(messages: any[]): string {
    const userMessages = messages.filter((message) => message?.role === "user").length;
    const assistantMessages = messages.filter((message) => message?.role === "assistant").length;
    return `Compacted ${messages.length} messages (${userMessages} user, ${assistantMessages} assistant)`;
  }

  private buildContextSummary(messages: readonly RuntimeContextMessage[]): string {
    const userHighlights = messages
      .filter((message) => message.role === "user")
      .map((message) => previewText(message.content, 120))
      .filter(Boolean)
      .slice(-3);
    const assistantHighlights = messages
      .filter((message) => message.role === "assistant")
      .map((message) => previewText(message.content, 120))
      .filter(Boolean)
      .slice(-3);

    const lines = [
      `已压缩 ${messages.length} 条较早上下文消息。`,
      userHighlights.length > 0
        ? `用户侧关键信息：${userHighlights.join("；")}`
        : "",
      assistantHighlights.length > 0
        ? `助手侧已知结论：${assistantHighlights.join("；")}`
        : "",
    ].filter(Boolean);

    return lines.join("\n");
  }

  private buildStepSummary(steps: readonly AgentStep[]): string {
    const toolCounts = new Map<string, number>();
    const observations: string[] = [];
    const answers: string[] = [];
    const errors: string[] = [];

    for (const step of steps) {
      if (step.type === "action" && step.toolName) {
        toolCounts.set(step.toolName, (toolCounts.get(step.toolName) ?? 0) + 1);
      }
      if (step.type === "observation") {
        const preview = previewText(step.content, 180);
        if (preview) observations.push(preview);
      }
      if (step.type === "answer") {
        const preview = previewText(step.content, 180);
        if (preview) answers.push(preview);
      }
      if (step.type === "error") {
        const preview = previewText(step.content, 160);
        if (preview) errors.push(preview);
      }
    }

    const toolSummary = [...toolCounts.entries()]
      .slice(0, 6)
      .map(([toolName, count]) => (count > 1 ? `${toolName} ×${count}` : toolName))
      .join("、");

    const lines = [
      `已压缩 ${steps.length} 条较早执行步骤。`,
      toolSummary ? `主要工具轨迹：${toolSummary}` : "",
      observations.length > 0 ? `关键观察：${observations.slice(-2).join("；")}` : "",
      answers.length > 0 ? `阶段性回答：${answers.slice(-1)[0]}` : "",
      errors.length > 0 ? `已见错误：${errors.slice(-1)[0]}` : "",
    ].filter(Boolean);

    return lines.join("\n");
  }
}
