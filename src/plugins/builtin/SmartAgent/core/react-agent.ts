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
import { ClarificationInterrupt } from "@/core/agent/actor/middlewares/clarification-middleware";
import type {
  MToolsAI,
  AIToolDefinition,
  AIToolCall,
} from "@/core/plugin-system/plugin-interface";
import type { ThinkingLevel } from "@/core/agent/actor/types";
import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import type { PluginAction } from "@/core/plugin-system/plugin-interface";
import { applyContextBudget, type PromptSection } from "@/core/agent/context-budget";
import { mergeStreamChunk } from "@/core/ai/stream-chunk-merge";
import { parseToolCallArguments } from "./tool-call-arguments";

// ── 结构化工具错误类型（借鉴 Kimi CLI 四层体系） ──

export const ToolErrorType = {
  NotFound: "not_found",
  ParseError: "parse_error",
  ValidationError: "validation_error",
  RuntimeError: "runtime_error",
  Timeout: "timeout",
  LoopDetected: "loop_detected",
  PlanModeBlocked: "plan_mode_blocked",
} as const;
export type ToolErrorType = (typeof ToolErrorType)[keyof typeof ToolErrorType];

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
  execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

export interface AgentStep {
  type: "thought" | "action" | "observation" | "answer" | "error" | "thinking" | "tool_streaming";
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
  /** 每次工具成功执行后的回调（用于通知外部状态重置，如 sequential_thinking 计数器） */
  onToolExecuted?: (toolName: string) => void;
  /** 角色覆盖：设置后替换默认身份描述（用于 Cluster 子 Agent 注入角色身份） */
  roleOverride?: string;
  /** Skill 系统注入的领域知识和行为约束（由 skill-resolver 生成） */
  skillsPrompt?: string;
  /** 管理中心提供的全局补充指令，跨 Ask / Agent / Cluster / Dialog 共享 */
  extraSystemPrompt?: string;
  /** 跳过内置的 detectCodingContext + codingBlock，由 Skills 系统统一提供编程指引 */
  skipInternalCodingBlock?: boolean;
  /** Coding Execution Policy（注入 system prompt 而非 user message，避免占历史空间） */
  codingHint?: string;
  /** system prompt 总 token 预算（0 = 不限，默认不限） */
  contextBudget?: number;
  /** 运行时模型覆盖（用于多 Agent / Actor 场景下每个 Agent 使用不同模型） */
  modelOverride?: string;
  /** 运行时思考深度（由 Actor/Dialog 透传） */
  thinkingLevel?: ThinkingLevel;
  /** Actor 收件箱排空回调：每次 iteration 间隙调用，返回待处理消息（空数组 = 无新消息） */
  inboxDrain?: () => { id: string; from: string; content: string; expectReply?: boolean; replyTo?: string }[];
  /** 对话历史上下文：作为多轮 messages 注入（system 之后、当前 query 之前），用于 Actor 会话连续性 */
  contextMessages?: Array<{ role: "user" | "assistant"; content: string }>;
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

function isFCCompatibilityErrorMessage(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  if (normalized.startsWith("FC_INCOMPATIBLE")) return true;

  return /(?:function calling|tool(?:_calls?| calling| use| choice)?).{0,48}(?:not supported|unsupported|unavailable|disabled|invalid|forbidden)|does not support.{0,48}(?:tools|tool use|function calling)|unknown parameter.{0,48}(?:tools|tool_choice)|extra inputs? are not permitted.{0,48}(?:tools|tool_choice)|tool_choice.{0,32}(?:not supported|unsupported|invalid)/i
    .test(normalized);
}

function isTransportOrTimeoutErrorMessage(message: string): boolean {
  return /(timeout|timed out|超时|卡住|请求失败|网络|network|econn|socket hang up|connection reset|流读取错误|503|504|502|rate limit|overloaded|temporarily unavailable)/i
    .test(message);
}

// ── Context 管理 ──

import { estimateTokens, estimateMessagesTokens } from "@/core/ai/token-utils";

const DEFAULT_CONTEXT_LIMIT = 100_000;
const CONTEXT_COMPACT_THRESHOLD = 0.75;

function summarizeDiscardedMiddle<
  T extends { role: string; content: string | null; tool_calls?: unknown; [k: string]: unknown },
>(middle: T[]): string {
  const toolNames: string[] = [];
  const keyFindings: string[] = [];
  for (const m of middle) {
    if (m.role === "assistant" && m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{ function?: { name?: string } }>) {
        if (tc.function?.name) toolNames.push(tc.function.name);
      }
    }
    if (m.role === "assistant" && !m.tool_calls && m.content) {
      // 提取前100字符作为关键发现
      const snippet = m.content.slice(0, 100).trim();
      if (snippet) keyFindings.push(snippet);
    }
  }
  const parts: string[] = ["[上下文压缩摘要]"];
  if (toolNames.length > 0) {
    const unique = [...new Set(toolNames)];
    parts.push(`已执行工具: ${unique.join(", ")} (共${toolNames.length}次调用)`);
  }
  if (keyFindings.length > 0) {
    parts.push(`关键步骤: ${keyFindings.slice(-3).join(" → ")}`);
  }
  parts.push(`(已压缩 ${middle.length} 条消息)`);
  return parts.join("\n");
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
    const nonGroupMessages: T[] = [];
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
        nonGroupMessages.push(m);
        i++;
      }
    }

    // 保留最近3组工具调用
    const keepCount = Math.min(3, toolCallGroups.length);
    const recentGroups = toolCallGroups.slice(-keepCount);
    const discardedGroups = toolCallGroups.slice(0, toolCallGroups.length - keepCount);

    // 保留最后一条纯文本 assistant，其余 nonGroupMessages 视为可丢弃
    const keptNonGroup = new Set<T>();
    const assistantTexts = nonGroupMessages.filter(
      (m) => m.role === "assistant" && !m.tool_calls,
    );
    if (assistantTexts.length > 0) keptNonGroup.add(assistantTexts[assistantTexts.length - 1]);

    const discardedMessages = [
      ...discardedGroups.flat(),
      ...nonGroupMessages.filter((m) => !keptNonGroup.has(m)),
    ];
    if (discardedMessages.length > 0) {
      const summary = summarizeDiscardedMiddle(discardedMessages);
      result.push({ role: "user", content: summary } as unknown as T);
      result.push({ role: "assistant", content: "好的，我已了解之前的执行历史，继续当前任务。" } as unknown as T);
    }

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

    // 先恢复工具调用组（时间较早），再放纯文本 assistant（时间较晚）
    for (const group of compactedGroups) result.push(...group);
    for (const m of keptNonGroup) result.push(m);
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

