/**
 * ReAct Agent 核心引擎
 * 来源: note-gen 的 ReAct 框架实现
 *
 * 执行循环: Thought → Action → Observation → ... → Final Answer
 *
 * 双模式支持:
 * - 结构化 Tool Calling（优先）：通过 streamWithTools 使用 OpenAI Function Calling
 * - 文本 ReAct（降级）：当模型不支持 Function Calling 时，回退到文本格式解析
 */

import { handleError, ErrorLevel } from "@/core/errors";
import type {
  MToolsAI,
  AIToolDefinition,
  AIToolCall,
} from "@/core/plugin-system/plugin-interface";
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
  /** 标记为流式中间状态 — UI 应替换同类型的上一个 streaming 步骤而非新增 */
  streaming?: boolean;
}

export interface AgentConfig {
  maxIterations: number;
  temperature: number;
  verbose: boolean;
  /** 危险操作确认回调，返回 true 则继续执行，false 则取消 */
  confirmDangerousAction?: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<boolean>;
  /** 被视为危险操作的工具名称模式（包含即匹配） */
  dangerousToolPatterns?: string[];
  /** 强制使用文本 ReAct 模式（跳过 Function Calling） */
  forceTextMode?: boolean;
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 10,
  temperature: 0.7,
  verbose: true,
};

// ── 工具格式转换 ──

/** 将 AgentTool 转为 OpenAI Function Calling 格式 */
function toolToFunctionDef(tool: AgentTool): AIToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  if (tool.parameters) {
    for (const [key, param] of Object.entries(tool.parameters)) {
      properties[key] = {
        type: param.type,
        ...(param.description ? { description: param.description } : {}),
      };
      required.push(key);
    }
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
  };
}

/**
 * ReAct Agent
 * 支持双模式：结构化 Function Calling（优先）+ 文本 ReAct（降级）
 */
export class ReActAgent {
  private ai: MToolsAI;
  private tools: AgentTool[];
  private config: AgentConfig;
  private steps: AgentStep[] = [];
  private history: AgentStep[] = [];
  private onStep?: (step: AgentStep) => void;
  /** Function Calling 是否可用（首次尝试后缓存结果） */
  private fcAvailable: boolean | null = null;

  constructor(
    ai: MToolsAI,
    tools: AgentTool[],
    config?: Partial<AgentConfig>,
    onStep?: (step: AgentStep) => void,
    history: AgentStep[] = [],
  ) {
    this.ai = ai;
    this.tools = tools;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onStep = onStep;
    this.history = history;
  }

  private addStep(step: AgentStep) {
    this.steps.push(step);
    this.onStep?.(step);
  }

  // ── 文本 ReAct 模式（降级方案） ──

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

