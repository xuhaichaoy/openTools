/**
 * ClarificationMiddleware — Agent 主动中断执行等待用户澄清
 *
 * 灵感来源：deer-flow 的 ask_clarification + ClarificationMiddleware
 *
 * 为 Agent 注入 `ask_clarification` 工具。当 Agent 对任务理解不确定时，
 * 可调用此工具中断当前执行，向用户提出澄清问题，获得回答后继续。
 *
 * 与普通的 `ask_user` 不同：
 * - ask_user: 在 ReAct 循环中发问，循环继续
 * - ask_clarification: 完全中断当前任务，等用户回答后重新启动
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { createLogger } from "@/core/logger";

const log = createLogger("Clarification");

/** 抛出此错误将中断 ReAct 循环，结果回传给用户 */
export class ClarificationInterrupt extends Error {
  readonly question: string;
  readonly options?: string[];

  constructor(question: string, options?: string[]) {
    super(`[CLARIFICATION_NEEDED] ${question}`);
    this.name = "ClarificationInterrupt";
    this.question = question;
    this.options = options;
  }
}

export class ClarificationMiddleware implements ActorMiddleware {
  readonly name = "Clarification";

  async apply(ctx: ActorRunContext): Promise<void> {
    const askUser = ctx.askUser;
    const actorSystem = ctx.actorSystem;
    const actorId = ctx.actorId;

    ctx.tools = [
      ...ctx.tools,
      {
        name: "ask_clarification",
        description: [
          "当你对用户需求理解不确定，或缺少关键信息无法继续执行时，调用此工具向用户提出澄清问题。",
          "此工具会中断当前执行流程，等待用户回答后你将收到用户的回复。",
          "仅在真正需要澄清时使用，不要用于普通对话。",
        ].join("\n"),
        parameters: [
          {
            name: "question",
            type: "string",
            description: "向用户提出的具体问题",
            required: true,
          },
          {
            name: "options",
            type: "string",
            description: "可选的选项列表，JSON 数组格式，如 [\"选项A\", \"选项B\"]。不提供则为开放式问题。",
            required: false,
          },
          {
            name: "context",
            type: "string",
            description: "为什么需要这个信息的简短说明",
            required: false,
          },
        ],
        execute: async (params: Record<string, unknown>) => {
          const question = String(params.question || "").trim();
          if (!question) {
            return { error: "question 参数不能为空" };
          }

          let options: string[] | undefined;
          if (params.options) {
            try {
              const parsed = JSON.parse(String(params.options));
              if (Array.isArray(parsed)) options = parsed.map(String);
            } catch { /* not valid JSON, ignore */ }
          }

          const contextInfo = params.context ? `\n\n_原因：${params.context}_` : "";

          // 构建用户可读的澄清消息
          let displayMessage = `❓ **需要你的确认**\n\n${question}${contextInfo}`;

          if (options?.length) {
            displayMessage += "\n\n请选择：\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n");
            displayMessage += "\n\n（输入序号或直接回答）";
          }

          log.info(`Clarification requested by ${actorId}: "${question}"`);

          // 通过 askUser 回调等待用户回答
          if (askUser) {
            try {
              const reply = await askUser(displayMessage, 300_000); // 5 min timeout
              log.info(`Clarification answered: "${reply.slice(0, 80)}"`);

              // 如果用户输入了序号，映射到选项
              if (options?.length) {
                const num = parseInt(reply.trim(), 10);
                if (num > 0 && num <= options.length) {
                  return {
                    answer: options[num - 1],
                    raw_input: reply,
                    was_option_selection: true,
                  };
                }
              }

              return { answer: reply, was_option_selection: false };
            } catch {
              return { error: "用户未在规定时间内回答，请根据已有信息继续执行。" };
            }
          }

          // 如果没有 askUser，通过 actorSystem 的聊天机制
          if (actorSystem) {
            try {
              const reply = await actorSystem.askUserInChat(actorId, displayMessage, 300_000);
              if (options?.length) {
                const num = parseInt(reply.trim(), 10);
                if (num > 0 && num <= options.length) {
                  return { answer: options[num - 1], raw_input: reply, was_option_selection: true };
                }
              }
              return { answer: reply, was_option_selection: false };
            } catch {
              return { error: "用户未在规定时间内回答，请根据已有信息继续执行。" };
            }
          }

          return { error: "无法与用户交互，请根据已有信息继续执行。" };
        },
      },
    ];
  }
}
