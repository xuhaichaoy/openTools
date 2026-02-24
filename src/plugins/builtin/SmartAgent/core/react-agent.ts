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

// ── 结构化工具错误类型（借鉴 Kimi CLI 四层体系） ──

export enum ToolErrorType {
  NotFound = "not_found",
  ParseError = "parse_error",
  ValidationError = "validation_error",
  RuntimeError = "runtime_error",
  Timeout = "timeout",
  LoopDetected = "loop_detected",
  PlanModeBlocked = "plan_mode_blocked",
}

export interface ToolErrorResult {
  type: ToolErrorType;
  tool: string;
  message: string;
  recoverable: boolean;
}

export type AgentMode = "execute" | "plan";

export interface AgentTool {
  name: string;
  description: string;
  parameters?: Record<
    string,
    { type: string; description?: string; required?: boolean }
  >;
  /** 标记为高风险工具，执行前会触发确认弹窗 */
  dangerous?: boolean;
  /** 标记为只读工具（不产生副作用），可安全并行执行 */
  readonly?: boolean;
  /** 单工具执行超时（毫秒），不设则无超时 */
  timeout?: number;
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
  /** 用于区分不同流式来源（如主 Agent vs 子任务），防止相互覆盖 */
  streamId?: string;
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
  /** Function Calling 兼容性缓存 key（建议按模型/提供商组合） */
  fcCompatibilityKey?: string;
  /** 用户记忆片段，注入到 system prompt 中 */
  userMemoryPrompt?: string;
  /** 上下文窗口 token 上限（默认 100000） */
  contextLimit?: number;
  /** 初始 Agent 模式（默认 execute） */
  initialMode?: AgentMode;
  /** 工具级全局默认超时（毫秒） */
  defaultToolTimeout?: number;
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 10,
  temperature: 0.7,
  verbose: true,
};

/** 仅缓存“不兼容 FC”的模型，避免重复探测。 */
const FC_CACHE_TTL_MS = 30 * 60 * 1000;
const FC_CACHE_MAX_SIZE = 50;
const fcIncompatibleCache = new Map<string, number>();

function pruneFCCache() {
  if (fcIncompatibleCache.size <= FC_CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [k, ts] of fcIncompatibleCache) {
    if (now - ts > FC_CACHE_TTL_MS) fcIncompatibleCache.delete(k);
  }
  if (fcIncompatibleCache.size > FC_CACHE_MAX_SIZE) {
    const oldest = [...fcIncompatibleCache.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, fcIncompatibleCache.size - FC_CACHE_MAX_SIZE);
    for (const [k] of oldest) fcIncompatibleCache.delete(k);
  }
}

function isFCCacheValid(key: string): boolean {
  const ts = fcIncompatibleCache.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > FC_CACHE_TTL_MS) {
    fcIncompatibleCache.delete(key);
    return false;
  }
  return true;
}

function normalizeFCCompatibilityKey(key?: string): string | null {
  const normalized = (key || "").trim().toLowerCase();
  return normalized || null;
}

// ── Context 管理 ──

const DEFAULT_CONTEXT_LIMIT = 100_000;
const CONTEXT_COMPACT_THRESHOLD = 0.75;

function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + nonCjkLength / 3.5);
}

function estimateMessagesTokens(
  messages: { role: string; content: string | null; [k: string]: unknown }[],
): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // role + structural overhead
    total += estimateTokens(m.content || "");
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
    if (m.name) total += estimateTokens(String(m.name));
  }
  return total;
}

function compactMessages<
  T extends { role: string; content: string | null; [k: string]: unknown },
>(messages: T[], contextLimit: number): T[] {
  const threshold = contextLimit * CONTEXT_COMPACT_THRESHOLD;
  const currentTokens = estimateMessagesTokens(messages);
  if (currentTokens <= threshold) return messages;

  const result: T[] = [];
  const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
  if (systemMsg) result.push(systemMsg);

  const tailSize = Math.min(8, messages.length - (systemMsg ? 1 : 0));
  const tailStart = Math.max(systemMsg ? 1 : 0, messages.length - tailSize);
  const tail = messages.slice(tailStart);

  const middle = messages.slice(systemMsg ? 1 : 0, tailStart);

  if (middle.length > 0) {
    const toolCallGroups: T[][] = [];
    let i = 0;
    while (i < middle.length) {
      const m = middle[i];
      if (m.role === "assistant" && m.tool_calls) {
        const group: T[] = [m];
        let j = i + 1;
        while (j < middle.length && middle[j].role === "tool") {
          group.push(middle[j]);
          j++;
        }
        toolCallGroups.push(group);
        i = j;
      } else {
        i++;
      }
    }

    const recentGroups = toolCallGroups.slice(-2);
    const compactedGroups = recentGroups.map((group) =>
      group.map((m) => {
        if (m.role === "tool") {
          const content = m.content || "";
          if (content.length > 500) {
            return { ...m, content: content.slice(0, 200) + "\n... [已压缩] ...\n" + content.slice(-150) };
          }
        }
        return m;
      }),
    );

    const assistantMsgs = middle.filter(
      (m) => m.role === "assistant" && !m.tool_calls,
    );
    const lastAssistant = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : null;

    if (lastAssistant) result.push(lastAssistant);
    for (const group of compactedGroups) result.push(...group);
  }

  result.push(...tail);

  const finalTokens = estimateMessagesTokens(result);
  if (finalTokens > threshold && result.length > 4) {
    return [result[0], ...result.slice(-3)];
  }

  return result;
}

// ── 工具输出截断 ──

const TOOL_OUTPUT_MAX_CHARS = 8000;
const TOOL_OUTPUT_KEEP_HEAD = 3500;
const TOOL_OUTPUT_KEEP_TAIL = 1500;

function truncateToolOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_MAX_CHARS) return output;
  const head = output.slice(0, TOOL_OUTPUT_KEEP_HEAD);
  const tail = output.slice(-TOOL_OUTPUT_KEEP_TAIL);
  const omitted = output.length - TOOL_OUTPUT_KEEP_HEAD - TOOL_OUTPUT_KEEP_TAIL;
  return `${head}\n\n... [已省略 ${omitted} 字符] ...\n\n${tail}`;
}