  private buildTextConversation(): {
    role: "system" | "user" | "assistant";
    content: string;
  }[] {
    const messages: {
      role: "system" | "user" | "assistant";
      content: string;
    }[] = [{ role: "system", content: this.buildSystemPrompt() }];

    // 添加历史记录
    for (const step of this.history) {
      if (step.type === "thought" || step.type === "action") {
        messages.push({ role: "assistant", content: step.content });
      } else if (step.type === "observation") {
        messages.push({
          role: "user",
          content: `Observation: ${step.content}`,
        });
      } else if (step.type === "answer") {
        messages.push({
          role: "assistant",
          content: `Final Answer: ${step.content}`,
        });
      }
    }

    // 将当前步骤转为对话
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
    const thoughtMatch = response.match(
      /Thought:\s*(.+?)(?=\n(?:Action|Final Answer))/s,
    );
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
   * 通过流式 API 获取 LLM 响应（文本模式），实时推送思考过程给用户。
   */
  private async streamTextLLM(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    signal?: AbortSignal,
  ): Promise<string> {
    let accumulated = "";
    let lastPushedLen = 0;

    const pushThinking = () => {
      const current = accumulated.trim();
      if (!current || current.length <= lastPushedLen + 10) return;

      const thoughtMatch = current.match(
        /Thought:\s*(.+?)(?=\n(?:Action|Final Answer)|$)/s,
      );
      const content = thoughtMatch ? thoughtMatch[1].trim() : current;

      if (content) {
        this.onStep?.({
          type: "thought",
          content,
          timestamp: Date.now(),
          streaming: true,
        });
        lastPushedLen = current.length;
      }
    };

    await this.ai.stream({
      messages,
      onChunk: (chunk) => {
        if (signal?.aborted) return;
        accumulated += chunk;
        pushThinking();
      },
      onDone: (full) => {
        accumulated = full;
      },
    });

    if (signal?.aborted) throw new Error("Aborted");
    return accumulated;
  }

  // ── Function Calling 模式（优先方案） ──

  /** 构建 FC 模式的 system prompt（更简洁，不需要格式指令） */
  private buildFCSystemPrompt(): string {
    return `你是一个智能助手 Agent，能够使用工具来回答问题和执行任务。

规则:
1. 分析用户问题，决定是否需要调用工具
2. 如果需要工具，直接调用（一次只调用一个工具）
3. 仔细分析工具返回的结果，决定下一步
4. 如果工具执行失败，分析原因并尝试其他方法
5. 不要在没有使用工具的情况下编造信息
6. 用中文回答`;
  }

  /**
   * 通过 streamWithTools 获取 LLM 响应（FC 模式）
   * 返回值区分：纯文本内容 或 工具调用请求
   */
  private async streamFCLLM(
    messages: {
      role: string;
      content: string | null;
      tool_calls?: AIToolCall[];
      tool_call_id?: string;
      name?: string;
    }[],
    signal?: AbortSignal,
  ): Promise<
    | { type: "content"; content: string }
    | { type: "tool_calls"; toolCalls: AIToolCall[] }
  > {
    const toolDefs = this.tools.map(toolToFunctionDef);
    let lastPushedLen = 0;
    let accumulated = "";

    const result = await this.ai.streamWithTools!({
      messages,
      tools: toolDefs,
      onChunk: (chunk) => {
        if (signal?.aborted) return;
        accumulated += chunk;
        // 实时推送思考内容
        const current = accumulated.trim();
        if (current && current.length > lastPushedLen + 10) {
          this.onStep?.({
            type: "thought",
            content: current,
            timestamp: Date.now(),
            streaming: true,
          });
          lastPushedLen = current.length;
        }
      },
      onDone: (full) => {
        accumulated = full;
      },
    });

    if (signal?.aborted) throw new Error("Aborted");
    return result;
  }

  /**
   * Function Calling 模式的执行循环
   */
  private async runFC(userInput: string, signal?: AbortSignal): Promise<string> {
    type FCMessage = {
      role: string;
      content: string | null;
      tool_calls?: AIToolCall[];
      tool_call_id?: string;
      name?: string;
    };

    const messages: FCMessage[] = [
      { role: "system", content: this.buildFCSystemPrompt() },
    ];

    // 添加历史记录转换为 FC 格式
    // （历史记录中的工具调用已经是文本形式，直接作为 assistant/user 消息添加）
    for (const step of this.history) {
      if (step.type === "answer") {
        messages.push({ role: "assistant", content: step.content });
      } else if (step.type === "observation") {
        messages.push({ role: "user", content: `上次执行结果: ${step.content}` });
      }
    }

    messages.push({ role: "user", content: userInput });

    let unknownToolCount = 0;

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (signal?.aborted) throw new Error("Aborted");

      const result = await this.streamFCLLM(messages, signal);

      if (signal?.aborted) throw new Error("Aborted");

      if (result.type === "content") {
        // 纯文本回复 — 作为最终答案
        const answer = result.content.trim();
        if (answer) {
          this.addStep({
            type: "answer",
            content: answer,
            timestamp: Date.now(),
          });
          return answer;
        }
        // 空回复，提示继续
        messages.push({ role: "assistant", content: "" });
        messages.push({ role: "user", content: "请继续回答或使用工具。" });
        continue;
      }

      // tool_calls — 先校验有效性
      const validToolCalls = result.toolCalls.filter(
        (tc) => tc.function.name && tc.function.name.trim(),
      );

      // 所有 tool_calls 的名称都为空 → 模型不兼容 FC，立即降级
      if (validToolCalls.length === 0) {
        throw new Error(
          "FC_INCOMPATIBLE: model returned tool_calls with empty function names",
        );
      }

      for (const tc of validToolCalls) {
        const toolName = tc.function.name;
        let toolParams: Record<string, unknown> = {};
        try {
          toolParams = JSON.parse(tc.function.arguments || "{}");
        } catch {
          toolParams = {};
        }

        const tool = this.tools.find((t) => t.name === toolName);
        if (!tool) {
          // 未知工具 — 记录错误并继续
          this.addStep({
            type: "error",
            content: `未知工具: ${toolName}`,
            timestamp: Date.now(),
          });
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [tc],
          });
          messages.push({
            role: "tool",
            content: `错误: 未知工具 ${toolName}，可用工具: ${this.tools.map((t) => t.name).join(", ")}`,
            tool_call_id: tc.id,
            name: toolName,
          });
          // 连续多次未知工具也应降级
          unknownToolCount++;
          if (unknownToolCount >= 3) {
            throw new Error(
              "FC_INCOMPATIBLE: too many unknown tool calls, model may not be compatible with FC",
            );
          }
          continue;
        }
        unknownToolCount = 0; // 找到有效工具，重置计数

        this.addStep({
          type: "action",
          content: `调用 ${toolName}`,
          toolName,
          toolInput: toolParams,
          timestamp: Date.now(),
        });

        // 危险操作检查
        const isDangerous = this.config.dangerousToolPatterns?.some((pattern) =>
          toolName.toLowerCase().includes(pattern.toLowerCase()),
        );
        if (isDangerous && this.config.confirmDangerousAction) {
          const confirmed = await this.config.confirmDangerousAction(
            toolName,
            toolParams,
          );
          if (!confirmed) {
            this.addStep({
              type: "observation",
              content: "用户拒绝执行此操作",
              toolName,
              timestamp: Date.now(),
            });
            messages.push({
              role: "assistant",
              content: null,
              tool_calls: [tc],
            });
            messages.push({
              role: "tool",
              content: "用户拒绝执行此操作",
              tool_call_id: tc.id,
              name: toolName,
            });
            continue;
          }
        }

        // 执行工具
        try {
          if (signal?.aborted) throw new Error("Aborted");
          const output = await tool.execute(toolParams);

          if (signal?.aborted) throw new Error("Aborted");

          const outputStr =
            typeof output === "string"
              ? output
              : JSON.stringify(output, null, 2);

          this.addStep({
            type: "observation",
            content: outputStr,
            toolName,
            toolOutput: output,
            timestamp: Date.now(),
          });

          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [tc],
          });
          messages.push({
            role: "tool",
            content: outputStr,
            tool_call_id: tc.id,
            name: toolName,
          });
        } catch (e) {
          if ((e as Error).message === "Aborted") throw e;
          const errorStr = `工具执行失败: ${e}`;
          this.addStep({
            type: "error",
            content: errorStr,
            toolName,
            timestamp: Date.now(),
          });
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [tc],
          });
          messages.push({
            role: "tool",
            content: errorStr,
            tool_call_id: tc.id,
            name: toolName,
          });
        }
      }
    }

    const fallback = "抱歉，我尝试了多次但无法完成任务。请尝试简化你的问题。";
    this.addStep({
      type: "answer",
      content: fallback,
      timestamp: Date.now(),
    });
    return fallback;
  }

  // ── 文本 ReAct 模式的执行循环 ──

  private async runText(userInput: string, signal?: AbortSignal): Promise<string> {
    const messages = this.buildTextConversation();
    messages.push({ role: "user", content: userInput });

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (signal?.aborted) throw new Error("Aborted");

      let responseContent: string;
      try {
        responseContent = await this.streamTextLLM(messages, signal);
      } catch (e) {
        if ((e as Error).message === "Aborted") throw e;
        const response = await this.ai.chat({
          messages,
          temperature: this.config.temperature,
        });
        responseContent = response.content;
      }

      if (signal?.aborted) throw new Error("Aborted");

      const parsed = this.parseResponse(responseContent);

      if (parsed.thought) {
        this.addStep({
          type: "thought",
          content: parsed.thought,
          timestamp: Date.now(),
        });
      }

      if (parsed.finalAnswer) {
        this.addStep({
          type: "answer",
          content: parsed.finalAnswer,
          timestamp: Date.now(),
        });
        return parsed.finalAnswer;
      }

      if (parsed.action) {
        const tool = this.tools.find((t) => t.name === parsed.action);
        if (!tool) {
          const errorMsg = `未知工具: ${parsed.action}`;
          this.addStep({
            type: "error",
            content: errorMsg,
            timestamp: Date.now(),
          });
          messages.push({ role: "assistant", content: responseContent });
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

        // 危险操作检查
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
            messages.push({ role: "assistant", content: responseContent });
            messages.push({
              role: "user",
              content: `Observation: ${cancelMsg}`,
            });
            continue;
          }
        }

        try {
          if (signal?.aborted) throw new Error("Aborted");
          const output = await tool.execute(parsed.actionInput || {});

          if (signal?.aborted) throw new Error("Aborted");

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

          messages.push({ role: "assistant", content: responseContent });
          messages.push({
            role: "user",
            content: `Observation: ${outputStr}`,
          });
        } catch (e) {
          if ((e as Error).message === "Aborted") throw e;
          const errorStr = `工具执行失败: ${e}`;
          this.addStep({
            type: "error",
            content: errorStr,
            toolName: parsed.action,
            timestamp: Date.now(),
          });
          messages.push({ role: "assistant", content: responseContent });
          messages.push({
            role: "user",
            content: `Observation: ${errorStr}`,
          });
        }
      } else {
        messages.push({ role: "assistant", content: responseContent });
        messages.push({
          role: "user",
          content:
            "请按照规定格式回复：使用 Thought/Action/Action Input 或 Thought/Final Answer",
        });
      }
    }

    const fallback = "抱歉，我尝试了多次但无法完成任务。请尝试简化你的问题。";
    this.addStep({
      type: "answer",
      content: fallback,
      timestamp: Date.now(),
    });
    return fallback;
  }

  // ── 公共入口 ──

  /**
   * 执行 Agent 推理循环
   * 优先使用结构化 Function Calling（消除格式解析失败），
   * 如果 streamWithTools 不可用或首次调用失败则降级为文本 ReAct。
   */
  async run(userInput: string, signal?: AbortSignal): Promise<string> {
    this.steps = [];

    this.addStep({
      type: "thought",
      content: `用户问题: ${userInput}`,
      timestamp: Date.now(),
    });

    // 判断是否可以使用 Function Calling
    const canUseFC =
      !this.config.forceTextMode &&
      typeof this.ai.streamWithTools === "function";

    if (canUseFC && this.fcAvailable !== false) {
      try {
        const result = await this.runFC(userInput, signal);
        this.fcAvailable = true; // 标记 FC 可用
        return result;
      } catch (e) {
        if ((e as Error).message === "Aborted") throw e;

        const errMsg = (e as Error).message || "";
        const isFCIncompatible = errMsg.startsWith("FC_INCOMPATIBLE");

        // FC 调用失败 或 模型不兼容 FC → 降级到文本 ReAct 模式
        if (this.fcAvailable === null || isFCIncompatible) {
          handleError(e, {
            context: "ReAct Agent Function Calling 降级为文本模式",
            level: ErrorLevel.Warning,
          });
          this.fcAvailable = false;
          this.steps = [];
          this.addStep({
            type: "thought",
            content: `用户问题: ${userInput}`,
            timestamp: Date.now(),
          });
          return this.runText(userInput, signal);
        }
        throw e;
      }
    }

    // 文本 ReAct 模式
    return this.runText(userInput, signal);
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
