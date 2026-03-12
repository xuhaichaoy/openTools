/**
 * SuggestionsMiddleware — 后续问题建议生成
 *
 * 灵感来源：deer-flow 的 /api/threads/{id}/suggestions
 *
 * 在 Agent 回复后自动生成 3-5 个后续问题建议，
 * 提升用户交互体验。通过工具注入方式提供给 Agent。
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

export class SuggestionsMiddleware implements ActorMiddleware {
  readonly name = "Suggestions";

  async apply(ctx: ActorRunContext): Promise<void> {
    // Add a tool that agents can call to generate follow-up suggestions
    ctx.tools = [
      ...ctx.tools,
      {
        name: "generate_suggestions",
        description: "基于当前对话生成 3-5 个后续问题/操作建议，帮助用户继续探索。在回复较长的分析或完成任务后调用此工具。",
        parameters: {
          context_summary: {
            type: "string",
            description: "当前对话的简要总结",
            required: true,
          },
          suggestions: {
            type: "string",
            description: "JSON 数组字符串，每项包含 { text: string, type: 'question' | 'action' | 'deepdive' }",
            required: true,
          },
        },
        execute: async (params: Record<string, unknown>) => {
          try {
            const suggestions = JSON.parse(String(params.suggestions || "[]"));
            if (!Array.isArray(suggestions) || suggestions.length === 0) {
              return { error: "suggestions 应为非空 JSON 数组" };
            }

            // Format suggestions as a user-friendly block
            const formatted = suggestions
              .slice(0, 5)
              .map((s: { text: string; type?: string }, i: number) => {
                const icon = s.type === "action" ? "🔧" : s.type === "deepdive" ? "🔍" : "💡";
                return `${icon} ${i + 1}. ${s.text}`;
              })
              .join("\n");

            return {
              display: `\n---\n**你可能还想了解：**\n${formatted}`,
              suggestions,
            };
          } catch {
            return { error: "suggestions 解析失败，请确保是有效的 JSON 数组" };
          }
        },
      },
    ];
  }
}
