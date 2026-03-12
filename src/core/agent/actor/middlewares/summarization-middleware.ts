/**
 * SummarizationMiddleware — 自动上下文摘要中间件
 *
 * 灵感来源：deer-flow 的 SummarizationMiddleware
 *
 * 当 context messages 接近 token 上限时，自动对历史消息进行摘要压缩。
 * 支持配置触发阈值、保留最近消息数、摘要 prompt。
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { estimateTokens, estimateMessagesTokens } from "@/core/ai/token-utils";
import { createLogger } from "@/core/logger";

const log = createLogger("Summarization");

export interface SummarizationConfig {
  /** 触发摘要的 token 占比阈值（占 contextTokens 的比例，0-1） */
  triggerRatio?: number;
  /** 摘要后保留的最近消息数 */
  keepRecentMessages?: number;
  /** 最大摘要文本 token 数 */
  maxSummaryTokens?: number;
}

const DEFAULT_CONFIG: Required<SummarizationConfig> = {
  triggerRatio: 0.65,
  keepRecentMessages: 6,
  maxSummaryTokens: 800,
};

function summarizeMessages(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  maxTokens: number,
): string {
  if (messages.length === 0) return "";

  const parts: string[] = [];
  let budget = maxTokens;

  // Extract key exchanges
  const exchanges: string[] = [];
  for (let i = 0; i < messages.length; i += 2) {
    const user = messages[i];
    const assistant = messages[i + 1];
    if (!user) break;

    const userSnippet = user.content.slice(0, 150).trim();
    const assistantSnippet = assistant?.content.slice(0, 200).trim() ?? "";

    if (userSnippet) {
      exchanges.push(`Q: ${userSnippet}${user.content.length > 150 ? "…" : ""}`);
    }
    if (assistantSnippet) {
      exchanges.push(`A: ${assistantSnippet}${(assistant?.content.length ?? 0) > 200 ? "…" : ""}`);
    }
  }

  parts.push("[对话历史摘要]");
  parts.push(`共 ${messages.length} 条消息被压缩。`);

  // Add as many exchanges as budget allows
  for (const exchange of exchanges) {
    const cost = estimateTokens(exchange);
    if (cost > budget) break;
    parts.push(exchange);
    budget -= cost;
  }

  return parts.join("\n");
}

export class SummarizationMiddleware implements ActorMiddleware {
  readonly name = "Summarization";
  private config: Required<SummarizationConfig>;

  constructor(config?: SummarizationConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async apply(ctx: ActorRunContext): Promise<void> {
    if (ctx.contextMessages.length <= this.config.keepRecentMessages) return;

    const contextBudget = ctx.contextTokens ?? 100_000;
    const threshold = contextBudget * this.config.triggerRatio;
    const currentTokens = estimateMessagesTokens(
      ctx.contextMessages.map((m) => ({ role: m.role, content: m.content })),
    );

    if (currentTokens <= threshold) return;

    log.info(`Context tokens (${currentTokens}) exceed threshold (${threshold}), summarizing...`);

    // Split: keep recent, summarize older
    const keepCount = this.config.keepRecentMessages;
    const recentMessages = ctx.contextMessages.slice(-keepCount);
    const olderMessages = ctx.contextMessages.slice(0, -keepCount);

    if (olderMessages.length === 0) return;

    const summary = summarizeMessages(olderMessages, this.config.maxSummaryTokens);
    if (!summary) return;

    // Replace context with summary + recent messages
    ctx.contextMessages = [
      { role: "user" as const, content: summary },
      { role: "assistant" as const, content: "好的，我了解了之前的对话内容，继续当前任务。" },
      ...recentMessages,
    ];

    const newTokens = estimateMessagesTokens(
      ctx.contextMessages.map((m) => ({ role: m.role, content: m.content })),
    );
    log.info(`Summarization complete: ${olderMessages.length} messages → summary. Tokens: ${currentTokens} → ${newTokens}`);
  }
}
