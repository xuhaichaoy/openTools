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
import type { ExecutionPolicy, LoopDetectionConfig, ThinkingLevel } from "@/core/agent/actor/types";
import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import type { PluginAction } from "@/core/plugin-system/plugin-interface";
import {
  applyContextBudget,
  type PromptSection,
} from "@/core/agent/context-budget";
import { mergeStreamChunk } from "@/core/ai/stream-chunk-merge";
import { parseToolCallArguments } from "./tool-call-arguments";
import {
  hasArtifactPayloadKey,
  parsePartialToolJSON,
} from "./tool-streaming-preview";

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
  /**
   * 原始 JSON Schema（如 MCP input_schema）。
   * 若提供，toolToFunctionDef 会直接透传给模型，
   * 跳过 parameters → JSON Schema 的有损转换。
   */
  rawParametersSchema?: Record<string, unknown>;
  /** 标记为高风险工具，执行前会触发确认弹窗 */
  dangerous?: boolean;
  /** 标记为只读工具（不产生副作用），可安全并行执行 */
  readonly?: boolean;
  /** 单工具执行超时（毫秒），不设则无超时 */
  timeout?: number;
  execute: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export interface AgentStep {
  type:
    | "thought"
    | "action"
    | "observation"
    | "answer"
    | "error"
    | "thinking"
    | "tool_streaming"
    | "checkpoint";
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

export const WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT = "__WAIT_FOR_SPAWNED_TASKS_DEFERRED__";

export class WaitForSpawnedTasksInterrupt extends Error {
  readonly snapshot?: Record<string, unknown>;
  readonly summary?: string;

  constructor(snapshot?: Record<string, unknown>) {
    super("wait_for_spawned_tasks_deferred");
    this.name = "WaitForSpawnedTasksInterrupt";
    this.snapshot = snapshot;
    this.summary = typeof snapshot?.summary === "string" ? snapshot.summary : undefined;
  }
}

function shouldEmitToolStreamingPreview(rawContent: string): boolean {
  const parsed = parsePartialToolJSON(rawContent);
  if (parsed.thought.trim()) return true;
  if (parsed.targetAgent.trim() && parsed.task.trim()) return true;
  return Boolean(
    parsed.path.trim()
      && (parsed.content.trim() || hasArtifactPayloadKey(rawContent)),
  );
}

export interface AgentConfig {
  maxIterations: number;
  temperature: number;
  verbose: boolean;
  /** 完整调试用：把关键 LLM / tool 边界事件回传给上层 */
  onTraceEvent?: (event: string, detail?: Record<string, unknown>) => void;
  /** 危险操作确认回调，返回 true 则继续执行，false 则取消 */
  confirmDangerousAction?: (
    toolName: string,
    params: Record<string, unknown>,
    context?: DangerousActionConfirmationContext,
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
  inboxDrain?: () => {
    id: string;
    from: string;
    content: string;
    expectReply?: boolean;
    replyTo?: string;
    images?: string[];
  }[];
  /** 对话历史上下文：作为多轮 messages 注入（system 之后、当前 query 之前），用于 Actor 会话连续性 */
  contextMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 将传入工具列表视为最终真相，禁止自动注入 delegate_subtask / enter_plan_mode / exit_plan_mode */
  authoritativeToolList?: boolean;
  /** 在送模型前修补历史中缺失的 tool result，避免 dangling tool_calls 污染消息格式 */
  patchDanglingToolCalls?: boolean;
  /** 运行时 loop guardrail 配置 */
  loopDetection?: LoopDetectionConfig;
}

export interface DangerousActionConfirmationContext {
  actorId?: string;
  executionPolicy?: ExecutionPolicy;
  workspace?: string;
}

type IterationStopReason =
  | "iteration_limit_reached"
  | "repeated_tool_calls"
  | "empty_model_output";

interface IterationStopDiagnostics {
  iterationsUsed: number;
  stopReason: IterationStopReason;
  repeatedToolPattern?: string;
}

const EMPTY_MODEL_OUTPUT_LIMIT = 3;

function formatIterationStopReason(reason: IterationStopReason): string {
  switch (reason) {
    case "repeated_tool_calls":
      return "连续 2 轮 tool_calls 计划完全相同";
    case "empty_model_output":
      return `连续 ${EMPTY_MODEL_OUTPUT_LIMIT} 轮模型未返回有效内容`;
    default:
      return "已达到迭代上限";
  }
}

function formatIterationStopHeadline(
  reason: IterationStopReason,
  maxIterations: number,
): string {
  switch (reason) {
    case "repeated_tool_calls":
      return `执行已提前停止：检测到连续重复的 tool_calls 计划（最大 ${maxIterations} 步）。`;
    case "empty_model_output":
      return `执行已提前停止：模型连续未返回有效内容（最大 ${maxIterations} 步）。`;
    default:
      return `已达到最大执行步数（${maxIterations} 步）。`;
  }
}

function formatRepeatedToolPattern(
  toolCalls: AIToolCall[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const toolCall of toolCalls) {
    const name = toolCall.function.name?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(", ");
}

function buildRepeatedToolCallCorrectionMessage(toolPattern?: string): string {
  return [
    "[系统提示] 你刚刚连续两轮提出了完全相同的 tool_calls 计划。",
    toolPattern ? `连续重复计划：${toolPattern}` : "",
    "不要再次提交完全相同的 tool_calls 计划。",
    "请先基于当前已有结果说明卡点在哪里。",
    "如果还要继续，必须至少改变其中一项：工具、参数、目标对象，或直接给出结论。",
    "若这是有副作用的工具（如创建页面、写文件、发请求），默认视为上一次已经生效，不要盲目重试。",
    "如果工具执行失败或超时，请尝试以下替代方案之一：",
    "1. 换用更简单的参数或更小的数据量重试",
    "2. 拆分为多个小步骤分别完成",
    "3. 在 answer 中直接说明无法完成的原因和已取得的部分成果",
  ]
    .filter(Boolean)
    .join("\n");
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 10,
  temperature: 0.7,
  verbose: true,
};

function previewTraceValue(
  value: unknown,
  maxLength = 80,
): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

// ── MCP 参数自动推断 ──

const URL_PATTERN = /https?:\/\/[^\s"'<>\u3000\u3001\u3002\uff01\uff0c\uff1b]+/;
const FILE_PATH_PATTERN = /(?:\/[\w.-]+){2,}|[A-Z]:\\[\w.-\\]+/;

/**
 * 从用户输入中推断 MCP 工具缺失的必填参数值。
 * 仅处理高置信度场景（URL、文件路径、搜索关键词），避免误填。
 */
function inferMcpParamFromUserInput(
  paramKey: string,
  paramDesc: string,
  userInput: string,
): string | null {
  // URL 类参数
  if (
    paramKey === "url" ||
    paramDesc.includes("url") ||
    paramDesc.includes("navigate")
  ) {
    const match = userInput.match(URL_PATTERN);
    if (match) return match[0];
  }
  // 文件路径类参数
  if (
    paramKey === "path" ||
    paramKey === "filepath" ||
    paramKey === "file_path" ||
    paramDesc.includes("file") ||
    paramDesc.includes("path")
  ) {
    const match = userInput.match(FILE_PATH_PATTERN);
    if (match) return match[0];
  }
  // 搜索 / 查询类参数：提取引号中的内容或 URL 去除后的关键文本
  if (
    paramKey === "query" ||
    paramKey === "search" ||
    paramKey === "keyword" ||
    paramDesc.includes("search") ||
    paramDesc.includes("query")
  ) {
    // 先尝试提取引号中的内容
    const quotedMatch = userInput.match(/["'「」""]([^"'「」""]+)["'「」""]/);
    if (quotedMatch) return quotedMatch[1].trim();
    // 去掉命令前缀，取核心文本
    const cleaned = userInput
      .replace(/^.*?(?:搜索|查询|查找|search|query|find)\s*/i, "")
      .replace(URL_PATTERN, "")
      .trim();
    if (cleaned.length > 0 && cleaned.length <= 200) return cleaned;
  }
  return null;
}

/** 仅缓存“不兼容 FC”的模型，避免重复探测。 */
const FC_CACHE_TTL_MS = 30 * 60 * 1000;
const FC_CACHE_MAX_SIZE = 50;
const fcIncompatibleCache = new Map<string, number>();
const MEMORY_RECALL_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
const NON_CACHEABLE_TOOLS = new Set(["wait_for_spawned_tasks"]);
const PATH_BASED_FUZZY_CACHE_TOOLS = new Set([
  "read_document",
  "read_file",
]);
const MEMORY_RECALL_QUERY_PATTERNS: RegExp[] = [
  /之前|先前|前面|上次|刚才|历史|记得|还记得|回忆|回顾/,
  /偏好|习惯|默认|常驻地|常住地|居住地|所在城市|我的城市/,
  /待办|todo|任务列表|未完成|进度|进展/,
  /决策|决定|结论|方案|约定|规则/,
  /日期|几号|哪天|何时|什么时候/,
  /人物|谁|联系人|用户信息|背景/,
];

function extractPrimaryUserIntent(input: string): string {
  const normalized = String(input || "").trim();
  if (!normalized) return "";

  const wrappedUserBlock = normalized.match(
    /(?:^|\n)\[用户\]:\s*([\s\S]*?)(?=\n\s*\[(?:system|系统)\]:|$)/i,
  );
  if (wrappedUserBlock?.[1]) {
    return wrappedUserBlock[1].trim();
  }

  return normalized;
}

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

function extractNumericIntentTokens(input: string): string[] {
  const matches = input.match(/\b\d{3,}(?:px|rpx|rem|em|vh|vw|%)?\b/gi) ?? [];
  return [...new Set(matches.map((item) => item.toLowerCase()))];
}

function countExactTokenMatches(
  tokens: readonly string[],
  candidate?: string,
): number {
  if (!candidate || tokens.length === 0) return 0;
  const normalized = candidate.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function isFCCompatibilityErrorMessage(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  if (normalized.startsWith("FC_INCOMPATIBLE")) return true;

  return /(?:function calling|tool(?:_calls?| calling| use| choice)?).{0,48}(?:not supported|unsupported|unavailable|disabled|invalid|forbidden)|does not support.{0,48}(?:tools|tool use|function calling)|unknown parameter.{0,48}(?:tools|tool_choice)|extra inputs? are not permitted.{0,48}(?:tools|tool_choice)|tool_choice.{0,32}(?:not supported|unsupported|invalid)/i.test(
    normalized,
  );
}

function isTransportOrTimeoutErrorMessage(message: string): boolean {
  return /(timeout|timed out|超时|卡住|请求失败|网络|network|econn|socket hang up|connection reset|流读取错误|503|504|502|rate limit|overloaded|temporarily unavailable)/i.test(
    message,
  );
}

function isFirstChunkStallErrorMessage(message: string): boolean {
  return /ai_agent_stream 卡住超过/i.test(message)
    && /phase=(?:invoke_start|init)/i.test(message);
}

// ── Context 管理 ──

import { estimateTokens, estimateMessagesTokens } from "@/core/ai/token-utils";

const DEFAULT_CONTEXT_LIMIT = 100_000;
const CONTEXT_COMPACT_THRESHOLD = 0.75;
const PROCESSED_HISTORY_IMAGE_MARKER = "[历史图片已处理，无需重复发送原图]";
const TOOL_CONTEXT_TRUNCATION_NOTICE =
  "[工具输出已按上下文预算压缩，如需细节请缩小范围或重新读取目标片段]";
const TOOL_CONTEXT_COMPACTION_PLACEHOLDER =
  "[较早工具输出已移出上下文以节省空间，必要时请重新执行该工具查看详情]";
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.18;
const TOTAL_TOOL_RESULT_CONTEXT_SHARE = 0.35;
const PRESERVED_IMAGE_CONTEXT_COUNT = 1;

function summarizeDiscardedMiddle<
  T extends {
    role: string;
    content: string | null;
    tool_calls?: unknown;
    [k: string]: unknown;
  },
>(middle: T[]): string {
  const toolNames: string[] = [];
  const keyFindings: string[] = [];
  for (const m of middle) {
    if (m.role === "assistant" && m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{
        function?: { name?: string };
      }>) {
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
    parts.push(
      `已执行工具: ${unique.join(", ")} (共${toolNames.length}次调用)`,
    );
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
    const discardedGroups = toolCallGroups.slice(
      0,
      toolCallGroups.length - keepCount,
    );

    // 保留最后一条纯文本 assistant，其余 nonGroupMessages 视为可丢弃
    const keptNonGroup = new Set<T>();
    const assistantTexts = nonGroupMessages.filter(
      (m) => m.role === "assistant" && !m.tool_calls,
    );
    if (assistantTexts.length > 0)
      keptNonGroup.add(assistantTexts[assistantTexts.length - 1]);

    const discardedMessages = [
      ...discardedGroups.flat(),
      ...nonGroupMessages.filter((m) => !keptNonGroup.has(m)),
    ];
    if (discardedMessages.length > 0) {
      const summary = summarizeDiscardedMiddle(discardedMessages);
      result.push({ role: "user", content: summary } as unknown as T);
      result.push({
        role: "assistant",
        content: "好的，我已了解之前的执行历史，继续当前任务。",
      } as unknown as T);
    }

    const compactedGroups = recentGroups.map((group) =>
      group.map((m) => {
        if (m.role === "tool") {
          const content = m.content || "";
          if (content.length > 500) {
            return {
              ...m,
              content:
                content.slice(0, 200) +
                "\n... [已压缩] ...\n" +
                content.slice(-150),
            };
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

function appendContextMarker(content: string | null, marker: string): string {
  if (!content) return marker;
  if (content.includes(marker)) return content;
  return `${content}\n\n${marker}`;
}

function cloneMessages<
  T extends { role: string; content: string | null; [k: string]: unknown },
>(messages: T[]): T[] {
  return messages.map((message) => ({ ...message }));
}

function pruneProcessedHistoryImages<
  T extends {
    role: string;
    content: string | null;
    images?: string[];
    [k: string]: unknown;
  },
>(messages: T[]): T[] {
  const imageMessageIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "user" && message.images?.length) {
      imageMessageIndexes.push(i);
    }
  }

  if (imageMessageIndexes.length <= PRESERVED_IMAGE_CONTEXT_COUNT)
    return messages;

  const preservedIndexes = new Set(
    imageMessageIndexes.slice(-PRESERVED_IMAGE_CONTEXT_COUNT),
  );

  let nextMessages: T[] | null = null;
  for (const i of imageMessageIndexes) {
    if (preservedIndexes.has(i)) continue;
    if (!nextMessages) nextMessages = cloneMessages(messages);

    nextMessages[i] = {
      ...nextMessages[i],
      content: appendContextMarker(
        nextMessages[i].content,
        PROCESSED_HISTORY_IMAGE_MARKER,
      ),
    };
    delete nextMessages[i].images;
  }

  return nextMessages ?? messages;
}

function findSliceEndByTokenBudget(text: string, maxTokens: number): number {
  if (!text || maxTokens <= 0) return 0;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function findSliceStartByTokenBudget(text: string, maxTokens: number): number {
  if (!text || maxTokens <= 0) return text.length;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(mid)) <= maxTokens) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

function truncateTextToTokenBudget(
  text: string,
  maxTokens: number,
  notice: string,
): string {
  if (!text) return text;
  if (estimateTokens(text) <= maxTokens) return text;

  const normalizedBudget = Math.max(1, Math.floor(maxTokens));
  const noticeTokens = estimateTokens(notice);
  if (normalizedBudget <= noticeTokens + 8) {
    return notice;
  }

  const tailBudget = Math.max(24, Math.floor(normalizedBudget * 0.22));
  const headBudget = Math.max(24, normalizedBudget - noticeTokens - tailBudget);
  const headEnd = findSliceEndByTokenBudget(text, headBudget);
  const tailStart = findSliceStartByTokenBudget(text, tailBudget);

  const head = text.slice(0, headEnd).trimEnd();
  const tail = text.slice(tailStart).trimStart();
  let combined = [head, notice, tail].filter(Boolean).join("\n\n");

  if (estimateTokens(combined) <= normalizedBudget) return combined;

  let adjustedTailStart = tailStart;
  while (
    adjustedTailStart < text.length &&
    estimateTokens(combined) > normalizedBudget
  ) {
    adjustedTailStart = Math.min(
      text.length,
      adjustedTailStart +
        Math.max(16, Math.floor((text.length - adjustedTailStart) * 0.15)),
    );
    const nextTail = text.slice(adjustedTailStart).trimStart();
    combined = [head, notice, nextTail].filter(Boolean).join("\n\n");
  }

  if (estimateTokens(combined) <= normalizedBudget) return combined;

  const reducedHeadEnd = findSliceEndByTokenBudget(
    head,
    Math.max(16, normalizedBudget - noticeTokens),
  );
  const reducedHead = head.slice(0, reducedHeadEnd).trimEnd();
  return [reducedHead, notice].filter(Boolean).join("\n\n");
}

function buildToolContextNotice(toolName?: string): string {
  if (toolName === "read_file" || toolName === "read_text_file") {
    return `${TOOL_CONTEXT_TRUNCATION_NOTICE}，可改用 read_file_range 读取局部行段。`;
  }
  if (toolName === "search_in_files") {
    return `${TOOL_CONTEXT_TRUNCATION_NOTICE}，可缩小 query 或 file_pattern。`;
  }
  if (toolName === "run_shell_command" || toolName === "persistent_shell") {
    return `${TOOL_CONTEXT_TRUNCATION_NOTICE}，可用 grep/head/tail 先过滤结果。`;
  }
  return TOOL_CONTEXT_TRUNCATION_NOTICE;
}

function enforceToolResultContextBudget<
  T extends {
    role: string;
    content: string | null;
    name?: string;
    [k: string]: unknown;
  },
>(messages: T[], contextLimit: number): T[] {
  const threshold = Math.max(
    512,
    Math.floor(contextLimit * CONTEXT_COMPACT_THRESHOLD),
  );
  const singleToolBudget = Math.max(
    192,
    Math.floor(threshold * SINGLE_TOOL_RESULT_CONTEXT_SHARE),
  );
  const totalToolBudget = Math.max(
    singleToolBudget,
    Math.floor(threshold * TOTAL_TOOL_RESULT_CONTEXT_SHARE),
  );

  let nextMessages: T[] | null = null;
  const toolIndexes: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (
      message.role !== "tool" ||
      typeof message.content !== "string" ||
      !message.content
    )
      continue;
    toolIndexes.push(i);
    const truncated = truncateTextToTokenBudget(
      message.content,
      singleToolBudget,
      buildToolContextNotice(message.name),
    );
    if (truncated === message.content) continue;
    if (!nextMessages) nextMessages = cloneMessages(messages);
    nextMessages[i] = { ...nextMessages[i], content: truncated };
  }

  const working = nextMessages ?? messages;

  const getToolTokens = () =>
    toolIndexes.reduce((sum, index) => {
      const content = working[index]?.content;
      return sum + estimateTokens(typeof content === "string" ? content : "");
    }, 0);

  let totalTokens = estimateMessagesTokens(working);
  let totalToolTokens = getToolTokens();
  if (totalTokens <= threshold && totalToolTokens <= totalToolBudget) {
    return working;
  }

  if (!nextMessages) nextMessages = cloneMessages(messages);
  for (const index of toolIndexes) {
    const current = nextMessages[index];
    if (!current || current.role !== "tool") continue;
    const placeholder = current.name
      ? `[${current.name}] ${TOOL_CONTEXT_COMPACTION_PLACEHOLDER}`
      : TOOL_CONTEXT_COMPACTION_PLACEHOLDER;
    if (current.content === placeholder) continue;

    nextMessages[index] = { ...current, content: placeholder };
    totalTokens = estimateMessagesTokens(nextMessages);
    totalToolTokens = toolIndexes.reduce((sum, toolIndex) => {
      const content = nextMessages![toolIndex]?.content;
      return sum + estimateTokens(typeof content === "string" ? content : "");
    }, 0);
    if (totalTokens <= threshold && totalToolTokens <= totalToolBudget) {
      break;
    }
  }

  return nextMessages;
}

function prepareMessagesForModel<
  T extends {
    role: string;
    content: string | null;
    images?: string[];
    name?: string;
    [k: string]: unknown;
  },
>(messages: T[], contextLimit: number, patchDanglingToolCalls = false): T[] {
  const patched = patchDanglingToolCalls
    ? patchDanglingToolCallMessages(messages).messages
    : messages;
  const pruned = pruneProcessedHistoryImages(patched);
  const compacted = compactMessages(pruned, contextLimit);
  return enforceToolResultContextBudget(compacted, contextLimit);
}

export function patchDanglingToolCallMessages<
  T extends {
    role: string;
    content: string | null;
    tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
    tool_call_id?: string;
    name?: string;
    [k: string]: unknown;
  },
>(messages: T[]): { messages: T[]; patchCount: number } {
  const existingToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id.trim()) {
      existingToolCallIds.add(message.tool_call_id.trim());
    }
  }

  let patchCount = 0;
  const patchedToolCallIds = new Set<string>();
  const patchedMessages: T[] = [];
  for (const message of messages) {
    patchedMessages.push(message);
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      const toolCallId = String(toolCall?.id ?? "").trim();
      if (!toolCallId || existingToolCallIds.has(toolCallId) || patchedToolCallIds.has(toolCallId)) {
        continue;
      }
      patchedMessages.push({
        role: "tool",
        content: "[Tool call was interrupted and did not return a result.]",
        tool_call_id: toolCallId,
        name: String(toolCall?.function?.name ?? "unknown_tool"),
      } as T);
      patchedToolCallIds.add(toolCallId);
      patchCount += 1;
    }
  }

  return patchCount > 0
    ? { messages: patchedMessages, patchCount }
    : { messages, patchCount: 0 };
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
    recoveryHint =
      "\n<NOTE>输出已截断。请使用 read_file_range 指定 start_line/end_line 分段读取需要的部分。</NOTE>";
  } else if (toolName === "search_in_files") {
    recoveryHint =
      "\n<NOTE>搜索结果已截断。请缩小搜索范围：添加 file_pattern 过滤文件类型，或减小 max_results，或使用更精确的 query。</NOTE>";
  } else if (
    toolName === "run_shell_command" ||
    toolName === "persistent_shell"
  ) {
    recoveryHint =
      "\n<NOTE>命令输出已截断。请在命令中配合 grep/head/tail 过滤输出，或将输出重定向到文件后用 read_file_range 分段读取。</NOTE>";
  } else if (toolName === "list_directory") {
    recoveryHint =
      "\n<NOTE>目录列表已截断。请指定更深层的子目录路径来缩小范围。</NOTE>";
  } else {
    recoveryHint =
      "\n<NOTE>输出已截断。请尝试缩小请求范围以获取完整结果。</NOTE>";
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
  type:
    | "llm_call"
    | "tool_call"
    | "tool_result"
    | "mode_switch"
    | "error"
    | "reflection"
    | "answer";
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
const SYSTEM_INFO_LOG_PREFIX = "[ReActAgent][get_system_info]";
const FILE_REGEN_LOG_PREFIX = "[ReActAgent][file_regen]";
const FILE_REGEN_PARSE_LOG_PREFIX = "[ReActAgent][file_regen_parse]";
const FILE_WRITE_TOOL_NAMES = new Set([
  "write_file",
  "export_document",
  "str_replace_edit",
  "json_edit",
]);
const LOOP_DETECT_EXEMPT_TOOLS = new Set([
  "get_current_time",
  "get_system_info",
  "calculate",
  "native_calendar_list",
  "native_reminder_lists",
  "native_shortcuts_list",
  "native_app_list",
  "native_app_list_interactive",
]);

const DEFAULT_LOOP_DETECTION_CONFIG: Required<LoopDetectionConfig> = {
  windowSize: LOOP_DETECTOR_WINDOW,
  repeatThreshold: LOOP_DETECTOR_THRESHOLD,
  consecutiveFailureLimit: DOOM_LOOP_CONSECUTIVE_FAILURES,
  consecutiveSameToolLimit: SAME_TOOL_CONSECUTIVE_LIMIT,
  exemptTools: [...LOOP_DETECT_EXEMPT_TOOLS],
};

function normalizeLoopDetectionConfig(
  config?: LoopDetectionConfig,
): Required<LoopDetectionConfig> {
  return {
    ...DEFAULT_LOOP_DETECTION_CONFIG,
    ...(config ?? {}),
    exemptTools: [
      ...new Set([
        ...DEFAULT_LOOP_DETECTION_CONFIG.exemptTools,
        ...(config?.exemptTools ?? []),
      ]),
    ],
  };
}

interface FileMutationTrace {
  count: number;
  lastToolName: string;
  lastSignature: string;
}

class LoopDetector {
  private readonly config: Required<LoopDetectionConfig>;

  constructor(config: Required<LoopDetectionConfig>) {
    this.config = config;
  }

  private recentCalls: string[] = [];
  private consecutiveFailures: Map<string, number> = new Map();
  private disabledTools: Set<string> = new Set();
  private consecutiveToolCounts: Map<string, number> = new Map();
  private lastToolName: string | null = null;

  private isExempt(toolName: string): boolean {
    return this.config.exemptTools.includes(toolName);
  }

  record(toolName: string, args: Record<string, unknown>): void {
    const key = `${toolName}::${JSON.stringify(args)}`;
    this.recentCalls.push(key);
    if (this.recentCalls.length > this.config.windowSize * 2) {
      this.recentCalls = this.recentCalls.slice(-this.config.windowSize * 2);
    }

    if (toolName === this.lastToolName) {
      this.consecutiveToolCounts.set(
        toolName,
        (this.consecutiveToolCounts.get(toolName) ?? 1) + 1,
      );
    } else {
      this.consecutiveToolCounts.set(toolName, 1);
      this.lastToolName = toolName;
    }
  }

  detect(): { looping: boolean; tool?: string } {
    if (this.recentCalls.length < this.config.repeatThreshold) {
      return { looping: false };
    }
    const tail = this.recentCalls.slice(-this.config.windowSize);
    const counts = new Map<string, number>();
    for (const key of tail) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count >= this.config.repeatThreshold) {
        const toolName = key.split("::")[0];
        if (this.isExempt(toolName)) continue;
        return { looping: true, tool: toolName };
      }
    }
    return { looping: false };
  }

  detectConsecutiveSameTool(): {
    looping: boolean;
    tool?: string;
    count?: number;
  } {
    if (!this.lastToolName) return { looping: false };
    const count = this.consecutiveToolCounts.get(this.lastToolName) ?? 0;
    if (
      count >= this.config.consecutiveSameToolLimit &&
      CONSECUTIVE_LIMIT_TOOLS.has(this.lastToolName)
    ) {
      return { looping: true, tool: this.lastToolName, count };
    }
    return { looping: false };
  }

  recordFailure(toolName: string): void {
    if (this.isExempt(toolName)) return;
    const count = (this.consecutiveFailures.get(toolName) ?? 0) + 1;
    this.consecutiveFailures.set(toolName, count);
    if (count >= this.config.consecutiveFailureLimit) {
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
  // 如果工具提供了原始 JSON Schema（如 MCP input_schema），直接透传，
  // 避免 parameters → JSON Schema 的有损转换（会丢失 required/enum/default 等）。
  if (tool.rawParametersSchema) {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.rawParametersSchema,
      },
    };
  }

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
  private loopDetectionConfig = DEFAULT_LOOP_DETECTION_CONFIG;
  private loopDetector = new LoopDetector(this.loopDetectionConfig);
  private approvedDangerousKeys = new Set<string>();
  /** 缓存已成功执行的 tool+params → 输出，避免重复执行（LRU, max 200 entries） */
  private successfulCallCache = new Map<string, string>();
  private static readonly CALL_CACHE_MAX_SIZE = 200;
  private mode: AgentMode = "execute";
  private trajectory: TrajectoryEntry[] = [];
  private fileMutationTrace = new Map<string, FileMutationTrace>();
  private fileMutationParseTrace = new Map<string, number>();

  private emitTraceEvent(
    event: string,
    detail?: Record<string, unknown>,
  ): void {
    this.config.onTraceEvent?.(event, detail);
  }

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
    if (inferCodingExecutionProfile({ query: q }).profile.codingMode)
      return false;
    if (
      /网页|页面|html|代码|文件|保存|实现|生成|修复|下载|artifact|write|create|build/i.test(
        q,
      )
    ) {
      return false;
    }
    const directExpression = /^[-+*/%().\d\s=xX]+$/i.test(q);
    const askMath =
      /^(请)?(帮我)?(计算|算一下|求|evaluate|what is|是多少|等于多少)/i.test(
        q,
      ) && /[-+*/%().\d\s=xX]+/.test(q);
    return directExpression || askMath;
  }

  private getLatestAnswerSnapshot(): string {
    const streaming = this.lastStreamingAnswer.trim();
    if (streaming) return streaming;

    const currentAnswer = [...this.steps]
      .reverse()
      .find((step) => step.type === "answer" && step.content.trim());
    if (currentAnswer?.content.trim()) return currentAnswer.content.trim();

    const historyAnswer = [...this.history]
      .reverse()
      .find((step) => step.type === "answer" && step.content.trim());
    if (historyAnswer?.content.trim()) return historyAnswer.content.trim();

    return "";
  }

  private buildQuickAnswerFromTool(
    userInput: string,
    toolName: string,
    toolOutput: unknown,
  ): string | null {
    if (toolName === "export_spreadsheet") {
      if (typeof toolOutput === "string" && toolOutput.trim()) {
        const normalized = toolOutput.trim();
        if (/已导出\s*Excel\s*文件[:：]\s*\/[^\s"'`]+?\.(?:xlsx|xls|csv)\b/iu.test(normalized)) {
          return normalized;
        }
      }
      if (
        toolOutput
        && typeof toolOutput === "object"
      ) {
        const output = toolOutput as { path?: unknown; message?: unknown };
        if (typeof output.path === "string" && output.path.trim()) {
          return `已导出 Excel 文件: ${output.path.trim()}`;
        }
        if (
          typeof output.message === "string"
          && /已导出\s*Excel\s*文件[:：]\s*\/[^\s"'`]+?\.(?:xlsx|xls|csv)\b/iu.test(output.message)
        ) {
          return output.message.trim();
        }
      }
    }

    if (
      toolName === "export_document" &&
      toolOutput &&
      typeof toolOutput === "object"
    ) {
      const output = toolOutput as { path?: unknown; format?: unknown; message?: unknown };
      if (typeof output.path === "string" && output.path.trim()) {
        const format = typeof output.format === "string" && output.format.trim()
          ? output.format.trim().toLowerCase()
          : "";
        const formatLabel = format === "docx"
          ? "Word 文档"
          : format === "rtf"
            ? "RTF 文档"
            : "文档";
        return `已导出${formatLabel}到 ${output.path.trim()}`;
      }
      if (typeof output.message === "string" && output.message.trim()) {
        return output.message.trim();
      }
    }

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

    if (
      toolName === "calculate" &&
      toolOutput &&
      typeof toolOutput === "object"
    ) {
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

    if (
      toolName === "generate_suggestions" &&
      toolOutput &&
      typeof toolOutput === "object"
    ) {
      const output = toolOutput as { display?: unknown };
      if (typeof output.display === "string" && output.display.trim()) {
        const baseAnswer = this.getLatestAnswerSnapshot();
        if (!baseAnswer) return null;
        const display = output.display.trim();
        if (!display) return baseAnswer;
        if (baseAnswer.includes(display)) return baseAnswer;
        return `${baseAnswer}\n\n${display}`;
      }
    }

    return null;
  }

  private logSystemInfoToolResult(
    source: "cache" | "execute" | "error",
    payload: Record<string, unknown>,
  ): void {
    console.log(SYSTEM_INFO_LOG_PREFIX, {
      source,
      at: new Date().toISOString(),
      ...payload,
    });
  }

  private normalizeMutationPath(path: unknown): string {
    return String(path ?? "")
      .trim()
      .replace(/\\/g, "/");
  }

  private extractPathGuessFromRawArgs(rawArguments: string): string {
    const match = rawArguments.match(
      /["']path["']\s*:?\s*["']([^"'\n\r]+)["']/i,
    );
    return this.normalizeMutationPath(match?.[1] ?? "");
  }

  private extractWriteSignature(
    toolName: string,
    toolParams: Record<string, unknown>,
  ): string {
    if (toolName === "write_file" || toolName === "export_document") {
      return `${toolName}::${String(toolParams.content ?? "")}`;
    }
    if (toolName === "str_replace_edit") {
      return JSON.stringify({
        command: toolParams.command ?? "",
        old_str: toolParams.old_str ?? "",
        new_str: toolParams.new_str ?? "",
        insert_line: toolParams.insert_line ?? null,
      });
    }
    return JSON.stringify(toolParams);
  }

  private summarizeRecentStepsForFileRegen(maxCount = 6): Array<{
    type: AgentStep["type"];
    toolName?: string;
    preview: string;
  }> {
    return this.steps.slice(-maxCount).map((step) => ({
      type: step.type,
      toolName: step.toolName,
      preview: step.content.replace(/\s+/g, " ").trim().slice(0, 140),
    }));
  }

  private maybeLogRepeatedFileMutation(
    toolName: string,
    toolParams: Record<string, unknown>,
    output: unknown,
    outputStr: string,
    userInput: string,
  ): void {
    if (!FILE_WRITE_TOOL_NAMES.has(toolName)) return;
    const path = this.normalizeMutationPath(toolParams.path);
    if (!path) return;

    const signature = this.extractWriteSignature(toolName, toolParams);
    const previous = this.fileMutationTrace.get(path);
    const count = (previous?.count ?? 0) + 1;
    this.fileMutationTrace.set(path, {
      count,
      lastToolName: toolName,
      lastSignature: signature,
    });

    if (count !== 2 && count !== 4 && count !== 8) return;

    console.warn(FILE_REGEN_LOG_PREFIX, {
      at: new Date().toISOString(),
      path,
      repeatCount: count,
      toolName,
      previousToolName: previous?.lastToolName,
      sameContentAsPrevious: previous
        ? previous.lastSignature === signature
        : false,
      userInputPreview: userInput.slice(0, 300),
      toolParams: {
        path,
        command: toolParams.command,
        insert_line: toolParams.insert_line,
        contentChars:
          typeof toolParams.content === "string"
            ? toolParams.content.length
            : undefined,
        newStrChars:
          typeof toolParams.new_str === "string"
            ? toolParams.new_str.length
            : undefined,
      },
      outputPreview: outputStr.slice(0, 300),
      output,
      recentSteps: this.summarizeRecentStepsForFileRegen(),
      trajectoryTail: this.trajectory.slice(-6).map((entry) => ({
        type: entry.type,
        toolName: entry.toolName,
        durationMs: entry.durationMs,
        resultPreview:
          typeof entry.result === "string"
            ? entry.result.slice(0, 160)
            : entry.result,
      })),
    });
  }

  private maybeLogRepeatedMalformedWriteToolCall(
    toolName: string,
    rawArguments: string,
    parseError: string,
    userInput: string,
  ): void {
    if (!FILE_WRITE_TOOL_NAMES.has(toolName)) return;

    const pathGuess =
      this.extractPathGuessFromRawArgs(rawArguments) || "(unknown)";
    const traceKey = `${toolName}::${pathGuess}`;
    const count = (this.fileMutationParseTrace.get(traceKey) ?? 0) + 1;
    this.fileMutationParseTrace.set(traceKey, count);

    if (count !== 2 && count !== 4 && count !== 8) return;

    console.warn(FILE_REGEN_PARSE_LOG_PREFIX, {
      at: new Date().toISOString(),
      toolName,
      pathGuess,
      repeatCount: count,
      userInputPreview: userInput.slice(0, 300),
      parseError,
      rawArgumentsPreview: rawArguments.slice(0, 500),
      recentSteps: this.summarizeRecentStepsForFileRegen(),
      trajectoryTail: this.trajectory.slice(-6).map((entry) => ({
        type: entry.type,
        toolName: entry.toolName,
        durationMs: entry.durationMs,
        resultPreview:
          typeof entry.result === "string"
            ? entry.result.slice(0, 160)
            : entry.result,
      })),
    });
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
    const writeToolPatterns = ["write_file", "export_document", "str_replace_edit", "json_edit"];
    return allSteps.some(
      (step) =>
        step.type === "action" &&
        writeToolPatterns.some((p) => step.toolName?.toLowerCase().includes(p)),
    );
  }

  private hasSaveLikeIntent(userInput: string): boolean {
    const text = userInput.toLowerCase();
    const writeVerbs = [
      "写入",
      "保存",
      "另存",
      "覆盖",
      "修改文件",
      "更新文件",
      "写到",
      "编辑文件",
      "插入",
      "write_file",
      "str_replace",
      "save",
      "edit",
    ];
    if (writeVerbs.some((k) => text.includes(k))) return true;
    const targets = [".md", ".txt", ".json", ".csv", ".yaml", ".yml", ".docx", ".rtf"];
    const writeContextWords = [
      "改成",
      "改为",
      "替换",
      "更新",
      "创建",
      "生成",
      "导出",
    ];
    if (
      targets.some((t) => text.includes(t)) &&
      writeContextWords.some((w) => text.includes(w))
    ) {
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

  private hasToolNamed(toolName: string): boolean {
    return this.tools.some((tool) => tool.name === toolName);
  }

  private hasBothModeSwitchTools(): boolean {
    return this.hasToolNamed("enter_plan_mode") && this.hasToolNamed("exit_plan_mode");
  }

  private hasDelegateSubtaskTool(): boolean {
    return this.hasToolNamed("delegate_subtask");
  }

  private canUseInteractiveAskUser(): boolean {
    return this.hasToolNamed("ask_user");
  }

  private buildUserInteractionRules(): string {
    if (this.canUseInteractiveAskUser()) {
      return [
        "- **严禁在回复文本中向用户提问**。需要用户输入时，必须调用 ask_user 工具（会弹出交互对话框让用户选择/输入）",
        "- 以下情况必须调用 ask_user 工具：",
        '  · 任务目标模糊（如"帮我处理文件"但未指定哪个文件）',
        "  · 有多个合理方案需要用户选择（如保存格式、目标路径）",
        "  · 操作不可逆且影响范围不明确（如批量删除、覆盖文件）",
        "  · 缺少必要的参数（如收件人、密码、具体日期等）",
        "- **ask_user 最多调用 2 次**。第一次调用时用 extra_questions 参数把所有相关问题合并到一次调用中",
        "- 获得用户回答后立即执行任务，不要反复追问。如果用户回答不够详细，基于合理推断继续",
      ].join("\n");
    }

    return [
      "- 当前环境不提供 ask_user 交互弹窗。",
      "- 如果信息不足，允许直接用自然语言向用户提一个简洁问题，并等待用户下一条消息。",
      "- 一次只问最关键的一个问题，不要拼复杂表单，也不要暴露 ask_user、审批弹窗、计划模式等内部机制。",
      "- 不要为了“是否继续执行”发起确认；能直接执行就继续，确实必须人工确认时明确说明需要回到本机确认。",
    ].join("\n");
  }

  private buildTextModeUserInteractionRules(): string {
    if (this.canUseInteractiveAskUser()) {
      return [
        "7. **严禁在 Final Answer 中向用户提问**。需要信息时必须用 ask_user 工具",
        "8. ask_user **最多调用 2 次**，第一次就用 extra_questions 把所有问题问完",
      ].join("\n");
    }

    return [
      "7. 当前环境不提供 ask_user 交互弹窗；若缺少关键信息，可在 Final Answer 中直接向用户提出一个简洁问题",
      "8. 不要为了“是否继续执行”向用户索要确认；能直接执行就继续，确实必须人工确认时明确说明需要回到本机确认",
    ].join("\n");
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
    const canUseInteractiveAskUser = this.canUseInteractiveAskUser();
    if (
      (this.hasAnyToolAction() || this.hasSaveLikeIntent(userInput)) &&
      this.isLikelyExecutionConfirmation(answer)
    ) {
      return canUseInteractiveAskUser
        ? "不要在文本里向用户请求“是否继续执行/请确认继续”。如需用户确认，必须调用 ask_user 工具并在拿到回答后继续执行。"
        : "不要在文本里向用户请求“是否继续执行/请确认继续”。若能直接执行，请继续执行；若确实必须人工确认，请明确说明需要回到本机确认。";
    }
    if (
      this.hasSaveLikeIntent(userInput) &&
      !this.hasWriteFileAction() &&
      this.isLikelySaveOutcomeClaim(answer)
    ) {
      return "你尚未实际调用保存/写入工具（write_file / export_document / str_replace_edit / json_edit）。若任务包含保存、导出或修改文件，必须先调用相应工具并基于真实工具结果再给结论。";
    }
    if (
      rejectedDangerousActionCount === 0 &&
      this.isLikelyUserRefusalClaim(answer)
    ) {
      return "不要假设用户已经拒绝授权。仅可基于真实工具调用结果给出结论；若未触发确认，请继续执行并给出结果。";
    }
    if (
      canUseInteractiveAskUser &&
      !this.hasAnyToolAction() &&
      this.isLikelyAskingUser(answer)
    ) {
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
      const pattern = new RegExp(
        `(?:调用工具|Action|tool_call)[:\\s]*${name}\\s*\\(`,
        "i",
      );
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
    this.loopDetectionConfig = normalizeLoopDetectionConfig(config?.loopDetection);
    this.loopDetector = new LoopDetector(this.loopDetectionConfig);
    this.onStep = onStep;
    this.history = history;
    this.depth = depth;
    this.fcCompatibilityKey = normalizeFCCompatibilityKey(
      this.config.fcCompatibilityKey,
    );
    if (this.fcCompatibilityKey && isFCCacheValid(this.fcCompatibilityKey)) {
      this.fcAvailable = false;
    }
    this.mode = this.config.initialMode ?? "execute";

    const MAX_DEPTH = 2;
    const baseTools = [...tools];
    const hasManagedDelegationTool = tools.some((tool) =>
      tool.name === "spawn_task" || tool.name === "wait_for_spawned_tasks"
    );
    const authoritativeToolList = this.config.authoritativeToolList === true;
    if (!authoritativeToolList && depth < MAX_DEPTH && !hasManagedDelegationTool) {
      baseTools.push(this.createDelegateSubtaskTool(ai, tools, depth));
    }
    if (!authoritativeToolList) {
      baseTools.push(...this.createModeSwitchTools());
    }
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
            onTraceEvent: this.config.onTraceEvent,
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
            authoritativeToolList: this.config.authoritativeToolList,
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
          this.addStep({
            type: "observation",
            content: "[模式切换] 进入 Plan 模式（只读分析）",
            timestamp: Date.now(),
          });
          return {
            status: "plan_mode_active",
            hint: "现在仅可使用只读工具，完成规划后调用 exit_plan_mode",
          };
        },
      },
      {
        name: "exit_plan_mode",
        description: "退出 Plan 模式，切换回 Execute 模式（可执行所有工具）。",
        readonly: true,
        execute: async () => {
          if (this.mode === "execute")
            return { status: "already_in_execute_mode" };
          this.mode = "execute";
          this.addStep({
            type: "observation",
            content: "[模式切换] 进入 Execute 模式（完整权限）",
            timestamp: Date.now(),
          });
          return {
            status: "execute_mode_active",
            hint: "现在可以使用所有工具执行操作",
          };
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

  listVisibleToolNames(): string[] {
    return this.getAvailableTools().map((tool) => tool.name);
  }

  private buildMemoryPolicyBlock(): string {
    const availableToolNames = new Set(
      this.getAvailableTools().map((tool) => tool.name),
    );
    const hasMemorySearch = availableToolNames.has("memory_search");
    const hasMemoryGet = availableToolNames.has("memory_get");
    const hasMemorySave =
      availableToolNames.has("memory_save") ||
      availableToolNames.has("save_user_memory");

    if (!hasMemorySearch && !hasMemoryGet && !hasMemorySave) {
      return "";
    }

    const lines = ["## 记忆与上下文延续"];
    lines.push(
      "- 若最新用户请求明显切换到新项目、新目录、新文件夹或新主题，立即重置工作范围，不要继续沿用旧项目假设。",
    );

    if (hasMemorySearch && hasMemoryGet) {
      lines.push(
        "- 回答涉及过往工作、决策、日期、人物、偏好、待办事项、项目历史时，先调用 memory_search 检索 MEMORY.md 与 memory/*.md，再用 memory_get 精读需要的行。",
      );
      lines.push(
        "- 不要一次读取整份记忆文件；只拉取与当前问题直接相关的片段。",
      );
      lines.push(
        "- 如果检索后仍然低置信，请明确说明你已经检查过记忆，不要假装记得。",
      );
    }

    if (hasMemorySave) {
      lines.push(
        "- 当用户明确表达长期偏好、稳定约束、重要事实或持续目标时，使用 memory_save（或兼容别名 save_user_memory）记录候选。",
      );
      lines.push("- 不要把一次性指令、临时状态或会过期的信息写成长久记忆。");
    }

    return lines.join("\n");
  }

  private shouldEnforceMemoryRecall(userInput: string): boolean {
    const availableToolNames = new Set(
      this.getAvailableTools().map((tool) => tool.name),
    );
    if (
      !availableToolNames.has("memory_search") ||
      !availableToolNames.has("memory_get")
    ) {
      return false;
    }
    const normalized = extractPrimaryUserIntent(userInput);
    if (!normalized) return false;
    return MEMORY_RECALL_QUERY_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    );
  }

  private hasPerformedMemoryRecall(): boolean {
    return [...this.history, ...this.steps].some(
      (step) =>
        step.type === "action" &&
        !!step.toolName &&
        MEMORY_RECALL_TOOL_NAMES.has(step.toolName),
    );
  }

  private buildMemoryRecallCorrection(userInput: string): string | null {
    if (!this.shouldEnforceMemoryRecall(userInput)) return null;
    if (this.hasPerformedMemoryRecall()) return null;
    return [
      "[系统校验] 当前问题涉及历史信息、用户偏好、待办或既有决策。",
      "在给出最终答案前，必须先调用 memory_search 检索 MEMORY.md / memory/*.md；必要时再调用 memory_get 精读命中的片段。",
      "如果检索后仍然没有命中，请明确说明你已经检查过记忆，再继续回答。",
    ].join("\n");
  }

  private pickBestFinalAnswer(
    userInput: string,
    candidates: Array<string | null | undefined>,
  ): string | undefined {
    const validCandidates = candidates.filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    );
    if (validCandidates.length === 0) return undefined;

    const intentTokens = extractNumericIntentTokens(userInput);
    if (intentTokens.length === 0) {
      return validCandidates[0];
    }

    let best = validCandidates[0];
    let bestScore = countExactTokenMatches(intentTokens, best);

    for (let index = 1; index < validCandidates.length; index += 1) {
      const candidate = validCandidates[index];
      const score = countExactTokenMatches(intentTokens, candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
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
    const timer = setTimeout(
      () => toolAbort.abort(new ToolTimeoutError(tool.name, timeout)),
      timeout,
    );

    const onParentAbort = () => toolAbort.abort(new Error("Aborted"));
    signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const result = await tool.execute(params, toolAbort.signal);
      return result;
    } catch (err) {
      if (
        toolAbort.signal.aborted &&
        toolAbort.signal.reason instanceof ToolTimeoutError
      ) {
        throw toolAbort.signal.reason;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
  }

  private buildIterationExhaustedSummary(
    diagnostics?: IterationStopDiagnostics,
  ): string {
    const toolsCalled = this.steps
      .filter((s) => s.type === "action" && s.toolName)
      .map((s) => s.toolName!);
    const answers = this.steps.filter((s) => s.type === "answer");
    const errors = this.steps.filter((s) => s.type === "error");
    const iterationsUsed = Math.max(
      1,
      Math.min(
        diagnostics?.iterationsUsed ?? this.config.maxIterations,
        this.config.maxIterations,
      ),
    );
    const stopReason = diagnostics?.stopReason ?? "iteration_limit_reached";
    const repeatedToolPattern = diagnostics?.repeatedToolPattern?.trim();

    let summary = formatIterationStopHeadline(
      stopReason,
      this.config.maxIterations,
    );
    summary += "\n执行诊断：";
    summary += `\n- 实际运行轮数：${iterationsUsed} / ${this.config.maxIterations}`;
    summary +=
      "\n- 轮数定义：1 轮 = 1 次模型决策（返回回答或 tool_calls），不等于 1 次工具执行";
    summary += `\n- 停止原因：${formatIterationStopReason(stopReason)}`;
    summary += `\n- 工具执行次数：${toolsCalled.length}`;
    if (toolsCalled.length > 0) {
      const unique = [...new Set(toolsCalled)];
      summary += `\n- 已调用工具：${unique.join(", ")}（共 ${toolsCalled.length} 次）`;
    }
    if (repeatedToolPattern) {
      summary += `\n- 重复工具模式：${repeatedToolPattern}`;
    }
    if (errors.length > 0) {
      summary += `\n- 错误次数：${errors.length}`;
    }
    if (answers.length > 0) {
      const lastAnswer = answers[answers.length - 1].content;
      if (lastAnswer && lastAnswer.length > 20) {
        summary += `\n\n以下是目前收集到的部分信息:\n${lastAnswer}`;
      }
    }
    summary += "\n\n如需继续，请发送追问消息。";

    this.addStep({
      type: "error",
      content: "iteration_exhausted",
      toolOutput: {
        iterationsUsed,
        maxIterations: this.config.maxIterations,
        stopReason,
        repeatedToolPattern,
      },
      timestamp: Date.now(),
    });

    return summary;
  }

  /**
   * 共享工具执行管道：危险检查 → 用户确认 → 执行 → 快捷回答 → 结果返回
   * 返回 { output, outputStr, quickAnswer, rejected, error }
   */
  private reflectOnError(
    toolName: string,
    toolParams: Record<string, unknown>,
    error: string,
  ): string {
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
    rawOutput?: unknown;
    quickAnswer?: string;
    rejected?: boolean;
    error?: string;
    errorResult?: ToolErrorResult;
    reflection?: string;
  }> {
    const startTime = Date.now();
    const summarizeToolPayload = (value: unknown) => previewTraceValue(
      typeof value === "string" ? value : JSON.stringify(value),
    );
    const finishToolSuccess = <T extends {
      outputStr: string;
      rawOutput?: unknown;
      quickAnswer?: string;
      rejected?: boolean;
      error?: string;
      errorResult?: ToolErrorResult;
      reflection?: string;
    }>(result: T, detail?: Record<string, unknown>): T => {
      this.emitTraceEvent("tool_call_completed", {
        tool: toolName,
        elapsed_ms: Date.now() - startTime,
        ...(detail ?? {}),
      });
      this.emitTraceEvent("tool_result_recorded", {
        tool: toolName,
        status: result.rejected ? "rejected" : "completed",
        elapsed_ms: Date.now() - startTime,
        preview: summarizeToolPayload(result.quickAnswer ?? result.outputStr ?? result.rawOutput),
      });
      return result;
    };
    const finishToolFailure = <T extends {
      outputStr: string;
      rawOutput?: unknown;
      quickAnswer?: string;
      rejected?: boolean;
      error?: string;
      errorResult?: ToolErrorResult;
      reflection?: string;
    }>(result: T, detail?: Record<string, unknown>): T => {
      this.emitTraceEvent("tool_call_failed", {
        tool: toolName,
        elapsed_ms: Date.now() - startTime,
        status: result.errorResult?.type ?? (result.rejected ? "rejected" : "failed"),
        preview: summarizeToolPayload(result.error ?? result.outputStr ?? result.rawOutput),
        ...(detail ?? {}),
      });
      this.emitTraceEvent("tool_result_recorded", {
        tool: toolName,
        status: result.errorResult?.type ?? (result.rejected ? "rejected" : "failed"),
        elapsed_ms: Date.now() - startTime,
        preview: summarizeToolPayload(result.outputStr ?? result.error ?? result.rawOutput),
      });
      return result;
    };
    this.emitTraceEvent("tool_call_started", {
      tool: toolName,
      preview: summarizeToolPayload(toolParams),
    });
    const tool = this.tools.find((t) => t.name === toolName);

    if (!tool) {
      const available = this.getAvailableTools()
        .map((t) => t.name)
        .join(", ");
      const msg = `未知工具: ${toolName}，可用工具: ${available}`;
      const errResult: ToolErrorResult = {
        type: ToolErrorType.NotFound,
        tool: toolName,
        message: msg,
        recoverable: true,
      };
      this.addStep({
        type: "error",
        content: `未知工具: ${toolName}`,
        timestamp: Date.now(),
      });
      this.emitTraceEvent("tool_call_blocked", {
        tool: toolName,
        status: "not_found",
        preview: summarizeToolPayload(msg),
      });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return finishToolFailure({ outputStr: `错误: ${msg}`, error: msg, errorResult: errResult });
    }

    if (this.mode === "plan" && !tool.readonly) {
      const msg = `[Plan 模式] 工具 ${toolName} 不是只读工具，Plan 模式下禁止执行。请先调用 exit_plan_mode 切换到 Execute 模式。`;
      const errResult: ToolErrorResult = {
        type: ToolErrorType.PlanModeBlocked,
        tool: toolName,
        message: msg,
        recoverable: true,
      };
      this.addStep({
        type: "error",
        content: msg,
        toolName,
        timestamp: Date.now(),
      });
      this.emitTraceEvent("tool_call_blocked", {
        tool: toolName,
        status: "plan_mode_blocked",
        preview: summarizeToolPayload(msg),
      });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return finishToolFailure({ outputStr: msg, error: msg, errorResult: errResult });
    }

    if (this.loopDetector.isDisabled(toolName)) {
      const msg = `[Doom Loop] 工具 ${toolName} 已被禁用（连续失败 ${this.loopDetectionConfig.consecutiveFailureLimit} 次）。请改用其他工具或方式完成任务。`;
      const errResult: ToolErrorResult = {
        type: ToolErrorType.LoopDetected,
        tool: toolName,
        message: msg,
        recoverable: false,
      };
      this.addStep({
        type: "error",
        content: msg,
        toolName,
        timestamp: Date.now(),
      });
      this.emitTraceEvent("tool_call_dropped", {
        tool: toolName,
        status: "loop_disabled",
        preview: summarizeToolPayload(msg),
      });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return finishToolFailure({ outputStr: msg, error: msg, errorResult: errResult });
    }

    if (tool.parameters) {
      const missing: string[] = [];
      for (const [key, param] of Object.entries(tool.parameters)) {
        if (
          param.required !== false &&
          (toolParams[key] === undefined || toolParams[key] === null)
        ) {
          missing.push(key);
        }
      }

      // MCP 工具参数自动补全：当模型遗漏必填参数时，尝试从用户输入中提取
      if (missing.length > 0 && toolName.startsWith("mcp_")) {
        for (const key of [...missing]) {
          const desc = (tool.parameters[key]?.description ?? "").toLowerCase();
          const keyLower = key.toLowerCase();
          const inferred = inferMcpParamFromUserInput(
            keyLower,
            desc,
            userInput,
          );
          if (inferred !== null) {
            toolParams[key] = inferred;
            missing.splice(missing.indexOf(key), 1);
            this.addStep({
              type: "observation",
              content: `[MCP 参数补全] ${toolName}.${key} = ${JSON.stringify(inferred).slice(0, 100)}`,
              timestamp: Date.now(),
            });
          }
        }
      }

      if (missing.length > 0) {
        const schema = Object.entries(tool.parameters)
          .map(
            ([k, v]) =>
              `  ${k}: ${v.type}${v.required === false ? " (可选)" : " (必需)"}${v.description ? ` - ${v.description}` : ""}`,
          )
          .join("\n");
        const msg = `参数校验失败: ${toolName} 缺少必需参数 [${missing.join(", ")}]。收到的参数: ${JSON.stringify(toolParams)}。期望的参数格式:\n${schema}`;
        const errResult: ToolErrorResult = {
          type: ToolErrorType.ValidationError,
          tool: toolName,
          message: msg,
          recoverable: true,
        };
        this.addStep({
          type: "error",
          content: msg,
          toolName,
          timestamp: Date.now(),
        });
        this.emitTraceEvent("tool_call_blocked", {
          tool: toolName,
          status: "validation_error",
          preview: summarizeToolPayload(msg),
        });
        this.recordTrajectory({
          type: "error",
          toolName,
          toolParams,
          error: errResult,
        });
        return finishToolFailure({ outputStr: msg, error: msg, errorResult: errResult });
      }
    }

    this.addStep({
      type: "action",
      content: `调用 ${toolName}`,
      toolName,
      toolInput: toolParams,
      timestamp: Date.now(),
    });
    this.recordTrajectory({
      type: "tool_call",
      toolName,
      toolParams,
      mode: this.mode,
    });

    this.loopDetector.record(toolName, toolParams);
    const loopCheck = this.loopDetector.detect();
    if (loopCheck.looping) {
      const msg = `[循环检测] 工具 ${loopCheck.tool} 被重复调用（相同参数 ${this.loopDetectionConfig.repeatThreshold}+ 次）。请换一种方式或使用其他工具完成任务。`;
      const errResult: ToolErrorResult = {
        type: ToolErrorType.LoopDetected,
        tool: toolName,
        message: msg,
        recoverable: false,
      };
      this.addStep({
        type: "error",
        content: msg,
        toolName,
        timestamp: Date.now(),
      });
      this.emitTraceEvent("tool_call_dropped", {
        tool: toolName,
        status: "loop_detected",
        preview: summarizeToolPayload(msg),
      });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return finishToolFailure({ outputStr: msg, error: msg, errorResult: errResult });
    }

    const consecutiveCheck = this.loopDetector.detectConsecutiveSameTool();
    if (consecutiveCheck.looping) {
      const toolHint =
        consecutiveCheck.tool === "ask_user"
          ? "ask_user 连续调用过多。请用 extra_questions 参数把多个问题合并到一次调用中，减少对用户的打扰。先根据已有信息执行任务，需要更多信息时再合并提问。"
          : "请立即使用 read_file、list_directory、search_in_files 等工具获取实际信息，不要继续空转思考。";
      const msg = `[循环检测] 工具 ${consecutiveCheck.tool} 已连续调用 ${consecutiveCheck.count} 次。${toolHint}`;
      const errResult: ToolErrorResult = {
        type: ToolErrorType.LoopDetected,
        tool: toolName,
        message: msg,
        recoverable: true,
      };
      this.addStep({
        type: "error",
        content: msg,
        toolName,
        timestamp: Date.now(),
      });
      this.emitTraceEvent("tool_call_dropped", {
        tool: toolName,
        status: "consecutive_loop_detected",
        preview: summarizeToolPayload(msg),
      });
      this.recordTrajectory({ type: "error", toolName, error: errResult });
      return finishToolFailure({ outputStr: msg, error: msg, errorResult: errResult });
    }

    const cacheKey = `${toolName}::${JSON.stringify(toolParams)}`;
    const canUseCallCache = !NON_CACHEABLE_TOOLS.has(toolName);
    let cachedResult = canUseCallCache ? this.successfulCallCache.get(cacheKey) : undefined;
    if (!cachedResult && canUseCallCache && PATH_BASED_FUZZY_CACHE_TOOLS.has(toolName)) {
      const filePath = String(toolParams.path ?? toolParams.filePath ?? toolParams.file ?? "").trim();
      if (filePath) {
        const fuzzyPrefix = `${toolName}::`;
        for (const [key, value] of this.successfulCallCache) {
          if (!key.startsWith(fuzzyPrefix)) continue;
          try {
            const prevParams = JSON.parse(key.slice(fuzzyPrefix.length));
            const prevPath = String(prevParams.path ?? prevParams.filePath ?? prevParams.file ?? "").trim();
            if (prevPath === filePath) {
              cachedResult = value;
              break;
            }
          } catch { /* ignore parse errors */ }
        }
      }
    }
    if (cachedResult) {
      const hint = `[重复调用拦截] 该工具已用相同参数成功执行过，以下是上次的结果（无需再次调用）:\n${cachedResult}\n\n请直接基于此结果回答用户问题，不要再调用同一工具。`;
      if (toolName === "get_system_info") {
        this.logSystemInfoToolResult("cache", {
          hasData: Boolean(cachedResult.trim()),
          contentChars: cachedResult.length,
          preview: cachedResult.slice(0, 300),
        });
      }
      this.addStep({
        type: "observation",
        content: hint,
        toolName,
        toolOutput: cachedResult,
        timestamp: Date.now(),
      });
      this.recordTrajectory({
        type: "tool_result",
        toolName,
        result: "(cached)",
        durationMs: 0,
      });
      this.emitTraceEvent("tool_call_dropped", {
        tool: toolName,
        status: "cached",
        preview: summarizeToolPayload(toolParams),
      });
      return finishToolSuccess({ outputStr: hint, rawOutput: cachedResult }, {
        status: "cached",
      });
    }

    const isDangerous =
      !!tool.dangerous ||
      !!this.config.dangerousToolPatterns?.some((p) =>
        toolName.toLowerCase().includes(p.toLowerCase()),
      );
    if (isDangerous && this.config.confirmDangerousAction) {
      const dangerousKey = `${toolName}::${JSON.stringify(toolParams)}`;
      if (this.approvedDangerousKeys.has(dangerousKey)) {
        this.addStep({
          type: "observation",
          content: "已自动放行（同参数已确认过）",
          toolName,
          timestamp: Date.now(),
        });
      } else {
        this.addStep({
          type: "observation",
          content: `等待用户确认执行 ${toolName}`,
          toolName,
          timestamp: Date.now(),
        });
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
          this.emitTraceEvent("tool_call_blocked", {
            tool: toolName,
            status: "user_rejected",
            preview: summarizeToolPayload(toolParams),
          });
          return finishToolFailure({ outputStr: "用户拒绝执行此操作", rejected: true }, {
            status: "rejected",
          });
        }
        this.approvedDangerousKeys.add(dangerousKey);
        this.addStep({
          type: "observation",
          content: "用户已确认执行此操作",
          toolName,
          timestamp: Date.now(),
        });
      }
    }

    if (signal?.aborted) throw new Error("Aborted");
    try {
      const output = await this.executeWithTimeout(tool, toolParams, signal);
      if (signal?.aborted) throw new Error("Aborted");

      const shellExitCode =
        (toolName === "run_shell_command" || toolName === "persistent_shell")
          && output
          && typeof output === "object"
          ? (typeof (output as Record<string, unknown>).exit_code === "number"
            ? Number((output as Record<string, unknown>).exit_code)
            : typeof (output as Record<string, unknown>).exitCode === "number"
              ? Number((output as Record<string, unknown>).exitCode)
              : null)
          : null;
      const hasShellToolFailure = shellExitCode !== null && shellExitCode !== 0;
      const hasToolError = (
        output &&
        typeof output === "object" &&
        "error" in output &&
        typeof (output as Record<string, unknown>).error === "string"
      ) || hasShellToolFailure;
      if (hasToolError) {
        this.loopDetector.recordFailure(toolName);
      } else {
        this.loopDetector.recordSuccess(toolName);
        this.config.onToolExecuted?.(toolName);
      }

      const quickAnswer = this.buildQuickAnswerFromTool(
        userInput,
        toolName,
        output,
      );
      if (quickAnswer) {
        this.addStep({
          type: "answer",
          content: quickAnswer,
          timestamp: Date.now(),
        });
        this.recordTrajectory({
          type: "tool_result",
          toolName,
          result: "(quick_answer)",
          durationMs: Date.now() - startTime,
        });
        return finishToolSuccess({ outputStr: "", rawOutput: output, quickAnswer }, {
          status: "quick_answer",
        });
      }

      const rawStr =
        typeof output === "string" ? output : JSON.stringify(output, null, 2);
      const outputStr = truncateToolOutput(rawStr, toolName);
      this.maybeLogRepeatedFileMutation(
        toolName,
        toolParams,
        output,
        outputStr,
        userInput,
      );
      if (toolName === "get_system_info") {
        const outputObj =
          output && typeof output === "object"
            ? (output as Record<string, unknown>)
            : undefined;
        this.logSystemInfoToolResult("execute", {
          hasToolError,
          hasData: Boolean(outputStr.trim()),
          rawChars: rawStr.length,
          outputChars: outputStr.length,
          platform: outputObj?.platform,
          home_dir: outputObj?.home_dir,
          desktop_dir: outputObj?.desktop_dir,
          downloads_dir: outputObj?.downloads_dir,
          output,
          outputStr,
        });
      }

      if (!hasToolError && canUseCallCache) {
        this.successfulCallCache.set(cacheKey, outputStr);
        // LRU eviction: drop oldest entries when exceeding max size
        if (this.successfulCallCache.size > ReActAgent.CALL_CACHE_MAX_SIZE) {
          const firstKey = this.successfulCallCache.keys().next().value;
          if (firstKey !== undefined) this.successfulCallCache.delete(firstKey);
        }
      }

      this.addStep({
        type: "observation",
        content: outputStr,
        toolName,
        toolOutput: output,
        timestamp: Date.now(),
      });
      this.recordTrajectory({
        type: "tool_result",
        toolName,
        result: outputStr.slice(0, 200),
        durationMs: Date.now() - startTime,
      });
      if (hasToolError) {
        return finishToolFailure({
          outputStr,
          rawOutput: output,
          error: outputStr,
          errorResult: {
            type: ToolErrorType.RuntimeError,
            tool: toolName,
            message: outputStr,
            recoverable: true,
          },
        }, {
          status: hasShellToolFailure ? "command_failed" : "tool_error",
        });
      }
      const shouldYieldForSpawnWait =
        toolName === "wait_for_spawned_tasks"
        && output
        && typeof output === "object"
        && (output as Record<string, unknown>).wait_complete === false
        && Number((output as Record<string, unknown>).pending_count ?? 0) > 0;
      if (shouldYieldForSpawnWait) {
        finishToolSuccess({ outputStr, rawOutput: output }, { status: "spawn_wait" });
        throw new WaitForSpawnedTasksInterrupt(output as Record<string, unknown>);
      }
      return finishToolSuccess({ outputStr, rawOutput: output });
    } catch (e) {
      if ((e as Error).message === "Aborted") throw e;
      if (e instanceof ClarificationInterrupt || e instanceof WaitForSpawnedTasksInterrupt) throw e;
      if (toolName === "get_system_info") {
        this.logSystemInfoToolResult("error", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      const isTimeout = e instanceof ToolTimeoutError;
      const errorType = isTimeout
        ? ToolErrorType.Timeout
        : ToolErrorType.RuntimeError;
      const errorStr = isTimeout
        ? (e as ToolTimeoutError).message
        : `工具执行失败: ${e}`;
      const errResult: ToolErrorResult = {
        type: errorType,
        tool: toolName,
        message: errorStr,
        recoverable: !isTimeout,
      };
      this.addStep({
        type: "error",
        content: errorStr,
        toolName,
        timestamp: Date.now(),
      });
      this.loopDetector.recordFailure(toolName);
      this.recordTrajectory({
        type: "error",
        toolName,
        error: errResult,
        durationMs: Date.now() - startTime,
      });
      return finishToolFailure({
        outputStr: errorStr,
        error: errorStr,
        errorResult: errResult,
        reflection: this.reflectOnError(toolName, toolParams, errorStr),
      });
    }
  }

  // ── 文本 ReAct 模式（降级方案） ──

  private buildSystemPrompt(userInput?: string): string {
    const s = this.buildSharedPromptSections(userInput);
    const textModeUserInteractionRules =
      this.buildTextModeUserInteractionRules();

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

    const modeHint =
      this.mode === "plan"
        ? "\n\n**当前为 Plan 模式（只读），仅可使用只读工具。完成分析后调用 exit_plan_mode 切换到执行模式。**"
        : "";
    const disabledSection = s.disabledHint ? `\n\n${s.disabledHint}` : "";

    const codingHint = s.isCoding
      ? `## 编程任务工作流
1. 理解需求 → 2. 用 read_file / search_in_files 探索代码 → 3. 复现问题 → 4. 定位根因 → 5. 用 str_replace_edit 修改 → 6. 用 run_lint 验证 → 7. 总结
- 修改文件优先用 str_replace_edit，创建新文件用 str_replace_edit(create)
- 输出被截断时用 read_file_range 分段读取`
      : "";

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
${textModeUserInteractionRules}
9. **严禁在 Final Answer 中写工具调用**，必须用 Action/Action Input 格式真正调用
10. **所有文件路径必须使用绝对路径**
11. **sequential_thinking 仅用于梳理复杂逻辑，禁止连续调用超过 3 次**

${s.modeSwitching}

${s.taskStrategy}

${s.documentToolBlock}

用中文回答`;

    const sections: PromptSection[] = [
      { name: "identity_rules", content: identityAndRules, priority: 10 },
      {
        name: "extraSystem",
        content: s.extraSystemBlock,
        priority: 20,
        maxTokens: 500,
      },
      {
        name: "codingBlock",
        content: codingHint,
        priority: 30,
        maxTokens: 400,
      },
      { name: "skills", content: s.skillsBlock, priority: 40, maxTokens: 600 },
      {
        name: "memoryPolicy",
        content: s.memoryPolicyBlock,
        priority: 50,
        maxTokens: 500,
      },
      {
        name: "memoryContext",
        content: s.memoryBlock,
        priority: 60,
        maxTokens: 500,
      },
      {
        name: "codingHint",
        content: s.codingHintBlock,
        priority: 70,
        maxTokens: 500,
      },
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
    actionInputRaw?: string;
    actionInputParseError?: string;
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

    const actionInput = this.extractActionInputPayload(response);
    if (actionInput.raw) {
      result.actionInputRaw = actionInput.raw;
      result.actionInput = actionInput.params;
      if (actionInput.parseError) {
        result.actionInputParseError = actionInput.parseError;
      }
    }

    return result;
  }

  private extractActionInputPayload(response: string): {
    raw?: string;
    params?: Record<string, unknown>;
    parseError?: string;
  } {
    const markerMatch = response.match(/Action Input:\s*/);
    if (!markerMatch || markerMatch.index === undefined) return {};

    const afterMarker = response.slice(markerMatch.index + markerMatch[0].length).trimStart();
    if (!afterMarker) return {};

    let rawCandidate = "";
    if (afterMarker.startsWith("```")) {
      const fenceMatch = afterMarker.match(/^```(?:json)?\s*\n([\s\S]*?)\n```/i);
      rawCandidate = fenceMatch?.[1]?.trim() ?? "";
    } else {
      rawCandidate = this.extractLeadingJsonBlock(afterMarker)
        ?? afterMarker.split(/\n(?:Thought|Action|Final Answer):/)[0]?.trim()
        ?? "";
    }

    if (!rawCandidate) return {};
    const parsed = parseToolCallArguments(rawCandidate);
    return {
      raw: rawCandidate,
      params: parsed.params,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    };
  }

  private extractLeadingJsonBlock(input: string): string | null {
    const trimmed = input.trimStart();
    const first = trimmed[0];
    if (first !== "{" && first !== "[") return null;

    const closer = first === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < trimmed.length; index += 1) {
      const ch = trimmed[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === first) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          return trimmed.slice(0, index + 1);
        }
      }
    }

    return null;
  }

  /**
   * 通过流式 API 获取 LLM 响应（文本模式），实时推送思考过程给用户。
   */
  private async streamTextLLM(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    signal?: AbortSignal,
  ): Promise<string> {
    const startedAt = Date.now();
    let accumulated = "";
    let lastPushedLen = 0;
    let hasLoggedFirstChunk = false;

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
        if (!hasLoggedFirstChunk && chunk.trim()) {
          hasLoggedFirstChunk = true;
          this.emitTraceEvent("llm_first_chunk", {
            elapsed_ms: Date.now() - startedAt,
            phase: "text_stream",
            preview: previewTraceValue(chunk),
          });
        }
        const merged = mergeStreamChunk(accumulated, chunk);
        accumulated = merged.full;
        pushThinking(merged.mode === "reset");
      },
      onDone: (full) => {
        accumulated = full;
      },
    });

    if (signal?.aborted) throw new Error("Aborted");
    if (accumulated.trim()) {
      this.emitTraceEvent("llm_content_completed", {
        elapsed_ms: Date.now() - startedAt,
        phase: "text_stream",
        count: accumulated.trim().length,
        preview: previewTraceValue(accumulated),
      });
    }
    return accumulated;
  }

  // ── Function Calling 模式（优先方案） ──

  /**
   * 从用户输入和对话历史中检测当前是否为编程相关任务，
   * 避免在纯 Q&A / 翻译 / 总结等场景中注入编程指令。
   */
  private detectCodingContext(userInput: string): boolean {
    const strongPatterns =
      /(?:代码|编程|编码|修复|debug|fix\b|bug|重构|refactor|编译|compile|str_replace_edit|read_file|write_file|run_lint|persistent_shell|json_edit|search_in_files|代码审查|code review|package\.json|tsconfig|Cargo\.toml|requirements\.txt)/i;
    if (strongPatterns.test(userInput)) return true;
    const weakPatterns = [
      /(?:写一个|实现|创建)/i,
      /(?:函数|function|class|组件|component|接口|interface)/i,
      /(?:构建|部署|deploy|测试|test|脚本|script)/i,
      /(?:数据库|database|SQL|迁移|migration)/i,
      /(?:npm|yarn|pip|cargo)/i,
      /(?:git|commit|merge|branch|PR|pull request)/i,
      /(?:\.py|\.ts|\.js|\.rs|\.go|\.java|\.cpp|\.vue)\b/i,
      /(?:API|build)\b/i,
      /(?:项目路径|工作上下文)/i,
    ];
    const weakCount = weakPatterns.filter((p) => p.test(userInput)).length;
    if (weakCount >= 2) return true;
    const recentHistory = this.history.slice(-6);
    const codingTools = new Set([
      "str_replace_edit",
      "write_file",
      "json_edit",
      "run_lint",
      "persistent_shell",
      "read_file",
      "read_file_range",
      "search_in_files",
      "list_directory",
      "ckg_search_function",
      "ckg_search_class",
    ]);
    for (const step of recentHistory) {
      if (
        step.type === "action" &&
        step.toolName &&
        codingTools.has(step.toolName)
      )
        return true;
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
      : `你是 HiClow 内置的智能助手 Agent。禁止自称 Claude、GPT 或任何第三方厂商的助手。被问"你是谁"时，回答：你是 HiClow 内置助手。`;

    const disabledTools = this.loopDetector.getDisabledTools();
    const disabledHint =
      disabledTools.length > 0
        ? `已禁用的工具（连续失败过多）: ${disabledTools.join(", ")} — 请改用其他方式。`
        : "";

    const isCoding =
      !this.config.skipInternalCodingBlock && userInput
        ? this.detectCodingContext(userInput)
        : false;

    const modeSwitching = this.hasBothModeSwitchTools()
      ? `## 模式切换
- 面对复杂任务时，可先调用 enter_plan_mode 进入只读分析模式，收集信息和制定方案
- 方案确定后调用 exit_plan_mode 切回执行模式进行实际操作`
      : "";

    const taskStrategy = `## 复杂任务处理策略
1. **任务分解**：遇到复杂任务时，先在内部将其拆分为多个子步骤，按顺序逐步完成
2. **深度推理**：每一步执行前，先分析当前已知信息和目标的差距，选择最有效的工具
3. **信息收集优先**：在给出结论前，先充分收集必要信息（读文件、搜索、查询系统状态等）
4. **结果验证**：完成关键操作后，通过读取或查询验证结果是否正确
5. **错误恢复**：工具失败时分析根因，尝试替代方案而非简单重试`;

    const documentToolBlock = `## 文档/表格读取规则
- 遇到 xlsx/xls/csv/pdf/docx/ppt/pptx/xmind/mm 这类文件时，优先使用 read_document。
- md/txt/json/yaml/toml/log/html/xml 这类文本文档也可以直接使用 read_document；代码文件仍优先使用 read_file / read_file_range。
- 不要对 Office/PDF/表格文件使用 read_file / read_file_range。
- 不要为了读取这类文件退回 run_shell_command，除非用户明确要求你用 shell。`;
    const documentExportBlock = this.hasToolNamed("export_document")
      ? `## 文档导出规则
- 当用户明确要求保存为 Word / .docx / .rtf 时，优先使用 export_document。
- 不要用 write_file 手写 RTF 控制符，也不要伪造 .docx 二进制内容。
- 普通文本、Markdown、代码文件仍优先使用 write_file。`
      : "";

    const codingBlock = isCoding
      ? `## 编程任务工作流（7 步法）
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
- 命令输出被截断 → 用 run_shell_command 配合 grep/head/tail 过滤输出`
      : "";

    const skillsBlock = this.config.skillsPrompt || "";
    const memoryPolicyBlock = this.buildMemoryPolicyBlock();
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
      documentToolBlock,
      documentExportBlock,
      skillsBlock,
      memoryPolicyBlock,
      memoryBlock,
      extraSystemBlock,
      codingHintBlock,
    };
  }

  private buildFCSystemPrompt(userInput?: string): string {
    const s = this.buildSharedPromptSections(userInput);
    const userInteractionRules = this.buildUserInteractionRules();

    const modeHint =
      this.mode === "plan"
        ? `\n\n## 当前模式: Plan（只读分析）\n你正处于 Plan 模式，只能使用只读工具（信息收集、搜索、读取）。不能执行修改操作。\n完成分析后调用 exit_plan_mode 切换到 Execute 模式再执行修改。`
        : "";
    const disabledSection = s.disabledHint ? `\n\n## ${s.disabledHint}` : "";

    const identityAndRules = `${s.identityBlock}
你是一个高能力智能助手 Agent，能够自主使用工具来回答问题和执行复杂任务。${modeHint}${disabledSection}

## 核心行为
- 收到任务后立即开始执行，尽量自主完成
- 如果信息不足但可以合理推断，直接假设并继续
${userInteractionRules}
- 用中文回答

${s.modeSwitching}

${s.taskStrategy}

${s.documentToolBlock}

${s.documentExportBlock}

## 工具使用规则
- 需要工具时直接调用，**严禁在回复文本中写出工具调用**（如"调用工具: web_search(...)"），必须通过 function call 真正执行
- 仔细分析工具返回结果再决定下一步
- **工具返回成功结果后，禁止用相同参数再次调用同一工具**。结果已经拿到了，直接使用它来回答
- 不要在没有使用工具的情况下编造信息
- 涉及文件操作时，必须调用对应工具
- ClawHub 相关工具仅当当前用户消息**明确提到 ClawHub**时才可调用；未明确提到时，禁止自动搜索、自动推荐或自动安装 skill
${this.hasDelegateSubtaskTool() ? "- 如有 delegate_subtask 工具可用，可将独立子问题委派给子 Agent 并行处理" : ""}
- **所有文件路径必须使用绝对路径**，不要使用 ~ 或相对路径
- **sequential_thinking 仅用于梳理复杂逻辑，禁止连续调用超过 3 次**

## 回答质量
- 结论必须基于真实的工具调用结果
- 多角度分析问题，给出全面的答案
- 如果任务有多种可行方案，简要说明各方案优劣`;

    const sections: PromptSection[] = [
      { name: "identity_rules", content: identityAndRules, priority: 10 },
      {
        name: "extraSystem",
        content: s.extraSystemBlock,
        priority: 20,
        maxTokens: 500,
      },
      {
        name: "codingBlock",
        content: s.codingBlock,
        priority: 30,
        maxTokens: 800,
      },
      { name: "skills", content: s.skillsBlock, priority: 40, maxTokens: 600 },
      {
        name: "memoryPolicy",
        content: s.memoryPolicyBlock,
        priority: 50,
        maxTokens: 500,
      },
      {
        name: "memoryContext",
        content: s.memoryBlock,
        priority: 60,
        maxTokens: 500,
      },
      {
        name: "codingHint",
        content: s.codingHintBlock,
        priority: 70,
        maxTokens: 500,
      },
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
    const startedAt = Date.now();
    const availableTools = stripTools ? [] : this.getAvailableTools();
    const toolDefs = availableTools.map(toolToFunctionDef);
    let lastPushedLen = 0;
    let accumulated = "";
    let thinkingAccum = "";
    let thinkingStartedAt = 0;
    let toolArgsAccum = "";
    let toolArgsStartedAt = 0;
    let lastToolArgsPushedLen = 0;

    this.emitTraceEvent("llm_invoke_started", {
      phase: stripTools ? "fc_final_warning" : "fc_stream",
      count: messages.length,
      tool_count: toolDefs.length,
    });

    const result = await this.ai.streamWithTools!({
      messages,
      tools: toolDefs,
      signal,
      modelOverride: this.config.modelOverride,
      thinkingLevel: this.config.thinkingLevel,
      onTraceEvent: this.config.onTraceEvent,
      onChunk: (chunk) => {
        if (signal?.aborted) return;
        const merged = mergeStreamChunk(accumulated, chunk);
        accumulated = merged.full;
        const current = accumulated.trim();
        if (
          current &&
          (merged.mode === "reset" || current.length > lastPushedLen + 10)
        ) {
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
        const shouldSurfacePreview = shouldEmitToolStreamingPreview(toolArgsAccum);

        if (
          shouldSurfacePreview
          && (
          toolArgsAccum &&
          (merged.mode === "reset" ||
            toolArgsAccum.length > lastToolArgsPushedLen + 5)
          )
        ) {
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
    const finalVisibleAnswer = accumulated.trim();
    if (finalVisibleAnswer && finalVisibleAnswer !== this.lastStreamingAnswer) {
      this.onStep?.({
        type: "answer",
        content: finalVisibleAnswer,
        timestamp: Date.now(),
        streaming: true,
      });
      this.lastStreamingAnswer = finalVisibleAnswer;
    }
    if (thinkingAccum) {
      this.onStep?.({
        type: "thinking",
        content: thinkingAccum,
        timestamp: thinkingStartedAt || Date.now(),
        streaming: false,
      });
    }
    if (toolArgsAccum) {
      if (shouldEmitToolStreamingPreview(toolArgsAccum)) {
        this.onStep?.({
          type: "tool_streaming",
          content: toolArgsAccum,
          timestamp: toolArgsStartedAt || Date.now(),
          streaming: false,
        });
      }
    }
    if (result.type === "content" && finalVisibleAnswer) {
      this.emitTraceEvent("llm_content_completed", {
        elapsed_ms: Date.now() - startedAt,
        phase: stripTools ? "fc_final_warning" : "fc_stream",
        count: finalVisibleAnswer.length,
        preview: previewTraceValue(finalVisibleAnswer),
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
    const hiddenInHint = new Set([
      "sequential_thinking",
      "save_user_memory",
      "task_done",
      "enter_plan_mode",
      "exit_plan_mode",
    ]);
    const toolNames = this.getAvailableTools()
      .filter((t) => !t.name.startsWith("native_") && !hiddenInHint.has(t.name))
      .map((t) => t.name)
      .slice(0, 12);
    return `${userInput}\n\n[系统引导] 这是一个需要多步执行的复杂任务。请先制定简要的执行计划，明确：\n1. 需要分几步完成\n2. 每步使用什么工具（可用: ${toolNames.join(", ")}）\n3. 各步骤之间的依赖关系\n然后按计划逐步执行，直接开始行动。`;
  }

  /**
   * 生成阶段性进度摘要 —— 扫描最近的工具调用，按类别分组生成一行中文摘要
   */
  private buildCheckpointSummary(
    recentCalls: Array<{ toolName: string; error: boolean }>,
  ): string | null {
    if (recentCalls.length < 2) return null;

    const READ_TOOLS = new Set([
      "read_file",
      "read_file_range",
      "read_document",
      "list_directory",
      "search_in_files",
      "web_search",
      "fetch_url",
      "read_url",
    ]);
    const WRITE_TOOLS = new Set([
      "write_file",
      "write_to_file",
      "edit_file",
      "patch_file",
      "create_file",
      "delete_file",
      "move_file",
    ]);
    const COMMAND_TOOLS = new Set([
      "run_shell_command",
      "persistent_shell",
      "execute_command",
    ]);
    const SEARCH_TOOLS = new Set(["web_search", "search_in_files"]);
    const DELEGATE_TOOLS = new Set(["delegate_subtask", "send_message"]);

    let reads = 0,
      writes = 0,
      commands = 0,
      searches = 0,
      delegates = 0,
      others = 0;
    let errors = 0;
    for (const call of recentCalls) {
      const name = call.toolName;
      if (call.error) errors++;
      if (SEARCH_TOOLS.has(name)) searches++;
      else if (READ_TOOLS.has(name)) reads++;
      else if (WRITE_TOOLS.has(name)) writes++;
      else if (COMMAND_TOOLS.has(name)) commands++;
      else if (DELEGATE_TOOLS.has(name)) delegates++;
      else others++;
    }

    const parts: string[] = [];
    if (reads > 0) parts.push(`读取 ${reads} 个资源`);
    if (searches > 0) parts.push(`搜索 ${searches} 次`);
    if (writes > 0) parts.push(`修改 ${writes} 个文件`);
    if (commands > 0) parts.push(`执行 ${commands} 条命令`);
    if (delegates > 0) parts.push(`委派 ${delegates} 个子任务`);
    if (others > 0) parts.push(`其他操作 ${others} 次`);

    if (parts.length === 0) return null;

    const prefix = errors > 0 ? "⚠️" : "✅";
    const suffix = errors > 0 ? `（${errors} 项失败）` : "";
    return `${prefix} ${parts.join("，")}${suffix}`;
  }

  /**
   * Function Calling 模式的执行循环
   */
  private async runFC(
    userInput: string,
    signal?: AbortSignal,
    images?: string[],
  ): Promise<string> {
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
          historyParts.push(
            `[执行] ${step.toolName}(${step.toolInput ? JSON.stringify(step.toolInput) : ""})`,
          );
        } else if (step.type === "observation") {
          const obs =
            step.content.length > 300
              ? step.content.slice(0, 300) + "..."
              : step.content;
          historyParts.push(`[结果] ${obs}`);
        } else if (step.type === "answer") {
          historyParts.push(`[回答] ${step.content}`);
        }
      }
      if (historyParts.length > 0) {
        messages.push({
          role: "user",
          content: `[历史执行记录]\n${historyParts.join("\n")}`,
        });
        messages.push({
          role: "assistant",
          content: "好的，我已了解之前的执行历史，继续处理当前任务。",
        });
      }
    }

    const isComplex =
      this.isComplexQuery(userInput) && this.history.length === 0;
    const effectiveInput = isComplex
      ? this.buildPlanningHint(userInput)
      : userInput;
    const lastUserMsg: FCMessage = { role: "user", content: effectiveInput };
    if (images?.length) lastUserMsg.images = images;
    messages.push(lastUserMsg);

    let unknownToolCount = 0;
    let rejectedDangerousActionCount = 0;
    let guardRailRetryCount = 0;
    let memoryRecallCorrectionCount = 0;
    const MAX_GUARD_RAIL_RETRIES = 2;
    const toolFailCounts = new Map<string, number>();
    let toolCallsSinceCheckpoint = 0;
    const CHECKPOINT_INTERVAL = 3;
    const fcCheckpointBuffer: Array<{ toolName: string; error: boolean }> = [];

    let iterationWarningIdx = -1;
    let fcEmptyCount = 0;
    let fcStaleCount = 0;
    let repeatedToolCorrectionIssued = false;
    let prevToolCallsKey = "";
    let lastDisabledKey = this.loopDetector.getDisabledTools().join(",");
    let lastMode = this.mode;

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (signal?.aborted) throw new Error("Aborted");
      this.emitTraceEvent("llm_round_started", {
        count: i + 1,
        phase: "fc",
      });

      // Actor inbox 注入点：在每个 iteration 间隙检查是否有新消息
      if (this.config.inboxDrain) {
        const pending = this.config.inboxDrain();
        if (pending.length > 0) {
          for (const m of pending) {
            const replyHint = m.expectReply
              ? `（等待你的回复，请用 send_message 回复，reply_to 填 "${m.id}"）`
              : "";
            messages.push({
              role: "user",
              content: `[收件箱消息]\n来自 ${m.from}（消息ID: ${m.id}）${replyHint}\n\n${m.content}`,
              ...(m.images?.length ? { images: m.images } : {}),
            });
          }
          const hasAgentMsg = pending.some(
            (m) => m.from !== "用户" && m.from !== "user",
          );
          const replyGuide = hasAgentMsg
            ? "如果有其他 Agent 的消息需要回应，使用 send_message 回复。然后继续当前任务。"
            : "请根据消息内容继续当前任务。";
          messages.push({
            role: "user",
            content: `[收件箱处理要求]\n你在执行任务期间收到了 ${pending.length} 条新消息。\n${replyGuide}`,
          });
        }
      }

      // 仅在模式切换或 doom loop 禁用工具后才重建 system prompt
      if (i > 0) {
        const currentDisabled = this.loopDetector.getDisabledTools().join(",");
        const disabledChanged = currentDisabled !== (lastDisabledKey ?? "");
        const modeChanged = this.mode !== lastMode;
        if (disabledChanged || modeChanged) {
          messages[0] = {
            role: "system",
            content: this.buildFCSystemPrompt(userInput),
          };
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

      const preparedMessages = prepareMessagesForModel(
        messages,
        this.config.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
        this.config.patchDanglingToolCalls === true,
      );
      this.recordTrajectory({
        type: "llm_call",
        mode: this.mode,
        tokenEstimate: estimateMessagesTokens(preparedMessages),
      });
      const result = await this.streamFCLLM(
        preparedMessages,
        signal,
        isFinalWarningTurn,
      );
      this.emitTraceEvent("llm_round_completed", {
        count: i + 1,
        phase: "fc",
        status: result.type,
        tool_count: result.type === "tool_calls" ? result.toolCalls.length : undefined,
        preview: result.type === "content" ? previewTraceValue(result.content) : undefined,
      });

      if (signal?.aborted) throw new Error("Aborted");

      if (result.type === "content") {
        const answer = result.content.trim();
        if (answer) {
          const memoryRecallCorrection =
            memoryRecallCorrectionCount < 2
              ? this.buildMemoryRecallCorrection(userInput)
              : null;
          if (memoryRecallCorrection) {
            memoryRecallCorrectionCount++;
            messages.push({ role: "assistant", content: answer });
            messages.push({ role: "user", content: memoryRecallCorrection });
            continue;
          }
          const guardRailCorrection =
            guardRailRetryCount < MAX_GUARD_RAIL_RETRIES
              ? this.checkAnswerGuardRails(
                  answer,
                  userInput,
                  rejectedDangerousActionCount,
                )
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
        if (fcEmptyCount >= EMPTY_MODEL_OUTPUT_LIMIT) {
          const fallback = this.buildIterationExhaustedSummary({
            iterationsUsed: i + 1,
            stopReason: "empty_model_output",
          });
          this.addStep({
            type: "answer",
            content: fallback,
            timestamp: Date.now(),
          });
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

      // 循环 tool_calls 检测：连续 2 轮计划完全相同则触发纠偏/停止
      const curToolCallsKey = validToolCalls
        .map((tc) => `${tc.function.name}::${tc.function.arguments ?? ""}`)
        .join("|");
      if (curToolCallsKey === prevToolCallsKey) {
        fcStaleCount++;
        if (!repeatedToolCorrectionIssued) {
          repeatedToolCorrectionIssued = true;
          const repeatedToolPattern = formatRepeatedToolPattern(validToolCalls);
          this.addStep({
            type: "observation",
            content: repeatedToolPattern
              ? `检测到连续重复的工具计划，已要求模型调整策略：${repeatedToolPattern}`
              : "检测到连续重复的工具计划，已要求模型调整策略。",
            timestamp: Date.now(),
          });
          messages.push({
            role: "user",
            content:
              buildRepeatedToolCallCorrectionMessage(repeatedToolPattern),
          });
          continue;
        }
        if (fcStaleCount >= 2) {
          const fallback = this.buildIterationExhaustedSummary({
            iterationsUsed: i + 1,
            stopReason: "repeated_tool_calls",
            repeatedToolPattern: formatRepeatedToolPattern(validToolCalls),
          });
          this.addStep({
            type: "answer",
            content: fallback,
            timestamp: Date.now(),
          });
          return fallback;
        }
      } else {
        fcStaleCount = 0;
        repeatedToolCorrectionIssued = false;
      }
      prevToolCallsKey = curToolCallsKey;

      const parsedCalls = validToolCalls.map((tc) => {
        const { params: toolParams, parseError } = parseToolCallArguments(
          tc.function.arguments || "{}",
        );
        return { tc, toolName: tc.function.name, toolParams, parseError };
      });

      for (const { toolName } of parsedCalls) {
        if (!this.tools.find((t) => t.name === toolName)) {
          unknownToolCount++;
          if (unknownToolCount >= 3) {
            throw new Error(
              "FC_INCOMPATIBLE: too many unknown tool calls, model may not be compatible with FC",
            );
          }
        } else {
          unknownToolCount = 0;
        }
      }

      const canParallel =
        parsedCalls.length > 1 &&
        parsedCalls.every(({ toolName }) => {
          const tool = this.tools.find((t) => t.name === toolName);
          if (!tool) return false;
          if (toolName === "ask_clarification") return false;
          if (tool.readonly) return true;
          return (
            !tool.dangerous &&
            !this.config.dangerousToolPatterns?.some((p) =>
              toolName.toLowerCase().includes(p.toLowerCase()),
            )
          );
        });

      type PipelineResult = Awaited<
        ReturnType<ReActAgent["executeToolPipeline"]>
      >;
      type CallResult = {
        tc: AIToolCall;
        toolName: string;
        result: PipelineResult;
      };

      let callResults: CallResult[];
      if (canParallel) {
        callResults = await Promise.all(
          parsedCalls.map(
            async ({
              tc,
              toolName,
              toolParams,
              parseError,
            }): Promise<CallResult> => {
              if (parseError) {
                this.maybeLogRepeatedMalformedWriteToolCall(
                  toolName,
                  tc.function.arguments || "{}",
                  parseError,
                  userInput,
                );
                return {
                  tc,
                  toolName,
                  result: {
                    outputStr: parseError,
                    error: parseError,
                    errorResult: {
                      type: ToolErrorType.ParseError,
                      tool: toolName,
                      message: parseError,
                      recoverable: true,
                    },
                  },
                };
              }
              return {
                tc,
                toolName,
                result: await this.executeToolPipeline(
                  toolName,
                  toolParams,
                  userInput,
                  signal,
                ),
              };
            },
          ),
        );
      } else {
        callResults = [];
        for (const { tc, toolName, toolParams, parseError } of parsedCalls) {
          if (parseError) {
            this.maybeLogRepeatedMalformedWriteToolCall(
              toolName,
              tc.function.arguments || "{}",
              parseError,
              userInput,
            );
          }
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
              : await this.executeToolPipeline(
                  toolName,
                  toolParams,
                  userInput,
                  signal,
                ),
          });
        }
      }
      let quickAnswerFound: string | undefined;

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: callResults.map((r) => r.tc),
      });

      let taskDoneResult: string | undefined;
      /** task_done params.summary（纯文本，比 JSON outputStr 更适合展示） */
      let taskDoneSummary: string | undefined;
      /** task_done params.result / params.answer（用于内容型子任务显式交付完整结果） */
      let taskDoneExplicitResult: string | undefined;

      for (const { tc, toolName, result: pipelineResult } of callResults) {
        if (pipelineResult.quickAnswer && !quickAnswerFound) {
          quickAnswerFound = pipelineResult.quickAnswer;
        }
        if (pipelineResult.rejected) rejectedDangerousActionCount++;

        if (toolName === "task_done") {
          taskDoneResult = pipelineResult.outputStr || "任务已完成。";
          // 尝试从工具调用参数中提取 summary 文本（人类可读，非 JSON）
          try {
            const doneParams = parseToolCallArguments(
              tc.function.arguments || "{}",
            ).params as { summary?: string; result?: unknown; answer?: unknown };
            if (doneParams.summary) taskDoneSummary = doneParams.summary.trim();
            const explicitResultCandidates = [doneParams.result, doneParams.answer]
              .map((value) => {
                if (typeof value === "string") return value.trim();
                if (value == null) return "";
                try {
                  return JSON.stringify(value);
                } catch {
                  return String(value);
                }
              })
              .filter((value) => value.length > 0);
            if (explicitResultCandidates.length > 0) {
              taskDoneExplicitResult = explicitResultCandidates[0];
            }
          } catch {
            /* ignore */
          }
        }

        if (
          toolName === "install_clawhub_skill"
          && pipelineResult.rawOutput
          && typeof pipelineResult.rawOutput === "object"
        ) {
          const installOutput = pipelineResult.rawOutput as {
            installed?: unknown;
            resumeRequired?: unknown;
            resumePrompt?: unknown;
          };
          if (installOutput.installed === true && installOutput.resumeRequired === true) {
            taskDoneSummary =
              typeof installOutput.resumePrompt === "string" && installOutput.resumePrompt.trim()
                ? installOutput.resumePrompt.trim()
                : "已安装所需 ClawHub skill，已自动排入后续续跑任务。";
            taskDoneResult =
              "ClawHub skill 安装完成。当前 run 到此结束，系统会在下一次 run 中基于新 skill 继续处理刚才任务。";
          }
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
          messages.push({
            role: "tool",
            content: outputWithHint,
            tool_call_id: tc.id,
            name: toolName,
          });
        } else {
          toolFailCounts.delete(toolName);
          messages.push({
            role: "tool",
            content: pipelineResult.outputStr,
            tool_call_id: tc.id,
            name: toolName,
          });
        }
      }

      // ── Checkpoint: 阶段性进度总结 ──
      for (const r of callResults) {
        fcCheckpointBuffer.push({
          toolName: r.toolName,
          error: !!r.result.error,
        });
      }
      toolCallsSinceCheckpoint += callResults.length;
      if (toolCallsSinceCheckpoint >= CHECKPOINT_INTERVAL) {
        const summary = this.buildCheckpointSummary(fcCheckpointBuffer);
        if (summary) {
          this.addStep({
            type: "checkpoint",
            content: summary,
            timestamp: Date.now(),
          });
        }
        toolCallsSinceCheckpoint = 0;
        fcCheckpointBuffer.length = 0;
      }

      if (quickAnswerFound) return quickAnswerFound;

      if (taskDoneResult) {
        const lastAnswerStep = [...this.steps]
          .reverse()
          .find((s) => s.type === "answer");
        const answer =
          this.pickBestFinalAnswer(userInput, [
            taskDoneExplicitResult,
            lastAnswerStep?.content,
            this.lastStreamingAnswer.length > 50
              ? this.lastStreamingAnswer
              : undefined,
            taskDoneSummary,
            taskDoneResult,
          ]) || taskDoneResult;
        if (!lastAnswerStep) {
          this.addStep({
            type: "answer",
            content: answer,
            timestamp: Date.now(),
          });
        }
        return answer;
      }
    }

    const fallback = this.buildIterationExhaustedSummary({
      iterationsUsed: this.config.maxIterations,
      stopReason: "iteration_limit_reached",
    });
    this.addStep({
      type: "answer",
      content: fallback,
      timestamp: Date.now(),
    });
    return fallback;
  }

  // ── 文本 ReAct 模式的执行循环 ──

  private async runText(
    userInput: string,
    signal?: AbortSignal,
    images?: string[],
  ): Promise<string> {
    const messages = this.buildTextConversation(userInput);
    const isComplex =
      this.isComplexQuery(userInput) && this.history.length === 0;
    const effectiveTextInput = isComplex
      ? this.buildPlanningHint(userInput)
      : userInput;
    const userMsg: { role: "user"; content: string; images?: string[] } = {
      role: "user",
      content: effectiveTextInput,
    };
    if (images?.length) userMsg.images = images;
    messages.push(userMsg);
    let rejectedDangerousActionCount = 0;
    let guardRailRetryCount = 0;
    let memoryRecallCorrectionCount = 0;
    const MAX_GUARD_RAIL_RETRIES = 2;
    const textToolFailCounts = new Map<string, number>();
    let textToolCallsSinceCheckpoint = 0;
    const TEXT_CHECKPOINT_INTERVAL = 3;
    const textCheckpointBuffer: Array<{ toolName: string; error: boolean }> =
      [];

    let textIterationWarningIdx = -1;
    let prevResponseContent = "";
    let staleCount = 0;
    let textEmptyCount = 0;

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (signal?.aborted) throw new Error("Aborted");
      this.emitTraceEvent("llm_round_started", {
        count: i + 1,
        phase: "text",
      });

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
      let usedChatFallback = false;
      const compactedTextMessages = prepareMessagesForModel(
        messages,
        this.config.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
        this.config.patchDanglingToolCalls === true,
      );
      this.recordTrajectory({
        type: "llm_call",
        mode: this.mode,
        tokenEstimate: estimateMessagesTokens(compactedTextMessages),
      });
      try {
        responseContent = await this.streamTextLLM(
          compactedTextMessages,
          signal,
        );
      } catch (e) {
        if ((e as Error).message === "Aborted") throw e;
        this.emitTraceEvent("llm_retry", {
          count: i + 1,
          phase: "text_chat_fallback",
          preview: previewTraceValue(e instanceof Error ? e.message : String(e)),
        });
        const response = await this.ai.chat({
          messages: compactedTextMessages,
          temperature: this.config.temperature,
          signal,
        });
        responseContent = response.content;
        usedChatFallback = true;
      }

      if (signal?.aborted) throw new Error("Aborted");

      let trimmed = responseContent.trim();
      if (!trimmed && !usedChatFallback) {
        try {
          this.emitTraceEvent("llm_retry", {
            count: i + 1,
            phase: "text_empty_retry",
          });
          const response = await this.ai.chat({
            messages: compactedTextMessages,
            temperature: this.config.temperature,
            signal,
          });
          responseContent = response.content ?? "";
          trimmed = responseContent.trim();
          usedChatFallback = true;
        } catch (e) {
          if ((e as Error).message === "Aborted") throw e;
        }
      }

      if (!trimmed) {
        textEmptyCount++;
        if (textEmptyCount >= EMPTY_MODEL_OUTPUT_LIMIT) {
          const fallback = this.buildIterationExhaustedSummary({
            iterationsUsed: i + 1,
            stopReason: "empty_model_output",
          });
          this.addStep({
            type: "answer",
            content: fallback,
            timestamp: Date.now(),
          });
          return fallback;
        }
        this.addStep({
          type: "observation",
          content: `模型刚才没有返回任何可见内容，正在自动重试（${textEmptyCount}/${EMPTY_MODEL_OUTPUT_LIMIT}）...`,
          timestamp: Date.now(),
        });
        messages.push({ role: "assistant", content: "" });
        messages.push({
          role: "user",
          content: "你上一轮返回了空响应。禁止留空；下一轮必须直接给出可见回答，或按规定格式输出 Thought/Action/Action Input 或 Final Answer。",
        });
        continue;
      }
      textEmptyCount = 0;
      this.emitTraceEvent("llm_round_completed", {
        count: i + 1,
        phase: "text",
        status: usedChatFallback ? "chat_fallback" : "content",
        preview: previewTraceValue(trimmed),
      });

      const prevTrimmed = prevResponseContent.trim();
      const compareLen = Math.min(300, trimmed.length, prevTrimmed.length);
      const isSimilar =
        compareLen > 20 &&
        trimmed.slice(0, compareLen) === prevTrimmed.slice(0, compareLen);
      if (isSimilar) {
        staleCount++;
        if (staleCount >= 2) {
          this.addStep({
            type: "answer",
            content: trimmed,
            timestamp: Date.now(),
          });
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
        const memoryRecallCorrection =
          memoryRecallCorrectionCount < 2
            ? this.buildMemoryRecallCorrection(userInput)
            : null;
        if (memoryRecallCorrection) {
          memoryRecallCorrectionCount++;
          messages.push({ role: "assistant", content: responseContent });
          messages.push({ role: "user", content: memoryRecallCorrection });
          continue;
        }
        const guardRailCorrection =
          guardRailRetryCount < MAX_GUARD_RAIL_RETRIES
            ? this.checkAnswerGuardRails(
                parsed.finalAnswer,
                userInput,
                rejectedDangerousActionCount,
              )
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
        if (parsed.actionInputParseError) {
          this.emitTraceEvent("tool_call_blocked", {
            tool: parsed.action,
            status: "parse_error",
            preview: previewTraceValue(parsed.actionInputRaw ?? parsed.actionInputParseError, 160),
          });
          this.addStep({
            type: "error",
            content: parsed.actionInputParseError,
            toolName: parsed.action,
            timestamp: Date.now(),
          });
          messages.push({ role: "assistant", content: responseContent });
          messages.push({ role: "user", content: `Observation: ${parsed.actionInputParseError}` });
          continue;
        }
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

        // Checkpoint for text ReAct
        textCheckpointBuffer.push({
          toolName: parsed.action,
          error: !!pipelineResult.error,
        });
        textToolCallsSinceCheckpoint++;
        if (textToolCallsSinceCheckpoint >= TEXT_CHECKPOINT_INTERVAL) {
          const summary = this.buildCheckpointSummary(textCheckpointBuffer);
          if (summary) {
            this.addStep({
              type: "checkpoint",
              content: summary,
              timestamp: Date.now(),
            });
          }
          textToolCallsSinceCheckpoint = 0;
          textCheckpointBuffer.length = 0;
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

    const fallback = this.buildIterationExhaustedSummary({
      iterationsUsed: this.config.maxIterations,
      stopReason: "iteration_limit_reached",
    });
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
  async run(
    userInput: string,
    signal?: AbortSignal,
    images?: string[],
  ): Promise<string> {
    if (this.running) throw new Error("Agent is already running");
    this.running = true;
    this.currentSignal = signal;
    this.steps = [];
    this.trajectory = [];
    this.lastStreamingAnswer = "";
    this.loopDetector.reset();
    this.approvedDangerousKeys.clear();
    this.successfulCallCache.clear();
    this.fileMutationTrace.clear();
    this.fileMutationParseTrace.clear();
    this.mode = this.config.initialMode ?? "execute";

    try {
      // 判断是否可以使用 Function Calling
      const canUseFC =
        !this.config.forceTextMode &&
        typeof this.ai.streamWithTools === "function";

      if (canUseFC && this.fcAvailable !== false) {
        const FC_MAX_TRANSPORT_RETRIES = 1;
        const FC_FIRST_CHUNK_RETRIES = 1;
        for (let fcRetryCount = 0; ; fcRetryCount++) {
          try {
            const result = await this.runFC(userInput, signal, images);
            this.fcAvailable = true;
            return result;
          } catch (e) {
            if ((e as Error).message === "Aborted") throw e;

            const errMsg = (e as Error).message || "";
            const isFCIncompatible = isFCCompatibilityErrorMessage(errMsg);
            const isTransportOrTimeout =
              isTransportOrTimeoutErrorMessage(errMsg);
            const isFirstChunkStall = isFirstChunkStallErrorMessage(errMsg);

            if (isFCIncompatible) {
              this.fcAvailable = false;
              if (this.fcCompatibilityKey) {
                fcIncompatibleCache.set(this.fcCompatibilityKey, Date.now());
                pruneFCCache();
              }
            }

            if (isFCIncompatible) {
              handleError(e, {
                context: "ReAct Agent Function Calling 降级为文本模式",
                level: ErrorLevel.Warning,
                silent: true,
              });
              this.addStep({
                type: "observation",
                content:
                  "Function Calling 模式不可用，已自动切换至文本 ReAct 模式。",
                timestamp: Date.now(),
              });
              return await this.runText(userInput, signal, images);
            }

            if (isFirstChunkStall && fcRetryCount < FC_FIRST_CHUNK_RETRIES) {
              const delay = 1500;
              this.emitTraceEvent("llm_retry", {
                count: fcRetryCount + 1,
                phase: "fc_first_chunk_retry",
                elapsed_ms: delay,
                preview: previewTraceValue(errMsg),
              });
              this.addStep({
                type: "observation",
                content: "Function Calling 首个响应迟迟未到，正在快速重试；若仍失败将自动切换到文本模式。",
                timestamp: Date.now(),
              });
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }

            if (isFirstChunkStall) {
              handleError(e, {
                context: "ReAct Agent Function Calling 首包卡住，降级为文本模式",
                level: ErrorLevel.Warning,
                silent: true,
              });
              this.addStep({
                type: "observation",
                content:
                  "Function Calling 首个响应持续卡住，已自动切换至文本 ReAct 模式。",
                timestamp: Date.now(),
              });
              return await this.runText(userInput, signal, images);
            }

            // 传输/stall 类错误：自动重试最多 FC_MAX_TRANSPORT_RETRIES 次
            if (
              isTransportOrTimeout &&
              fcRetryCount < FC_MAX_TRANSPORT_RETRIES
            ) {
              const delay = (fcRetryCount + 1) * 3000;
              this.emitTraceEvent("llm_retry", {
                count: fcRetryCount + 1,
                phase: "fc_transport_retry",
                elapsed_ms: delay,
                preview: previewTraceValue(errMsg),
              });
              this.addStep({
                type: "observation",
                content: `网络/流传输错误，${delay / 1000}秒后自动重试（第${fcRetryCount + 1}次）...`,
                timestamp: Date.now(),
              });
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }

            if (isTransportOrTimeout) {
              handleError(e, {
                context: "ReAct Agent Function Calling 传输不稳定，降级为文本模式",
                level: ErrorLevel.Warning,
                silent: true,
              });
              this.addStep({
                type: "observation",
                content:
                  "Function Calling 连接不稳定，已自动切换至文本 ReAct 模式继续执行。",
                timestamp: Date.now(),
              });
              return await this.runText(userInput, signal, images);
            }

            if (!isTransportOrTimeout) {
              handleError(e, {
                context:
                  "ReAct Agent Function Calling 执行失败（保留结构化模式）",
                level: ErrorLevel.Warning,
                silent: true,
              });
            }
            throw e;
          }
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

  private recordTrajectory(
    entry: Omit<TrajectoryEntry, "step" | "timestamp">,
  ): void {
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
