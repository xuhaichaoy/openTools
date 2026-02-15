/**
 * ReAct Agent 核心引擎
 * 来源: note-gen 的 ReAct 框架实现
 *
 * 执行循环: Thought → Action → Observation → ... → Final Answer
 */

import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import type { PluginAction } from "@/core/plugin-system/plugin-interface";

export interface AgentTool {
  name: string;
  description: string;
  parameters?: Record<string, { type: string; description?: string }>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentStep {
  type: "thought" | "action" | "observation" | "answer" | "error";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  timestamp: number;
}

export interface AgentConfig {
  maxIterations: number;
  temperature: number;
  verbose: boolean;
  /** 危险操作确认回调，返回 true 则继续执行，false 则取消 */
  confirmDangerousAction?: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
  /** 被视为危险操作的工具名称模式（包含即匹配） */
  dangerousToolPatterns?: string[];
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 10,
  temperature: 0.7,
  verbose: true,
};

/**
 * ReAct Agent
 */
export class ReActAgent {
  private ai: MToolsAI;
  private tools: AgentTool[];
  private config: AgentConfig;
  private steps: AgentStep[] = [];
  private onStep?: (step: AgentStep) => void;

  constructor(
    ai: MToolsAI,
    tools: AgentTool[],
    config?: Partial<AgentConfig>,
    onStep?: (step: AgentStep) => void,
  ) {
    this.ai = ai;
    this.tools = tools;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onStep = onStep;
  }

  private addStep(step: AgentStep) {
    this.steps.push(step);
    this.onStep?.(step);
  }

  private buildSystemPrompt(): string {
    const toolDescriptions = this.tools
      .map((t) => {
        const params = t.parameters
          ? Object.entries(t.parameters)
              .map(([k, v]) => `  - ${k}: ${v.type} (${v.description || ""})`)
              .join("\n")
          : "  (无参数)";
        return `- ${t.name}: ${t.description}\n  参数:\n${params}`;
      })
      .join("\n\n");

    return `你是一个智能助手 Agent，使用 ReAct (Reasoning + Acting) 框架来回答问题和执行任务。

可用工具:
${toolDescriptions}

使用以下严格格式响应:

Thought: [分析当前情况，决定下一步]
Action: [工具名称]
Action Input: [JSON 格式的参数]

或者，如果你已经知道最终答案:

Thought: [最终分析]
Final Answer: [最终回答]

规则:
1. 每次只使用一个工具
2. Action Input 必须是有效的 JSON
3. 仔细分析 Observation 结果再决定下一步
4. 如果工具执行失败，分析原因并尝试其他方法
5. 不要在没有使用工具的情况下编造信息
6. 用中文回答`;
  }

  private buildConversation(): { role: string; content: string }[] {
    const messages: { role: string; content: string }[] = [
      { role: "system", content: this.buildSystemPrompt() },
    ];

    // 将历史步骤转为对话
    for (const step of this.steps) {
      if (step.type === "thought" || step.type === "action") {
        messages.push({ role: "assistant", content: step.content });
      } else if (step.type === "observation") {
        messages.push({
          role: "user",
          content: `Observation: ${step.content}`,
        });
      }
    }

    return messages;
  }

  private parseResponse(response: string): {
    thought?: string;
    action?: string;
    actionInput?: Record<string, unknown>;
    finalAnswer?: string;
  } {
    const result: ReturnType<typeof this.parseResponse> = {};

    // 提取 Thought
    const thoughtMatch = response.match(/Thought:\s*(.+?)(?=\n(?:Action|Final Answer))/s);
    if (thoughtMatch) result.thought = thoughtMatch[1].trim();

    // 检查是否有 Final Answer
    const answerMatch = response.match(/Final Answer:\s*(.+)/s);
    if (answerMatch) {
      result.finalAnswer = answerMatch[1].trim();
      return result;
    }

    // 提取 Action
    const actionMatch = response.match(/Action:\s*(.+)/);
    if (actionMatch) result.action = actionMatch[1].trim();

    // 提取 Action Input
    const inputMatch = response.match(/Action Input:\s*(\{[\s\S]*?\})/);
    if (inputMatch) {
      try {
        result.actionInput = JSON.parse(inputMatch[1]);
      } catch {
        result.actionInput = {};
      }
    }

    return result;
  }