function truncateToolOutput(output: string, toolName?: string): string {
  if (output.length <= TOOL_OUTPUT_MAX_CHARS) return output;
  const head = output.slice(0, TOOL_OUTPUT_KEEP_HEAD);
  const tail = output.slice(-TOOL_OUTPUT_KEEP_TAIL);
  const omitted = output.length - TOOL_OUTPUT_KEEP_HEAD - TOOL_OUTPUT_KEEP_TAIL;

  // 根据工具类型提供可操作的恢复指引
  let recoveryHint = "";
  if (toolName === "read_file" || toolName === "read_text_file") {
    recoveryHint = "\n<NOTE>输出已截断。请使用 read_file_range 指定 start_line/end_line 分段读取需要的部分。</NOTE>";
  } else if (toolName === "search_in_files") {
    recoveryHint = "\n<NOTE>搜索结果已截断。请缩小搜索范围：添加 file_pattern 过滤文件类型，或减小 max_results，或使用更精确的 query。</NOTE>";
  } else if (toolName === "run_shell_command" || toolName === "persistent_shell") {
    recoveryHint = "\n<NOTE>命令输出已截断。请在命令中配合 grep/head/tail 过滤输出，或将输出重定向到文件后用 read_file_range 分段读取。</NOTE>";
  } else if (toolName === "list_directory") {
    recoveryHint = "\n<NOTE>目录列表已截断。请指定更深层的子目录路径来缩小范围。</NOTE>";
  } else {
    recoveryHint = "\n<NOTE>输出已截断。请尝试缩小请求范围以获取完整结果。</NOTE>";
  }

  return `${head}\n\n... [已省略 ${omitted} 字符] ...${recoveryHint}\n\n${tail}`;
}

// ── 工具超时异常 ──