// ── 工具超时异常 ──

class ToolTimeoutError extends Error {
  constructor(public toolName: string, public timeoutMs: number) {
    super(`工具 ${toolName} 执行超时（${timeoutMs}ms）`);
    this.name = "ToolTimeoutError";
  }
}

// ── Trajectory 条目（借鉴 trae-agent TrajectoryRecorder） ──

export interface TrajectoryEntry {
  step: number;
  timestamp: number;
  type: "llm_call" | "tool_call" | "tool_result" | "mode_switch" | "error" | "reflection" | "answer";
  mode?: AgentMode;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  result?: unknown;
  error?: ToolErrorResult;
  durationMs?: number;
  tokenEstimate?: number;
}

// ── 循环 / Doom Loop 检测器（借鉴 Gemini CLI loopDetector + OpenCode doom loop） ──

const LOOP_DETECTOR_WINDOW = 6;
const LOOP_DETECTOR_THRESHOLD = 3;
const DOOM_LOOP_CONSECUTIVE_FAILURES = 3;

class LoopDetector {
  private recentCalls: string[] = [];
  private consecutiveFailures: Map<string, number> = new Map();
  private disabledTools: Set<string> = new Set();

  record(toolName: string, args: Record<string, unknown>): void {
    const key = `${toolName}::${JSON.stringify(args)}`;
    this.recentCalls.push(key);
    if (this.recentCalls.length > LOOP_DETECTOR_WINDOW * 2) {
      this.recentCalls = this.recentCalls.slice(-LOOP_DETECTOR_WINDOW * 2);
    }
  }