  /**
   * 执行 Agent 推理循环
   */
  async run(userInput: string): Promise<string> {
    this.steps = [];

    // 添加用户输入
    this.addStep({
      type: "thought",
      content: `用户问题: ${userInput}`,
      timestamp: Date.now(),
    });

    const messages = this.buildConversation();
    messages.push({ role: "user", content: userInput });

    for (let i = 0; i < this.config.maxIterations; i++) {
      // 调用 LLM
      const response = await this.ai.chat({
        messages,
        temperature: this.config.temperature,
      });

      const parsed = this.parseResponse(response.content);

      // 记录思考
      if (parsed.thought) {
        this.addStep({
          type: "thought",
          content: parsed.thought,
          timestamp: Date.now(),
        });
      }

      // 如果有最终答案，返回
      if (parsed.finalAnswer) {
        this.addStep({
          type: "answer",
          content: parsed.finalAnswer,
          timestamp: Date.now(),
        });
        return parsed.finalAnswer;
      }

      // 执行工具
      if (parsed.action) {
        const tool = this.tools.find((t) => t.name === parsed.action);
        if (!tool) {
          const errorMsg = `未知工具: ${parsed.action}`;
          this.addStep({
            type: "error",
            content: errorMsg,
            timestamp: Date.now(),
          });
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: `Observation: 错误 - ${errorMsg}，可用工具: ${this.tools.map((t) => t.name).join(", ")}`,
          });
          continue;
        }

        this.addStep({
          type: "action",
          content: `调用 ${parsed.action}`,
          toolName: parsed.action,
          toolInput: parsed.actionInput || {},
          timestamp: Date.now(),
        });

        // 危险操作检查 — 需用户确认
        const isDangerous = this.config.dangerousToolPatterns?.some((pattern) =>
          parsed.action!.toLowerCase().includes(pattern.toLowerCase()),
        );
        if (isDangerous && this.config.confirmDangerousAction) {
          const confirmed = await this.config.confirmDangerousAction(
            parsed.action!,
            parsed.actionInput || {},
          );
          if (!confirmed) {
            const cancelMsg = "用户拒绝执行此操作";
            this.addStep({
              type: "observation",
              content: cancelMsg,
              toolName: parsed.action,
              timestamp: Date.now(),
            });
            messages.push({ role: "assistant", content: response.content });
            messages.push({ role: "user", content: `Observation: ${cancelMsg}` });
            continue;
          }
        }

        try {
          const output = await tool.execute(parsed.actionInput || {});
          const outputStr =
            typeof output === "string"
              ? output
              : JSON.stringify(output, null, 2);

          this.addStep({
            type: "observation",
            content: outputStr,
            toolName: parsed.action,
            toolOutput: output,
            timestamp: Date.now(),
          });

          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: `Observation: ${outputStr}`,
          });
        } catch (e) {
          const errorStr = `工具执行失败: ${e}`;
          this.addStep({
            type: "error",
            content: errorStr,
            toolName: parsed.action,
            timestamp: Date.now(),
          });
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: `Observation: ${errorStr}`,
          });
        }
      } else {
        // 没有 action 也没有 final answer，可能格式不对
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content:
            "请按照规定格式回复：使用 Thought/Action/Action Input 或 Thought/Final Answer",
        });
      }
    }

    // 超过最大迭代
    const fallback = "抱歉，我尝试了多次但无法完成任务。请尝试简化你的问题。";
    this.addStep({
      type: "answer",
      content: fallback,
      timestamp: Date.now(),
    });
    return fallback;
  }

  getSteps(): AgentStep[] {
    return [...this.steps];
  }
}

/**
 * 将 PluginAction 转换为 AgentTool
 */
export function pluginActionToTool(
  pluginId: string,
  pluginName: string,
  action: PluginAction,
  ai: MToolsAI,
): AgentTool {
  return {
    name: `${pluginId}_${action.name}`,
    description: `[${pluginName}] ${action.description}`,
    parameters: action.parameters
      ? Object.fromEntries(
          Object.entries(action.parameters).map(([k, v]) => [
            k,
            { type: v.type, description: v.description },
          ]),
        )
      : undefined,
    execute: (params) => action.execute(params, { ai }),
  };
}