class ToolTimeoutError extends Error {
  toolName: string;
  timeoutMs: number;
  constructor(toolName: string, timeoutMs: number) {
    super(`工具 ${toolName} 执行超时（${timeoutMs}ms）`);
    this.name = "ToolTimeoutError";
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
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
const SAME_TOOL_CONSECUTIVE_LIMIT = 3;
const CONSECUTIVE_LIMIT_TOOLS = new Set(["sequential_thinking"]);
const LOOP_DETECT_EXEMPT_TOOLS = new Set([
  "get_current_time", "get_system_info", "calculate",
  "native_calendar_list", "native_reminder_lists", "native_shortcuts_list",
  "native_app_list", "native_app_list_interactive",
]);

class LoopDetector {
  private recentCalls: string[] = [];
  private consecutiveFailures: Map<string, number> = new Map();
  private disabledTools: Set<string> = new Set();
  private consecutiveToolCounts: Map<string, number> = new Map();
  private lastToolName: string | null = null;

  record(toolName: string, args: Record<string, unknown>): void {
    const key = `${toolName}::${JSON.stringify(args)}`;
    this.recentCalls.push(key);
    if (this.recentCalls.length > LOOP_DETECTOR_WINDOW * 2) {
      this.recentCalls = this.recentCalls.slice(-LOOP_DETECTOR_WINDOW * 2);
    }

    if (toolName === this.lastToolName) {
      this.consecutiveToolCounts.set(toolName, (this.consecutiveToolCounts.get(toolName) ?? 1) + 1);
    } else {
      this.consecutiveToolCounts.set(toolName, 1);
      this.lastToolName = toolName;
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
        const toolName = key.split("::")[0];
        if (LOOP_DETECT_EXEMPT_TOOLS.has(toolName)) continue;
        return { looping: true, tool: toolName };
      }
    }
    return { looping: false };
  }

  detectConsecutiveSameTool(): { looping: boolean; tool?: string; count?: number } {
    if (!this.lastToolName) return { looping: false };
    const count = this.consecutiveToolCounts.get(this.lastToolName) ?? 0;
    if (count >= SAME_TOOL_CONSECUTIVE_LIMIT && CONSECUTIVE_LIMIT_TOOLS.has(this.lastToolName)) {
      return { looping: true, tool: this.lastToolName, count };
    }
    return { looping: false };
  }

  recordFailure(toolName: string): void {
    if (LOOP_DETECT_EXEMPT_TOOLS.has(toolName)) return;
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
    this.consecutiveToolCounts.clear();
    this.lastToolName = null;
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
  /** 追踪流式 answer 的最新累积内容，用于 task_done 时恢复完整文档 */
  private lastStreamingAnswer = "";
  /** Function Calling 是否可用（当前实例内缓存） */
  private fcAvailable: boolean | null = null;
  /** 跨实例模型兼容性缓存 key */
  private fcCompatibilityKey: string | null = null;
  private running = false;
  private currentSignal?: AbortSignal;
  private loopDetector = new LoopDetector();
  private approvedDangerousKeys = new Set<string>();
  /** 缓存已成功执行的 tool+params → 输出，避免重复执行（LRU, max 200 entries） */
  private successfulCallCache = new Map<string, string>();
  private static readonly CALL_CACHE_MAX_SIZE = 200;
  private mode: AgentMode = "execute";
  private trajectory: TrajectoryEntry[] = [];

  private isQuickTimeQuery(userInput: string): boolean {
    const q = userInput.trim();
    if (!q) return false;
    return /现在.*几点|当前.*时间|现在几号|今天几号|当前日期|what time|current time/i.test(
      q,
    );
  }

  private isQuickMathQuery(userInput: string): boolean {
    const q = userInput.trim();
    if (!q || q.length > 80) return false;
    if (inferCodingExecutionProfile({ query: q }).profile.codingMode) return false;
    if (/网页|页面|html|代码|文件|保存|实现|生成|修复|下载|artifact|write|create|build/i.test(q)) {
      return false;
    }
    const directExpression = /^[-+*/%().\d\s=xX]+$/i.test(q);
    const askMath = /^(请)?(帮我)?(计算|算一下|求|evaluate|what is|是多少|等于多少)/i.test(q)
      && /[-+*/%().\d\s=xX]+/.test(q);
    return directExpression || askMath;
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
      if (!this.isQuickMathQuery(userInput)) {
        return null;
      }
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
    const writeToolPatterns = ["write_file", "str_replace_edit", "json_edit"];
    return allSteps.some(
      (step) =>
        step.type === "action" &&
        writeToolPatterns.some((p) => step.toolName?.toLowerCase().includes(p)),
    );
  }

  private hasSaveLikeIntent(userInput: string): boolean {
    const text = userInput.toLowerCase();
    const writeVerbs = ["写入", "保存", "另存", "覆盖", "修改文件", "更新文件", "写到", "编辑文件", "插入", "write_file", "str_replace", "save", "edit"];
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
      (this.hasAnyToolAction() || this.hasSaveLikeIntent(userInput)) &&
      this.isLikelyExecutionConfirmation(answer)
    ) {
      return "不要在文本里向用户请求“是否继续执行/请确认继续”。如需用户确认，必须调用 ask_user 工具并在拿到回答后继续执行。";
    }
    if (
      this.hasSaveLikeIntent(userInput) &&
      !this.hasWriteFileAction() &&
      this.isLikelySaveOutcomeClaim(answer)
    ) {
      return "你尚未实际调用文件写入工具（write_file / str_replace_edit / json_edit）。若任务包含保存/修改文件，必须先调用相应工具并基于真实工具结果再给结论。";
    }
    if (
      rejectedDangerousActionCount === 0 &&
      this.isLikelyUserRefusalClaim(answer)
    ) {
      return "不要假设用户已经拒绝授权。仅可基于真实工具调用结果给出结论；若未触发确认，请继续执行并给出结果。";
    }
    if (!this.hasAnyToolAction() && this.isLikelyAskingUser(answer)) {
      return "严禁在回复文本中向用户提问。如果需要用户提供信息，必须调用 ask_user 工具（会弹出交互对话框）。请调用 ask_user 工具来提问，不要用文字回复提问。";
    }
    const toolCallInText = this.detectToolCallInText(answer);
    if (toolCallInText) {
      return `你在回复文本中写出了工具调用"${toolCallInText}"，但并没有真正执行。请直接调用该工具，不要把工具调用写在文字里。`;
    }
    return null;
  }

  private hasAnyToolAction(): boolean {
    return this.steps.some((s) => s.type === "action");
  }

  private isLikelyAskingUser(text: string): boolean {
    const strongPatterns = [
      /请告诉我/,
      /请提供.*(?:信息|内容|文件|路径)/,
      /请输入/,
      /请选择.*(?:方案|选项|模式)/,
      /请指定/,
      /直接.*发给我/,
      /请问您/,
    ];
    const weakPatterns = [
      /您(?:想|希望|能否|可以).*(?:吗|呢|\?|？)/,
      /你(?:想|希望|能否|可以).*(?:吗|呢|\?|？)/,
      /(?:什么|哪个|哪些|哪种).*(?:\?|？)/,
    ];
    const strongCount = strongPatterns.filter((p) => p.test(text)).length;
    if (strongCount >= 2) return true;
    const weakCount = weakPatterns.filter((p) => p.test(text)).length;
    return strongCount >= 1 && weakCount >= 1;
  }

  private isLikelyExecutionConfirmation(text: string): boolean {
    const normalized = text.replace(/\s+/g, "");
    const patterns = [
      /是否继续执行/,
      /要不要继续执行/,
      /需不需要继续执行/,
      /请确认继续/,
      /是否执行修改/,
      /确认(?:后)?继续/,
      /继续(?:执行|修改).*(?:吗|？|\?)/,
      /是否(?:继续|执行|覆盖|提交).*(?:吗|？|\?)/,
    ];
    return patterns.some((p) => p.test(normalized));
  }

  private detectToolCallInText(text: string): string | null {
    const toolNames = this.getAvailableTools().map((t) => t.name);
    for (const name of toolNames) {
      const pattern = new RegExp(`(?:调用工具|Action|tool_call)[:\\s]*${name}\\s*\\(`, "i");
      if (pattern.test(text)) return name;
      const callPattern = new RegExp(`${name}\\(\\s*\\{`, "i");
      if (callPattern.test(text)) return name;
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
            skillsPrompt: this.config.skillsPrompt,
            extraSystemPrompt: this.config.extraSystemPrompt,
            skipInternalCodingBlock: this.config.skipInternalCodingBlock,
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
      return tool.execute(params, signal);
    }

    // 创建组合 AbortController：超时或父级 abort 都会触发
    const toolAbort = new AbortController();
    const timer = setTimeout(() => toolAbort.abort(new ToolTimeoutError(tool.name, timeout)), timeout);

    const onParentAbort = () => toolAbort.abort(new Error("Aborted"));
    signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const result = await tool.execute(params, toolAbort.signal);
      return result;
    } catch (err) {
      if (toolAbort.signal.aborted && toolAbort.signal.reason instanceof ToolTimeoutError) {
        throw toolAbort.signal.reason;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
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

    this.loopDetector.record(toolName, toolParams);
    const loopCheck = this.loopDetector.detect();
    if (loopCheck.looping) {
      const msg = `[循环检测] 工具 ${loopCheck.tool} 被重复调用（相同参数 ${LOOP_DETECTOR_THRESHOLD}+ 次）。请换一种方式或使用其他工具完成任务。`;
      const errResult: ToolErrorResult = { type: ToolErrorType.LoopDetected, tool: toolName, message: msg, recoverable: false };
      this.addStep({ type: "error", content: msg, toolName, timestamp: Date.now() });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return { outputStr: msg, error: msg, errorResult: errResult };
    }

    const consecutiveCheck = this.loopDetector.detectConsecutiveSameTool();
    if (consecutiveCheck.looping) {
      const toolHint = consecutiveCheck.tool === "ask_user"
        ? "ask_user 连续调用过多。请用 extra_questions 参数把多个问题合并到一次调用中，减少对用户的打扰。先根据已有信息执行任务，需要更多信息时再合并提问。"
        : "请立即使用 read_file、list_directory、search_in_files 等工具获取实际信息，不要继续空转思考。";
      const msg = `[循环检测] 工具 ${consecutiveCheck.tool} 已连续调用 ${consecutiveCheck.count} 次。${toolHint}`;
      const errResult: ToolErrorResult = { type: ToolErrorType.LoopDetected, tool: toolName, message: msg, recoverable: true };
      this.addStep({ type: "error", content: msg, toolName, timestamp: Date.now() });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return { outputStr: msg, error: msg, errorResult: errResult };
    }

    const cacheKey = `${toolName}::${JSON.stringify(toolParams)}`;
    const cachedResult = this.successfulCallCache.get(cacheKey);
    if (cachedResult) {
      const hint = `[重复调用拦截] 该工具已用相同参数成功执行过，以下是上次的结果（无需再次调用）:\n${cachedResult}\n\n请直接基于此结果回答用户问题，不要再调用同一工具。`;
      this.addStep({ type: "observation", content: hint, toolName, toolOutput: cachedResult, timestamp: Date.now() });
      this.recordTrajectory({ type: "tool_result", toolName, result: "(cached)", durationMs: 0 });
      return { outputStr: hint };
    }

    const isDangerous =
      !!tool.dangerous ||
      !!this.config.dangerousToolPatterns?.some((p) =>
        toolName.toLowerCase().includes(p.toLowerCase()),
      );
    if (isDangerous && this.config.confirmDangerousAction) {
      const dangerousKey = `${toolName}::${JSON.stringify(toolParams)}`;
      if (this.approvedDangerousKeys.has(dangerousKey)) {
        this.addStep({ type: "observation", content: "已自动放行（同参数已确认过）", toolName, timestamp: Date.now() });
      } else {
        this.addStep({ type: "observation", content: `等待用户确认执行 ${toolName}`, toolName, timestamp: Date.now() });
        const confirmed = await this.config.confirmDangerousAction(toolName, toolParams);
        if (!confirmed) {
          this.addStep({ type: "observation", content: "用户拒绝执行此操作", toolName, timestamp: Date.now() });
          return { outputStr: "用户拒绝执行此操作", rejected: true };
        }
        this.approvedDangerousKeys.add(dangerousKey);
        this.addStep({ type: "observation", content: "用户已确认执行此操作", toolName, timestamp: Date.now() });
      }
    }

    if (signal?.aborted) throw new Error("Aborted");
    try {
      const output = await this.executeWithTimeout(tool, toolParams, signal);
      if (signal?.aborted) throw new Error("Aborted");

      const hasToolError = output && typeof output === "object" && "error" in output && typeof (output as Record<string, unknown>).error === "string";
      if (hasToolError) {
        this.loopDetector.recordFailure(toolName);
      } else {
        this.loopDetector.recordSuccess(toolName);
        this.config.onToolExecuted?.(toolName);
      }

      const quickAnswer = this.buildQuickAnswerFromTool(userInput, toolName, output);
      if (quickAnswer) {
        this.addStep({ type: "answer", content: quickAnswer, timestamp: Date.now() });
        this.recordTrajectory({ type: "tool_result", toolName, result: "(quick_answer)", durationMs: Date.now() - startTime });
        return { outputStr: "", quickAnswer };
      }

      const rawStr = typeof output === "string" ? output : JSON.stringify(output, null, 2);
      const outputStr = truncateToolOutput(rawStr, toolName);

      if (!hasToolError) {
        this.successfulCallCache.set(cacheKey, outputStr);
        // LRU eviction: drop oldest entries when exceeding max size
        if (this.successfulCallCache.size > ReActAgent.CALL_CACHE_MAX_SIZE) {
          const firstKey = this.successfulCallCache.keys().next().value;
          if (firstKey !== undefined) this.successfulCallCache.delete(firstKey);
        }
      }

      this.addStep({ type: "observation", content: outputStr, toolName, toolOutput: output, timestamp: Date.now() });
      this.recordTrajectory({ type: "tool_result", toolName, result: outputStr.slice(0, 200), durationMs: Date.now() - startTime });
      return { outputStr };
    } catch (e) {
      if ((e as Error).message === "Aborted") throw e;
      if (e instanceof ClarificationInterrupt) throw e;
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

  private buildSystemPrompt(userInput?: string): string {
    const s = this.buildSharedPromptSections(userInput);

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
    const disabledSection = s.disabledHint ? `\n\n${s.disabledHint}` : "";

    const codingHint = s.isCoding ? `## 编程任务工作流
1. 理解需求 → 2. 用 read_file / search_in_files 探索代码 → 3. 复现问题 → 4. 定位根因 → 5. 用 str_replace_edit 修改 → 6. 用 run_lint 验证 → 7. 总结
- 修改文件优先用 str_replace_edit，创建新文件用 str_replace_edit(create)
- 输出被截断时用 read_file_range 分段读取` : "";

    const identityAndRules = `${s.identityBlock}
你是一个高能力智能助手 Agent，使用 ReAct (Reasoning + Acting) 框架来自主回答问题和执行复杂任务。${modeHint}${disabledSection}

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
5. **工具返回成功结果后，禁止用相同参数再次调用同一工具**
6. 如果信息不足但可推断，做合理假设并继续
7. **严禁在 Final Answer 中向用户提问**。需要信息时必须用 ask_user 工具
8. ask_user **最多调用 2 次**，第一次就用 extra_questions 把所有问题问完
9. **严禁在 Final Answer 中写工具调用**，必须用 Action/Action Input 格式真正调用
10. **所有文件路径必须使用绝对路径**
11. **sequential_thinking 仅用于梳理复杂逻辑，禁止连续调用超过 3 次**

${s.modeSwitching}

${s.taskStrategy}

用中文回答`;

    const sections: PromptSection[] = [
      { name: "identity_rules", content: identityAndRules, priority: 10 },
      { name: "extraSystem", content: s.extraSystemBlock, priority: 20, maxTokens: 500 },
      { name: "codingBlock", content: codingHint, priority: 30, maxTokens: 400 },
      { name: "skills", content: s.skillsBlock, priority: 40, maxTokens: 600 },
      { name: "memory", content: s.memoryBlock ? `- **记住偏好**: 发现用户明确偏好时，用 save_user_memory 工具记录${s.memoryBlock}` : "", priority: 50, maxTokens: 400 },
      { name: "codingHint", content: s.codingHintBlock, priority: 60, maxTokens: 500 },
    ];

    const budget = this.config.contextBudget ?? 0;
    const result = applyContextBudget(sections, budget);
    return result.sections.map((sec) => sec.content).join("\n\n");
  }

  private buildTextConversation(userInput?: string): {
    role: "system" | "user" | "assistant";
    content: string;
    images?: string[];
  }[] {
    const messages: {
      role: "system" | "user" | "assistant";
      content: string;
      images?: string[];
    }[] = [{ role: "system", content: this.buildSystemPrompt(userInput) }];

    if (this.config.contextMessages?.length) {
      for (const cm of this.config.contextMessages) {
        messages.push({ role: cm.role, content: cm.content });
      }
    }

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
      result.actionInput = parseToolCallArguments(inputMatch[1]).params;
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

    const pushThinking = (force = false) => {
      const current = accumulated.trim();
      if (!current) return;
      if (!force && current.length <= lastPushedLen + 10) return;

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
        const merged = mergeStreamChunk(accumulated, chunk);
        accumulated = merged.full;
        pushThinking(merged.mode === "reset");
      },
      onDone: (full) => {
        accumulated = full;
      },
    });

    if (signal?.aborted) throw new Error("Aborted");
    return accumulated;
  }

  // ── Function Calling 模式（优先方案） ──

  /**
   * 从用户输入和对话历史中检测当前是否为编程相关任务，
   * 避免在纯 Q&A / 翻译 / 总结等场景中注入编程指令。
   */
  private detectCodingContext(userInput: string): boolean {
    const strongPatterns = /(?:代码|编程|编码|修复|debug|fix\b|bug|重构|refactor|编译|compile|str_replace_edit|read_file|write_file|run_lint|persistent_shell|json_edit|search_in_files|代码审查|code review|package\.json|tsconfig|Cargo\.toml|requirements\.txt)/i;
    if (strongPatterns.test(userInput)) return true;
    const weakPatterns = [
      /(?:写一个|实现|创建)/i, /(?:函数|function|class|组件|component|接口|interface)/i,
      /(?:构建|部署|deploy|测试|test|脚本|script)/i, /(?:数据库|database|SQL|迁移|migration)/i,
      /(?:npm|yarn|pip|cargo)/i, /(?:git|commit|merge|branch|PR|pull request)/i,
      /(?:\.py|\.ts|\.js|\.rs|\.go|\.java|\.cpp|\.vue)\b/i, /(?:API|build)\b/i,
      /(?:项目路径|工作上下文)/i,
    ];
    const weakCount = weakPatterns.filter((p) => p.test(userInput)).length;
    if (weakCount >= 2) return true;
    const recentHistory = this.history.slice(-6);
    const codingTools = new Set(["str_replace_edit", "write_file", "json_edit", "run_lint", "persistent_shell", "read_file", "read_file_range", "search_in_files", "list_directory", "ckg_search_function", "ckg_search_class"]);
    for (const step of recentHistory) {
      if (step.type === "action" && step.toolName && codingTools.has(step.toolName)) return true;
    }
    return false;
  }

  /**
   * 两种模式共享的 prompt 段落和决策。
   * FC / Text builder 各自从此取用，避免重复。
   */
  private buildSharedPromptSections(userInput?: string) {
    const identityBlock = this.config.roleOverride
      ? `${this.config.roleOverride}\n禁止自称 Claude、GPT 或任何第三方厂商的助手。`
      : `你是 51ToolBox 内置的智能助手 Agent。禁止自称 Claude、GPT 或任何第三方厂商的助手。被问"你是谁"时，回答：你是 51ToolBox 内置助手。`;

    const disabledTools = this.loopDetector.getDisabledTools();
    const disabledHint = disabledTools.length > 0
      ? `已禁用的工具（连续失败过多）: ${disabledTools.join(", ")} — 请改用其他方式。`
      : "";

    const isCoding = !this.config.skipInternalCodingBlock && userInput
      ? this.detectCodingContext(userInput) : false;

    const modeSwitching = `## 模式切换
- 面对复杂任务时，可先调用 enter_plan_mode 进入只读分析模式，收集信息和制定方案
- 方案确定后调用 exit_plan_mode 切回执行模式进行实际操作`;

    const taskStrategy = `## 复杂任务处理策略
1. **任务分解**：遇到复杂任务时，先在内部将其拆分为多个子步骤，按顺序逐步完成
2. **深度推理**：每一步执行前，先分析当前已知信息和目标的差距，选择最有效的工具
3. **信息收集优先**：在给出结论前，先充分收集必要信息（读文件、搜索、查询系统状态等）
4. **结果验证**：完成关键操作后，通过读取或查询验证结果是否正确
5. **错误恢复**：工具失败时分析根因，尝试替代方案而非简单重试`;

    const codingBlock = isCoding ? `## 编程任务工作流（7 步法）
当任务涉及代码编写、修改、调试时，遵循以下流程：
1. **理解需求**：仔细分析任务目标，明确要修改什么、为什么修改
2. **探索代码**：用 read_file / read_file_range / search_in_files / list_directory 了解项目结构和相关代码
3. **复现问题**（如适用）：用 run_shell_command 运行测试或复现 bug，确认当前行为
4. **定位根因**：基于探索结果分析问题根源，用 sequential_thinking 梳理复杂逻辑
5. **实施修改**：优先使用 str_replace_edit（精确替换）修改代码，仅在创建全新文件时使用 write_file
6. **验证结果**：修改后用 read_file_range 确认改动正确，用 run_lint 检查语法/类型错误，用 run_shell_command 运行测试/构建验证
7. **总结输出**：简要说明做了什么改动、为什么这样改、验证结果如何

### 编程工具选择指南
- **修改已有文件** → str_replace_edit (command: str_replace)：只需提供要改的那一小段，精确安全
- **在文件中插入代码** → str_replace_edit (command: insert)：在指定行号后插入
- **创建新文件** → str_replace_edit (command: create)：防止误覆盖已有文件
- **完全重写文件** → write_file：仅在需要全量替换时使用
- **编辑 JSON 配置** → json_edit：精确修改 JSON 字段，避免全文覆写出错
- **代码检查** → run_lint：修改代码后检查语法/类型错误，自动检测项目类型
- **执行命令** → persistent_shell（保持会话状态）或 run_shell_command（一次性命令）

### 输出被截断时的恢复策略
如果工具返回的内容被截断（出现"已省略"提示），不要猜测被省略的内容：
- 文件内容被截断 → 用 read_file_range 指定行号范围读取具体部分
- 搜索结果被截断 → 用 search_in_files 缩小搜索范围或添加 file_pattern 过滤
- 命令输出被截断 → 用 run_shell_command 配合 grep/head/tail 过滤输出` : "";

    const skillsBlock = this.config.skillsPrompt || "";
    const memoryBlock = this.config.userMemoryPrompt || "";
    const extraSystemBlock = this.config.extraSystemPrompt || "";
    const codingHintBlock = this.config.codingHint || "";

    return {
      identityBlock,
      disabledHint,
      isCoding,
      codingBlock,
      modeSwitching,
      taskStrategy,
      skillsBlock,
      memoryBlock,
      extraSystemBlock,
      codingHintBlock,
    };
  }

  private buildFCSystemPrompt(userInput?: string): string {
    const s = this.buildSharedPromptSections(userInput);

    const modeHint = this.mode === "plan"
      ? `\n\n## 当前模式: Plan（只读分析）\n你正处于 Plan 模式，只能使用只读工具（信息收集、搜索、读取）。不能执行修改操作。\n完成分析后调用 exit_plan_mode 切换到 Execute 模式再执行修改。`
      : "";
    const disabledSection = s.disabledHint ? `\n\n## ${s.disabledHint}` : "";

    const identityAndRules = `${s.identityBlock}
你是一个高能力智能助手 Agent，能够自主使用工具来回答问题和执行复杂任务。${modeHint}${disabledSection}

## 核心行为
- 收到任务后立即开始执行，尽量自主完成
- 如果信息不足但可以合理推断，直接假设并继续
- **严禁在回复文本中向用户提问**。需要用户输入时，必须调用 ask_user 工具（会弹出交互对话框让用户选择/输入）
- 以下情况必须调用 ask_user 工具：
  · 任务目标模糊（如"帮我处理文件"但未指定哪个文件）
  · 有多个合理方案需要用户选择（如保存格式、目标路径）
  · 操作不可逆且影响范围不明确（如批量删除、覆盖文件）
  · 缺少必要的参数（如收件人、密码、具体日期等）
- **ask_user 最多调用 2 次**。第一次调用时用 extra_questions 参数把所有相关问题合并到一次调用中
- 获得用户回答后立即执行任务，不要反复追问。如果用户回答不够详细，基于合理推断继续
- 用中文回答

${s.modeSwitching}

${s.taskStrategy}

## 工具使用规则
- 需要工具时直接调用，**严禁在回复文本中写出工具调用**（如"调用工具: web_search(...)"），必须通过 function call 真正执行
- 仔细分析工具返回结果再决定下一步
- **工具返回成功结果后，禁止用相同参数再次调用同一工具**。结果已经拿到了，直接使用它来回答
- 不要在没有使用工具的情况下编造信息
- 涉及文件操作时，必须调用对应工具
- 如有 delegate_subtask 工具可用，可将独立子问题委派给子 Agent 并行处理
- **所有文件路径必须使用绝对路径**，不要使用 ~ 或相对路径
- **sequential_thinking 仅用于梳理复杂逻辑，禁止连续调用超过 3 次**

## 回答质量
- 结论必须基于真实的工具调用结果
- 多角度分析问题，给出全面的答案
- 如果任务有多种可行方案，简要说明各方案优劣`;

    const sections: PromptSection[] = [
      { name: "identity_rules", content: identityAndRules, priority: 10 },
      { name: "extraSystem", content: s.extraSystemBlock, priority: 20, maxTokens: 500 },
      { name: "codingBlock", content: s.codingBlock, priority: 30, maxTokens: 800 },
      { name: "skills", content: s.skillsBlock, priority: 40, maxTokens: 600 },
      { name: "memory", content: s.memoryBlock ? `- 发现用户有明确偏好或习惯时，使用 save_user_memory 工具记录${s.memoryBlock}` : "", priority: 50, maxTokens: 400 },
      { name: "codingHint", content: s.codingHintBlock, priority: 60, maxTokens: 500 },
    ];

    const budget = this.config.contextBudget ?? 0;
    const result = applyContextBudget(sections, budget);
    return result.sections.map((sec) => sec.content).join("\n\n");
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
    let thinkingAccum = "";
    let thinkingStartedAt = 0;
    let toolArgsAccum = "";
    let toolArgsStartedAt = 0;
    let lastToolArgsPushedLen = 0;

    const result = await this.ai.streamWithTools!({
      messages,
      tools: toolDefs,
      signal,
      modelOverride: this.config.modelOverride,
      thinkingLevel: this.config.thinkingLevel,
      onChunk: (chunk) => {
        if (signal?.aborted) return;
        const merged = mergeStreamChunk(accumulated, chunk);
        accumulated = merged.full;
        const current = accumulated.trim();
        if (current && (merged.mode === "reset" || current.length > lastPushedLen + 10)) {
          this.onStep?.({
            type: "answer",
            content: current,
            timestamp: Date.now(),
            streaming: true,
          });
          this.lastStreamingAnswer = current;
          lastPushedLen = current.length;
        }
      },
      onDone: (full) => {
        accumulated = full;
      },
      onThinking: (chunk) => {
        if (signal?.aborted) return;
        if (!thinkingStartedAt) thinkingStartedAt = Date.now();
        thinkingAccum = mergeStreamChunk(thinkingAccum, chunk).full;
        this.onStep?.({
          type: "thinking",
          content: thinkingAccum || " ",
          timestamp: thinkingStartedAt,
          streaming: true,
        });
      },
      onToolArgs: (chunk) => {
        if (signal?.aborted) return;
        if (!toolArgsStartedAt) toolArgsStartedAt = Date.now();
        const merged = mergeStreamChunk(toolArgsAccum, chunk);
        toolArgsAccum = merged.full;

        if (toolArgsAccum && (merged.mode === "reset" || toolArgsAccum.length > lastToolArgsPushedLen + 5)) {
          this.onStep?.({
            type: "tool_streaming",
            content: toolArgsAccum || " ",
            timestamp: toolArgsStartedAt,
            streaming: true,
          });
          lastToolArgsPushedLen = toolArgsAccum.length;
        }
      },
    });

    if (signal?.aborted) throw new Error("Aborted");
    if (thinkingAccum) {
      this.onStep?.({
        type: "thinking",
        content: thinkingAccum,
        timestamp: thinkingStartedAt || Date.now(),
        streaming: false,
      });
    }
    if (toolArgsAccum) {
      this.onStep?.({
        type: "tool_streaming",
        content: toolArgsAccum,
        timestamp: toolArgsStartedAt || Date.now(),
        streaming: false,
      });
    }
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
    return `${userInput}\n\n[系统引导] 这是一个需要多步执行的复杂任务。请先制定简要的执行计划，明确：\n1. 需要分几步完成\n2. 每步使用什么工具（可用: ${toolNames.join(", ")}）\n3. 各步骤之间的依赖关系\n然后按计划逐步执行，直接开始行动。`;
  }

  /**
   * Function Calling 模式的执行循环
   */
  private async runFC(userInput: string, signal?: AbortSignal, images?: string[]): Promise<string> {
    type FCMessage = {
      role: string;
      content: string | null;
      images?: string[];
      tool_calls?: AIToolCall[];
      tool_call_id?: string;
      name?: string;
    };

    const messages: FCMessage[] = [
      { role: "system", content: this.buildFCSystemPrompt(userInput) },
    ];

    if (this.config.contextMessages?.length) {
      for (const cm of this.config.contextMessages) {
        messages.push({ role: cm.role, content: cm.content });
      }
    }

    if (this.history.length > 0) {
      const historyParts: string[] = [];
      for (const step of this.history) {
        if (step.type === "action") {
          historyParts.push(`[执行] ${step.toolName}(${step.toolInput ? JSON.stringify(step.toolInput) : ""})`);
        } else if (step.type === "observation") {
          const obs = step.content.length > 300 ? step.content.slice(0, 300) + "..." : step.content;
          historyParts.push(`[结果] ${obs}`);
        } else if (step.type === "answer") {
          historyParts.push(`[回答] ${step.content}`);
        }
      }
      if (historyParts.length > 0) {
        messages.push({ role: "user", content: `[历史执行记录]\n${historyParts.join("\n")}` });
        messages.push({ role: "assistant", content: "好的，我已了解之前的执行历史，继续处理当前任务。" });
      }
    }

    const isComplex = this.isComplexQuery(userInput) && this.history.length === 0;
    const effectiveInput = isComplex ? this.buildPlanningHint(userInput) : userInput;
    const lastUserMsg: FCMessage = { role: "user", content: effectiveInput };
    if (images?.length) lastUserMsg.images = images;
    messages.push(lastUserMsg);

    let unknownToolCount = 0;
    let rejectedDangerousActionCount = 0;
    let guardRailRetryCount = 0;
    const MAX_GUARD_RAIL_RETRIES = 2;
    const toolFailCounts = new Map<string, number>();

    let iterationWarningIdx = -1;
    let fcEmptyCount = 0;
    let lastDisabledKey = this.loopDetector.getDisabledTools().join(",");
    let lastMode = this.mode;

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (signal?.aborted) throw new Error("Aborted");

      // Actor inbox 注入点：在每个 iteration 间隙检查是否有新消息
      if (this.config.inboxDrain) {
        const pending = this.config.inboxDrain();
        if (pending.length > 0) {
          const inboxBlock = pending.map((m) => {
            const replyHint = m.expectReply
              ? `（等待你的回复，请用 send_message 回复，reply_to 填 "${m.id}"）`
              : "";
            return `[消息来自 ${m.from}（消息ID: ${m.id}）${replyHint}]: ${m.content}`;
          }).join("\n");
          const hasAgentMsg = pending.some((m) => m.from !== "用户" && m.from !== "user");
          const replyGuide = hasAgentMsg
            ? "如果有其他 Agent 的消息需要回应，使用 send_message 回复。然后继续当前任务。"
            : "请根据消息内容继续当前任务。";
          messages.push({
            role: "user",
            content: `[收件箱 — 你在执行任务期间收到了新消息]\n${inboxBlock}\n\n${replyGuide}`,
          });
        }
      }

      // 仅在模式切换或 doom loop 禁用工具后才重建 system prompt
      if (i > 0) {
        const currentDisabled = this.loopDetector.getDisabledTools().join(",");
        const disabledChanged = currentDisabled !== (lastDisabledKey ?? "");
        const modeChanged = this.mode !== lastMode;
        if (disabledChanged || modeChanged) {
          messages[0] = { role: "system", content: this.buildFCSystemPrompt(userInput) };
          lastDisabledKey = currentDisabled;
          lastMode = this.mode;
        }
      }

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
        fcEmptyCount++;
        if (fcEmptyCount >= 3) {
          const fallback = this.buildIterationExhaustedSummary();
          this.addStep({ type: "answer", content: fallback, timestamp: Date.now() });
          return fallback;
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
        const { params: toolParams, parseError } = parseToolCallArguments(tc.function.arguments || "{}");
        return { tc, toolName: tc.function.name, toolParams, parseError };
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
        if (toolName === "ask_clarification") return false;
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
          parsedCalls.map(async ({ tc, toolName, toolParams, parseError }): Promise<CallResult> => ({
            tc,
            toolName,
            result: parseError
              ? {
                  outputStr: parseError,
                  error: parseError,
                  errorResult: {
                    type: ToolErrorType.ParseError,
                    tool: toolName,
                    message: parseError,
                    recoverable: true,
                  },
                }
              : await this.executeToolPipeline(toolName, toolParams, userInput, signal),
          })),
        );
      } else {
        callResults = [];
        for (const { tc, toolName, toolParams, parseError } of parsedCalls) {
          callResults.push({
            tc,
            toolName,
            result: parseError
              ? {
                  outputStr: parseError,
                  error: parseError,
                  errorResult: {
                    type: ToolErrorType.ParseError,
                    tool: toolName,
                    message: parseError,
                    recoverable: true,
                  },
                }
              : await this.executeToolPipeline(toolName, toolParams, userInput, signal),
          });
        }
      }
      let quickAnswerFound: string | undefined;

      messages.push({ role: "assistant", content: null, tool_calls: callResults.map((r) => r.tc) });

      let taskDoneResult: string | undefined;
      /** task_done params.summary（纯文本，比 JSON outputStr 更适合展示） */
      let taskDoneSummary: string | undefined;

      for (const { tc, toolName, result: pipelineResult } of callResults) {
        if (pipelineResult.quickAnswer && !quickAnswerFound) {
          quickAnswerFound = pipelineResult.quickAnswer;
        }
        if (pipelineResult.rejected) rejectedDangerousActionCount++;

        if (toolName === "task_done") {
          taskDoneResult = pipelineResult.outputStr || "任务已完成。";
          // 尝试从工具调用参数中提取 summary 文本（人类可读，非 JSON）
          try {
            const doneParams = parseToolCallArguments(tc.function.arguments || "{}").params as { summary?: string };
            if (doneParams.summary) taskDoneSummary = doneParams.summary.trim();
          } catch { /* ignore */ }
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
        // 优先级：① 已记录的 answer 步骤 → ② 流式累积的完整文档 → ③ task_done.summary 文本 → ④ 原始 outputStr JSON
        const answer =
          lastAnswerStep?.content ||
          (this.lastStreamingAnswer.length > 50 ? this.lastStreamingAnswer : undefined) ||
          taskDoneSummary ||
          taskDoneResult;
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

  private async runText(userInput: string, signal?: AbortSignal, images?: string[]): Promise<string> {
    const messages = this.buildTextConversation(userInput);
    const isComplex = this.isComplexQuery(userInput) && this.history.length === 0;
    const effectiveTextInput = isComplex ? this.buildPlanningHint(userInput) : userInput;
    const userMsg: { role: "user"; content: string; images?: string[] } = { role: "user", content: effectiveTextInput };
    if (images?.length) userMsg.images = images;
    messages.push(userMsg);
    let rejectedDangerousActionCount = 0;
    let guardRailRetryCount = 0;
    const MAX_GUARD_RAIL_RETRIES = 2;
    const textToolFailCounts = new Map<string, number>();

    let textIterationWarningIdx = -1;
    let prevResponseContent = "";
    let staleCount = 0;

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

      const trimmed = responseContent.trim();
      const prevTrimmed = prevResponseContent.trim();
      const compareLen = Math.min(300, trimmed.length, prevTrimmed.length);
      const isSimilar = compareLen > 20 &&
        trimmed.slice(0, compareLen) === prevTrimmed.slice(0, compareLen);
      if (isSimilar) {
        staleCount++;
        if (staleCount >= 2) {
          this.addStep({ type: "answer", content: trimmed, timestamp: Date.now() });
          return trimmed;
        }
      } else {
        staleCount = 0;
      }
      prevResponseContent = responseContent;

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
   * 只有在明确确认 FC 不兼容时才降级为文本 ReAct。
   */
  async run(userInput: string, signal?: AbortSignal, images?: string[]): Promise<string> {
    if (this.running) throw new Error("Agent is already running");
    this.running = true;
    this.currentSignal = signal;
    this.steps = [];
    this.trajectory = [];
    this.lastStreamingAnswer = "";
    this.loopDetector.reset();
    this.approvedDangerousKeys.clear();
    this.successfulCallCache.clear();
    this.mode = this.config.initialMode ?? "execute";

    try {
    // 判断是否可以使用 Function Calling
    const canUseFC =
      !this.config.forceTextMode &&
      typeof this.ai.streamWithTools === "function";

    if (canUseFC && this.fcAvailable !== false) {
      try {
        const result = await this.runFC(userInput, signal, images);
        this.fcAvailable = true; // 当前实例标记 FC 可用
        return result;
      } catch (e) {
        if ((e as Error).message === "Aborted") throw e;

        const errMsg = (e as Error).message || "";
        const isFCIncompatible = isFCCompatibilityErrorMessage(errMsg);
        const isTransportOrTimeoutError = isTransportOrTimeoutErrorMessage(
          errMsg,
        );
        const shouldDowngrade = isFCIncompatible;

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
          this.addStep({
            type: "observation",
            content: "Function Calling 模式不可用，已自动切换至文本 ReAct 模式。",
            timestamp: Date.now(),
          });
          const prevMaxIterations = this.config.maxIterations;
          this.config.maxIterations = Math.min(prevMaxIterations, 6);
          try {
            return await this.runText(userInput, signal, images);
          } finally {
            this.config.maxIterations = prevMaxIterations;
          }
        }
        if (!isTransportOrTimeoutError) {
          handleError(e, {
            context: "ReAct Agent Function Calling 执行失败（保留结构化模式）",
            level: ErrorLevel.Warning,
            silent: true,
          });
        }
        throw e;
      }
    }

    // 文本 ReAct 模式
    return this.runText(userInput, signal, images);
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