  detect(): { looping: boolean; tool?: string } {
    if (this.recentCalls.length < LOOP_DETECTOR_THRESHOLD) {
      return { looping: false };
    }
    const tail = this.recentCalls.slice(-LOOP_DETECTOR_WINDOW);
    const counts = new Map<string, number>();
    for (const key of tail) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count >= LOOP_DETECTOR_THRESHOLD) {
        return { looping: true, tool: key.split("::")[0] };
      }
    }
    return { looping: false };
  }

  recordFailure(toolName: string): void {
    const count = (this.consecutiveFailures.get(toolName) ?? 0) + 1;
    this.consecutiveFailures.set(toolName, count);
    if (count >= DOOM_LOOP_CONSECUTIVE_FAILURES) {
      this.disabledTools.add(toolName);
    }
  }

  recordSuccess(toolName: string): void {
    this.consecutiveFailures.delete(toolName);
  }

  isDisabled(toolName: string): boolean {
    return this.disabledTools.has(toolName);
  }

  getDisabledTools(): string[] {
    return [...this.disabledTools];
  }

  reset(): void {
    this.recentCalls = [];
    this.consecutiveFailures.clear();
    this.disabledTools.clear();
  }
}

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
      if (param.required !== false) {
        required.push(key);
      }
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
  /** Function Calling 是否可用（当前实例内缓存） */
  private fcAvailable: boolean | null = null;
  /** 跨实例模型兼容性缓存 key */
  private fcCompatibilityKey: string | null = null;
  private running = false;
  private currentSignal?: AbortSignal;
  private loopDetector = new LoopDetector();
  private mode: AgentMode = "execute";
  private trajectory: TrajectoryEntry[] = [];

  private isQuickTimeQuery(userInput: string): boolean {
    const q = userInput.trim();
    if (!q) return false;
    return /现在.*几点|当前.*时间|现在几号|今天几号|当前日期|what time|current time/i.test(
      q,
    );
  }

  private buildQuickAnswerFromTool(
    userInput: string,
    toolName: string,
    toolOutput: unknown,
  ): string | null {
    if (toolName === "get_current_time" && this.isQuickTimeQuery(userInput)) {
      if (toolOutput && typeof toolOutput === "object") {
        const output = toolOutput as { time?: unknown; timestamp?: unknown };
        if (typeof output.time === "string" && output.time.trim()) {
          return `现在时间是 ${output.time}。`;
        }
        if (typeof output.timestamp === "number") {
          return `现在时间是 ${new Date(output.timestamp).toLocaleString("zh-CN")}。`;
        }
      }
      return `现在时间是 ${new Date().toLocaleString("zh-CN")}。`;
    }

    if (toolName === "calculate" && toolOutput && typeof toolOutput === "object") {
      const output = toolOutput as { result?: unknown; expression?: unknown };
      if (typeof output.result === "number") {
        if (typeof output.expression === "string" && output.expression.trim()) {
          return `${output.expression} = ${output.result}`;
        }
        return `计算结果：${output.result}`;
      }
    }

    return null;
  }

  private isLikelyUserRefusalClaim(content: string): boolean {
    const text = content.trim();
    if (!text) return false;
    const refusalPatterns = [
      "用户拒绝",
      "你拒绝",
      "您拒绝",
      "已拒绝",
      "拒绝执行",
      "未获授权",
      "没有授权",
    ];
    return refusalPatterns.some((pattern) => text.includes(pattern));
  }

  private hasWriteFileAction(): boolean {
    const allSteps = [...this.history, ...this.steps];
    return allSteps.some(
      (step) => step.type === "action" && step.toolName?.toLowerCase().includes("write_file"),
    );
  }

  private hasSaveLikeIntent(userInput: string): boolean {
    const text = userInput.toLowerCase();
    const writeVerbs = ["写入", "保存", "另存", "覆盖", "修改文件", "更新文件", "写到", "write_file", "save"];
    if (writeVerbs.some((k) => text.includes(k))) return true;
    const targets = [".md", ".txt", ".json", ".csv", ".yaml", ".yml"];
    const writeContextWords = ["改成", "改为", "替换", "更新", "创建", "生成", "导出"];
    if (targets.some((t) => text.includes(t)) && writeContextWords.some((w) => text.includes(w))) {
      return true;
    }
    return false;
  }

  private isLikelySaveOutcomeClaim(content: string): boolean {
    const text = content.trim();
    if (!text) return false;
    const patterns = [
      "已保存",
      "保存成功",
      "写入成功",
      "写入失败",
      "系统拒绝",
      "无法写入",
      "操作已取消",
      "内容保持不变",
      "仍为",
      "文件已生成",
    ];
    return patterns.some((pattern) => text.includes(pattern));
  }

  /**
   * 检查模型回答是否触发 guard rail 拦截。
   * 返回需要追加的纠正提示，null 表示通过。
   */
  private checkAnswerGuardRails(
    answer: string,
    userInput: string,
    rejectedDangerousActionCount: number,
  ): string | null {
    if (
      this.hasSaveLikeIntent(userInput) &&
      !this.hasWriteFileAction() &&
      this.isLikelySaveOutcomeClaim(answer)
    ) {
      return "你尚未实际调用 write_file 工具。若任务包含保存/修改文件，必须先调用 write_file 并基于真实工具结果再给结论。";
    }
    if (
      rejectedDangerousActionCount === 0 &&
      this.isLikelyUserRefusalClaim(answer)
    ) {
      return "不要假设用户已经拒绝授权。仅可基于真实工具调用结果给出结论；若未触发确认，请继续执行并给出结果。";
    }
    return null;
  }

  private depth: number;

  constructor(
    ai: MToolsAI,
    tools: AgentTool[],
    config?: Partial<AgentConfig>,
    onStep?: (step: AgentStep) => void,
    history: AgentStep[] = [],
    depth = 0,
  ) {
    this.ai = ai;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onStep = onStep;
    this.history = history;
    this.depth = depth;
    this.fcCompatibilityKey = normalizeFCCompatibilityKey(
      this.config.fcCompatibilityKey,
    );
    if (
      this.fcCompatibilityKey &&
      isFCCacheValid(this.fcCompatibilityKey)
    ) {
      this.fcAvailable = false;
    }
    this.mode = this.config.initialMode ?? "execute";

    const MAX_DEPTH = 2;
    const baseTools = [...tools];
    if (depth < MAX_DEPTH) {
      baseTools.push(this.createDelegateSubtaskTool(ai, tools, depth));
    }
    baseTools.push(...this.createModeSwitchTools());
    this.tools = baseTools;
  }

  private createDelegateSubtaskTool(
    ai: MToolsAI,
    parentTools: AgentTool[],
    currentDepth: number,
  ): AgentTool {
    return {
      name: "delegate_subtask",
      description:
        "将一个独立的子问题委派给子 Agent 处理。子 Agent 拥有与你相同的工具，会独立完成任务并返回结果。适用于：可并行的信息收集、独立的子问题求解、需要深入探索的分支任务。",
      parameters: {
        task: {
          type: "string",
          description: "子任务的详细描述，需要足够清晰以便子 Agent 独立完成",
        },
        context: {
          type: "string",
          description: "提供给子 Agent 的上下文信息（已知事实、约束条件等）",
          required: false,
        },
      },
      execute: async (params) => {
        const task = String(params.task || "").trim();
        if (!task) return { error: "子任务描述不能为空" };

        const context = params.context ? String(params.context) : "";
        const subQuery = context ? `${task}\n\n背景信息：${context}` : task;

        const subSteps: AgentStep[] = [];
        const subStreamId = `subtask-${currentDepth + 1}-${Date.now()}`;
        const subAgent = new ReActAgent(
          ai,
          parentTools,
          {
            maxIterations: 10,
            temperature: this.config.temperature,
            verbose: this.config.verbose,
            fcCompatibilityKey: this.config.fcCompatibilityKey,
            dangerousToolPatterns: this.config.dangerousToolPatterns,
            confirmDangerousAction: this.config.confirmDangerousAction,
            userMemoryPrompt: this.config.userMemoryPrompt,
            contextLimit: this.config.contextLimit,
            initialMode: this.config.initialMode,
            defaultToolTimeout: this.config.defaultToolTimeout,
          },
          (step) => {
            subSteps.push(step);
            this.onStep?.({
              ...step,
              content: `[子任务] ${step.content}`,
              streamId: subStreamId,
            });
          },
          [],
          currentDepth + 1,
        );

        try {
          const result = await subAgent.run(subQuery, this.currentSignal);
          return {
            status: "completed",
            result,
            steps_count: subSteps.length,
          };
        } catch (e) {
          if ((e as Error).message === "Aborted") throw e;
          return {
            status: "error",
            error: `子任务执行失败: ${e}`,
            steps_count: subSteps.length,
          };
        }
      },
    };
  }

  private addStep(step: AgentStep) {
    this.steps.push(step);
    this.onStep?.(step);
  }

  // ── Plan/Execute 模式切换工具 ──

  private createModeSwitchTools(): AgentTool[] {
    return [
      {
        name: "enter_plan_mode",
        description:
          "切换到 Plan 模式（只读分析）。Plan 模式下只能使用 readonly 工具，适合信息收集和方案设计阶段。完成规划后使用 exit_plan_mode 切回执行模式。",
        readonly: true,
        execute: async () => {
          if (this.mode === "plan") return { status: "already_in_plan_mode" };
          this.mode = "plan";
          this.addStep({ type: "observation", content: "[模式切换] 进入 Plan 模式（只读分析）", timestamp: Date.now() });
          return { status: "plan_mode_active", hint: "现在仅可使用只读工具，完成规划后调用 exit_plan_mode" };
        },
      },
      {
        name: "exit_plan_mode",
        description: "退出 Plan 模式，切换回 Execute 模式（可执行所有工具）。",
        readonly: true,
        execute: async () => {
          if (this.mode === "execute") return { status: "already_in_execute_mode" };
          this.mode = "execute";
          this.addStep({ type: "observation", content: "[模式切换] 进入 Execute 模式（完整权限）", timestamp: Date.now() });
          return { status: "execute_mode_active", hint: "现在可以使用所有工具执行操作" };
        },
      },
    ];
  }

  /** 获取当前模式下可用的工具列表 */
  private getAvailableTools(): AgentTool[] {
    const disabled = this.loopDetector.getDisabledTools();
    let tools = this.tools.filter((t) => !disabled.includes(t.name));
    if (this.mode === "plan") {
      tools = tools.filter((t) => t.readonly);
    }
    return tools;
  }

  /** 带超时的工具执行 */
  private async executeWithTimeout(
    tool: AgentTool,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = tool.timeout ?? this.config.defaultToolTimeout;
    if (!timeout || timeout <= 0) {
      return tool.execute(params);
    }
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new ToolTimeoutError(tool.name, timeout));
        }
      }, timeout);

      const onAbort = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Aborted")); }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      tool.execute(params).then(
        (val) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(val); } },
        (err) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(err); } },
      );
    });
  }

  private buildIterationExhaustedSummary(): string {
    const toolsCalled = this.steps
      .filter((s) => s.type === "action" && s.toolName)
      .map((s) => s.toolName!);
    const answers = this.steps.filter((s) => s.type === "answer");
    const errors = this.steps.filter((s) => s.type === "error");

    let summary = `已达到最大执行步数（${this.config.maxIterations} 步）。`;
    if (toolsCalled.length > 0) {
      const unique = [...new Set(toolsCalled)];
      summary += `\n已调用工具: ${unique.join(", ")}（共 ${toolsCalled.length} 次）`;
    }
    if (errors.length > 0) {
      summary += `\n遇到 ${errors.length} 个错误`;
    }
    if (answers.length > 0) {
      const lastAnswer = answers[answers.length - 1].content;
      if (lastAnswer && lastAnswer.length > 20) {
        summary += `\n\n以下是目前收集到的部分信息:\n${lastAnswer}`;
      }
    }
    summary += "\n\n如需继续，请发送追问消息。";
    return summary;
  }

  /**
   * 共享工具执行管道：危险检查 → 用户确认 → 执行 → 快捷回答 → 结果返回
   * 返回 { output, outputStr, quickAnswer, rejected, error }
   */
  private reflectOnError(toolName: string, toolParams: Record<string, unknown>, error: string): string {
    const paramSummary = Object.keys(toolParams).join(", ");
    return `工具 ${toolName}(${paramSummary}) 执行失败: ${error}。请分析错误原因，尝试修正参数或改用其他方式。`;
  }

  private async executeToolPipeline(
    toolName: string,
    toolParams: Record<string, unknown>,
    userInput: string,
    signal?: AbortSignal,
  ): Promise<{
    outputStr: string;
    quickAnswer?: string;
    rejected?: boolean;
    error?: string;
    errorResult?: ToolErrorResult;
    reflection?: string;
  }> {
    const startTime = Date.now();
    const tool = this.tools.find((t) => t.name === toolName);

    if (!tool) {
      const available = this.getAvailableTools().map((t) => t.name).join(", ");
      const msg = `未知工具: ${toolName}，可用工具: ${available}`;
      const errResult: ToolErrorResult = { type: ToolErrorType.NotFound, tool: toolName, message: msg, recoverable: true };
      this.addStep({ type: "error", content: `未知工具: ${toolName}`, timestamp: Date.now() });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return { outputStr: `错误: ${msg}`, error: msg, errorResult: errResult };
    }

    if (this.mode === "plan" && !tool.readonly) {
      const msg = `[Plan 模式] 工具 ${toolName} 不是只读工具，Plan 模式下禁止执行。请先调用 exit_plan_mode 切换到 Execute 模式。`;
      const errResult: ToolErrorResult = { type: ToolErrorType.PlanModeBlocked, tool: toolName, message: msg, recoverable: true };
      this.addStep({ type: "error", content: msg, toolName, timestamp: Date.now() });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return { outputStr: msg, error: msg, errorResult: errResult };
    }

    if (this.loopDetector.isDisabled(toolName)) {
      const msg = `[Doom Loop] 工具 ${toolName} 已被禁用（连续失败 ${DOOM_LOOP_CONSECUTIVE_FAILURES} 次）。请改用其他工具或方式完成任务。`;
      const errResult: ToolErrorResult = { type: ToolErrorType.LoopDetected, tool: toolName, message: msg, recoverable: false };
      this.addStep({ type: "error", content: msg, toolName, timestamp: Date.now() });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return { outputStr: msg, error: msg, errorResult: errResult };
    }

    if (tool.parameters) {
      const missing: string[] = [];
      for (const [key, param] of Object.entries(tool.parameters)) {
        if (param.required !== false && (toolParams[key] === undefined || toolParams[key] === null)) {
          missing.push(key);
        }
      }
      if (missing.length > 0) {
        const schema = Object.entries(tool.parameters)
          .map(([k, v]) => `  ${k}: ${v.type}${v.required === false ? " (可选)" : " (必需)"}${v.description ? ` - ${v.description}` : ""}`)
          .join("\n");
        const msg = `参数校验失败: ${toolName} 缺少必需参数 [${missing.join(", ")}]。收到的参数: ${JSON.stringify(toolParams)}。期望的参数格式:\n${schema}`;
        const errResult: ToolErrorResult = { type: ToolErrorType.ValidationError, tool: toolName, message: msg, recoverable: true };
        this.addStep({ type: "error", content: msg, toolName, timestamp: Date.now() });
        this.recordTrajectory({ type: "error", toolName, toolParams, error: errResult });
        return { outputStr: msg, error: msg, errorResult: errResult };
      }
    }

    this.addStep({
      type: "action",
      content: `调用 ${toolName}`,
      toolName,
      toolInput: toolParams,
      timestamp: Date.now(),
    });
    this.recordTrajectory({ type: "tool_call", toolName, toolParams, mode: this.mode });

    const isDangerous =
      !!tool.dangerous ||
      !!this.config.dangerousToolPatterns?.some((p) =>
        toolName.toLowerCase().includes(p.toLowerCase()),
      );
    if (isDangerous && this.config.confirmDangerousAction) {
      this.addStep({ type: "observation", content: `等待用户确认执行 ${toolName}`, toolName, timestamp: Date.now() });
      const confirmed = await this.config.confirmDangerousAction(toolName, toolParams);
      if (!confirmed) {
        this.addStep({ type: "observation", content: "用户拒绝执行此操作", toolName, timestamp: Date.now() });
        return { outputStr: "用户拒绝执行此操作", rejected: true };
      }
      this.addStep({ type: "observation", content: "用户已确认执行此操作", toolName, timestamp: Date.now() });
    }

    this.loopDetector.record(toolName, toolParams);
    const loopCheck = this.loopDetector.detect();
    if (loopCheck.looping) {
      const msg = `[循环检测] 工具 ${loopCheck.tool} 被重复调用（相同参数 ${LOOP_DETECTOR_THRESHOLD}+ 次）。请换一种方式或使用其他工具完成任务。`;
      const errResult: ToolErrorResult = { type: ToolErrorType.LoopDetected, tool: toolName, message: msg, recoverable: false };
      this.addStep({ type: "error", content: msg, toolName, timestamp: Date.now() });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return { outputStr: msg, error: msg, errorResult: errResult };
    }

    if (signal?.aborted) throw new Error("Aborted");
    try {
      const output = await this.executeWithTimeout(tool, toolParams, signal);
      if (signal?.aborted) throw new Error("Aborted");

      this.loopDetector.recordSuccess(toolName);

      const quickAnswer = this.buildQuickAnswerFromTool(userInput, toolName, output);
      if (quickAnswer) {
        this.addStep({ type: "answer", content: quickAnswer, timestamp: Date.now() });
        this.recordTrajectory({ type: "tool_result", toolName, result: "(quick_answer)", durationMs: Date.now() - startTime });
        return { outputStr: "", quickAnswer };
      }

      const rawStr = typeof output === "string" ? output : JSON.stringify(output, null, 2);
      const outputStr = truncateToolOutput(rawStr);
      this.addStep({ type: "observation", content: outputStr, toolName, toolOutput: output, timestamp: Date.now() });
      this.recordTrajectory({ type: "tool_result", toolName, result: outputStr.slice(0, 200), durationMs: Date.now() - startTime });
      return { outputStr };
    } catch (e) {
      if ((e as Error).message === "Aborted") throw e;
      const isTimeout = e instanceof ToolTimeoutError;
      const errorType = isTimeout ? ToolErrorType.Timeout : ToolErrorType.RuntimeError;
      const errorStr = isTimeout ? (e as ToolTimeoutError).message : `工具执行失败: ${e}`;
      const errResult: ToolErrorResult = { type: errorType, tool: toolName, message: errorStr, recoverable: !isTimeout };
      this.addStep({ type: "error", content: errorStr, toolName, timestamp: Date.now() });
      this.loopDetector.recordFailure(toolName);
      this.recordTrajectory({ type: "error", toolName, error: errResult, durationMs: Date.now() - startTime });
      return { outputStr: errorStr, error: errorStr, errorResult: errResult, reflection: this.reflectOnError(toolName, toolParams, errorStr) };
    }
  }

  // ── 文本 ReAct 模式（降级方案） ──

  private buildSystemPrompt(): string {
    const availableTools = this.getAvailableTools();
    const toolDescriptions = availableTools
      .map((t) => {
        const params = t.parameters
          ? Object.entries(t.parameters)
              .map(([k, v]) => `  - ${k}: ${v.type} (${v.description || ""})`)
              .join("\n")
          : "  (无参数)";
        return `- ${t.name}: ${t.description}\n  参数:\n${params}`;
      })
      .join("\n\n");

    const modeHint = this.mode === "plan"
      ? "\n\n**当前为 Plan 模式（只读），仅可使用只读工具。完成分析后调用 exit_plan_mode 切换到执行模式。**"
      : "";

    return `你是一个高能力智能助手 Agent，使用 ReAct (Reasoning + Acting) 框架来自主回答问题和执行复杂任务。${modeHint}

可用工具:
${toolDescriptions}

使用以下严格格式响应:

Thought: [分析当前情况和目标差距，制定下一步策略]
Action: [工具名称]
Action Input: [JSON 格式的参数]

或者，如果你已经知道最终答案:

Thought: [综合所有收集到的信息，给出最终分析]
Final Answer: [最终回答]

## 核心规则
1. 收到任务后立即开始执行，尽量自主完成
2. 每次只使用一个工具
3. Action Input 必须是有效的 JSON
4. 仔细分析 Observation 结果再决定下一步
5. 如果信息不足但可推断，做合理假设并继续
6. **严禁在 Final Answer 中向用户提问**。需要信息时必须用 ask_user 工具（会弹出交互对话框）
7. 调用 ask_user 时**必须提供 options 参数**，且**只能调用一次**，用 extra_questions 一次问完所有问题

## 复杂任务策略
- **任务分解**: 遇到复杂任务先拆分为子步骤，在 Thought 中列出计划
- **信息收集优先**: 在给结论前先用工具收集充分信息
- **结果验证**: 关键操作后通过查询验证结果
- **错误恢复**: 工具失败时在 Thought 中分析根因，尝试替代方案
- **多角度分析**: 复杂问题从多角度思考，给出全面答案
- **记住偏好**: 发现用户明确偏好时，用 save_user_memory 工具记录${this.config.userMemoryPrompt || ""}

用中文回答`;
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
      signal,
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

  private buildFCSystemPrompt(): string {
    const modeHint = this.mode === "plan"
      ? `\n\n## 当前模式: Plan（只读分析）\n你正处于 Plan 模式，只能使用只读工具（信息收集、搜索、读取）。不能执行修改操作。\n完成分析后调用 exit_plan_mode 切换到 Execute 模式再执行修改。`
      : "";
    const disabledTools = this.loopDetector.getDisabledTools();
    const disabledHint = disabledTools.length > 0
      ? `\n\n## 已禁用的工具（连续失败过多）\n${disabledTools.join(", ")} — 请改用其他方式完成任务。`
      : "";
    return `你是一个高能力智能助手 Agent，能够自主使用工具来回答问题和执行复杂任务。${modeHint}${disabledHint}

## 核心行为
- 收到任务后立即开始执行，尽量自主完成
- 如果信息不足但可以合理推断，直接假设并继续
- **严禁在回复文本中向用户提问**。需要用户输入时，必须调用 ask_user 工具（会弹出交互对话框让用户选择/输入）
- 以下情况必须调用 ask_user 工具：
  · 任务目标模糊（如"帮我处理文件"但未指定哪个文件）
  · 有多个合理方案需要用户选择（如保存格式、目标路径）
  · 操作不可逆且影响范围不明确（如批量删除、覆盖文件）
  · 缺少必要的参数（如收件人、密码、具体日期等）
- 调用 ask_user 时**必须提供 options 参数**列出你认为合理的选项（用户也可以忽略选项自由输入）
- **ask_user 只能调用一次**。如需了解多项信息，用 extra_questions 参数在一次调用中问完所有问题，不要多次调用
- 示例: ask_user(question="您想搜索什么类型的资料？", options="技术文档,学术论文,新闻资讯", extra_questions='[{"question":"请描述具体主题","type":"text"}]')
- 用中文回答

## 模式切换
- 面对复杂任务时，可先调用 enter_plan_mode 进入只读分析模式，收集信息和制定方案
- 方案确定后调用 exit_plan_mode 切回执行模式进行实际操作

## 复杂任务处理策略
1. **任务分解**：遇到复杂任务时，先在内部将其拆分为多个子步骤，按顺序逐步完成
2. **深度推理**：每一步执行前，先分析当前已知信息和目标的差距，选择最有效的工具
3. **信息收集优先**：在给出结论前，先充分收集必要信息（读文件、搜索、查询系统状态等）
4. **结果验证**：完成关键操作后，通过读取或查询验证结果是否正确
5. **错误恢复**：工具失败时分析根因，尝试替代方案而非简单重试

## 工具使用规则
- 需要工具时直接调用
- 仔细分析工具返回结果再决定下一步
- 不要在没有使用工具的情况下编造信息
- 涉及文件操作时，必须调用对应工具
- 如有 delegate_subtask 工具可用，可将独立子问题委派给子 Agent 并行处理

## 回答质量
- 结论必须基于真实的工具调用结果
- 多角度分析问题，给出全面的答案
- 如果任务有多种可行方案，简要说明各方案优劣
- 发现用户有明确偏好或习惯时，使用 save_user_memory 工具记录${this.config.userMemoryPrompt || ""}`;
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
    /** Final Warning Turn: true 时不传工具定义，强制模型直接回答 */
    stripTools = false,
  ): Promise<
    | { type: "content"; content: string }
    | { type: "tool_calls"; toolCalls: AIToolCall[] }
  > {
    const availableTools = stripTools ? [] : this.getAvailableTools();
    const toolDefs = availableTools.map(toolToFunctionDef);
    let lastPushedLen = 0;
    let accumulated = "";

    const result = await this.ai.streamWithTools!({
      messages,
      tools: toolDefs,
      signal,
      onChunk: (chunk) => {
        if (signal?.aborted) return;
        accumulated += chunk;
        const current = accumulated.trim();
        if (current && current.length > lastPushedLen + 10) {
          this.onStep?.({
            type: "answer",
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

  private isComplexQuery(input: string): boolean {
    const text = input.trim();
    const complexIndicators = [
      /(?:分析|对比|比较|总结|调研|研究|规划|设计|评估|优化)/,
      /(?:步骤|流程|方案|计划|策略)/,
      /(?:多个|多种|几个|若干|所有|全部|每个).*(?:方面|维度|角度|问题)/,
      /(?:首先|然后|接着|最后|第一|第二)/,
      /(?:如何|怎么|怎样).*(?:并且|同时|还要|以及)/,
    ];
    const matchCount = complexIndicators.filter((r) => r.test(text)).length;
    if (matchCount >= 2) return true;
    if (text.length > 300 && matchCount >= 1) return true;
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return lines.length >= 3 && matchCount >= 1;
  }

  private buildPlanningHint(userInput: string): string {
    const hiddenInHint = new Set(["sequential_thinking", "save_user_memory", "task_done", "enter_plan_mode", "exit_plan_mode"]);
    const toolNames = this.getAvailableTools()
      .filter((t) => !t.name.startsWith("native_") && !hiddenInHint.has(t.name))
      .map((t) => t.name)
      .slice(0, 12);
    return `${userInput}\n\n[系统引导] 这是一个需要多步执行的任务。请先在内部制定执行计划（不要输出给用户），明确：\n1. 需要分几步完成\n2. 每步使用什么工具（可用: ${toolNames.join(", ")}）\n3. 各步骤之间的依赖关系\n然后按计划逐步执行。`;
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

    for (const step of this.history) {
      if (step.type === "answer") {
        messages.push({ role: "assistant", content: step.content });
      } else if (step.type === "action") {
        const paramStr = step.toolInput ? JSON.stringify(step.toolInput) : "";
        messages.push({
          role: "assistant",
          content: `调用工具: ${step.toolName || "unknown"}(${paramStr})`,
        });
      } else if (step.type === "observation") {
        messages.push({ role: "user", content: `上次执行结果: ${step.content}` });
      }
    }

    const isComplex = this.isComplexQuery(userInput) && this.history.length === 0;
    const effectiveInput = isComplex ? this.buildPlanningHint(userInput) : userInput;
    messages.push({ role: "user", content: effectiveInput });

    let unknownToolCount = 0;
    let rejectedDangerousActionCount = 0;
    let guardRailRetryCount = 0;
    const MAX_GUARD_RAIL_RETRIES = 2;
    const toolFailCounts = new Map<string, number>();

    let iterationWarningIdx = -1;

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (signal?.aborted) throw new Error("Aborted");

      // 每轮刷新 system prompt（模式切换或 doom loop 禁用工具后需要更新）
      messages[0] = { role: "system", content: this.buildFCSystemPrompt() };

      const remaining = this.config.maxIterations - i;
      const isFinalWarningTurn = remaining === 1;

      if (remaining <= 3 && remaining > 0) {
        const warningContent = isFinalWarningTurn
          ? `[Final Warning] 这是最后一步。请立即基于目前收集到的所有信息，给出完整的最终答案。不要再调用任何工具。`
          : `[系统提示] 剩余可用步骤仅 ${remaining} 步。请尽快基于已收集的信息给出最终答案。如果信息已足够，直接回复最终结论；如果还需关键操作，只做最必要的一步。`;
        const warningMsg = { role: "user" as const, content: warningContent };
        if (iterationWarningIdx >= 0) {
          messages[iterationWarningIdx] = warningMsg;
        } else {
          iterationWarningIdx = messages.length;
          messages.push(warningMsg);
        }
      }

      const compacted = compactMessages(messages, this.config.contextLimit ?? DEFAULT_CONTEXT_LIMIT);
      this.recordTrajectory({ type: "llm_call", mode: this.mode, tokenEstimate: estimateMessagesTokens(compacted) });
      const result = await this.streamFCLLM(compacted, signal, isFinalWarningTurn);

      if (signal?.aborted) throw new Error("Aborted");

      if (result.type === "content") {
        const answer = result.content.trim();
        if (answer) {
          const guardRailCorrection =
            guardRailRetryCount < MAX_GUARD_RAIL_RETRIES
              ? this.checkAnswerGuardRails(answer, userInput, rejectedDangerousActionCount)
              : null;
          if (guardRailCorrection) {
            guardRailRetryCount++;
            messages.push({ role: "assistant", content: answer });
            messages.push({ role: "user", content: guardRailCorrection });
            continue;
          }
          this.addStep({
            type: "answer",
            content: answer,
            timestamp: Date.now(),
          });
          return answer;
        }
        messages.push({ role: "assistant", content: "" });
        messages.push({ role: "user", content: "请继续回答或使用工具。" });
        continue;
      }

      const validToolCalls = result.toolCalls.filter(
        (tc) => tc.function.name && tc.function.name.trim(),
      );

      if (validToolCalls.length === 0) {
        throw new Error(
          "FC_INCOMPATIBLE: model returned tool_calls with empty function names",
        );
      }

      const parsedCalls = validToolCalls.map((tc) => {
        let toolParams: Record<string, unknown> = {};
        try { toolParams = JSON.parse(tc.function.arguments || "{}"); } catch { toolParams = {}; }
        return { tc, toolName: tc.function.name, toolParams };
      });

      for (const { tc, toolName } of parsedCalls) {
        if (!this.tools.find((t) => t.name === toolName)) {
          unknownToolCount++;
          if (unknownToolCount >= 3) {
            throw new Error("FC_INCOMPATIBLE: too many unknown tool calls, model may not be compatible with FC");
          }
        } else {
          unknownToolCount = 0;
        }
      }

      const canParallel = parsedCalls.length > 1 && parsedCalls.every(({ toolName }) => {
        const tool = this.tools.find((t) => t.name === toolName);
        if (!tool) return false;
        if (tool.readonly) return true;
        return !tool.dangerous && !this.config.dangerousToolPatterns?.some(
          (p) => toolName.toLowerCase().includes(p.toLowerCase()),
        );
      });

      type PipelineResult = Awaited<ReturnType<ReActAgent["executeToolPipeline"]>>;
      type CallResult = { tc: AIToolCall; toolName: string; result: PipelineResult };

      let callResults: CallResult[];
      if (canParallel) {
        callResults = await Promise.all(
          parsedCalls.map(async ({ tc, toolName, toolParams }): Promise<CallResult> => ({
            tc, toolName, result: await this.executeToolPipeline(toolName, toolParams, userInput, signal),
          })),
        );
      } else {
        callResults = [];
        for (const { tc, toolName, toolParams } of parsedCalls) {
          callResults.push({ tc, toolName, result: await this.executeToolPipeline(toolName, toolParams, userInput, signal) });
        }
      }
      let quickAnswerFound: string | undefined;

      messages.push({ role: "assistant", content: null, tool_calls: callResults.map((r) => r.tc) });

      let taskDoneResult: string | undefined;

      for (const { tc, toolName, result: pipelineResult } of callResults) {
        if (pipelineResult.quickAnswer && !quickAnswerFound) {
          quickAnswerFound = pipelineResult.quickAnswer;
        }
        if (pipelineResult.rejected) rejectedDangerousActionCount++;

        if (toolName === "task_done") {
          taskDoneResult = pipelineResult.outputStr || "任务已完成。";
        }

        if (pipelineResult.error) {
          const failCount = (toolFailCounts.get(toolName) ?? 0) + 1;
          toolFailCounts.set(toolName, failCount);
          let outputWithHint = pipelineResult.outputStr;
          if (failCount >= 2) {
            outputWithHint += `\n\n[系统提示] 工具 ${toolName} 已连续失败 ${failCount} 次。请仔细检查参数格式是否正确，或改用其他工具/方式完成任务。不要再以相同方式重试。`;
          }
          if (pipelineResult.reflection) {
            outputWithHint += `\n\n[反思] ${pipelineResult.reflection}`;
          }
          messages.push({ role: "tool", content: outputWithHint, tool_call_id: tc.id, name: toolName });
        } else {
          toolFailCounts.delete(toolName);
          messages.push({ role: "tool", content: pipelineResult.outputStr, tool_call_id: tc.id, name: toolName });
        }
      }

      if (quickAnswerFound) return quickAnswerFound;

      if (taskDoneResult) {
        const lastAnswerStep = [...this.steps].reverse().find((s) => s.type === "answer");
        const answer = lastAnswerStep?.content || taskDoneResult;
        if (!lastAnswerStep) {
          this.addStep({ type: "answer", content: answer, timestamp: Date.now() });
        }
        return answer;
      }
    }

    const fallback = this.buildIterationExhaustedSummary();
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
    const isComplex = this.isComplexQuery(userInput) && this.history.length === 0;
    const effectiveTextInput = isComplex ? this.buildPlanningHint(userInput) : userInput;
    messages.push({ role: "user", content: effectiveTextInput });
    let rejectedDangerousActionCount = 0;
    let guardRailRetryCount = 0;
    const MAX_GUARD_RAIL_RETRIES = 2;
    const textToolFailCounts = new Map<string, number>();

    let textIterationWarningIdx = -1;

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (signal?.aborted) throw new Error("Aborted");

      const remaining = this.config.maxIterations - i;
      const isFinalWarningTurn = remaining === 1;

      if (remaining <= 3 && remaining > 0) {
        const warningContent = isFinalWarningTurn
          ? `[Final Warning] 这是最后一步。请立即写出 Final Answer，不要再使用任何工具。基于目前收集到的信息给出最终答案。`
          : `[系统提示] 剩余可用步骤仅 ${remaining} 步。请尽快给出 Final Answer。如果信息已足够，直接写 Final Answer；如果还需关键操作，只做最必要的一步。`;
        const warningMsg = { role: "user" as const, content: warningContent };
        if (textIterationWarningIdx >= 0) {
          messages[textIterationWarningIdx] = warningMsg;
        } else {
          textIterationWarningIdx = messages.length;
          messages.push(warningMsg);
        }
      }

      let responseContent: string;
      const compactedTextMessages = compactMessages(messages, this.config.contextLimit ?? DEFAULT_CONTEXT_LIMIT);
      this.recordTrajectory({ type: "llm_call", mode: this.mode, tokenEstimate: estimateMessagesTokens(compactedTextMessages) });
      try {
        responseContent = await this.streamTextLLM(compactedTextMessages, signal);
      } catch (e) {
        if ((e as Error).message === "Aborted") throw e;
        const response = await this.ai.chat({
          messages: compactedTextMessages,
          temperature: this.config.temperature,
          signal,
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
        const guardRailCorrection =
          guardRailRetryCount < MAX_GUARD_RAIL_RETRIES
            ? this.checkAnswerGuardRails(parsed.finalAnswer, userInput, rejectedDangerousActionCount)
            : null;
        if (guardRailCorrection) {
          guardRailRetryCount++;
          messages.push({ role: "assistant", content: responseContent });
          messages.push({ role: "user", content: guardRailCorrection });
          continue;
        }
        this.addStep({
          type: "answer",
          content: parsed.finalAnswer,
          timestamp: Date.now(),
        });
        return parsed.finalAnswer;
      }

      if (parsed.action) {
        const pipelineResult = await this.executeToolPipeline(
          parsed.action,
          parsed.actionInput || {},
          userInput,
          signal,
        );

        if (pipelineResult.quickAnswer) return pipelineResult.quickAnswer;
        if (pipelineResult.rejected) rejectedDangerousActionCount++;

        let observation = pipelineResult.outputStr;
        if (pipelineResult.error) {
          const failCount = (textToolFailCounts.get(parsed.action) ?? 0) + 1;
          textToolFailCounts.set(parsed.action, failCount);
          if (failCount >= 2) {
            observation += `\n\n[系统提示] 工具 ${parsed.action} 已连续失败 ${failCount} 次。请仔细检查参数格式是否正确，或改用其他工具/方式完成任务。不要再以相同方式重试。`;
          }
          if (pipelineResult.reflection) {
            observation += `\n\n[反思] ${pipelineResult.reflection}`;
          }
        } else {
          textToolFailCounts.delete(parsed.action);
        }

        messages.push({ role: "assistant", content: responseContent });
        messages.push({ role: "user", content: `Observation: ${observation}` });
      } else {
        messages.push({ role: "assistant", content: responseContent });
        messages.push({
          role: "user",
          content:
            "请按照规定格式回复：使用 Thought/Action/Action Input 或 Thought/Final Answer",
        });
      }
    }

    const fallback = this.buildIterationExhaustedSummary();
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
    if (this.running) throw new Error("Agent is already running");
    this.running = true;
    this.currentSignal = signal;
    this.steps = [];
    this.trajectory = [];
    this.loopDetector.reset();
    this.mode = this.config.initialMode ?? "execute";

    try {
    // 判断是否可以使用 Function Calling
    const canUseFC =
      !this.config.forceTextMode &&
      typeof this.ai.streamWithTools === "function";

    if (canUseFC && this.fcAvailable !== false) {
      try {
        const result = await this.runFC(userInput, signal);
        this.fcAvailable = true; // 当前实例标记 FC 可用
        return result;
      } catch (e) {
        if ((e as Error).message === "Aborted") throw e;

        const errMsg = (e as Error).message || "";
        const isFCIncompatible = errMsg.startsWith("FC_INCOMPATIBLE");
        const shouldDowngrade = this.fcAvailable === null || isFCIncompatible;

        if (isFCIncompatible) {
          this.fcAvailable = false;
          if (this.fcCompatibilityKey) {
            fcIncompatibleCache.set(this.fcCompatibilityKey, Date.now());
            pruneFCCache();
          }
        }

        // FC 调用失败 或 模型不兼容 FC → 降级到文本 ReAct 模式
        if (shouldDowngrade) {
          handleError(e, {
            context: "ReAct Agent Function Calling 降级为文本模式",
            level: ErrorLevel.Warning,
            silent: true,
          });
          if (!isFCIncompatible) {
            this.fcAvailable = false;
          }
          this.addStep({
            type: "observation",
            content: "Function Calling 模式不可用，已自动切换至文本 ReAct 模式。",
            timestamp: Date.now(),
          });
          return this.runText(userInput, signal);
        }
        throw e;
      }
    }

    // 文本 ReAct 模式
    return this.runText(userInput, signal);
    } finally {
      this.running = false;
      this.currentSignal = undefined;
    }
  }

  getSteps(): AgentStep[] {
    return [...this.steps];
  }

  getTrajectory(): TrajectoryEntry[] {
    return [...this.trajectory];
  }

  getMode(): AgentMode {
    return this.mode;
  }

  private recordTrajectory(entry: Omit<TrajectoryEntry, "step" | "timestamp">): void {
    this.trajectory.push({
      step: this.trajectory.length + 1,
      timestamp: Date.now(),
      ...entry,
    });
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
  const actionName = action.name.toLowerCase();
  const actionDesc = action.description.toLowerCase();
  const dangerousKeywords = [
    "shell",
    "command",
    "delete",
    "remove",
    "clear",
    "lock",
    "shutdown",
    "reboot",
    "sleep",
    "write",
    "file",
    "trash",
  ];
  const dangerous =
    pluginId.toLowerCase() === "system-actions" ||
    dangerousKeywords.some(
      (keyword) => actionName.includes(keyword) || actionDesc.includes(keyword),
    );

  return {
    name: `${pluginId}_${action.name}`,
    description: `[${pluginName}] ${action.description}`,
    parameters: action.parameters
      ? Object.fromEntries(
          Object.entries(action.parameters).map(([k, v]) => [
            k,
            { type: v.type, description: v.description, required: v.required },
          ]),
        )
      : undefined,
    dangerous,
    execute: (params) => action.execute(params, { ai }),
  };
}
