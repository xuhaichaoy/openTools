import {
  AgentActor,
  DIALOG_FULL_ROLE,
  type AskUserCallback,
  type ConfirmDangerousAction,
} from "./agent-actor";
import { isLikelyVisualAttachmentPath } from "@/core/ai/ai-center-handoff";
import type {
  ApprovalRequest,
  AgentCapability,
  AgentCapabilities,
  ActorConfig,
  ActorEvent,
  DialogSubtaskExecutionIntent,
  DialogSubtaskProfile,
  DialogArtifactRecord,
  DialogExecutionMode,
  DialogExecutionPlan,
  DialogMessage,
  DialogRoomCompactionState,
  ExecutionPolicy,
  InboxMessage,
  PendingInteraction,
  PendingInteractionReplyMode,
  PendingInteractionResult,
  PendingInteractionType,
  PendingReply,
  SessionUploadRecord,
  SpawnMode,
  SpawnTaskOverrides,
  SpawnedTaskRecord,
  SpawnedTaskRoleBoundary,
  SpawnedTaskEventDetail,
  ToolPolicy,
} from "./types";
import {
  appendDialogMessageSync as appendDialogMessage,
  appendSpawnEventSync as appendSpawnEvent,
  appendAnnounceEventSync as appendAnnounceEvent,
  updateTranscriptActors,
  archiveSession,
  deleteTranscriptSession,
  clearSessionCache,
} from "./actor-transcript";
import { ActorCron } from "./actor-cron";
import { cloneDialogRoomCompaction } from "./dialog-room-compaction";
import {
  DialogSubtaskRuntime,
  resolveDialogSubtaskProfile,
} from "./dialog-subtask-runtime";
import { clearSessionApprovals, clearAllTodos, resetTitleGeneration, clearTelemetry } from "./middlewares";
import {
  buildSpawnTaskExecutionHint,
} from "./spawned-task-result-validator";
import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import {
  cloneExecutionContract,
  resolveChildExecutionSettings,
} from "@/core/collaboration/execution-contract";
import type { ExecutionContract } from "@/core/collaboration/types";
import { createLogger } from "@/core/logger";
import {
  getDialogStepTracePath,
  isDialogFullTraceEnabled,
  isDialogStepTraceEnabled,
  resetDialogStepTrace,
  traceDialogActorSystemEvent,
  traceDialogFlowEvent,
  traceDialogSessionStarted,
} from "./dialog-step-trace";
import { splitStructuredMediaReply } from "@/core/media/structured-media";
import {
  buildExecutionContractFromLegacyDialogExecutionPlan,
  buildLegacyDialogExecutionPlanFromContract,
  cloneLegacyDialogExecutionPlan,
  type LegacyDialogExecutionPlanRuntimeState,
} from "./dialog-execution-plan-compat";
import { getRoleBoundaryPolicyProfile } from "./execution-policy";
import {
  DEFAULT_DIALOG_WORKER_BUDGET_SECONDS,
  DEFAULT_DIALOG_WORKER_IDLE_LEASE_SECONDS,
  isTimeoutErrorMessage,
  normalizePositiveSeconds,
} from "./timeout-policy";

const generateId = (): string => {
  // 使用更安全的随机 ID 生成
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 12);
  return `${timestamp}-${randomPart}`;
};

const ASK_AGENT_TIMEOUT_MS = 120_000; // 2 min default
const MAX_SPAWN_DEPTH = 3; // 最大 spawn 链深度
const MAX_CHILDREN_PER_AGENT = 5; // 单个 Agent 同时运行的子任务上限
const MAX_ACTIVE_DIALOG_CHILDREN = 3; // Dialog 软并发上限：超出后进入待派发队列
const ANNOUNCE_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;
const ANNOUNCE_HARD_EXPIRY_MS = 30 * 60 * 1000; // 30 分钟硬超时
const RESULT_SHAREABLE_ARTIFACT_SOURCES = new Set(["message", "tool_write", "tool_edit"]);
const USER_SHAREABLE_ARTIFACT_DIR_PATTERNS = [
  /(?:^|\/)downloads(?:\/|$)/i,
  /(?:^|\/)desktop(?:\/|$)/i,
  /(?:^|\/)documents(?:\/|$)/i,
  /^\/tmp(?:\/|$)/i,
  /^\/var\/folders(?:\/|$)/i,
] as const;
const INLINE_ONLY_EXECUTOR_ALLOW_TOOL_NAMES = [
  "task_done",
  "list_*",
  "read_*",
  "search_*",
  "web_search",
  "calculate",
] as const;

function uniqueNonEmptyStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

const STRICT_NON_CODING_EXECUTOR_DENY_TOOL_NAMES = [
  "list_*",
  "search_*",
  "web_search",
  "read_file",
  "read_file_range",
  "write_file",
  "str_replace_edit",
  "json_edit",
  "export_document",
  "export_spreadsheet",
  "run_shell_command",
  "persistent_shell",
  "delegate_subtask",
  "enter_plan_mode",
  "exit_plan_mode",
] as const;
const INLINE_ONLY_CONTENT_TASK_PATTERNS = [
  /课程|培训|课纲|课程候选|课程名称|课程介绍|课程主题|课题/u,
  /excel|xlsx|xls|csv|表格|工作簿/iu,
  /文档|报告|方案|清单|汇总|提案/u,
] as const;
const GENERAL_TO_EXECUTOR_PROMOTION_PATTERNS = [
  /课程|培训|课纲|课程候选|课程名称|课程介绍|课程主题|课题|清单/u,
  /excel|xlsx|xls|csv|表格|工作簿/iu,
] as const;
const STRONG_CODE_TASK_PATTERNS = [
  /repo|repository|codebase|仓库|项目结构|工程|源码/i,
  /代码|编码|编程|函数|类|模块|接口|重构|修复|debug|bug|报错/i,
  /\/[^\s"'`]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|vue|html|css|scss|less)\b/i,
] as const;
const COURSE_CONTENT_TASK_PATTERNS = [
  /课程|培训|课纲|课程候选|课程名称|课程介绍|课程主题|培训目标|培训对象/u,
  /基于.*(?:excel|xlsx|xls|csv|表格|工作簿)/iu,
  /按主题.*(?:生成|整理|汇总).*(?:课程|条目|清单)/u,
] as const;
const REVIEW_LIKE_TASK_PATTERNS = [
  /review|reviewer|审查|审阅|评审|审核|安全/u,
] as const;
const VALIDATION_LIKE_TASK_PATTERNS = [
  /tester|test|qa|验证|回归|验收|测试/u,
] as const;
const CONTENT_EXECUTOR_ALLOW_TOOL_NAMES = [
  "read_document",
  "calculate",
  "task_done",
] as const;
const CONTENT_EXECUTOR_DENY_TOOL_NAMES = [
  "spawn_task",
  "delegate_subtask",
  "wait_for_spawned_tasks",
  "send_message",
  "agents",
  "ask_user",
  "ask_clarification",
  "send_local_media",
  "enter_plan_mode",
  "exit_plan_mode",
  "memory_*",
  "list_*",
  "read_file",
  "read_file_range",
  "search_*",
  "web_search",
  "write_file",
  "str_replace_edit",
  "json_edit",
  "export_document",
  "export_spreadsheet",
  "run_shell_command",
  "persistent_shell",
  "delete_file",
  "native_*",
  "database_execute",
  "ssh_*",
] as const;
const INLINE_STRUCTURED_RESULT_ALLOW_TOOL_NAMES = [
  "task_done",
] as const;
const INLINE_STRUCTURED_RESULT_DENY_TOOL_NAMES = [
  ...CONTENT_EXECUTOR_DENY_TOOL_NAMES,
  "read_document",
  "calculate",
] as const;
const CODING_INTENT_TOOL_NAMES = new Set([
  "write_file",
  "str_replace_edit",
  "json_edit",
  "run_shell_command",
  "persistent_shell",
  "export_document",
  "export_spreadsheet",
]);

function mergeToolPolicies(
  ...policies: Array<ToolPolicy | undefined>
): ToolPolicy | undefined {
  const allow = [...new Set(
    policies.flatMap((policy) => policy?.allow ?? [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  )];
  const deny = [...new Set(
    policies.flatMap((policy) => policy?.deny ?? [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  )];
  if (allow.length === 0 && deny.length === 0) return undefined;
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
  };
}

function taskLooksLikeCourseContentDelivery(task: string): boolean {
  const normalizedTask = String(task ?? "").trim();
  if (!normalizedTask) return false;
  return COURSE_CONTENT_TASK_PATTERNS.some((pattern) => pattern.test(normalizedTask));
}

function taskExplicitlyRequestsReview(task: string): boolean {
  const normalizedTask = String(task ?? "").trim();
  return REVIEW_LIKE_TASK_PATTERNS.some((pattern) => pattern.test(normalizedTask));
}

function taskExplicitlyRequestsValidation(task: string): boolean {
  const normalizedTask = String(task ?? "").trim();
  return VALIDATION_LIKE_TASK_PATTERNS.some((pattern) => pattern.test(normalizedTask));
}

function overrideToolPolicyEnablesCoding(policy?: ToolPolicy): boolean {
  const allow = policy?.allow ?? [];
  return allow.some((toolName) => CODING_INTENT_TOOL_NAMES.has(String(toolName ?? "").trim()));
}

function isInlineOnlyNonCodingExecutorTask(params: {
  roleBoundary?: SpawnedTaskRoleBoundary;
  task: string;
}): boolean {
  if (params.roleBoundary !== "executor") return false;
  const normalizedTask = String(params.task ?? "").trim();
  const contentLike = INLINE_ONLY_CONTENT_TASK_PATTERNS.some((pattern) => pattern.test(normalizedTask));
  const strongCodeLike = STRONG_CODE_TASK_PATTERNS.some((pattern) => pattern.test(normalizedTask));
  if (taskLooksLikeCourseContentDelivery(normalizedTask)) return true;
  if (contentLike && !strongCodeLike) return true;
  const inferred = inferCodingExecutionProfile({ query: params.task });
  return !inferred.profile.codingMode;
}

function shouldPromoteGeneralTaskToExecutor(task: string): boolean {
  const normalizedTask = String(task ?? "").trim();
  if (!normalizedTask) return false;
  if (taskLooksLikeCourseContentDelivery(normalizedTask)) return true;
  const contentLike = GENERAL_TO_EXECUTOR_PROMOTION_PATTERNS.some((pattern) => pattern.test(normalizedTask));
  const strongCodeLike = STRONG_CODE_TASK_PATTERNS.some((pattern) => pattern.test(normalizedTask));
  return contentLike && !strongCodeLike;
}

function buildStrictContentExecutorToolPolicy(overrideToolPolicy?: ToolPolicy): ToolPolicy {
  const deny = uniqueNonEmptyStrings([
    ...CONTENT_EXECUTOR_DENY_TOOL_NAMES,
    ...(overrideToolPolicy?.deny ?? []),
  ]);
  return {
    allow: [...CONTENT_EXECUTOR_ALLOW_TOOL_NAMES],
    ...(deny.length > 0 ? { deny } : {}),
  };
}

function buildInlineStructuredResultToolPolicy(overrideToolPolicy?: ToolPolicy): ToolPolicy {
  const deny = uniqueNonEmptyStrings([
    ...INLINE_STRUCTURED_RESULT_DENY_TOOL_NAMES,
    ...(overrideToolPolicy?.deny ?? []),
  ]);
  return {
    allow: [...INLINE_STRUCTURED_RESULT_ALLOW_TOOL_NAMES],
    ...(deny.length > 0 ? { deny } : {}),
  };
}

function resolveDialogSubtaskExecutionIntent(params: {
  roleBoundary?: SpawnedTaskRoleBoundary;
  task: string;
  overrideToolPolicy?: ToolPolicy;
  explicitExecutionIntent?: DialogSubtaskExecutionIntent;
}): DialogSubtaskExecutionIntent {
  if (params.explicitExecutionIntent) return params.explicitExecutionIntent;
  const normalizedTask = String(params.task ?? "").trim();
  if (params.roleBoundary === "reviewer" && taskExplicitlyRequestsReview(normalizedTask)) return "reviewer";
  if (params.roleBoundary === "validator" && taskExplicitlyRequestsValidation(normalizedTask)) return "validator";
  if (taskLooksLikeCourseContentDelivery(normalizedTask)) {
    return overrideToolPolicyEnablesCoding(params.overrideToolPolicy) ? "coding_executor" : "content_executor";
  }
  if (params.roleBoundary === "reviewer") return "reviewer";
  if (params.roleBoundary === "validator") return "validator";
  if (params.roleBoundary === "executor") {
    if (overrideToolPolicyEnablesCoding(params.overrideToolPolicy)) return "coding_executor";
    return isInlineOnlyNonCodingExecutorTask({ roleBoundary: params.roleBoundary, task: normalizedTask })
      ? "content_executor"
      : "coding_executor";
  }
  return "general";
}

function buildExecutionIntentToolPolicy(params: {
  executionIntent: DialogSubtaskExecutionIntent;
  resultContract?: "default" | "inline_structured_result";
  overrideToolPolicy?: ToolPolicy;
}): ToolPolicy | undefined {
  switch (params.executionIntent) {
    case "content_executor":
      return params.resultContract === "inline_structured_result"
        ? buildInlineStructuredResultToolPolicy(params.overrideToolPolicy)
        : buildStrictContentExecutorToolPolicy(params.overrideToolPolicy);
    case "coding_executor":
      return mergeToolPolicies(getRoleBoundaryPolicyProfile("executor").toolPolicy, params.overrideToolPolicy);
    case "reviewer":
      return mergeToolPolicies(getRoleBoundaryPolicyProfile("reviewer").toolPolicy, params.overrideToolPolicy);
    case "validator":
      return mergeToolPolicies(getRoleBoundaryPolicyProfile("validator").toolPolicy, params.overrideToolPolicy);
    default:
      return params.overrideToolPolicy;
  }
}

function buildExecutorTaskSpecificToolPolicy(params: {
  roleBoundary?: SpawnedTaskRoleBoundary;
  task: string;
}): ToolPolicy | undefined {
  if (!isInlineOnlyNonCodingExecutorTask(params)) return undefined;
  return {
    allow: [...INLINE_ONLY_EXECUTOR_ALLOW_TOOL_NAMES],
    deny: [...STRICT_NON_CODING_EXECUTOR_DENY_TOOL_NAMES],
  };
}

function sanitizeInlineOnlyExecutorTask(task: string): string {
  const normalized = task.trim();
  if (!normalized) return normalized;

  return normalized
    .replace(
      /生成一批课程候选\s*json/giu,
      "直接在 terminal result 返回完整课程候选列表（每条至少包含课程名称和课程介绍）",
    )
    .replace(
      /(?:输出|结果|内容|课程候选|最终结果|最终内容|产物)[^。；;\n]{0,80}?(?:保存到|写入到|写到|落到|输出到|导出到)\s*`?(\/[^\s`，。,；;]+)`?/giu,
      "直接在 terminal result 中返回结果，不要写入中间文件",
    )
    .replace(
      /(?:文件(?:路径)?|输出路径)[:：]\s*`?(\/[^\s`，。,；;]+\.(?:json|txt|md|csv|xlsx?|docx?))`?/giu,
      "不要生成中间文件",
    )
    .replace(
      /并返回摘要/gu,
      "并在末尾附一行简短摘要（前面必须先给完整结果）",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 错误分类：对标 OpenClaw announce 机制
const TRANSIENT_ERROR_PATTERNS = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/i,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
] as const;

const PERMANENT_ERROR_PATTERNS = [
  /unknown actor/i,
  /actor.*not found/i,
  /invalid.*target/i,
] as const;

type DeferredSpawnRequest = {
  id: string;
  spawnerActorId: string;
  targetActorId: string;
  task: string;
  queuedAt: number;
  label?: string;
  context?: string;
  attachments?: string[];
  images?: string[];
  timeoutSeconds?: number;
  mode?: SpawnMode;
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  roleBoundary?: SpawnedTaskRoleBoundary;
  profile: DialogSubtaskProfile;
  executionIntent?: DialogSubtaskExecutionIntent;
  createIfMissing?: boolean;
  createChildSpec?: {
    description?: string;
    capabilities?: AgentCapability[];
    workspace?: string;
  };
  overrides?: SpawnTaskOverrides;
  plannedDelegationId?: string;
};

function isTransientAnnounceError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (!msg) return false;

  // 先检查是否是 permanent 错误
  if (PERMANENT_ERROR_PATTERNS.some((p) => p.test(msg))) {
    return false;
  }

  // 检查是否是 transient 错误
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg));
}

function isRetryableDeferredSpawnError(message: string): boolean {
  return [
    /max active children reached/i,
    /已达到并发子任务上限/u,
    /already running a task/i,
    /正在执行其他任务/u,
    /请等待空闲/u,
  ].some((pattern) => pattern.test(message));
}

type EphemeralChildRoleBoundary = {
  role: SpawnedTaskRoleBoundary;
  systemPromptAppend?: string;
  toolPolicy?: ToolPolicy;
  executionPolicy?: ExecutionPolicy;
};

function buildEphemeralChildBoundary(role: SpawnedTaskRoleBoundary): EphemeralChildRoleBoundary {
  const profile = getRoleBoundaryPolicyProfile(role);
  switch (role) {
    case "reviewer":
      return {
        role,
        toolPolicy: profile.toolPolicy,
        executionPolicy: profile.executionPolicy,
        systemPromptAppend: [
          "你当前是独立审查子 Agent。",
          "默认不要修改文件、不要运行写操作、不要直接接管实现任务。",
          "不要使用 send_message / ask_user / ask_clarification / delegate_subtask / enter_plan_mode / exit_plan_mode；最终结论直接写进 terminal result。",
          "重点输出发现、风险、证据和建议修复方向；如果认为必须改代码，应回传上游协调者，由其决定是否另派实现任务。",
        ].join("\n"),
      };
    case "validator":
      return {
        role,
        toolPolicy: profile.toolPolicy,
        executionPolicy: profile.executionPolicy,
        systemPromptAppend: [
          "你当前是验证子 Agent。",
          "默认不要修改代码；重点做复现、测试、验收和回归检查。",
          "不要使用 send_message / ask_user / ask_clarification / delegate_subtask / enter_plan_mode / exit_plan_mode；最终结论直接写进 terminal result。",
          "可以运行测试、构建或检查命令，但若被实现缺口阻塞，应明确说明阻塞点和建议的上游动作。",
        ].join("\n"),
      };
    case "executor":
      return {
        role,
        toolPolicy: profile.toolPolicy,
        executionPolicy: profile.executionPolicy,
        systemPromptAppend: [
          "你当前是执行子 Agent。",
          "聚焦实现、修复或探索，不要抢协调权。",
          "不要使用 send_message / ask_user / ask_clarification / delegate_subtask / enter_plan_mode / exit_plan_mode；最终结果、验证结论和 blocker 直接写进 terminal result。",
          "如果任务属于课程生成、内容整理、方案撰写、资料汇总这类非 coding 工作，默认直接在 terminal result 返回完整结果，不要写中间 JSON / TSV / Markdown 文件。",
          "如需额外审查或验证，优先把结果和缺口写进终态结果回传给上游协调者，再由其继续分派。",
        ].join("\n"),
      };
    default:
      return {
        role: "general",
        toolPolicy: profile.toolPolicy,
        executionPolicy: profile.executionPolicy,
        systemPromptAppend: [
          "你当前是通用支援子 Agent。",
          "聚焦补充分析、资料整理和局部线索确认，默认不要修改文件或继续派发新的子任务。",
          "不要使用 send_message / ask_user / ask_clarification / delegate_subtask / enter_plan_mode / exit_plan_mode；最终结论直接写进 terminal result。",
          "如果发现需要新增实现、审查或验证线程，请把建议与原因回传给上游协调者，由其继续派工。",
        ].join("\n"),
      };
  }
}

function inferEphemeralChildBoundary(params: {
  name: string;
  description?: string;
  capabilities?: AgentCapability[];
}): EphemeralChildRoleBoundary {
  const text = `${params.name}\n${params.description ?? ""}`.toLowerCase();
  const capabilities = new Set(params.capabilities ?? []);
  const reviewLike =
    capabilities.has("code_review")
    || capabilities.has("security")
    || /review|reviewer|审查|审阅|评审|审核|安全/.test(text);
  const validationLike =
    capabilities.has("testing")
    || /tester|test|qa|验证|回归|验收|测试/.test(text);
  const executorLike =
    capabilities.has("code_write")
    || capabilities.has("debugging")
    || /fix|fixer|implement|coder|修复|实现|开发|编码/.test(text);

  if (reviewLike && !executorLike) {
    return buildEphemeralChildBoundary("reviewer");
  }

  if (validationLike && !executorLike) {
    return buildEphemeralChildBoundary("validator");
  }

  if (executorLike) {
    return buildEphemeralChildBoundary("executor");
  }

  return buildEphemeralChildBoundary("general");
}

function formatRoleBoundaryLabel(role: SpawnedTaskRoleBoundary): string | null {
  switch (role) {
    case "reviewer":
      return "独立审查";
    case "validator":
      return "验证回归";
    case "executor":
      return "执行实现";
    default:
      return null;
  }
}

function buildSpawnTaskRoleBoundaryInstruction(role: SpawnedTaskRoleBoundary): string | undefined {
  switch (role) {
    case "reviewer":
      return "你本轮是独立审查角色。重点检查边界条件、回归风险、证据和修复建议，默认不要直接接管实现。";
    case "validator":
      return "你本轮是验证角色。重点做复现、测试、构建、验收和回归检查，默认不要直接修改代码。";
    case "executor":
      return "你本轮是执行角色。聚焦实现、修复和探索，不要抢协调权，也不要继续派发新的子任务；若需要独立审查或验证，请把缺口回传上游。";
    default:
      return "你本轮是通用支援角色。聚焦分析、整理和补充线索，不要继续派发新的子任务；若发现需要新增线程，请把建议回传上游协调者。";
  }
}

function buildDelegatedTaskPrompt(params: {
  spawnerName: string;
  task: string;
  label?: string;
  roleBoundaryInstruction?: string;
  context?: string;
  attachments?: readonly string[];
  executionHint?: string;
  inlineOnly?: boolean;
}): string {
  const task = (params.inlineOnly ? sanitizeInlineOnlyExecutorTask(params.task) : params.task).trim() || "未命名任务";
  const label = params.label?.trim();
  const context = params.context?.trim();
  const attachments = (params.attachments ?? [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  const executionHint = params.executionHint?.trim();

  const lines: string[] = [
    `[由 ${params.spawnerName} 委派的任务]`,
    "",
    "## 任务目标",
    task,
  ];

  if (label && label !== task) {
    lines.push("", "## 任务焦点", label);
  }

  lines.push(
    "",
    "## 协作方式",
    "- 这是主 Agent 委派给你的子任务。你需要在给定目标和边界内自行决定执行步骤。",
    "- 不要等待上游继续逐步指挥，也不要擅自改写任务目标。",
    "- 如果发现缺少关键前提或必须扩大范围，先尽量在当前边界内推进，再明确回报缺口、原因和建议的上游动作。",
  );

  if (params.roleBoundaryInstruction) {
    lines.push("", "## 本轮职责边界", params.roleBoundaryInstruction);
  }

  lines.push(
    "",
    "## 范围与边界",
    attachments.length > 0
      ? "- 优先围绕下方工作集和补充上下文涉及的文件、目录或模块开展工作。"
      : "- 优先围绕任务描述和补充上下文涉及的范围开展工作，不要无边界发散。",
    "- 如需越过当前范围，请确认确有必要，并在结果里说明原因。",
    ...(params.inlineOnly
      ? ["- 这是非 coding 的内容执行任务：不要读取或复用 Downloads / 历史目录里的旧 JSON、旧产物或重跑文件。"]
      : []),
  );

  if (context) {
    lines.push("", "## 已知上下文", context);
  }

  if (attachments.length > 0) {
    lines.push("", "## 工作集 / 附件文件", ...attachments.map((file) => `- ${file}`));
  }

  lines.push(
    "",
    "## 交付要求",
    "- 返回时给出结论、关键证据和下一步建议，不要只回复“已处理”或“看过了”。",
    "- 若任务涉及代码、文件、页面或验证，请优先提供文件路径、关键修改点、命令或测试结果等可核查信息。",
    "- 若未完成，请明确说明阻塞原因、已完成部分和建议的后续动作。",
    ...(params.inlineOnly
      ? [
          "- 不要写入任何中间 JSON / 临时文件；直接在 terminal result 返回结构化结果，由父 Agent 统一导出最终交付。",
          "- 如果任务是在整理课程、表格、文档或候选清单，先给完整结果，再在末尾补一行简短摘要；不要只回摘要。",
          "- 当你使用 `task_done` 结束任务时，确保完整结果已经出现在 answer / streaming answer 中，避免只留下 summary。",
        ]
      : []),
  );

  if (executionHint) {
    lines.push("", executionHint);
  }

  return lines.join("\n");
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message || "error";
  if (typeof error === "string") return error;
  return "unknown error";
}

function basename(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function normalizePath(path?: string | null): string {
  return String(path ?? "").trim().replace(/\\/g, "/");
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function dirname(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/") || "/";
}

function inferLanguageFromPath(path: string): string | undefined {
  const fileName = basename(path).toLowerCase();
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    default:
      return ext || undefined;
  }
}

function isPathWithinDirectory(path: string, directory?: string): boolean {
  const normalizedPath = trimTrailingSlash(normalizePath(path));
  const normalizedDirectory = trimTrailingSlash(normalizePath(directory));
  if (!normalizedPath || !normalizedDirectory) return false;
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

function isLikelyUserShareableArtifactPath(path: string, workspace?: string): boolean {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return false;
  if (isLikelyVisualAttachmentPath(normalizedPath)) return true;

  const normalizedWorkspace = normalizePath(workspace);
  if (normalizedWorkspace) {
    return !isPathWithinDirectory(normalizedPath, normalizedWorkspace);
  }

  return USER_SHAREABLE_ARTIFACT_DIR_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

function collectDialogMessagePreview(items: readonly string[] | undefined, limit = 3): string[] | undefined {
  if (!items?.length) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = String(item || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result.length > 0 ? result : undefined;
}

function getInteractionRequestKind(type: PendingInteractionType): DialogMessage["kind"] {
  switch (type) {
    case "clarification":
      return "clarification_request";
    case "approval":
      return "approval_request";
    default:
      return "agent_message";
  }
}

function getInteractionResponseKind(type: PendingInteractionType): DialogMessage["kind"] {
  switch (type) {
    case "clarification":
      return "clarification_response";
    case "approval":
      return "approval_response";
    default:
      return "user_input";
  }
}

const LOW_SIGNAL_COORDINATION_TEXTS = new Set([
  "收到",
  "已收到",
  "我已收到",
  "好的",
  "明白",
  "明白了",
  "了解",
  "确认",
  "收到感谢",
  "谢谢",
  "感谢",
  "待命",
  "等待指示",
  "任务完成",
  "任务已完成",
  "任务闭环",
]);

const LOW_SIGNAL_COORDINATION_PATTERNS = [
  /^(收到|已收到|我已收到|好的|明白了?|了解|确认|谢谢|感谢)([。！!.,，]*)$/u,
  /^(我(这边)?会配合|我已向.*发送确认|我已经.*保存).*$/u,
  /^(当前状态|任务状态|任务进展)[:：].*$/u,
  /等待.*(任务|指示|安排|分配)/u,
  /请问.*(下一步|需要我做什么|当前任务是什么)/u,
  /(任务已完成|任务闭环|无需重复操作)/u,
] as const;

function isLowSignalCoordinationMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  // 避免误杀长篇有效内容，只针对短协作回执做抑制
  if (trimmed.length > 220) return false;

  const compact = trimmed
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[!！。,.，:：;；?？~～`"'“”‘’]/g, "");

  if (LOW_SIGNAL_COORDINATION_TEXTS.has(compact)) {
    return true;
  }

  return LOW_SIGNAL_COORDINATION_PATTERNS.some((re) => re.test(trimmed));
}

const actorSystemLogger = createLogger("ActorSystem");
const log = (message: string, data?: unknown) => actorSystemLogger.debug(message, data);
const logWarn = (message: string, data?: unknown) => actorSystemLogger.warn(message, data);
let lastTracedActorSystemSessionId: string | null = null;
let lastTracedActorSystemCreatedAt = 0;

function previewActorSystemText(value?: string, maxLength = 120): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function deriveEphemeralActorName(params: {
  targetActorId?: string;
  label?: string;
  description?: string;
  task?: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
}): string {
  const candidates = [
    params.targetActorId,
    params.label,
    params.description,
    previewActorSystemText(params.task, 32),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").replace(/\s+/g, " ").trim();
    if (normalized) return normalized;
  }

  switch (params.roleBoundary) {
    case "reviewer":
      return "Independent Reviewer";
    case "validator":
      return "QA Validator";
    case "executor":
      return "Task Executor";
    default:
      return "Temporary Worker";
  }
}

type SystemEventHandler = (event: ActorEvent | DialogMessage) => void;

// ── Hook System (对标 OpenClaw subagent hooks) ──

/** 扩展的 Hook 类型，匹配 OpenClaw 生命周期 */
export type HookType = 
  | "onSpawn"           // Agent 创建后
  | "beforeSpawn"       // Agent 创建前
  | "onEnd"             // Agent 任务完成
  | "beforeKill"        // Agent 终止前
  | "onKill"            // Agent 终止后
  | "onMessage"         // 消息接收/发送
  | "onTaskStart"       // 任务开始
  | "onTaskError"       // 任务错误
  | "onSpawnTask"       // 子任务派发
  | "onSpawnTaskEnd";   // 子任务完成

export interface HookContext {
  system: ActorSystem;
  actorId: string;
  actorName: string;
  timestamp: number;
}

export interface SpawnHookContext extends HookContext {
  config: ActorConfig;
}

export interface BeforeSpawnHookContext extends HookContext {
  config: ActorConfig;
  /** 如果返回 false，则取消 spawn */
  canContinue?: () => boolean;
}

export interface EndHookContext extends HookContext {
  taskId: string;
  result?: string;
  error?: string;
  elapsed: number;
}

export interface MessageHookContext extends HookContext {
  message: DialogMessage;
  direction: "inbound" | "outbound";
}

export interface TaskStartHookContext extends HookContext {
  taskId: string;
  query: string;
}

export interface TaskErrorHookContext extends HookContext {
  taskId: string;
  error: string;
}

export interface SpawnTaskHookContext extends HookContext {
  spawnerId: string;
  targetId: string;
  task: string;
  mode: "run" | "session";
  runId: string;
}

export interface SpawnTaskEndHookContext extends HookContext {
  spawnerId: string;
  targetId: string;
  task: string;
  runId: string;
  status: "completed" | "error" | "aborted";
  result?: string;
  error?: string;
}

export type HookHandler<T extends HookContext = HookContext> = (ctx: T) => void | Promise<void>;

/**
 * 修改型 Hook 返回结果
 * - modify: 返回修改后的上下文
 * - continue: 继续执行（不做修改）
 * - stop: 阻止操作执行
 */
export interface ModifyResult<T> {
  action: "modify" | "continue" | "stop";
  modified?: T;
  error?: string;
}

/**
 * 修改型 Hook 处理器
 * 可以拦截和修改传入的参数
 */
export type ModifyHookHandler<T extends HookContext = HookContext> = (ctx: T) => ModifyResult<T>;

// Hook 分类
export type VoidHookType = 
  | "onSpawn" | "onEnd" | "onKill" | "onMessage" 
  | "onTaskStart" | "onTaskError" | "onSpawnTask" | "onSpawnTaskEnd";

export type ModifyHookType = "beforeSpawn" | "beforeKill";

export const VOID_HOOKS: VoidHookType[] = [
  "onSpawn", "onEnd", "onKill", "onMessage", 
  "onTaskStart", "onTaskError", "onSpawnTask", "onSpawnTaskEnd"
];

export const MODIFY_HOOKS: ModifyHookType[] = ["beforeSpawn", "beforeKill"];

export interface ActorSystemOptions {
  askUser?: AskUserCallback;
  confirmDangerousAction?: ConfirmDangerousAction;
  defaultProductMode?: "dialog" | "review";
}

/**
 * ActorSystem — 全局 Actor 注册表和消息路由。
 *
 * 管理所有 AgentActor 的生命周期，提供：
 * - Actor 创建 / 销毁
 * - 消息路由（点对点、广播）
 * - 并发任务调度
 * - ask-and-wait 机制（Agent A 向 Agent B 提问并等待回复）
 */
export class ActorSystem {
  private actors = new Map<string, AgentActor>();
  private dialogHistory: DialogMessage[] = [];
  private eventHandlers: SystemEventHandler[] = [];
  private pendingReplies = new Map<string, PendingReply>();
  private pendingInteractions = new Map<string, PendingInteraction>();
  private artifactRecords = new Map<string, DialogArtifactRecord>();
  private sessionUploads = new Map<string, SessionUploadRecord>();
  private stagedResultMedia = new Map<string, Pick<DialogMessage, "images" | "attachments">>();
  private deferredSpawnRequests = new Map<string, DeferredSpawnRequest[]>();
  private deferredSpawnDispatchingOwners = new Set<string>();
  private coordinatorActorId: string | null = null;
  private activeExecutionContract: ExecutionContract | null = null;
  private legacyDialogExecutionPlanRuntimeState: LegacyDialogExecutionPlanRuntimeState | null = null;
  private dialogRoomCompaction: DialogRoomCompactionState | null = null;
  private dialogExecutionMode: DialogExecutionMode = "execute";
  private options: ActorSystemOptions;
  readonly sessionId: string;
  private hooks = new Map<HookType, Array<HookHandler<any>>>();
  private modifyHooks = new Map<ModifyHookType, Array<ModifyHookHandler<any>>>();
  private _cron: ActorCron;
  private readonly dialogSubtaskRuntime: DialogSubtaskRuntime;
  private supportActorCleanupScheduled = false;

  private traceFlow(
    event: string,
    detail?: Record<string, unknown>,
    actorId?: string | null,
  ): void {
    traceDialogFlowEvent({
      sessionId: this.sessionId,
      actorId: actorId ?? this.coordinatorActorId ?? undefined,
      event,
      detail,
    });
  }

  constructor(options: ActorSystemOptions = {}) {
    this.options = options;
    this.sessionId = generateId();
    if (isDialogStepTraceEnabled()) {
      traceDialogSessionStarted(this.sessionId);
      if (isDialogFullTraceEnabled()) {
        const createdAt = Date.now();
        if (
          lastTracedActorSystemSessionId
          && createdAt - lastTracedActorSystemCreatedAt <= 1_500
        ) {
          traceDialogFlowEvent({
            sessionId: this.sessionId,
            event: "system_instance_replaced",
            detail: {
              previous_session: lastTracedActorSystemSessionId.slice(0, 8),
              elapsed_ms: createdAt - lastTracedActorSystemCreatedAt,
            },
          });
        }
        this.traceFlow("system_instance_created");
        lastTracedActorSystemSessionId = this.sessionId;
        lastTracedActorSystemCreatedAt = createdAt;
      }
      void getDialogStepTracePath()
        .then((path) => {
          actorSystemLogger.info("dialog step trace enabled", {
            sessionId: this.sessionId,
            path,
          });
        })
        .catch((error) => {
          actorSystemLogger.warn("dialog step trace path resolve failed", {
            sessionId: this.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    this.dialogSubtaskRuntime = new DialogSubtaskRuntime({
      sessionId: this.sessionId,
      getActor: (actorId) => this.get(actorId),
      getActorName: (actorId) => this.getActorName(actorId),
      getActorNames: () => this.getActorNamesMap(),
      emitEvent: (event) => this.emitEvent(event as ActorEvent),
      appendSpawnEvent: (spawnerActorId, targetActorId, task, runId) =>
        appendSpawnEvent(this.sessionId, spawnerActorId, targetActorId, task, runId),
      appendAnnounceEvent: (runId, status, result, error) =>
        appendAnnounceEvent(this.sessionId, runId, status, result, error),
      announceWithRetry: (fromActorId, toActorId, content, runId) =>
        this.announceWithRetry(fromActorId, toActorId, content, runId),
      finalizeSpawnedTaskHistoryWindow: (record, targetActor) =>
        this.finalizeSpawnedTaskHistoryWindow(record, targetActor),
      cancelPendingInteractionsForActor: (actorId) =>
        this.cancelPendingInteractionsForActor(actorId),
      killActor: (actorId) => this.kill(actorId),
      getArtifactRecordsSnapshot: () => this.getArtifactRecordsSnapshot(),
      onTaskSettled: ({ record, targetActorId, targetName, status, task }) => {
        void this.runHooks<SpawnTaskEndHookContext>("onSpawnTaskEnd", {
          system: this,
          actorId: targetActorId,
          actorName: targetName,
          timestamp: Date.now(),
          spawnerId: record.spawnerActorId,
          targetId: targetActorId,
          task,
          runId: record.runId,
          status,
          result: record.result,
          error: record.error,
        });
        this.dispatchDeferredSpawnTasks(record.spawnerActorId);
        this.tryFinalizeExecutionContract();
        this.scheduleExecutionContractProgressCheck();
      },
    });
    this._cron = new ActorCron(this);
  }

  private scheduleSupportActorCleanupAfterCoordinatorCompletion(): void {
    if (this.supportActorCleanupScheduled) return;
    this.supportActorCleanupScheduled = true;
    queueMicrotask(() => {
      this.supportActorCleanupScheduled = false;
      const coordinatorId = this.coordinatorActorId;
      if (!coordinatorId) return;
      if (this.pendingInteractions.size > 0 || this.pendingReplies.size > 0) return;
      const hasActiveSpawnedTasks = this.dialogSubtaskRuntime.hasActiveSpawnedTasks();
      if (hasActiveSpawnedTasks) return;

      const supportActors = this.getAll().filter((actor) => actor.id !== coordinatorId);
      if (supportActors.length === 0) return;
      if (supportActors.some((actor) => actor.status === "running" || actor.status === "waiting")) return;

      const removableActorIds = supportActors.map((actor) => actor.id);
      log(`🧹 coordinator completed, cleaning up ${removableActorIds.length} support actors`);
      for (const actorId of removableActorIds) {
        this.kill(actorId);
      }
    });
  }

  /** 定时任务调度器（对标 OpenClaw cron） */
  get cron(): ActorCron {
    return this._cron;
  }

  get defaultProductMode(): "dialog" | "review" {
    return this.options.defaultProductMode === "review" ? "review" : "dialog";
  }

  set defaultProductMode(mode: "dialog" | "review") {
    this.options.defaultProductMode = mode === "review" ? "review" : "dialog";
  }

  getDialogExecutionMode(): DialogExecutionMode {
    return this.dialogExecutionMode;
  }

  setDialogExecutionMode(mode: DialogExecutionMode, opts?: { force?: boolean }): void {
    const nextMode: DialogExecutionMode = mode === "plan" ? "plan" : "execute";
    if (this.dialogExecutionMode === nextMode) return;
    const busyActors = this.getAll().filter((actor) => actor.status !== "idle");
    if (!opts?.force && (busyActors.length > 0 || this.dialogSubtaskRuntime.hasActiveSpawnedTasks())) {
      throw new Error("当前仍有运行中的主线程或子任务，暂时不能切换规划模式。");
    }
    this.dialogExecutionMode = nextMode;
    for (const actor of this.actors.values()) {
      actor.setDialogExecutionMode(nextMode);
    }
    this.emitEvent({
      type: "dialog_execution_mode_changed",
      actorId: this.coordinatorActorId ?? "",
      timestamp: Date.now(),
      detail: { mode: nextMode },
    });
  }

  // ── Actor Lifecycle ──

  /** 创建并注册一个新的 Actor */
  spawn(config: ActorConfig): AgentActor {
    // 运行 beforeSpawn hooks（可以修改 config 或阻止 spawn）
    const beforeResult = this.runModifyHooks<BeforeSpawnHookContext>("beforeSpawn", {
      system: this,
      actorId: config.id,
      actorName: config.role.name,
      timestamp: Date.now(),
      config,
    });

    if (beforeResult.stopped) {
      throw new Error(beforeResult.error || `Spawn cancelled by beforeSpawn hook`);
    }

    const finalConfig = beforeResult.modified?.config ?? config;

    if (this.actors.has(finalConfig.id)) {
      throw new Error(`Actor ${finalConfig.id} already exists`);
    }

    const actor = new AgentActor(finalConfig, {
      askUser: this.options.askUser,
      confirmDangerousAction: this.options.confirmDangerousAction,
      actorSystem: this,
    });
    actor.setDialogExecutionMode(this.dialogExecutionMode);

    actor.on((event) => {
      this.emitEvent(event);
      if (event.type === "step" || event.type === "message_received") {
        const step = event.type === "step"
          ? (event.detail as { step?: { content?: string; streaming?: boolean } } | undefined)?.step
          : undefined;
        const progressSummary = step && !step.streaming && typeof step.content === "string"
          ? step.content.slice(0, 240)
          : undefined;
        this.dialogSubtaskRuntime.touchSessionActivity(event.actorId, event.timestamp, progressSummary);
      }
      if (event.type === "task_started") {
        this.dialogSubtaskRuntime.markSessionTaskStarted(event.actorId, event.timestamp);
      }
      if (event.type === "task_completed" || event.type === "task_error") {
        const detail = (event.detail ?? {}) as Record<string, unknown>;
        const normalizedError = String(detail.error ?? "");
        this.dialogSubtaskRuntime.markSessionTaskEnded(
          event.actorId,
          event.type === "task_completed"
            ? "completed"
            : (normalizedError === "Aborted" || isTimeoutErrorMessage(normalizedError) ? "aborted" : "error"),
          event.timestamp,
          {
            result: detail.result as string | undefined,
            error: detail.error as string | undefined,
          },
        );
        void this.runHooks<EndHookContext>("onEnd", {
          system: this,
          actorId: event.actorId,
          actorName: actor.role.name,
          timestamp: event.timestamp,
          taskId: String(detail.taskId ?? ""),
          result: detail.result as string | undefined,
          error: detail.error as string | undefined,
          elapsed: (detail.elapsed as number) ?? 0,
        });
        if (event.type === "task_completed" && event.actorId === this.coordinatorActorId) {
          this.scheduleSupportActorCleanupAfterCoordinatorCompletion();
        }
      }
    });

    this.actors.set(finalConfig.id, actor);
    if (!this.coordinatorActorId) {
      this.coordinatorActorId = finalConfig.id;
    }
    this.ensureUniqueActorNames();
    log(`spawn: ${finalConfig.role.name} (${finalConfig.id}), model=${finalConfig.modelOverride ?? "default"}`);
    this.syncTranscriptActors();
    void this.runHooks<SpawnHookContext>("onSpawn", {
      system: this, actorId: finalConfig.id, actorName: finalConfig.role.name,
      timestamp: Date.now(), config: finalConfig,
    });
    // 返回带有正确 ID 的 actor
    return actor;
  }

  /** 停止并移除一个 Actor，级联 kill 它的所有 spawned tasks */
  kill(actorId: string): void {
    const actor = this.actors.get(actorId);
    if (!actor) return;
    void this.runHooks("onKill", {
      system: this, actorId, actorName: actor.role.name, timestamp: Date.now(),
    });
    this.cascadeAbortSpawns(actorId);
    actor.stop();
    for (const record of this.dialogSubtaskRuntime.getSpawnedTasksSnapshot()) {
      if (record.targetActorId === actorId || record.spawnerActorId === actorId) {
        this.closeSpawnedSessionRecord(record);
      }
    }
    this.actors.delete(actorId);
    this.removeActorFromExecutionContract(actorId);
    if (this.coordinatorActorId === actorId) {
      this.coordinatorActorId = this.getFirstActor()?.id ?? null;
    }
    this.syncTranscriptActors();
  }

  /** 停止并移除所有 Actor */
  killAll(): void {
    this._cron.cancelAll();
    this.dialogSubtaskRuntime.clearAll();
    this.artifactRecords.clear();
    this.sessionUploads.clear();
    this.dialogRoomCompaction = null;
    for (const actor of this.actors.values()) {
      actor.stop();
    }
    this.actors.clear();
    this.coordinatorActorId = null;
    this.activeExecutionContract = null;
    this.legacyDialogExecutionPlanRuntimeState = null;
    this.dialogHistory = [];
    this.pendingReplies.clear();
  }

  /** 获取一个 Actor */
  get(actorId: string): AgentActor | undefined {
    return this.actors.get(actorId);
  }

  private getActorName(actorId: string): string {
    return this.actors.get(actorId)?.role.name ?? actorId;
  }

  private getActorNamesMap(): ReadonlyMap<string, string> {
    return new Map(
      [...this.actors.values()].map((actor) => [actor.id, actor.role.name] as const),
    );
  }

  /** 获取所有 Actor */
  getAll(): AgentActor[] {
    return [...this.actors.values()];
  }

  /** 获取 Actor 数量 */
  get size(): number {
    return this.actors.size;
  }

  /**
   * 规范化 Actor 名称，避免 UI 中出现多个同名 Agent。
   * 对于同名的 Actor，从第二个开始追加 #2 / #3 后缀。
   */
  ensureUniqueActorNames(): void {
    const nameMap = new Map<string, AgentActor[]>();
    for (const actor of this.actors.values()) {
      const name = actor.role.name;
      const list = nameMap.get(name) ?? [];
      list.push(actor);
      nameMap.set(name, list);
    }

    for (const [name, list] of nameMap) {
      if (list.length <= 1) continue;
      list.forEach((actor, index) => {
        if (index === 0) return;
        const newName = `${name} #${index + 1}`;
        if (actor.role.name !== newName) {
          log(`ensureUniqueActorNames: rename ${actor.role.name} → ${newName}`);
          actor.role.name = newName;
        }
      });
    }
  }

  /** 获取第一个（按 spawn 顺序）满足条件的 Actor，默认返回第一个 */
  getFirstActor(filter?: (a: AgentActor) => boolean): AgentActor | undefined {
    for (const actor of this.actors.values()) {
      if (!filter || filter(actor)) return actor;
    }
    return undefined;
  }

  private getExecutionContractCoordinator(filter?: (a: AgentActor) => boolean): AgentActor | undefined {
    const coordinatorId = this.activeExecutionContract?.coordinatorActorId;
    if (!coordinatorId) return undefined;
    const coordinator = this.actors.get(coordinatorId);
    if (coordinator && (!filter || filter(coordinator))) {
      return coordinator;
    }
    return undefined;
  }

  getCoordinator(filter?: (a: AgentActor) => boolean): AgentActor | undefined {
    const planCoordinator = this.getExecutionContractCoordinator(filter);
    if (planCoordinator) {
      return planCoordinator;
    }

    const coordinator = this.coordinatorActorId ? this.actors.get(this.coordinatorActorId) : undefined;
    if (coordinator && (!filter || filter(coordinator))) {
      return coordinator;
    }
    return this.getFirstActor(filter);
  }

  getCoordinatorId(): string | null {
    return this.getCoordinator()?.id ?? null;
  }

  setCoordinator(actorId: string): void {
    if (!this.actors.has(actorId)) {
      throw new Error(`Coordinator ${actorId} not found`);
    }
    this.coordinatorActorId = actorId;
  }

  /**
   * 按指定 ID 顺序重排 actors Map。
   * Map 迭代顺序由插入顺序决定，此方法通过重建 Map 实现排序。
   */
  reorderActors(orderedIds: string[]): void {
    const reordered = new Map<string, AgentActor>();
    for (const id of orderedIds) {
      const actor = this.actors.get(id);
      if (actor) reordered.set(id, actor);
    }
    // 追加未出现在 orderedIds 中的 actor（防御性）
    for (const [id, actor] of this.actors) {
      if (!reordered.has(id)) reordered.set(id, actor);
    }
    this.actors = reordered;
    this.syncTranscriptActors();
  }

  private getExecutionContractSurface(): ExecutionContract["surface"] {
    return this.activeExecutionContract?.surface ?? "local_dialog";
  }

  getCurrentSurface(): ExecutionContract["surface"] {
    return this.getExecutionContractSurface();
  }

  private ensureRuntimeExecutionContract(): ExecutionContract | null {
    return this.activeExecutionContract;
  }

  private setLegacyDialogExecutionPlanRuntimeState(
    state?: LegacyDialogExecutionPlanRuntimeState | null,
  ): void {
    const activatedAt = typeof state?.activatedAt === "number" ? state.activatedAt : undefined;
    const sourceMessageId = state?.sourceMessageId?.trim() || undefined;
    this.legacyDialogExecutionPlanRuntimeState = activatedAt || sourceMessageId
      ? { activatedAt, sourceMessageId }
      : null;
  }

  getActiveExecutionContract(): ExecutionContract | null {
    return this.activeExecutionContract ? cloneExecutionContract(this.activeExecutionContract) : null;
  }

  /**
   * @deprecated 仅用于旧数据兼容与过渡期调试视图。
   * 新运行态应统一读取 `getActiveExecutionContract()`。
   */
  getDialogExecutionPlan(): DialogExecutionPlan | null {
    const contract = this.activeExecutionContract;
    if (contract) {
      return cloneLegacyDialogExecutionPlan(buildLegacyDialogExecutionPlanFromContract(contract, {
        runtimeState: this.legacyDialogExecutionPlanRuntimeState,
        hasActor: (actorId) => this.actors.has(actorId),
      }));
    }
    return null;
  }

  getDialogRoomCompaction(): DialogRoomCompactionState | null {
    return cloneDialogRoomCompaction(this.dialogRoomCompaction);
  }

  setDialogRoomCompaction(state: DialogRoomCompactionState | null): void {
    this.dialogRoomCompaction = cloneDialogRoomCompaction(state);
  }

  private dedupeActorPairs(
    edges: Array<{ fromActorId: string; toActorId: string }>,
  ): Array<{ fromActorId: string; toActorId: string }> {
    const seen = new Set<string>();
    const result: Array<{ fromActorId: string; toActorId: string }> = [];
    for (const edge of edges) {
      if (!edge.fromActorId || !edge.toActorId) continue;
      const key = `${edge.fromActorId}->${edge.toActorId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ fromActorId: edge.fromActorId, toActorId: edge.toActorId });
    }
    return result;
  }

  private attachDynamicActorToExecutionContract(parentActorId: string, childActorId: string): void {
    const contract = this.activeExecutionContract;
    if (!contract) return;
    if (!contract.participantActorIds.includes(parentActorId)) {
      throw new Error(`[execution_contract] ${parentActorId} 不在已批准协作范围内，不能创建新的子 Agent`);
    }
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      participantActorIds: [...new Set([...contract.participantActorIds, childActorId])],
      allowedMessagePairs: this.dedupeActorPairs([
        ...contract.allowedMessagePairs,
        { fromActorId: parentActorId, toActorId: childActorId },
        { fromActorId: childActorId, toActorId: parentActorId },
      ]),
      allowedSpawnPairs: this.dedupeActorPairs([
        ...contract.allowedSpawnPairs,
        { fromActorId: parentActorId, toActorId: childActorId },
      ]),
    };
  }

  private removeActorFromExecutionContract(actorId: string): void {
    const contract = this.activeExecutionContract;
    if (!contract) return;
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      initialRecipientActorIds: contract.initialRecipientActorIds.filter((id) => id !== actorId),
      participantActorIds: contract.participantActorIds.filter((id) => id !== actorId),
      coordinatorActorId: contract.coordinatorActorId === actorId
        ? undefined
        : contract.coordinatorActorId,
      allowedMessagePairs: contract.allowedMessagePairs.filter(
        (edge) => edge.fromActorId !== actorId && edge.toActorId !== actorId,
      ),
      allowedSpawnPairs: contract.allowedSpawnPairs.filter(
        (edge) => edge.fromActorId !== actorId && edge.toActorId !== actorId,
      ),
      plannedDelegations: contract.plannedDelegations.filter((spawn) => spawn.targetActorId !== actorId),
    };
  }

  private createEphemeralAgent(
    spawnerActorId: string,
    opts: {
      name: string;
      description?: string;
      capabilities?: AgentCapability[];
      roleBoundary?: SpawnedTaskRoleBoundary;
      executionIntent?: DialogSubtaskExecutionIntent;
      workspace?: string;
      toolPolicy?: ToolPolicy;
      timeoutSeconds?: number;
      idleLeaseSeconds?: number;
      overrides?: import("./types").SpawnTaskOverrides;
    },
  ): AgentActor | { error: string } {
    const spawner = this.actors.get(spawnerActorId);
    if (!spawner) return { error: `Spawner ${spawnerActorId} not found` };

    const requestedName = opts.name.trim();
    if (!requestedName) {
      return { error: "临时 Agent 名称不能为空" };
    }

    const actorId = `spawned-${generateId()}`;
    const inferredBoundary = opts.roleBoundary
      ? buildEphemeralChildBoundary(opts.roleBoundary)
      : inferEphemeralChildBoundary({
          name: requestedName,
          description: opts.description,
          capabilities: opts.capabilities,
        });
    const resolvedExecutionIntent = opts.executionIntent
      ?? (inferredBoundary.role === "reviewer"
        ? "reviewer"
        : inferredBoundary.role === "validator"
          ? "validator"
          : inferredBoundary.role === "executor"
            ? "coding_executor"
            : "general");
    const explicitToolPolicy = opts.toolPolicy ?? opts.overrides?.toolPolicy;
    const resolvedChildSettings = resolveChildExecutionSettings({
      roleBoundary: inferredBoundary.role,
      parentToolPolicy: spawner.toolPolicyConfig,
      parentExecutionPolicy: spawner.executionPolicy,
      parentWorkspace: spawner.workspace,
      parentThinkingLevel: spawner.thinkingLevel,
      parentMiddlewareOverrides: spawner.middlewareOverrides,
      boundaryToolPolicy: inferredBoundary.toolPolicy,
      boundaryExecutionPolicy: inferredBoundary.executionPolicy,
      overrideToolPolicy: explicitToolPolicy,
      overrideExecutionPolicy: opts.overrides?.executionPolicy,
      overrideWorkspace: opts.workspace,
      overrideThinkingLevel: opts.overrides?.thinkingLevel,
      overrideMiddlewareOverrides: opts.overrides?.middlewareOverrides,
    });
    resolvedChildSettings.toolPolicy = buildExecutionIntentToolPolicy({
      executionIntent: resolvedExecutionIntent,
      resultContract: opts.overrides?.resultContract,
      overrideToolPolicy: explicitToolPolicy,
    }) ?? resolvedChildSettings.toolPolicy;
    const spawnerBasePrompt = spawner.getSystemPromptOverride() ?? spawner.role.systemPrompt;
    const systemPromptBlocks = [
      spawnerBasePrompt || DIALOG_FULL_ROLE.systemPrompt,
      `你是由 ${spawner.role.name} 临时创建的专用子 Agent。`,
      opts.description ? `你的职责定位：${opts.description}` : "",
      opts.capabilities?.length ? `优先能力聚焦：${opts.capabilities.join("、")}` : "",
      inferredBoundary.systemPromptAppend ? `默认职责边界：${inferredBoundary.systemPromptAppend}` : "",
      resolvedExecutionIntent === "content_executor"
        ? opts.overrides?.resultContract === "inline_structured_result"
          ? "执行意图：content_executor。当前启用 inline_structured_result 合同：你必须直接在 terminal result 返回完整结构化结果，禁止写文件、导出文件、搜索外网、再次派工。"
          : "执行意图：content_executor。你只能读取当前文档、做轻量计算并通过 terminal result 返回结构化内容，禁止写文件、搜索外网、再次派工。"
        : resolvedExecutionIntent === "coding_executor"
          ? "执行意图：coding_executor。你负责实现或修复，但仍禁止消息回流型工具和再次派工。"
          : "",
      opts.overrides?.systemPromptAppend ? `额外约束：${opts.overrides.systemPromptAppend}` : "",
      [
        "## 子任务执行规范（必读）",
        opts.overrides?.resultContract === "inline_structured_result"
          ? "- 当前子任务已锁定 inline_structured_result 合同：直接在 terminal result 返回完整结果，不要写任何中间 JSON / TSV / Markdown / Excel 文件。"
          : "- 如果任务属于内容整理、方案撰写、清单汇总这类非 coding 子任务，默认直接在 terminal result 返回完整结果，不要写任何中间 JSON / TSV / Markdown / Excel 文件。",
        "- 只有明确的 coding / 实现类任务，且当前工具策略允许时，才可以写文件或导出最终产物。",
        "- 默认只读取当前用户提供的文档和本轮 artifacts；不要扫描目录、历史 Downloads 或旧文件。",
        "- 读取同一文件只需调用一次 `read_document` / `read_file`，不要反复读取同一文件。",
        "- 尽量一次性完成目标，避免在执行过程中输出冗长的「步骤计划」或「执行方案」文本。",
        "- 最终 answer 只需要一两句话说明完成情况和产出文件路径。",
      ].join("\n"),
    ].filter(Boolean);

    try {
      const actor = this.spawn({
        id: actorId,
        role: {
          ...DIALOG_FULL_ROLE,
          id: `dialog_agent_${actorId}`,
          name: requestedName,
        },
        persistent: false,
        modelOverride: opts.overrides?.model,
        maxIterations: opts.overrides?.maxIterations,
        systemPromptOverride: systemPromptBlocks.join("\n\n"),
        toolPolicy: resolvedChildSettings.toolPolicy,
        executionPolicy: resolvedChildSettings.executionPolicy,
        timeoutSeconds: normalizePositiveSeconds(opts.timeoutSeconds) ?? DEFAULT_DIALOG_WORKER_BUDGET_SECONDS,
        idleLeaseSeconds: normalizePositiveSeconds(opts.idleLeaseSeconds) ?? DEFAULT_DIALOG_WORKER_IDLE_LEASE_SECONDS,
        workspace: resolvedChildSettings.workspace,
        contextTokens: opts.overrides?.contextTokens ?? spawner.contextTokens,
        thinkingLevel: resolvedChildSettings.thinkingLevel,
        capabilities: opts.capabilities?.length
          ? { tags: opts.capabilities, description: opts.description }
          : spawner.capabilities,
        middlewareOverrides: resolvedChildSettings.middlewareOverrides,
      });

      try {
        this.attachDynamicActorToExecutionContract(spawnerActorId, actor.id);
      } catch (error) {
        this.kill(actor.id);
        return { error: error instanceof Error ? error.message : String(error) };
      }

      log(`[execution_contract] spawned ephemeral child agent ${actor.role.name} for ${spawner.role.name}`);
      return actor;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  armExecutionContract(contract: ExecutionContract): void {
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      state: "sealed",
    };
    this.setLegacyDialogExecutionPlanRuntimeState(null);
    log(`armExecutionContract: ${contract.summary}`);
  }

  restoreExecutionContract(contract: ExecutionContract): void {
    const shouldPreserveRuntimeState = this.activeExecutionContract?.contractId === contract.contractId;
    this.activeExecutionContract = cloneExecutionContract(contract);
    if (!shouldPreserveRuntimeState) {
      this.setLegacyDialogExecutionPlanRuntimeState(null);
    }
    log(`restoreExecutionContract: ${contract.summary}`);
  }

  clearExecutionContract(): void {
    const summary = this.activeExecutionContract?.summary;
    if (summary) {
      log(`clearExecutionContract: ${summary}`);
    }
    this.activeExecutionContract = null;
    this.legacyDialogExecutionPlanRuntimeState = null;
  }

  /**
   * @deprecated 仅用于旧测试与兼容迁移入口。
   * 新运行态应统一调用 `armExecutionContract()`。
   */
  armDialogExecutionPlan(plan: DialogExecutionPlan): void {
    const { contract } = buildExecutionContractFromLegacyDialogExecutionPlan({
      surface: this.getExecutionContractSurface(),
      plan,
      hasActor: (actorId) => this.actors.has(actorId),
    });
    this.armExecutionContract(contract);
  }

  /**
   * @deprecated 仅用于旧快照恢复与兼容迁移入口。
   * 新运行态应统一调用 `restoreExecutionContract()`。
   */
  restoreDialogExecutionPlan(plan: DialogExecutionPlan): void {
    const { contract, runtimeState } = buildExecutionContractFromLegacyDialogExecutionPlan({
      surface: this.getExecutionContractSurface(),
      plan,
      hasActor: (actorId) => this.actors.has(actorId),
    });
    this.restoreExecutionContract(contract);
    this.setLegacyDialogExecutionPlanRuntimeState(runtimeState);
  }

  /**
   * @deprecated 仅用于兼容旧调用方。
   * 新运行态应统一调用 `clearExecutionContract()`。
   */
  clearDialogExecutionPlan(): void {
    this.clearExecutionContract();
  }

  private activateExecutionContract(sourceMessageId: string): boolean {
    const contract = this.activeExecutionContract;
    if (!contract || contract.state !== "sealed") return false;
    const activatedAt = Date.now();
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      state: "active",
    };
    this.setLegacyDialogExecutionPlanRuntimeState({ activatedAt, sourceMessageId });
    log(`activateExecutionContract: sourceMessageId=${sourceMessageId}`);
    return true;
  }

  private tryFinalizeExecutionContract(): void {
    const contract = this.activeExecutionContract;
    if (!contract || contract.state !== "active") return;

    const allRunning = this.dialogSubtaskRuntime.getSpawnedTasksSnapshot().filter((r) => r.status === "running");
    if (allRunning.length > 0) return;

    const recipientIds = contract.initialRecipientActorIds ?? [];
    const allIdle = recipientIds.every((id) => {
      const actor = this.actors.get(id);
      return !actor || actor.status === "idle";
    });
    if (!allIdle) return;

    const hasError = this.dialogSubtaskRuntime.getSpawnedTasksSnapshot().some(
      (r) => r.status === "error" || r.status === "aborted",
    );
    const newState = hasError ? "failed" : "completed";
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      state: newState,
    };
    log(`tryFinalizeExecutionContract: contract → ${newState}`);
    this.emitEvent({
      // Keep the legacy event name for compatibility with existing listeners.
      type: "dialog_plan_finalized",
      actorId: this.coordinatorActorId ?? "",
      timestamp: Date.now(),
      detail: { state: newState, summary: contract.summary },
    });
  }

  private _sessionStallTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleExecutionContractProgressCheck(): void {
    if (this._sessionStallTimer) {
      clearTimeout(this._sessionStallTimer);
      this._sessionStallTimer = null;
    }
    const contract = this.ensureRuntimeExecutionContract();
    if (!contract || contract.state !== "active") return;

    this._sessionStallTimer = setTimeout(() => {
      this._sessionStallTimer = null;
      const running = this.dialogSubtaskRuntime.getSpawnedTasksSnapshot().filter((r) => r.status === "running");
      if (running.length > 0) return;

      const busyActors = [...this.actors.values()].filter((a) => a.status !== "idle");
      if (busyActors.length > 0) return;

      if (this.ensureRuntimeExecutionContract()?.state === "active") {
        log("scheduleExecutionContractProgressCheck: session stall detected");
        this.emitEvent({
          type: "session_stalled",
          actorId: this.coordinatorActorId ?? "",
          timestamp: Date.now(),
          detail: { planSummary: contract.summary },
        });
      }
    }, 30_000);
  }

  private getSuggestedPlannedSpawn(
    spawnerActorId: string,
    params: {
      targetActorId?: string;
      plannedDelegationId?: string | null;
    },
  ): NonNullable<ExecutionContract["plannedDelegations"]>[number] | undefined {
    const plan = this.ensureRuntimeExecutionContract();
    if (!plan?.plannedDelegations?.length) return undefined;
    const coordinatorActorId = plan.coordinatorActorId ?? plan.initialRecipientActorIds[0];
    if (!coordinatorActorId || spawnerActorId !== coordinatorActorId) return undefined;
    const plannedDelegationId = params.plannedDelegationId?.trim();
    if (plannedDelegationId) {
      return plan.plannedDelegations.find((spawn) => spawn.id === plannedDelegationId);
    }
    const targetActorId = params.targetActorId?.trim();
    if (!targetActorId) return undefined;
    return plan.plannedDelegations.find((spawn) =>
      spawn.targetActorId === targetActorId
      || spawn.targetActorName === targetActorId,
    );
  }

  private isExecutionContractEdgeAllowed(
    pairs: ExecutionContract["allowedMessagePairs"] | ExecutionContract["allowedSpawnPairs"],
    fromActorId: string,
    toActorId: string,
  ): boolean {
    return pairs.some((edge) => edge.fromActorId === fromActorId && edge.toActorId === toActorId);
  }

  private assertUserDispatchMatchesContract(
    recipientActorIds: string[],
    mode: "send" | "broadcast" | "broadcastAndResolve",
  ): void {
    const contract = this.ensureRuntimeExecutionContract();
    if (!contract) return;

    const expected = new Set(contract.initialRecipientActorIds);
    const actual = new Set(recipientActorIds);
    const matches = expected.size === actual.size && [...expected].every((id) => actual.has(id));

    if (!matches) {
      const expectedLabel = [...expected].join(", ") || "none";
      const actualLabel = [...actual].join(", ") || "none";
      throw new Error(
        `[execution_contract] ${mode} 目标不在已批准计划内（expected=${expectedLabel}, actual=${actualLabel}）`,
      );
    }
  }

  private assertActorMessageAllowed(fromActorId: string, toActorId: string): void {
    const contract = this.ensureRuntimeExecutionContract();
    if (!contract) return;

    if (!contract.participantActorIds.includes(fromActorId) || !contract.participantActorIds.includes(toActorId)) {
      throw new Error(`[execution_contract] ${fromActorId} 或 ${toActorId} 不在已批准协作范围内`);
    }

    if (!this.isExecutionContractEdgeAllowed(contract.allowedMessagePairs, fromActorId, toActorId)) {
      throw new Error(`[execution_contract] ${fromActorId} -> ${toActorId} 的消息未在已批准计划中`);
    }
  }

  private assertActorSpawnAllowed(spawnerActorId: string, targetActorId: string): void {
    const contract = this.ensureRuntimeExecutionContract();
    if (!contract) return;

    if (!contract.participantActorIds.includes(spawnerActorId) || !contract.participantActorIds.includes(targetActorId)) {
      throw new Error(`[execution_contract] ${spawnerActorId} 或 ${targetActorId} 不在已批准协作范围内`);
    }

    if (!this.isExecutionContractEdgeAllowed(contract.allowedSpawnPairs, spawnerActorId, targetActorId)) {
      throw new Error(`[execution_contract] ${spawnerActorId} -> ${targetActorId} 的 spawn_task 未在已批准计划中`);
    }
  }

  private finalizeSpawnedTaskHistoryWindow(record: SpawnedTaskRecord, targetActor?: AgentActor): void {
    if (typeof record.sessionHistoryEndIndex === "number") return;
    const resolvedTarget = targetActor ?? this.actors.get(record.targetActorId);
    record.sessionHistoryEndIndex = resolvedTarget?.getSessionHistory().length ?? record.sessionHistoryStartIndex;
  }

  private getArtifactKey(path: string): string {
    return path.trim().replace(/\\/g, "/");
  }

  private getOpenSpawnedSessionByRunId(runId: string): SpawnedTaskRecord | undefined {
    return this.dialogSubtaskRuntime.getOpenSessionByRunId(runId);
  }

  private getOpenSpawnedSessionByTarget(targetActorId: string): SpawnedTaskRecord | undefined {
    return this.dialogSubtaskRuntime.getOpenSessionByTarget(targetActorId);
  }

  private getOwningSpawnedTaskForActor(actorId: string): SpawnedTaskRecord | undefined {
    return this.dialogSubtaskRuntime.getOwningTaskForActor(actorId);
  }

  getDeferredSpawnRequests(actorId: string): DeferredSpawnRequest[] {
    return [...(this.deferredSpawnRequests.get(actorId) ?? [])];
  }

  getPendingDeferredSpawnTaskCount(actorId: string): number {
    return this.getDeferredSpawnRequests(actorId).length;
  }

  enqueueDeferredSpawnTask(
    spawnerActorId: string,
    targetActorId: string,
    task: string,
    opts?: {
      label?: string;
      context?: string;
      attachments?: string[];
      images?: string[];
      timeoutSeconds?: number;
      mode?: SpawnMode;
      cleanup?: "delete" | "keep";
      expectsCompletionMessage?: boolean;
      roleBoundary?: SpawnedTaskRoleBoundary;
      createIfMissing?: boolean;
      createChildSpec?: {
        description?: string;
        capabilities?: AgentCapability[];
        workspace?: string;
      };
      overrides?: SpawnTaskOverrides;
      plannedDelegationId?: string;
    },
  ): DeferredSpawnRequest {
    let resolvedRoleBoundary: SpawnedTaskRoleBoundary = opts?.roleBoundary ?? "general";
    if (!opts?.roleBoundary && resolvedRoleBoundary === "general" && shouldPromoteGeneralTaskToExecutor(task)) {
      resolvedRoleBoundary = "executor";
    }
    const resolvedExecutionIntent = resolveDialogSubtaskExecutionIntent({
      roleBoundary: resolvedRoleBoundary,
      task,
      overrideToolPolicy: opts?.overrides?.toolPolicy,
      explicitExecutionIntent: opts?.overrides?.executionIntent,
    });
    if (resolvedExecutionIntent === "content_executor" || resolvedExecutionIntent === "coding_executor") {
      resolvedRoleBoundary = "executor";
    } else if (resolvedExecutionIntent === "reviewer") {
      resolvedRoleBoundary = "reviewer";
    } else if (resolvedExecutionIntent === "validator") {
      resolvedRoleBoundary = "validator";
    }
    const request: DeferredSpawnRequest = {
      id: generateId(),
      spawnerActorId,
      targetActorId,
      task,
      queuedAt: Date.now(),
      label: opts?.label,
      context: opts?.context,
      attachments: opts?.attachments?.length ? [...new Set(opts.attachments)] : undefined,
      images: opts?.images?.length ? [...new Set(opts.images)] : undefined,
      timeoutSeconds: normalizePositiveSeconds(opts?.timeoutSeconds),
      mode: opts?.mode,
      cleanup: opts?.cleanup,
      expectsCompletionMessage: opts?.expectsCompletionMessage,
      roleBoundary: resolvedRoleBoundary,
      profile: resolveDialogSubtaskProfile(resolvedRoleBoundary),
      executionIntent: resolvedExecutionIntent,
      createIfMissing: opts?.createIfMissing,
      createChildSpec: opts?.createChildSpec,
      overrides: opts?.overrides,
      plannedDelegationId: opts?.plannedDelegationId,
    };
    const queue = this.deferredSpawnRequests.get(spawnerActorId) ?? [];
    queue.push(request);
    this.deferredSpawnRequests.set(spawnerActorId, queue);
    this.traceFlow("spawn_queued", {
      queue_id: request.id,
      queue_position: queue.length,
      pending_dispatch_count: queue.length,
      profile: request.profile,
      execution_intent: request.executionIntent,
      phase: request.mode ?? "run",
      target: targetActorId.trim() || undefined,
      preview: previewActorSystemText(task),
    }, spawnerActorId);
    return request;
  }

  dispatchDeferredSpawnTasks(actorId: string): number {
    const queue = this.deferredSpawnRequests.get(actorId);
    if (!queue?.length) return 0;
    if (this.deferredSpawnDispatchingOwners.has(actorId)) return 0;

    this.deferredSpawnDispatchingOwners.add(actorId);
    let dispatched = 0;
    try {
      while (queue.length > 0) {
        const activeCount = this.getActiveSpawnedTasks(actorId).length;
        if (activeCount >= MAX_ACTIVE_DIALOG_CHILDREN) break;

        const next = queue[0];
        const result = this.spawnTask(actorId, next.targetActorId, next.task, {
          label: next.label,
          context: next.context,
          attachments: next.attachments,
          images: next.images,
          timeoutSeconds: next.timeoutSeconds,
          mode: next.mode,
          cleanup: next.cleanup,
          expectsCompletionMessage: next.expectsCompletionMessage,
          roleBoundary: next.roleBoundary,
          createIfMissing: next.createIfMissing,
          createChildSpec: next.createChildSpec,
          overrides: next.executionIntent
            ? {
                ...(next.overrides ?? {}),
                executionIntent: next.executionIntent,
              }
            : next.overrides,
          plannedDelegationId: next.plannedDelegationId,
        });

        if (!("runId" in result)) {
          if (isRetryableDeferredSpawnError(result.error)) {
            break;
          }

          queue.shift();
          this.traceFlow("spawn_queue_failed", {
            queue_id: next.id,
            status: "error",
            preview: previewActorSystemText(result.error),
          }, actorId);
          try {
            this.send(actorId, actorId, `[Task failed: ${next.label ?? next.task.slice(0, 30)}]\n\nError: ${result.error}`, {
              bypassPlanCheck: true,
              relatedRunId: next.id,
            });
          } catch (error) {
            actorSystemLogger.warn("deferred spawn failure self-notify failed", {
              actorId,
              queueId: next.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          continue;
        }

        queue.shift();
        dispatched += 1;
        this.traceFlow("spawn_queue_dispatched", {
          queue_id: next.id,
          run_id: result.runId,
          pending_dispatch_count: queue.length,
          target: result.targetActorId,
          profile: result.runtime?.profile ?? result.roleBoundary ?? next.profile,
          execution_intent: result.executionIntent ?? next.executionIntent,
          preview: previewActorSystemText(next.task),
        }, actorId);
      }
    } finally {
      if (queue.length === 0) {
        this.deferredSpawnRequests.delete(actorId);
      }
      this.deferredSpawnDispatchingOwners.delete(actorId);
    }

    if (dispatched > 0) {
      this.dialogSubtaskRuntime.notifySpawnedTaskUpdate(actorId);
    }
    return dispatched;
  }

  private closeSpawnedSessionRecord(record: SpawnedTaskRecord, closedAt = Date.now()): void {
    this.dialogSubtaskRuntime.closeSession(record, closedAt);
  }

  private markSpawnedSessionTaskStarted(actorId: string, timestamp: number): void {
    this.dialogSubtaskRuntime.markSessionTaskStarted(actorId, timestamp);
  }

  private touchSpawnedSessionActivity(
    actorId: string,
    timestamp: number,
    progressSummary?: string,
  ): void {
    this.dialogSubtaskRuntime.touchSessionActivity(actorId, timestamp, progressSummary);
  }

  private markSpawnedSessionTaskEnded(
    actorId: string,
    status: "completed" | "error" | "aborted",
    timestamp: number,
    detail?: { result?: string; error?: string },
  ): void {
    this.dialogSubtaskRuntime.markSessionTaskEnded(actorId, status, timestamp, detail);
  }

  // ── Messaging ──

  /**
   * 发送消息（用户 -> Agent 或 Agent -> Agent）。
   * 消息会被投递到目标 Actor 的 inbox，并记录到对话历史。
   */
  send(from: string, to: string, content: string, opts?: {
    expectReply?: boolean;
    replyTo?: string;
    priority?: "normal" | "urgent";
    _briefContent?: string;
    images?: string[];
    bypassPlanCheck?: boolean;
    relatedRunId?: string;
    spawnedTaskResult?: import("./dialog-subtask-runtime").DialogStructuredSubtaskResult;
  }): DialogMessage {
    const target = this.actors.get(to);
    if (!target) throw new Error(`Actor ${to} not found`);

    if (!opts?.bypassPlanCheck && from === "user") {
      this.assertUserDispatchMatchesContract([to], "send");
    } else if (!opts?.bypassPlanCheck) {
      this.assertActorMessageAllowed(from, to);
    }

    const fromName = from === "user" ? "用户" : (this.actors.get(from)?.role.name ?? from);
    const toName = target.role.name;
    log(`send: ${fromName} → ${toName}, content="${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"${opts?.expectReply ? " [expectReply]" : ""}${opts?.replyTo ? ` [replyTo=${opts.replyTo}]` : ""}`);

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to,
      content,
      timestamp: Date.now(),
      priority: opts?.priority ?? "normal",
      expectReply: opts?.expectReply,
      replyTo: opts?.replyTo,
      _briefContent: opts?._briefContent,
      kind: from === "user" ? "user_input" : "agent_message",
      relatedRunId: opts?.relatedRunId,
      spawnedTaskResult: opts?.spawnedTaskResult,
      ...(from !== "user" ? this.buildDialogMessageRecallPatch(from) : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
    };

    if (from === "user") {
      this.traceFlow("user_turn_received", {
        kind: "send",
        preview: previewActorSystemText(content),
      }, to);
    }
    target.receive(msg);
    this.traceFlow("dispatch_delivered", {
      status: "delivered",
      to,
      preview: previewActorSystemText(content),
    }, to);
    if (from === "user" && !opts?.bypassPlanCheck) {
      this.activateExecutionContract(msg.id);
    }
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);

    void this.runHooks<MessageHookContext>("onMessage", {
      system: this, actorId: to, actorName: target.role.name,
      timestamp: Date.now(), message: msg, direction: "inbound",
    });

    if (msg.replyTo) {
      const pending = this.pendingReplies.get(msg.replyTo);
      if (pending && pending.fromActorId === to) {
        log(`send: resolved pending reply ${msg.replyTo} for ${toName}`);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        this.pendingReplies.delete(msg.replyTo);
        pending.resolve(msg);
      }
    }

    return msg;
  }

  /**
   * 广播消息给所有 Actor（来自用户或系统）。
   * - 来自用户：投递给所有 Agent（用于 UI 的“广播”路由模式）
   * - 来自 Agent：投递给除自己外的所有 Agent
   * 消息始终记录到 dialogHistory，UI 上全员可见。
   */
  broadcast(from: string, content: string, opts?: { _briefContent?: string; images?: string[] }): DialogMessage {
    const fromName = from === "user" ? "用户" : (this.actors.get(from)?.role.name ?? from);
    log(`broadcast: ${fromName} → all, content="${content.slice(0, 80)}"`);

    const recipientIds = [...this.actors.values()]
      .filter((actor) => from === "user" || actor.id !== from)
      .map((actor) => actor.id);

    if (from === "user") {
      this.assertUserDispatchMatchesContract(recipientIds, "broadcast");
    } else {
      for (const recipientId of recipientIds) {
        this.assertActorMessageAllowed(from, recipientId);
      }
    }

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      _briefContent: opts?._briefContent,
      kind: from === "user" ? "user_input" : "agent_message",
      ...(from !== "user" ? this.buildDialogMessageRecallPatch(from) : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    if (from === "user") {
      this.activateExecutionContract(msg.id);
    }

    for (const actor of this.actors.values()) {
      if (from !== "user" && actor.id === from) continue;
      actor.receive(msg);
    }
    return msg;
  }

  /**
   * 群聊模式：广播消息给协调者或所有 Agent。
   *
   * 协调者投递策略：
   * - 当存在待用户交互项时，不再隐式消费，避免将新消息错误绑定到旧交互
   * - 默认仅投递给协调者，其他 Agent 等待 spawn_task 激活
   * - 消息始终记录到 dialogHistory，UI 上所有人可见
   */
  broadcastAndResolve(
    from: string,
    content: string,
    opts?: {
      _briefContent?: string;
      images?: string[];
      externalChannelType?: DialogMessage["externalChannelType"];
      externalChannelId?: DialogMessage["externalChannelId"];
      externalConversationId?: DialogMessage["externalConversationId"];
      externalConversationType?: DialogMessage["externalConversationType"];
      externalSessionId?: DialogMessage["externalSessionId"];
      runtimeDisplayLabel?: string;
      runtimeDisplayDetail?: string;
    },
  ): DialogMessage {
    const fromName = from === "user" ? "用户" : (this.actors.get(from)?.role.name ?? from);
    log(`broadcastAndResolve: ${fromName} → all, content="${content.slice(0, 80)}", pendingInteractions=${this.pendingInteractions.size}`);

    const activeContract = this.ensureRuntimeExecutionContract();
    const planRecipientIds = from === "user" && activeContract?.initialRecipientActorIds.length
      ? [...activeContract.initialRecipientActorIds]
      : null;
    const activePending = from === "user"
      ? [...this.pendingInteractions.entries()].filter(([, p]) => p.status === "pending")
      : [];
    if (from === "user" && planRecipientIds) {
      this.assertUserDispatchMatchesContract(planRecipientIds, "broadcastAndResolve");
    }

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      _briefContent: opts?._briefContent,
      kind: from === "user" ? "user_input" : "agent_message",
      relatedRunId: activePending.length === 1
        ? this.dialogHistory.find((message) => message.id === activePending[0][0])?.relatedRunId
        : undefined,
      ...(opts?.externalChannelType ? { externalChannelType: opts.externalChannelType } : {}),
      ...(opts?.externalChannelId ? { externalChannelId: opts.externalChannelId } : {}),
      ...(opts?.externalConversationId ? { externalConversationId: opts.externalConversationId } : {}),
      ...(opts?.externalConversationType ? { externalConversationType: opts.externalConversationType } : {}),
      ...(opts?.externalSessionId ? { externalSessionId: opts.externalSessionId } : {}),
      ...(opts?.runtimeDisplayLabel ? { runtimeDisplayLabel: opts.runtimeDisplayLabel } : {}),
      ...(opts?.runtimeDisplayDetail ? { runtimeDisplayDetail: opts.runtimeDisplayDetail } : {}),
      ...(from !== "user" ? this.buildDialogMessageRecallPatch(from) : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);

    if (from === "user") {
      this.traceFlow("user_turn_received", {
        kind: "broadcast_and_resolve",
        preview: previewActorSystemText(content),
        count: activePending.length,
      });
      actorSystemLogger.info("broadcastAndResolve start", {
        messageId: msg.id,
        from,
        fromName,
        pendingInteractions: activePending.length,
        plannedRecipients: planRecipientIds ?? [],
        contentPreview: previewActorSystemText(content),
        imageCount: opts?.images?.length ?? 0,
      });
      // 恰好 1 个待回复交互时，自动视为对该交互的回复（兼容 IM 等无法显式选择的入口）
      if (activePending.length === 1) {
        const [pendingMsgId, pending] = activePending[0];
        log(`broadcastAndResolve: auto-resolving single pending interaction (msgId=${pendingMsgId}, type=${pending.type})`);
        pending.status = "answered";
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        this.pendingInteractions.delete(pendingMsgId);
        this.updateDialogMessage(pendingMsgId, { interactionStatus: "answered" });
        pending.resolve({
          interactionId: pending.id,
          interactionType: pending.type,
          status: "answered",
          content,
          message: msg,
        });
      }

      if (planRecipientIds?.length) {
        this.traceFlow("dispatch_started", {
          phase: "contract_plan",
          count: planRecipientIds.length,
          preview: previewActorSystemText(content),
        });
        const recipients = planRecipientIds
          .map((actorId) => this.actors.get(actorId))
          .filter((actor): actor is AgentActor => Boolean(actor));
        for (const recipient of recipients) {
          log(`broadcastAndResolve(plan): delivering to ${recipient.role.name}`);
          actorSystemLogger.info("broadcastAndResolve deliver planned recipient", {
            messageId: msg.id,
            recipientId: recipient.id,
            recipientName: recipient.role.name,
            recipientStatus: recipient.status,
            recipientInboxSize: recipient.pendingInboxCount,
            executionStrategy: activeContract?.executionStrategy ?? "contract_plan",
          });
          recipient.receive(msg);
          this.traceFlow("dispatch_delivered", {
            phase: "contract_plan",
            status: "delivered",
            to: recipient.id,
          }, recipient.id);
        }
      } else {
        const agentsAwaitingReply = new Set(
          [...this.pendingInteractions.values()]
            .filter((p) => p.status === "pending")
            .map((p) => p.fromActorId),
        );
        const coordinator = this.getCoordinator((a) => !agentsAwaitingReply.has(a.id));
        if (coordinator) {
          this.traceFlow("dispatch_started", {
            phase: "coordinator",
            count: 1,
            preview: previewActorSystemText(content),
          }, coordinator.id);
          log(`broadcastAndResolve(coordinator): delivering to coordinator ${coordinator.role.name}`);
          actorSystemLogger.info("broadcastAndResolve deliver coordinator", {
            messageId: msg.id,
            coordinatorId: coordinator.id,
            coordinatorName: coordinator.role.name,
            coordinatorStatus: coordinator.status,
            coordinatorInboxSize: coordinator.pendingInboxCount,
            agentsAwaitingReply: [...agentsAwaitingReply],
            executionStrategy: activeContract?.executionStrategy ?? "coordinator",
          });
          coordinator.receive(msg);
          this.traceFlow("dispatch_delivered", {
            phase: "coordinator",
            status: "delivered",
            to: coordinator.id,
          }, coordinator.id);
        } else {
          const fallbackCoordinator = this.getCoordinator();
          if (fallbackCoordinator) {
            this.traceFlow("dispatch_started", {
              phase: "fallback_coordinator",
              count: 1,
              preview: previewActorSystemText(content),
            }, fallbackCoordinator.id);
            log(
              `broadcastAndResolve(fallback): queueing to ${fallbackCoordinator.role.name} despite pending interactions/state=${fallbackCoordinator.status}`,
            );
            actorSystemLogger.warn("broadcastAndResolve fallback coordinator delivery", {
              messageId: msg.id,
              coordinatorId: fallbackCoordinator.id,
              coordinatorName: fallbackCoordinator.role.name,
              coordinatorStatus: fallbackCoordinator.status,
              coordinatorInboxSize: fallbackCoordinator.pendingInboxCount,
              agentsAwaitingReply: [...agentsAwaitingReply],
              pendingInteractions: activePending.length,
            });
            fallbackCoordinator.receive(msg);
            this.traceFlow("dispatch_delivered", {
              phase: "fallback_coordinator",
              status: "delivered",
              to: fallbackCoordinator.id,
            }, fallbackCoordinator.id);
          } else if (activePending.length > 0) {
            log(`broadcastAndResolve: no available coordinator, pending interactions resolved`);
            actorSystemLogger.warn("broadcastAndResolve no coordinator after pending interaction handling", {
              messageId: msg.id,
              pendingInteractions: activePending.length,
            });
          } else {
            log(`broadcastAndResolve: no available coordinator and no pending interactions`);
            actorSystemLogger.warn("broadcastAndResolve no coordinator available", {
              messageId: msg.id,
            });
          }
        }
      }
      this.activateExecutionContract(msg.id);
    } else {
      const recipientIds = [...this.actors.values()]
        .filter((actor) => actor.id !== from)
        .map((actor) => actor.id);
      for (const recipientId of recipientIds) {
        this.assertActorMessageAllowed(from, recipientId);
      }
      for (const actor of this.actors.values()) {
        if (actor.id === from) continue;
        actor.receive(msg);
      }
    }

    this.emitEvent(msg);
    return msg;
  }

  /**
   * 向目标 Actor 提问并等待回复（Promise 阻塞直到回复或超时）。
   * 用于 Agent 间同步提问的实现。
   */
  askAndWait(
    fromActorId: string,
    toActorId: string,
    question: string,
    timeoutMs = ASK_AGENT_TIMEOUT_MS,
  ): Promise<InboxMessage> {
    const msg = this.send(fromActorId, toActorId, question, { expectReply: true });

    return new Promise<InboxMessage>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingReplies.delete(msg.id);
        reject(new Error(`等待 ${toActorId} 回复超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);

      this.pendingReplies.set(msg.id, {
        fromActorId,
        messageId: msg.id,
        resolve,
        timeoutId,
      });
    });
  }

  // ── Task Dispatch ──

  /** 给指定 Actor 分配任务（异步，不阻塞） */
  assignTask(actorId: string, query: string, images?: string[]) {
    const actor = this.actors.get(actorId);
    if (!actor) throw new Error(`Actor ${actorId} not found`);
    log(`assignTask: ${actor.role.name} (${actorId}), query="${query.slice(0, 60)}"`);
    return actor.assignTask(query, images);
  }

  /** 并发分配多个任务 */
  async assignTasks(
    assignments: { actorId: string; query: string; images?: string[] }[],
  ): Promise<Map<string, Awaited<ReturnType<AgentActor["assignTask"]>>>> {
    const results = await Promise.allSettled(
      assignments.map(({ actorId, query, images }) =>
        this.assignTask(actorId, query, images).then((task) => ({ actorId, task })),
      ),
    );

    const map = new Map<string, Awaited<ReturnType<AgentActor["assignTask"]>>>();
    for (const r of results) {
      if (r.status === "fulfilled") {
        map.set(r.value.actorId, r.value.task);
      }
    }
    return map;
  }

  /** 停止所有正在运行的 Actor */
  abortAll(): void {
    for (const actor of this.actors.values()) {
      actor.abort();
    }
  }

  // ── Spawn Registry (OpenClaw-style) ──

  /**
   * 派发子任务给目标 Agent（对标 OpenClaw sessions_spawn）。
   * 注册追踪 + 自动 Announce Flow（结果回送 spawner inbox）。
   */
  spawnTask(
    spawnerActorId: string,
    targetActorId: string,
    task: string,
    opts?: {
      label?: string;
      context?: string;
      timeoutSeconds?: number;
      attachments?: string[];
      images?: string[];
      /** Spawn 模式：run=一次性任务，session=保持会话 */
      mode?: "run" | "session";
      /** 清理策略：delete=完成后删除，keep=保持 */
      cleanup?: "delete" | "keep";
      /** 是否期望完成消息通知 */
      expectsCompletionMessage?: boolean;
      /** 本轮显式职责边界：执行 / 审查 / 验证 */
      roleBoundary?: SpawnedTaskRoleBoundary;
      /** 目标不存在时，是否自动创建一个临时子 Agent */
      createIfMissing?: boolean;
      /** 自动创建临时子 Agent 时的描述与能力提示 */
      createChildSpec?: {
        description?: string;
        capabilities?: AgentCapability[];
        workspace?: string;
      };
      /** Subagent 独立配置：动态覆盖目标 Agent 的运行参数 */
      overrides?: import("./types").SpawnTaskOverrides;
      /** 显式关联已批准的建议委派 */
      plannedDelegationId?: string;
    },
  ): SpawnedTaskRecord | { error: string } {
    const rejectSpawn = (message: string): { error: string } => {
      this.traceFlow("spawn_rejected", {
        status: "rejected",
        preview: previewActorSystemText(message),
      }, spawnerActorId);
      return { error: message };
    };
    this.traceFlow("spawn_requested", {
      status: "requested",
      phase: opts?.mode ?? "run",
      target: targetActorId.trim() || undefined,
      preview: previewActorSystemText(task),
    }, spawnerActorId);
    const spawner = this.actors.get(spawnerActorId);
    if (!spawner) return rejectSpawn(`Spawner ${spawnerActorId} not found`);
    const activeContract = this.ensureRuntimeExecutionContract();
    const requestedDelegationId = opts?.plannedDelegationId?.trim() || undefined;
    const requestedTimeoutSeconds = normalizePositiveSeconds(opts?.timeoutSeconds);
    const explicitRoleBoundary = opts?.roleBoundary;
    let resolvedRoleBoundary: SpawnedTaskRoleBoundary = explicitRoleBoundary ?? "general";
    let resolvedTargetActorId = targetActorId.trim();
    const plannedSpawn = this.getSuggestedPlannedSpawn(spawnerActorId, {
      targetActorId: resolvedTargetActorId,
      plannedDelegationId: requestedDelegationId,
    });
    if (requestedDelegationId && !plannedSpawn) {
      return rejectSpawn(`[execution_contract] 未找到已批准的建议委派 ${requestedDelegationId}`);
    }
    if (!resolvedTargetActorId) {
      resolvedTargetActorId = plannedSpawn?.targetActorId?.trim() ?? "";
    }
    const resolvedTask = task.trim() || plannedSpawn?.task?.trim();
    if (!resolvedTask) {
      return rejectSpawn("[sessions_spawn] task 不能为空");
    }
    let target = this.actors.get(resolvedTargetActorId);
    if (!target) {
      const requestedTargetName = plannedSpawn?.targetActorName?.trim() || targetActorId.trim();
      const actorByName = this.getAll().find((actor) => actor.role.name === requestedTargetName);
      if (actorByName) {
        target = actorByName;
        resolvedTargetActorId = actorByName.id;
      }
    }
    if (!explicitRoleBoundary && resolvedRoleBoundary === "general" && plannedSpawn?.roleBoundary) {
      resolvedRoleBoundary = plannedSpawn.roleBoundary;
    }
    if (!explicitRoleBoundary && resolvedRoleBoundary === "general" && shouldPromoteGeneralTaskToExecutor(resolvedTask)) {
      resolvedRoleBoundary = "executor";
    }
    const explicitExecutionIntent = opts?.overrides?.executionIntent ?? plannedSpawn?.overrides?.executionIntent;
    const resolvedCreateChildSpec = {
      description: opts?.createChildSpec?.description ?? plannedSpawn?.childDescription,
      capabilities: opts?.createChildSpec?.capabilities ?? plannedSpawn?.childCapabilities,
      workspace: opts?.createChildSpec?.workspace ?? plannedSpawn?.childWorkspace,
    };
    const resolvedOverrides: SpawnTaskOverrides = {
      ...(typeof plannedSpawn?.childMaxIterations === "number"
        ? { maxIterations: plannedSpawn.childMaxIterations }
        : {}),
      ...(plannedSpawn?.overrides ?? {}),
      ...(opts?.overrides ?? {}),
    };
    let resolvedExecutionIntent = resolveDialogSubtaskExecutionIntent({
      roleBoundary: resolvedRoleBoundary,
      task: resolvedTask,
      overrideToolPolicy: resolvedOverrides.toolPolicy,
      explicitExecutionIntent,
    });
    if (resolvedExecutionIntent === "content_executor" || resolvedExecutionIntent === "coding_executor") {
      resolvedRoleBoundary = "executor";
    } else if (resolvedExecutionIntent === "reviewer") {
      resolvedRoleBoundary = "reviewer";
    } else if (resolvedExecutionIntent === "validator") {
      resolvedRoleBoundary = "validator";
    }
    this.traceFlow("profile_inferred", {
      phase: "spawn",
      status: resolvedRoleBoundary,
      execution_intent: resolvedExecutionIntent,
      tool_policy_source: resolvedExecutionIntent === "content_executor"
        ? "content_executor_intent"
        : resolvedExecutionIntent === "coding_executor"
          ? "coding_executor_intent"
          : explicitRoleBoundary
            ? "explicit_role_boundary"
            : "heuristic_role_boundary",
      preview: previewActorSystemText(resolvedTask),
    }, spawnerActorId);
    if (!target && (opts?.createIfMissing || plannedSpawn?.createIfMissing)) {
      const childActorName = deriveEphemeralActorName({
        targetActorId: plannedSpawn?.targetActorName?.trim() || targetActorId.trim() || resolvedTargetActorId,
        label: opts?.label,
        description: resolvedCreateChildSpec.description,
        task: resolvedTask,
        roleBoundary: resolvedRoleBoundary,
      });
      if (resolvedRoleBoundary === "general") {
        resolvedRoleBoundary = inferEphemeralChildBoundary({
          name: childActorName,
          description: resolvedCreateChildSpec.description,
          capabilities: resolvedCreateChildSpec.capabilities,
        }).role;
        resolvedExecutionIntent = resolveDialogSubtaskExecutionIntent({
          roleBoundary: resolvedRoleBoundary,
          task: resolvedTask,
          overrideToolPolicy: resolvedOverrides.toolPolicy,
          explicitExecutionIntent,
        });
      }
      const executorTaskSpecificToolPolicy = buildExecutorTaskSpecificToolPolicy({
        roleBoundary: resolvedRoleBoundary,
        task: resolvedTask,
      });
      if (executorTaskSpecificToolPolicy) {
        resolvedOverrides.toolPolicy = mergeToolPolicies(
          resolvedOverrides.toolPolicy,
          executorTaskSpecificToolPolicy,
        );
      }
      const created = this.createEphemeralAgent(spawnerActorId, {
        name: childActorName,
        description: resolvedCreateChildSpec.description,
        capabilities: resolvedCreateChildSpec.capabilities,
        roleBoundary: resolvedRoleBoundary,
        executionIntent: resolvedExecutionIntent,
        workspace: resolvedCreateChildSpec.workspace,
        toolPolicy: resolvedOverrides.toolPolicy,
        timeoutSeconds: requestedTimeoutSeconds
          ? Math.max(requestedTimeoutSeconds, DEFAULT_DIALOG_WORKER_BUDGET_SECONDS)
          : undefined,
        overrides: resolvedOverrides,
      });
      if ("error" in created) {
        return rejectSpawn(created.error);
      }
      target = created;
      resolvedTargetActorId = created.id;
    }
    if (!target) return rejectSpawn(`Target ${targetActorId} not found`);
    if (resolvedRoleBoundary === "general" && target.persistent === false) {
      resolvedRoleBoundary = inferEphemeralChildBoundary({
        name: target.role.name,
        capabilities: target.capabilities?.tags,
        description: target.capabilities?.description,
      }).role;
      resolvedExecutionIntent = resolveDialogSubtaskExecutionIntent({
        roleBoundary: resolvedRoleBoundary,
        task: resolvedTask,
        overrideToolPolicy: resolvedOverrides.toolPolicy,
        explicitExecutionIntent,
      });
    }
    const executorTaskSpecificToolPolicy = buildExecutorTaskSpecificToolPolicy({
      roleBoundary: resolvedRoleBoundary,
      task: resolvedTask,
    });
    if (executorTaskSpecificToolPolicy) {
      resolvedOverrides.toolPolicy = mergeToolPolicies(
        resolvedOverrides.toolPolicy,
        executorTaskSpecificToolPolicy,
      );
    }
    resolvedOverrides.toolPolicy = buildExecutionIntentToolPolicy({
      executionIntent: resolvedExecutionIntent,
      resultContract: resolvedOverrides.resultContract,
      overrideToolPolicy: resolvedOverrides.toolPolicy,
    }) ?? resolvedOverrides.toolPolicy;
    try {
      this.assertActorSpawnAllowed(spawnerActorId, resolvedTargetActorId);
    } catch (error) {
      return rejectSpawn(error instanceof Error ? error.message : String(error));
    }

    if (Object.keys(resolvedOverrides).length > 0) {
      log(`spawnTask: prepared run overrides for ${target.role.name}`, JSON.stringify(resolvedOverrides).slice(0, 200));
    }

    const mode = opts?.mode ?? "run";
    const existingOpenSession = this.getOpenSpawnedSessionByTarget(resolvedTargetActorId);
    if (mode === "session" && existingOpenSession) {
      if (existingOpenSession.spawnerActorId !== spawnerActorId) {
        return rejectSpawn(`[sessions_spawn] ${target.role.name} 已绑定到另一个子会话（runId=${existingOpenSession.runId}）`);
      }
      if (
        plannedSpawn?.id
        && existingOpenSession.plannedDelegationId
        && existingOpenSession.plannedDelegationId !== plannedSpawn.id
      ) {
        return rejectSpawn(`[sessions_spawn] ${target.role.name} 当前保留会话已绑定到另一条建议委派（runId=${existingOpenSession.runId}）`);
      }
      existingOpenSession.contractId = activeContract?.contractId ?? existingOpenSession.contractId;
      existingOpenSession.plannedDelegationId = plannedSpawn?.id ?? existingOpenSession.plannedDelegationId;
      existingOpenSession.dispatchSource = plannedSpawn ? "contract_suggestion" : existingOpenSession.dispatchSource;
      return this.continueSpawnedSession(existingOpenSession.runId, spawnerActorId, resolvedTask, {
        label: opts?.label,
        context: opts?.context,
        attachments: opts?.attachments,
        images: opts?.images,
      });
    }

    if (mode === "run" && target.status === "running") {
      return rejectSpawn(`[sessions_spawn] ${target.role.name} is already running a task (mode='run' requires idle target)`);
    }
    if (mode === "session" && target.status === "running") {
      return rejectSpawn(`[sessions_spawn] ${target.role.name} 正在执行其他任务，请等待空闲后再创建新的子会话`);
    }

    const parentRecord = this.getOwningSpawnedTaskForActor(spawnerActorId);
    if (parentRecord) {
      return rejectSpawn("[sessions_spawn] 当前默认只允许顶层协调者创建子线程；请把新增分工建议回传给父 Agent，由父 Agent 继续派工。");
    }

    const coordinatorId = this.getCoordinatorId();
    if (coordinatorId && spawnerActorId !== coordinatorId) {
      return rejectSpawn(`[sessions_spawn] 当前默认只允许协调者 ${this.actors.get(coordinatorId)?.role.name ?? coordinatorId} 创建子线程`);
    }

    const depth = this.getSpawnDepth(spawnerActorId);
    if (depth >= MAX_SPAWN_DEPTH) {
      return rejectSpawn(`[sessions_spawn] spawn not allowed at this depth (current: ${depth}, max: ${MAX_SPAWN_DEPTH})`);
    }

    const activeChildren = this.getActiveSpawnedTasks(spawnerActorId).length;
    if (activeChildren >= MAX_CHILDREN_PER_AGENT) {
      return rejectSpawn(`[sessions_spawn] max active children reached (${activeChildren}/${MAX_CHILDREN_PER_AGENT})`);
    }

    const runId = generateId();
    const spawnedAt = Date.now();
    const spawnerName = spawner.role.name;
    const targetName = target.role.name;
    const label = opts?.label ?? plannedSpawn?.label ?? task.slice(0, 30);
    const baseBudgetSeconds = normalizePositiveSeconds(target.timeoutSeconds)
      ?? DEFAULT_DIALOG_WORKER_BUDGET_SECONDS;
    const budgetSeconds = requestedTimeoutSeconds
      ? Math.max(requestedTimeoutSeconds, baseBudgetSeconds)
      : baseBudgetSeconds;
    const idleLeaseSeconds = normalizePositiveSeconds(target.idleLeaseSeconds)
      ?? DEFAULT_DIALOG_WORKER_IDLE_LEASE_SECONDS;
    const cleanup = opts?.cleanup ?? (opts?.createIfMissing && mode === "run" ? "delete" : "keep");
    const expectsCompletionMessage = opts?.expectsCompletionMessage ?? true;
    const effectiveContext = opts?.context ?? plannedSpawn?.context;
    const roleBoundaryInstruction = buildSpawnTaskRoleBoundaryInstruction(resolvedRoleBoundary);
    const executionHint = buildSpawnTaskExecutionHint(resolvedTask);
    const inlineOnlyExecutorTask = Boolean(executorTaskSpecificToolPolicy);
    const fullTask = buildDelegatedTaskPrompt({
      spawnerName,
      task: resolvedTask,
      label,
      roleBoundaryInstruction,
      context: effectiveContext,
      attachments: opts?.attachments,
      executionHint,
      inlineOnly: inlineOnlyExecutorTask,
    });
    const effectiveRunOverrides: import("./types").SpawnTaskOverrides = {
      ...resolvedOverrides,
      timeoutSeconds: budgetSeconds,
      idleLeaseSeconds,
    };
    const runtimeProfile = resolveDialogSubtaskProfile(resolvedRoleBoundary);
    const record: SpawnedTaskRecord = {
      runId,
      spawnerActorId,
      targetActorId: resolvedTargetActorId,
      contractId: activeContract?.contractId,
      plannedDelegationId: plannedSpawn?.id,
      dispatchSource: plannedSpawn ? "contract_suggestion" : "manual",
      parentRunId: undefined,
      rootRunId: runId,
      roleBoundary: resolvedRoleBoundary,
      executionIntent: resolvedExecutionIntent,
      resultContract: resolvedOverrides.resultContract,
      deliveryTargetId: resolvedOverrides.deliveryTargetId,
      deliveryTargetLabel: resolvedOverrides.deliveryTargetLabel,
      sheetName: resolvedOverrides.sheetName,
      task: resolvedTask,
      label,
      images: opts?.images?.length ? [...new Set(opts.images)] : undefined,
      status: "running",
      spawnedAt,
      budgetSeconds,
      idleLeaseSeconds,
      mode,
      expectsCompletionMessage,
      cleanup,
      sessionHistoryStartIndex: target.getSessionHistory().length,
      sessionOpen: mode === "session",
      lastActiveAt: spawnedAt,
      runtime: {
        subtaskId: runId,
        profile: runtimeProfile,
        startedAt: spawnedAt,
        timeoutSeconds: budgetSeconds,
        eventCount: 0,
      },
    };

    void this.runHooks<SpawnTaskHookContext>("onSpawnTask", {
      system: this,
      actorId: resolvedTargetActorId,
      actorName: targetName,
      timestamp: Date.now(),
      spawnerId: spawnerActorId,
      targetId: resolvedTargetActorId,
      task: resolvedTask,
      mode,
      runId,
    });

    this.traceFlow("spawn_accepted", {
      run_id: runId,
      status: "accepted",
      phase: mode,
      target: resolvedTargetActorId,
      execution_intent: resolvedExecutionIntent,
      preview: previewActorSystemText(resolvedTask),
    }, spawnerActorId);

    return this.dialogSubtaskRuntime.startTask({
      record,
      target,
      fullTask,
      images: opts?.images,
      runOverrides: effectiveRunOverrides,
    });
  }

  /** 获取某个 Agent 派发的所有 spawned tasks */
  getSpawnedTasks(actorId: string): SpawnedTaskRecord[] {
    return this.dialogSubtaskRuntime.getSpawnedTasks(actorId);
  }

  buildWaitForSpawnedTasksResult(actorId: string) {
    const base = this.dialogSubtaskRuntime.buildWaitForSpawnedTasksResult(actorId);
    const pendingDispatches = this.getDeferredSpawnRequests(actorId);
    const pendingDispatchCount = pendingDispatches.length;
    const plannedCount = base.tasks.length + pendingDispatchCount;

    let summary = base.summary;
    if (pendingDispatchCount > 0) {
      summary = base.pending_count > 0
        ? `当前有 ${base.pending_count} 个子任务运行中，另有 ${pendingDispatchCount} 个子任务排队待派发。`
        : `当前有 ${pendingDispatchCount} 个子任务排队待派发，系统会在空位出现后自动补派。`;
    }

    return {
      ...base,
      wait_complete: base.wait_complete && pendingDispatchCount === 0,
      aggregation_ready: base.aggregation_ready && pendingDispatchCount === 0,
      summary,
      planned_count: plannedCount,
      pending_dispatch_count: pendingDispatchCount,
      pending_dispatches: pendingDispatches.map((request, index) => ({
        queue_id: request.id,
        target_actor_id: request.targetActorId,
        target_actor_name: this.getActorName(request.targetActorId),
        label: request.label,
        task: request.task,
        mode: request.mode ?? "run",
        role_boundary: request.roleBoundary,
        profile: request.profile,
        execution_intent: request.executionIntent,
        queued_at: request.queuedAt,
        queue_position: index + 1,
      })),
    };
  }

  collectStructuredSpawnedTaskResults(
    actorId: string,
    opts?: {
      terminalOnly?: boolean;
      excludeRunIds?: Iterable<string>;
    },
  ) {
    return this.dialogSubtaskRuntime.collectStructuredSpawnedTaskResults(actorId, opts);
  }

  waitForSpawnedTaskUpdate(actorId: string, timeoutMs: number): Promise<{ reason: "task_update" | "timeout" }> {
    return this.dialogSubtaskRuntime.waitForSpawnedTaskUpdate(actorId, timeoutMs);
  }

  /** 清理已完成的任务记录（可选调用） */
  pruneSpawnedTasks(): number {
    const removed = this.dialogSubtaskRuntime.pruneCompletedTasks();
    if (removed > 0) {
      log(`pruneSpawnedTasks: removed ${removed} completed tasks`);
    }
    return removed;
  }

  /** 获取某个 Agent 的 running 状态 spawned tasks */
  getActiveSpawnedTasks(actorId: string): SpawnedTaskRecord[] {
    return this.dialogSubtaskRuntime.getActiveSpawnedTasks(actorId);
  }

  getDialogSpawnConcurrencyLimit(): number {
    return MAX_ACTIVE_DIALOG_CHILDREN;
  }

  abortActiveRunSpawnedTasks(spawnerActorId: string, error = "父任务被终止"): number {
    const aborted = this.dialogSubtaskRuntime.abortActiveRunTasksForSpawner(spawnerActorId, error);
    if (aborted > 0) {
      this.tryFinalizeExecutionContract();
      this.scheduleExecutionContractProgressCheck();
    }
    return aborted;
  }

  /** 获取所有 spawned tasks 快照 */
  getSpawnedTasksSnapshot(): SpawnedTaskRecord[] {
    return this.dialogSubtaskRuntime.getSpawnedTasksSnapshot();
  }

  getSpawnedTask(runId: string): SpawnedTaskRecord | undefined {
    return this.dialogSubtaskRuntime.getSpawnedTask(runId);
  }

  getFocusedSpawnedSessionRunId(): string | null {
    return this.dialogSubtaskRuntime.getFocusedSessionRunId();
  }

  focusSpawnedSession(runId: string | null): void {
    this.dialogSubtaskRuntime.focusSession(runId);
  }

  closeSpawnedSession(runId: string): void {
    const record = this.dialogSubtaskRuntime.closeSessionByRunId(runId);
    if (!record) return;
  }

  abortSpawnedTask(runId: string, opts?: { error?: string }): void {
    const record = this.dialogSubtaskRuntime.getSpawnedTask(runId);
    if (!record) return;
    if (record.status !== "running" && !(record.mode === "session" && record.sessionOpen)) return;

    this.abortSpawnedTaskRecord(record, {
      error: opts?.error ?? "子会话已由用户终止",
    });
    this.tryFinalizeExecutionContract();
    this.scheduleExecutionContractProgressCheck();
  }

  continueSpawnedSession(
    runId: string,
    fromActorId: string,
    content: string,
    opts?: {
      label?: string;
      context?: string;
      attachments?: string[];
      images?: string[];
    },
  ): SpawnedTaskRecord | { error: string } {
    const record = this.getOpenSpawnedSessionByRunId(runId);
    if (!record) {
      return { error: `Spawned session ${runId} 不存在或已关闭` };
    }
    const spawner = this.actors.get(fromActorId);
    const target = this.actors.get(record.targetActorId);
    if (!spawner || !target) {
      return { error: `子会话参与方不存在（runId=${runId}）` };
    }
    if (record.spawnerActorId !== fromActorId) {
      return { error: `只有会话发起者 ${this.actors.get(record.spawnerActorId)?.role.name ?? record.spawnerActorId} 可以继续这个子会话` };
    }

    const chunks = [content];
    if (opts?.context) chunks.push(`补充上下文：${opts.context}`);
    if (opts?.attachments?.length) {
      chunks.push(`附件文件路径：\n${opts.attachments.map((filePath) => `- ${filePath}`).join("\n")}`);
    }
    const sessionMessage = chunks.filter(Boolean).join("\n\n");

    this.dialogSubtaskRuntime.resetSessionTaskForResume(record, {
      timestamp: Date.now(),
      label: opts?.label,
      images: opts?.images,
    });

    this.send(fromActorId, record.targetActorId, sessionMessage, {
      images: opts?.images,
      bypassPlanCheck: true,
      relatedRunId: record.runId,
    });

    return record;
  }

  sendUserMessageToSpawnedSession(
    runId: string,
    content: string,
    opts?: { _briefContent?: string; images?: string[] },
  ): DialogMessage {
    const record = this.getOpenSpawnedSessionByRunId(runId);
    if (!record) {
      throw new Error(`Spawned session ${runId} 不存在或已关闭`);
    }
    this.dialogSubtaskRuntime.resetSessionTaskForResume(record, {
      timestamp: Date.now(),
    });
    this.dialogSubtaskRuntime.focusSession(runId);
    return this.send("user", record.targetActorId, content, {
      _briefContent: opts?._briefContent,
      images: opts?.images,
      bypassPlanCheck: true,
      relatedRunId: runId,
    });
  }

  recordArtifact(record: Omit<DialogArtifactRecord, "id" | "fileName" | "directory"> & { id?: string }): DialogArtifactRecord {
    const pathKey = this.getArtifactKey(record.path);
    const existing = this.artifactRecords.get(pathKey);
    const normalized: DialogArtifactRecord = {
      id: record.id ?? existing?.id ?? `artifact-${generateId()}`,
      actorId: record.actorId,
      path: pathKey,
      fileName: basename(pathKey),
      directory: dirname(pathKey),
      source: record.source,
      toolName: record.toolName,
      summary: record.summary,
      preview: record.preview ?? existing?.preview,
      fullContent: record.fullContent ?? existing?.fullContent,
      language: record.language ?? existing?.language ?? inferLanguageFromPath(pathKey),
      timestamp: record.timestamp,
      relatedRunId: record.relatedRunId ?? existing?.relatedRunId,
    };
    this.artifactRecords.set(pathKey, normalized);
    if (normalized.relatedRunId) {
      const spawnedTask = this.dialogSubtaskRuntime.getSpawnedTask(normalized.relatedRunId);
      if (spawnedTask) {
        spawnedTask.lastActiveAt = Math.max(
          spawnedTask.lastActiveAt ?? 0,
          normalized.timestamp,
        );
      }
    }
    return normalized;
  }

  stageResultMedia(
    actorId: string,
    media: Pick<DialogMessage, "images" | "attachments">,
  ): Pick<DialogMessage, "images" | "attachments"> {
    const existing = this.stagedResultMedia.get(actorId);
    const nextImages = [...new Set([
      ...(existing?.images ?? []),
      ...(media.images ?? []),
    ].map((value) => normalizePath(value)).filter(Boolean))];
    const nextAttachments = new Map<string, { path: string; fileName?: string }>();
    for (const item of [...(existing?.attachments ?? []), ...(media.attachments ?? [])]) {
      const normalizedPath = normalizePath(item.path);
      if (!normalizedPath) continue;
      nextAttachments.set(normalizedPath, {
        path: normalizedPath,
        ...(item.fileName ? { fileName: item.fileName } : {}),
      });
    }

    const staged = {
      ...(nextImages.length ? { images: nextImages } : {}),
      ...(nextAttachments.size ? { attachments: [...nextAttachments.values()] } : {}),
    } satisfies Pick<DialogMessage, "images" | "attachments">;

    if (!staged.images?.length && !staged.attachments?.length) {
      this.stagedResultMedia.delete(actorId);
      return {};
    }

    this.stagedResultMedia.set(actorId, staged);
    return {
      ...(staged.images?.length ? { images: [...staged.images] } : {}),
      ...(staged.attachments?.length ? { attachments: staged.attachments.map((item) => ({ ...item })) } : {}),
    };
  }

  getStagedResultMediaSnapshot(
    actorId: string,
  ): Pick<DialogMessage, "images" | "attachments"> {
    const staged = this.stagedResultMedia.get(actorId);
    return {
      ...(staged?.images?.length ? { images: [...staged.images] } : {}),
      ...(staged?.attachments?.length ? { attachments: staged.attachments.map((item) => ({ ...item })) } : {}),
    };
  }

  private consumeStagedResultMedia(
    actorId: string,
  ): Pick<DialogMessage, "images" | "attachments"> {
    const staged = this.getStagedResultMediaSnapshot(actorId);
    this.stagedResultMedia.delete(actorId);
    return staged;
  }

  getArtifactRecordsSnapshot(): DialogArtifactRecord[] {
    return [...this.artifactRecords.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  restoreArtifactRecords(records: readonly DialogArtifactRecord[]): void {
    this.artifactRecords.clear();
    for (const record of records) {
      this.artifactRecords.set(this.getArtifactKey(record.path), { ...record });
    }
  }

  registerSessionUploads(
    records: readonly SessionUploadRecord[],
    opts?: {
      actorId?: string;
      relatedRunId?: string;
    },
  ): void {
    for (const record of records) {
      const key = record.path ? this.getArtifactKey(record.path) : `${record.type}:${record.name}`;
      this.sessionUploads.set(key, { ...record });
      if (!record.path) continue;

      const existingArtifact = this.artifactRecords.get(this.getArtifactKey(record.path));
      const summary = record.type === "image"
        ? `用户上传了图片：${record.name}`
        : `用户上传了文件：${record.name}`;
      this.recordArtifact({
        actorId: opts?.actorId ?? existingArtifact?.actorId ?? "user",
        path: record.path,
        source: "upload",
        summary,
        preview: record.preview ?? record.excerpt ?? existingArtifact?.preview,
        fullContent: record.excerpt ?? existingArtifact?.fullContent,
        language: record.originalExt
          ? record.originalExt.replace(/^\./, "").toLowerCase()
          : existingArtifact?.language,
        timestamp: record.addedAt,
        relatedRunId: opts?.relatedRunId ?? existingArtifact?.relatedRunId,
      });
    }
  }

  getSessionUploadsSnapshot(): SessionUploadRecord[] {
    return [...this.sessionUploads.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  restoreSessionUploads(records: readonly SessionUploadRecord[]): void {
    this.sessionUploads.clear();
    for (const record of records) {
      const key = record.path ? this.getArtifactKey(record.path) : `${record.type}:${record.name}`;
      this.sessionUploads.set(key, { ...record });
    }
  }

  private collectShareableResultMedia(
    actorId: string,
    relatedRunId?: string,
  ): Pick<DialogMessage, "images" | "attachments"> {
    const actorWorkspace = this.actors.get(actorId)?.workspace;
    const lastResultTimestamp = [...this.dialogHistory]
      .slice()
      .reverse()
      .find((message) =>
        message.kind === "agent_result"
        && message.from === actorId
        && message.relatedRunId === relatedRunId,
      )?.timestamp;

    const candidateArtifacts = this.getArtifactRecordsSnapshot()
      .filter((artifact) => {
        if (artifact.actorId !== actorId) return false;
        if (!RESULT_SHAREABLE_ARTIFACT_SOURCES.has(artifact.source)) return false;
        if (relatedRunId ? artifact.relatedRunId !== relatedRunId : Boolean(artifact.relatedRunId)) return false;
        if (typeof lastResultTimestamp === "number" && artifact.timestamp <= lastResultTimestamp) return false;
        return isLikelyUserShareableArtifactPath(artifact.path, actorWorkspace);
      })
      .sort((left, right) => left.timestamp - right.timestamp);

    const seenPaths = new Set<string>();
    const images: string[] = [];
    const attachments: Array<{ path: string; fileName?: string }> = [];

    for (const artifact of candidateArtifacts) {
      const normalizedPath = normalizePath(artifact.path);
      if (!normalizedPath || seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);

      if (isLikelyVisualAttachmentPath(normalizedPath)) {
        images.push(normalizedPath);
      } else {
        attachments.push({
          path: normalizedPath,
          fileName: artifact.fileName || basename(normalizedPath),
        });
      }
    }

    return {
      ...(images.length ? { images } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
  }

  /**
   * 获取某个 Agent 的完整后代任务树（含孙任务、曾孙任务...）。
   * 返回扁平列表，每个 record 带 depth 字段表示层级。
   */
  getDescendantTasks(actorId: string): Array<SpawnedTaskRecord & { depth: number }> {
    return this.dialogSubtaskRuntime.getDescendantTasks(actorId);
  }

  /** 计算 spawn 链深度（通过 spawnedTasks 回溯 spawner 链） */
  private getSpawnDepth(actorId: string): number {
    return this.dialogSubtaskRuntime.getSpawnDepth(actorId);
  }

  /**
   * Steer：向运行中的 Agent 注入高优先级指令，Agent 在下一次 inboxDrain 时读取。
   * 对标 OpenClaw 的 steer 能力。
   */
  steer(actorId: string, directive: string, from = "user"): DialogMessage | { error: string } {
    const actor = this.actors.get(actorId);
    if (!actor) return { error: `Agent ${actorId} not found` };
    const actorName = actor.role.name;
    log(`steer: → ${actorName}, directive="${directive.slice(0, 60)}"`);

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to: actorId,
      content: `[STEER 指令] ${directive}`,
      timestamp: Date.now(),
      priority: "urgent",
      kind: "system_notice",
    };

    actor.receive(msg);
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    return msg;
  }

  /** 级联 abort 某个 Agent 的所有 running / open spawned tasks */
  private cascadeAbortSpawns(actorId: string, error = "父任务被终止"): void {
    const activeSpawns = this.dialogSubtaskRuntime.getSpawnedTasksSnapshot().filter((record) =>
      record.spawnerActorId === actorId
      && (record.status === "running" || (record.mode === "session" && record.sessionOpen)),
    );
    for (const record of activeSpawns) {
      this.abortSpawnedTaskRecord(record, {
        error,
      });
      log(`cascadeAbort: ${record.targetActorId} (spawned by ${actorId}), runId=${record.runId}`);
    }
  }

  private abortSpawnedTaskRecord(
    record: SpawnedTaskRecord,
    options: {
      error: string;
    },
  ): void {
    const targetActor = this.actors.get(record.targetActorId);
    this.dialogSubtaskRuntime.abortTask(record, {
      error: options.error,
      targetActor,
    });

    if (targetActor) {
      this.cascadeAbortSpawns(record.targetActorId, options.error);
    }
  }

  /**
   * Announce Flow 重试：向 spawner 发送结果，失败时按 5s/10s/20s 重试。
   * 对标 OpenClaw 的 runAnnounceDeliveryWithRetry。
   */
  private announceWithRetry(
    fromActorId: string,
    toActorId: string,
    content: string,
    runId: string,
    attempt = 0,
  ): void {
    const spawnedAt = this.dialogSubtaskRuntime.getSpawnedTask(runId)?.spawnedAt ?? Date.now();
    if (Date.now() - spawnedAt > ANNOUNCE_HARD_EXPIRY_MS) {
      logWarn(`announce HARD EXPIRY: runId=${runId}, skipping delivery after 30min`);
      this.emitEvent({
        type: "spawned_task_failed",
        actorId: fromActorId,
        timestamp: Date.now(),
        detail: { runId, error: "announce delivery expired after hard timeout" } as SpawnedTaskEventDetail,
      });
      return;
    }

    try {
      const spawner = this.actors.get(toActorId);
      if (!spawner) {
        if (attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
          const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
          log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: spawner gone, retrying in ${delay / 1000}s, runId=${runId}`);
          setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
          return;
        }
        logWarn(`announce FAILED: spawner ${toActorId} not found after ${attempt} retries, runId=${runId}`);
        this.emitEvent({
          type: "spawned_task_failed",
          actorId: fromActorId,
          timestamp: Date.now(),
          detail: { runId, error: "announce delivery failed: spawner not found after retries" } as SpawnedTaskEventDetail,
        });
        return;
      }
      const spawnedTaskResult = this.dialogSubtaskRuntime.getStructuredSubtaskResult(runId);
      this.send(fromActorId, toActorId, content, {
        relatedRunId: runId,
        spawnedTaskResult,
      });
    } catch (err) {
      const errSummary = summarizeError(err);

      if (isTransientAnnounceError(err) && attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
        const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
        log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: transient error="${errSummary}", retrying in ${delay / 1000}s, runId=${runId}`);
        setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
      } else if (!isTransientAnnounceError(err) && attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
        const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
        log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: unknown error="${errSummary}", retrying in ${delay / 1000}s, runId=${runId}`);
        setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
      } else {
        logWarn(`announce FAILED after ${attempt} retries (last error: "${errSummary}"), runId=${runId}`, err);
        this.emitEvent({
          type: "spawned_task_failed",
          actorId: fromActorId,
          timestamp: Date.now(),
          detail: { runId, error: `announce delivery failed after retries: ${errSummary}` } as SpawnedTaskEventDetail,
        });
      }
    }
  }

  // ── Result / Question Publishing ──

  /**
   * 将 Actor 的任务结果发布到对话历史。
   * 默认不投递到其他 Agent inbox；仅在显式开启 fanout 时才会分发。
   */
  publishResult(
    actorId: string,
    content: string,
    opts?: {
      fanoutToPeers?: boolean;
      suppressLowSignal?: boolean;
      phase?: "final" | "failure" | "intermediate";
    },
  ): DialogMessage | null {
    const trimmed = content.trim();
    if (!trimmed) return null;
    const structuredReply = splitStructuredMediaReply(trimmed);
    const visibleContent = structuredReply.text.trim() || trimmed;

    const actor = this.actors.get(actorId);
    const actorName = actor?.role.name ?? actorId;
    const coordinatorId = this.getCoordinatorId();
    const fromNonCoordinator = coordinatorId ? actorId !== coordinatorId : false;
    const suppressLowSignal = opts?.suppressLowSignal ?? true;
    const relatedRunId = this.dialogSubtaskRuntime.getRelatedRunIdForActor(actorId);

    if (suppressLowSignal && fromNonCoordinator && isLowSignalCoordinationMessage(visibleContent)) {
      log(`publishResult: suppress low-signal message from ${actorName}`);
      return null;
    }

    const inferredResultMedia = this.collectShareableResultMedia(actorId, relatedRunId);
    const stagedResultMedia = this.consumeStagedResultMedia(actorId);
    const resultImages = [...new Set([
      ...(inferredResultMedia.images ?? []),
      ...(stagedResultMedia.images ?? []),
      ...(structuredReply.images ?? []),
    ])];
    const resultAttachments = new Map<string, { path: string; fileName?: string }>();
    for (const item of [
      ...(inferredResultMedia.attachments ?? []),
      ...(stagedResultMedia.attachments ?? []),
      ...(structuredReply.attachments ?? []),
    ]) {
      const normalizedPath = normalizePath(item.path);
      if (!normalizedPath) continue;
      resultAttachments.set(normalizedPath, {
        path: normalizedPath,
        ...(item.fileName ? { fileName: item.fileName } : {}),
      });
    }

    const msg: DialogMessage = {
      id: generateId(),
      from: actorId,
      to: undefined, // 广播模式
      content: visibleContent,
      timestamp: Date.now(),
      priority: "normal",
      kind: "agent_result",
      relatedRunId,
      ...this.buildDialogMessageRecallPatch(actorId),
      ...(resultImages.length ? { images: resultImages } : {}),
      ...(resultAttachments.size ? { attachments: [...resultAttachments.values()] } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    this.traceFlow("publish_result", {
      phase: opts?.phase ?? "final",
      run_id: relatedRunId,
      status: "published",
      preview: previewActorSystemText(visibleContent),
    }, actorId);

    if (opts?.fanoutToPeers) {
      for (const other of this.actors.values()) {
        if (other.id === actorId) continue;
        log(`publishResult: delivering ${actorName}'s result to ${other.role.name}`);
        other.receive({
          id: msg.id,
          from: msg.from,
          content: msg.content,
          timestamp: msg.timestamp,
          priority: msg.priority,
          expectReply: msg.expectReply,
          replyTo: msg.replyTo,
          attachments: msg.attachments,
          images: msg.images,
        });
      }
    }

    return msg;
  }

  publishSystemNotice(
    content: string,
    opts?: {
      from?: string;
      relatedRunId?: string;
    },
  ): DialogMessage | null {
    const trimmed = content.trim();
    if (!trimmed) return null;

    const msg: DialogMessage = {
      id: generateId(),
      from: opts?.from?.trim() || "system",
      to: undefined,
      content: trimmed,
      timestamp: Date.now(),
      priority: "normal",
      kind: "system_notice",
      ...(opts?.relatedRunId ? { relatedRunId: opts.relatedRunId } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    return msg;
  }

  /**
   * Agent 在聊天流中向用户提问，并等待用户回复。
   * 用于替代 askUser 弹窗，让提问直接出现在对话流中。
   */
  askUserInChat(
    actorId: string,
    question: string,
    opts?: number | {
      timeoutMs?: number;
      interactionType?: PendingInteractionType;
      options?: string[];
      replyMode?: PendingInteractionReplyMode;
      approvalRequest?: ApprovalRequest;
    },
  ): Promise<PendingInteractionResult> {
    const actorName = this.actors.get(actorId)?.role.name ?? actorId;
    log(`askUserInChat: ${actorName} asks user, question="${question.slice(0, 60)}"`);
    const normalizedOpts = typeof opts === "number" ? { timeoutMs: opts } : (opts ?? {});
    const timeoutMs = normalizedOpts.timeoutMs ?? 300_000;
    const interactionType = normalizedOpts.interactionType ?? "question";
    const options = normalizedOpts.options;
    const replyMode = normalizedOpts.replyMode ?? "single";
    const approvalRequest = normalizedOpts.approvalRequest;
    const relatedRunId = this.dialogSubtaskRuntime.getRelatedRunIdForActor(actorId);
    if (approvalRequest?.targetPath) {
      this.recordArtifact({
        actorId,
        path: approvalRequest.targetPath,
        source: "approval",
        toolName: approvalRequest.toolName,
        summary: approvalRequest.summary ?? "待确认的文件写入",
        preview: approvalRequest.preview,
        fullContent: approvalRequest.fullContent,
        language: approvalRequest.previewLanguage,
        timestamp: Date.now(),
        relatedRunId,
      });
    }
    const msg: DialogMessage = {
      id: generateId(),
      from: actorId,
      to: "user",
      content: question,
      timestamp: Date.now(),
      priority: "normal",
      expectReply: true,
      kind: getInteractionRequestKind(interactionType),
      interactionType,
      interactionStatus: "pending",
      options,
      interactionId: generateId(),
      approvalRequest,
      relatedRunId,
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);

    return new Promise<PendingInteractionResult>((resolve) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pendingInteractions.get(msg.id);
        if (!pending) return;
        pending.status = "timed_out";
        this.pendingInteractions.delete(msg.id);
        this.updateDialogMessage(msg.id, { interactionStatus: "timed_out" });
        this.emitEvent(msg); // re-sync so UI clears the pending indicator
        resolve({
          interactionId: pending.id,
          interactionType: pending.type,
          status: "timed_out",
          content: "",
        });
      }, timeoutMs);

      this.pendingInteractions.set(msg.id, {
        id: msg.interactionId!,
        fromActorId: actorId,
        messageId: msg.id,
        question,
        type: interactionType,
        replyMode,
        status: "pending",
        createdAt: msg.timestamp,
        expiresAt: msg.timestamp + timeoutMs,
        options,
        approvalRequest,
        resolve,
        timeoutId,
      });

      // emit AFTER pendingReplies is populated so sync() sees it
      this.emitEvent(msg);
    });
  }

  /**
   * 用户回复某条 expectReply 消息。
   * 由 UI 调用，将回复路由到等待中的 pending reply。
   */
  replyToMessage(
    messageId: string,
    content: string,
    opts?: {
      _briefContent?: string;
      images?: string[];
    },
  ): DialogMessage {
    const pendingInteraction = this.pendingInteractions.get(messageId);
    const sourceMessage = this.dialogHistory.find((message) => message.id === messageId);
    const relatedRunId = sourceMessage?.relatedRunId
      ?? (pendingInteraction ? this.dialogSubtaskRuntime.getRelatedRunIdForActor(pendingInteraction.fromActorId) : undefined);
    if (pendingInteraction) {
      const msg: DialogMessage = {
        id: generateId(),
        from: "user",
        to: pendingInteraction.fromActorId,
        content,
        timestamp: Date.now(),
        priority: "normal",
        replyTo: messageId,
        _briefContent: opts?._briefContent,
        kind: getInteractionResponseKind(pendingInteraction.type),
        interactionType: pendingInteraction.type,
        interactionId: pendingInteraction.id,
        interactionStatus: "answered",
        relatedRunId,
        ...(opts?.images?.length ? { images: opts.images } : {}),
      };
      this.dialogHistory.push(msg);
      appendDialogMessage(this.sessionId, msg);
      this.emitEvent(msg);

      pendingInteraction.status = "answered";
      if (pendingInteraction.timeoutId) clearTimeout(pendingInteraction.timeoutId);
      this.pendingInteractions.delete(messageId);
      this.updateDialogMessage(messageId, { interactionStatus: "answered" });
      pendingInteraction.resolve({
        interactionId: pendingInteraction.id,
        interactionType: pendingInteraction.type,
        status: "answered",
        content,
        message: msg,
      });
      return msg;
    }

    const pendingReply = this.pendingReplies.get(messageId);
    if (pendingReply) {
      const msg: DialogMessage = {
        id: generateId(),
        from: "user",
        to: pendingReply.fromActorId,
        content,
        timestamp: Date.now(),
        priority: "normal",
        replyTo: messageId,
        _briefContent: opts?._briefContent,
        kind: getInteractionResponseKind("question"),
        interactionType: "question",
        interactionStatus: "answered",
        relatedRunId,
        ...(opts?.images?.length ? { images: opts.images } : {}),
      };
      this.dialogHistory.push(msg);
      appendDialogMessage(this.sessionId, msg);
      this.emitEvent(msg);

      if (pendingReply.timeoutId) clearTimeout(pendingReply.timeoutId);
      this.pendingReplies.delete(messageId);
      pendingReply.resolve(msg);
      return msg;
    }

    const sourceInteractionType = sourceMessage?.interactionType
      ?? (sourceMessage?.kind === "approval_request"
        ? "approval"
        : sourceMessage?.kind === "clarification_request"
          ? "clarification"
          : sourceMessage?.expectReply
            ? "question"
            : undefined);
    const canResumePersistedInteraction = Boolean(
      sourceMessage
      && sourceMessage.from !== "user"
      && sourceMessage.expectReply
      && sourceMessage.interactionStatus === "pending"
      && sourceInteractionType
      && this.actors.has(sourceMessage.from),
    );

    if (canResumePersistedInteraction && sourceMessage && sourceInteractionType) {
      const msg: DialogMessage = {
        id: generateId(),
        from: "user",
        to: sourceMessage.from,
        content,
        timestamp: Date.now(),
        priority: "normal",
        replyTo: messageId,
        _briefContent: opts?._briefContent,
        kind: getInteractionResponseKind(sourceInteractionType),
        interactionType: sourceInteractionType,
        interactionId: sourceMessage.interactionId,
        interactionStatus: "answered",
        relatedRunId,
        ...(opts?.images?.length ? { images: opts.images } : {}),
      };
      this.dialogHistory.push(msg);
      appendDialogMessage(this.sessionId, msg);
      this.emitEvent(msg);
      this.updateDialogMessage(messageId, { interactionStatus: "answered" });
      return msg;
    }

    const fallbackActorId = sourceMessage?.from && sourceMessage.from !== "user" && this.actors.has(sourceMessage.from)
      ? sourceMessage.from
      : this.getCoordinator()?.id;

    if (fallbackActorId) {
      log(`replyToMessage: no pending interaction for ${messageId}, routing late reply to ${fallbackActorId} as a new user message`);
      return this.send("user", fallbackActorId, content, {
        _briefContent: opts?._briefContent,
        images: opts?.images,
        bypassPlanCheck: true,
        relatedRunId,
      });
    }

    const msg: DialogMessage = {
      id: generateId(),
      from: "user",
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      replyTo: messageId,
      _briefContent: opts?._briefContent,
      kind: "user_input",
      relatedRunId,
      ...(opts?.images?.length ? { images: opts.images } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    return msg;
  }

  /** 获取所有等待用户回复的交互 */
  getPendingUserInteractions(): PendingInteraction[] {
    return [...this.pendingInteractions.values()]
      .filter((interaction) => interaction.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 获取待交互快照，避免上层直接持有内部引用 */
  getPendingInteractionsSnapshot(): PendingInteraction[] {
    return this.getPendingUserInteractions().map((interaction) => ({
      ...interaction,
      ...(interaction.options ? { options: [...interaction.options] } : {}),
      ...(interaction.approvalRequest
        ? {
            approvalRequest: {
              ...interaction.approvalRequest,
              ...(interaction.approvalRequest.details
                ? {
                    details: interaction.approvalRequest.details.map((detail) => ({ ...detail })),
                  }
                : {}),
              ...(interaction.approvalRequest.decisionOptions
                ? {
                    decisionOptions: interaction.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                  }
                : {}),
            },
          }
        : {}),
    }));
  }

  /** 取消某个 Actor 发起的所有待用户交互（用于任务 abort / actor stop） */
  cancelPendingInteractionsForActor(actorId: string): number {
    let cancelled = 0;

    for (const [messageId, pending] of [...this.pendingInteractions.entries()]) {
      if (pending.fromActorId !== actorId || pending.status !== "pending") continue;

      pending.status = "cancelled";
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pendingInteractions.delete(messageId);
      this.updateDialogMessage(messageId, { interactionStatus: "cancelled" });
      const updatedMessage = this.dialogHistory.find((message) => message.id === messageId);
      if (updatedMessage) {
        this.emitEvent(updatedMessage);
      }
      pending.resolve({
        interactionId: pending.id,
        interactionType: pending.type,
        status: "cancelled",
        content: "",
      });
      cancelled++;
    }

    return cancelled;
  }

  // ── Dialog History ──

  getDialogHistory(): readonly DialogMessage[] {
    return this.dialogHistory;
  }

  getDialogMessagesSnapshot(): DialogMessage[] {
    return this.dialogHistory.map((message) => ({
      ...message,
      ...(message.images ? { images: [...message.images] } : {}),
      ...(message.attachments ? { attachments: message.attachments.map((item) => ({ ...item })) } : {}),
      ...(message.options ? { options: [...message.options] } : {}),
      ...(message.appliedMemoryPreview ? { appliedMemoryPreview: [...message.appliedMemoryPreview] } : {}),
      ...(message.appliedTranscriptPreview ? { appliedTranscriptPreview: [...message.appliedTranscriptPreview] } : {}),
      ...(message.approvalRequest
        ? {
            approvalRequest: {
              ...message.approvalRequest,
              ...(message.approvalRequest.details
                ? {
                    details: message.approvalRequest.details.map((detail) => ({ ...detail })),
                  }
                : {}),
              ...(message.approvalRequest.decisionOptions
                ? {
                    decisionOptions: message.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                  }
                : {}),
            },
          }
        : {}),
    }));
  }

  getMessagesFrom(actorId: string): DialogMessage[] {
    return this.dialogHistory.filter((m) => m.from === actorId);
  }

  getMessagesBetween(a: string, b: string): DialogMessage[] {
    return this.dialogHistory.filter(
      (m) => (m.from === a && m.to === b) || (m.from === b && m.to === a),
    );
  }

  restoreDialogHistory(history: DialogMessage[]): void {
    this.dialogHistory = [...history];
    log(`Restored ${history.length} dialog messages from persisted session`);
  }

  /** 恢复子任务记录（用于 session 恢复后 UI 显示） */
  restoreSpawnedTasks(records: Array<Omit<SpawnedTaskRecord, "timeoutId">>): void {
    for (const record of records) {
      const { dispatchSource = "manual", ...restoredRecord } = record;
      const nextRecord: SpawnedTaskRecord = {
        ...restoredRecord,
        dispatchSource,
      };
      this.dialogSubtaskRuntime.restoreRecord(nextRecord);
    }
    log(`Restored ${records.length} spawned task records`);
  }

  /** 恢复指定 Actor 的会话记忆 */
  restoreActorSessionHistory(actorId: string, history: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>): void {
    const actor = this.actors.get(actorId);
    if (actor) {
      actor.loadSessionHistory(history);
      log(`Restored session history for actor ${actor.role.name}: ${history.length} entries`);
    }
  }

  clearHistory(): void {
    this.dialogHistory = [];
    this.dialogRoomCompaction = null;
  }

  /**
   * 重置 session：归档旧 transcript，清空对话历史，保留 Actor 配置。
   * 对标 OpenClaw 的 sessions.reset。
   */
  resetSession(summary?: string): string {
    const oldSessionId = this.sessionId;
    archiveSession(oldSessionId, summary);
    this.dialogHistory = [];
    (this as any).sessionId = generateId();
    this.traceFlow("session_reset", {
      previous_session: oldSessionId.slice(0, 8),
      preview: previewActorSystemText(summary),
    });
    resetDialogStepTrace();
    traceDialogSessionStarted(this.sessionId);
    this.artifactRecords.clear();
    this.sessionUploads.clear();
    this.dialogSubtaskRuntime.focusSession(null);
    this.dialogRoomCompaction = null;

    // 清空每个 Agent 的会话记忆
    for (const actor of this.actors.values()) {
      actor.clearSessionHistory();
    }

    // 清理挂起的 pendingReplies（resolve 掉防 Promise 泄漏）
    for (const [id, pending] of this.pendingReplies) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pendingReplies.delete(id);
      pending.resolve({ id, from: "system", content: "", timestamp: Date.now(), priority: "normal" as const });
    }

    for (const [messageId, pending] of this.pendingInteractions) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pendingInteractions.delete(messageId);
      pending.resolve({
        interactionId: pending.id,
        interactionType: pending.type,
        status: "cancelled",
        content: "",
      });
    }

    this.dialogSubtaskRuntime.clearAll();
    this.deferredSpawnRequests.clear();
    this.deferredSpawnDispatchingOwners.clear();
    this.activeExecutionContract = null;
    this.legacyDialogExecutionPlanRuntimeState = null;

    // 清空 transcript 内存缓存
    clearSessionCache();

    // 清理中间件状态
    clearSessionApprovals();
    clearAllTodos();
    resetTitleGeneration(oldSessionId);
    clearTelemetry();

    log(`resetSession: archived ${oldSessionId}, new session ${this.sessionId}`);
    this.syncTranscriptActors();
    this.emitEvent({
      type: "status_change",
      actorId: "system",
      timestamp: Date.now(),
      detail: { action: "session_reset", oldSessionId, newSessionId: this.sessionId },
    });
    return this.sessionId;
  }

  /**
   * 删除 session 并归档，对标 OpenClaw 的 sessions.delete。
   */
  deleteSession(sessionId?: string): void {
    const target = sessionId ?? this.sessionId;
    deleteTranscriptSession(target);
    if (target === this.sessionId) {
      this.dialogHistory = [];
    }
    log(`deleteSession: ${target}`);
  }

  /** 获取所有 Agent 的能力摘要（用于 UI 展示） */
  getCapabilitiesSummary(): Array<{ id: string; name: string; capabilities: AgentCapabilities | undefined }> {
    return this.getAll().map((a) => ({
      id: a.id,
      name: a.role.name,
      capabilities: a.capabilities,
    }));
  }

  /** 根据能力标签查找 Agent */
  findByCapability(capability: string): AgentActor[] {
    return this.getAll().filter((a) =>
      a.capabilities?.tags?.some((c: string) => c === capability || c.includes(capability) || capability.includes(c))
    );
  }

  /** 智能路由：根据任务内容自动选择最合适的 Agent（含负载感知） */
  routeTask(taskDescription: string, preferredCapabilities?: string[]): { agentId: string; reason: string }[] {
    const agents = this.getAll();
    if (agents.length === 0) return [];
    if (agents.length === 1) {
      return [{ agentId: agents[0].id, reason: "唯一可用 Agent" }];
    }

    const KEYWORD_MAP: Record<string, string[]> = {
      review: ["code_review", "security"], 审查: ["code_review", "security"],
      安全: ["security"], 漏洞: ["security", "debugging"],
      bug: ["debugging"], 调试: ["debugging"], 错误: ["debugging"],
      性能: ["performance"], 优化: ["performance"], 慢: ["performance"],
      写代码: ["code_write"], 编写: ["code_write"], 实现: ["code_write"], 开发: ["code_write"],
      分析: ["code_analysis"], 架构: ["architecture"], 设计: ["architecture"],
      重构: ["code_analysis", "code_write"],
      测试: ["testing"], 单元测试: ["testing"],
      部署: ["devops"], devops: ["devops"],
      文档: ["documentation"],
      调研: ["research"], 搜索: ["research"], 研究: ["research"],
      头脑风暴: ["creative"], 创意: ["creative"],
      数据: ["data_analysis"], 整合: ["synthesis"], 总结: ["synthesis"],
      coordinator: ["coordinator"], 协调: ["coordinator"], 分解任务: ["coordinator"],
    };

    const CAPABILITY_LABELS: Record<string, string> = {
      coordinator: "协调", code_review: "审查", code_write: "编写", code_analysis: "分析",
      security: "安全", performance: "性能", architecture: "架构", debugging: "调试",
      research: "调研", documentation: "文档", testing: "测试", devops: "DevOps",
      data_analysis: "数据", creative: "创意", synthesis: "整合",
    };

    const taskLower = taskDescription.toLowerCase();
    const matchedCaps = new Set<string>();
    for (const [kw, caps] of Object.entries(KEYWORD_MAP)) {
      if (taskLower.includes(kw.toLowerCase())) caps.forEach((c) => matchedCaps.add(c));
    }

    // 将 preferredCapabilities 也加入匹配集合
    if (preferredCapabilities?.length) {
      for (const cap of preferredCapabilities) {
        matchedCaps.add(cap);
      }
    }

    // Tokenize task for expertise matching
    const taskTokens = taskLower.split(/[\s,.:;!?，。：；！？\n]+/).filter((t) => t.length > 1);

    const coordinatorId = this.getCoordinatorId();

    const scored = agents.map((agent, idx) => {
      let score = 0;
      const agentCaps = agent.capabilities?.tags || [];
      const expertise = agent.capabilities?.expertise || [];
      const matchedLabels: string[] = [];
      const scoreBreakdown: string[] = [];

      // Capability match: +10 per matched capability
      for (const cap of matchedCaps) {
        if (agentCaps.includes(cap as any)) {
          score += 10;
          matchedLabels.push(CAPABILITY_LABELS[cap] ?? cap);
        }
      }
      if (matchedLabels.length) {
        scoreBreakdown.push(`能力匹配+${matchedLabels.length * 10}`);
      }

      // preferredCapabilities bonus: extra +5 for explicitly preferred
      if (preferredCapabilities?.length) {
        for (const pref of preferredCapabilities) {
          if (agentCaps.includes(pref as any)) {
            score += 5;
            scoreBreakdown.push(`偏好能力${CAPABILITY_LABELS[pref] ?? pref}+5`);
          }
        }
      }

      // Expertise keyword overlap: +5 per match
      let expertiseMatches = 0;
      for (const exp of expertise) {
        if (taskTokens.some((t) => t.includes(exp.toLowerCase()) || exp.toLowerCase().includes(t))) {
          score += 5;
          expertiseMatches++;
        }
      }
      if (expertiseMatches) {
        scoreBreakdown.push(`专长匹配+${expertiseMatches * 5}`);
      }

      // No capability match: prefer coordinator / synthesis
      if (matchedCaps.size === 0) {
        if (agentCaps.includes("coordinator")) {
          score += 8;
          scoreBreakdown.push("无明确能力匹配→协调者+8");
        } else if (agentCaps.includes("synthesis")) {
          score += 4;
          scoreBreakdown.push("无明确能力匹配→整合者+4");
        }
      }

      // Coordinator context affinity: if session has a coordinator,
      // prefer routing through coordinator for complex/ambiguous tasks
      if (coordinatorId === agent.id) {
        score += 3;
        scoreBreakdown.push("协调者上下文亲和+3");
      }

      // Load balancing: idle agents get bonus, running agents penalized
      if (agent.status === "idle") {
        score += 3;
        scoreBreakdown.push("空闲+3");
      } else if (agent.status === "running") {
        score -= 5;
        scoreBreakdown.push("忙碌-5");
      }

      // Inbox depth penalty: penalize agents with queued work
      if (agent.pendingInboxCount > 0) {
        const penalty = Math.min(agent.pendingInboxCount * 2, 6);
        score -= penalty;
        scoreBreakdown.push(`队列深度${agent.pendingInboxCount}→-${penalty}`);
      }

      // Tiebreaker: stable ordering by spawn position (no randomness)
      score += (agents.length - idx) * 0.01;

      const reason = matchedLabels.length > 0
        ? `擅长 ${matchedLabels.join("、")} [${scoreBreakdown.join(", ")}]`
        : scoreBreakdown.length > 0
          ? `${scoreBreakdown.join(", ")}`
          : agent.status === "idle" ? "空闲可用" : "默认选择";

      return { agentId: agent.id, reason, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map(({ agentId, reason }) => ({ agentId, reason }));
  }

  // ── Events ──

  onEvent(handler: SystemEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  emitEvent(event: ActorEvent | DialogMessage): void {
    traceDialogActorSystemEvent(this.sessionId, event);
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch { /* non-critical */ }
    }
  }

  // ── Snapshot ──

  snapshot() {
    return {
      actors: this.getAll().map((a) => ({
        id: a.id,
        role: a.role,
        modelOverride: a.modelOverride,
        status: a.status,
        pendingInbox: a.pendingInboxCount,
        currentTask: a.currentTask,
      })),
      coordinatorActorId: this.getCoordinatorId(),
      executionContract: this.getActiveExecutionContract(),
      dialogHistory: [...this.dialogHistory],
      pendingReplies: this.pendingReplies.size + this.pendingInteractions.size,
      spawnedTasks: this.dialogSubtaskRuntime.getSpawnedTasksSnapshot().map((r) => ({
        runId: r.runId,
        spawner: r.spawnerActorId,
        target: r.targetActorId,
        contractId: r.contractId,
        plannedDelegationId: r.plannedDelegationId,
        dispatchSource: r.dispatchSource,
        task: r.task,
        label: r.label,
        status: r.status,
        mode: r.mode,
        cleanup: r.cleanup,
        expectsCompletionMessage: r.expectsCompletionMessage,
      })),
    };
  }

  /** 获取 spawnedTasks Map 引用（用于持久化） */
  getSpawnedTasksMap(): Map<string, SpawnedTaskRecord> {
    return this.dialogSubtaskRuntime.getSpawnedTasksMap();
  }

  // ── Hook System ──

  /**
   * 注册普通 Hook（无返回值）
   */
  registerHook<T extends HookContext>(type: VoidHookType, handler: HookHandler<T>): () => void {
    const handlers = this.hooks.get(type) ?? [];
    handlers.push(handler);
    this.hooks.set(type, handlers);
    return () => {
      const h = this.hooks.get(type);
      if (h) this.hooks.set(type, h.filter((fn) => fn !== handler));
    };
  }

  /**
   * 注册修改型 Hook（可以拦截和修改参数）
   */
  registerModifyHook<T extends HookContext>(type: ModifyHookType, handler: ModifyHookHandler<T>): () => void {
    const handlers = this.modifyHooks.get(type) ?? [];
    handlers.push(handler);
    this.modifyHooks.set(type, handlers);
    return () => {
      const h = this.modifyHooks.get(type);
      if (h) this.modifyHooks.set(type, h.filter((fn) => fn !== handler));
    };
  }

  /**
   * 运行普通 Hook
   */
  private async runHooks<T extends HookContext>(type: VoidHookType, ctx: T): Promise<void> {
    const handlers = this.hooks.get(type);
    if (!handlers?.length) return;
    for (const handler of handlers) {
      try { await handler(ctx); } catch (e) { logWarn(`hook ${type} error:`, e); }
    }
  }

  /**
   * 运行修改型 Hook（链式调用，返回最终修改后的上下文）
   * 每个 handler 都可以修改上下文，下一个 handler 看到的是修改后的值
   */
  runModifyHooks<T extends HookContext>(
    type: ModifyHookType,
    ctx: T,
  ): { modified: T; stopped: boolean; error?: string } {
    const handlers = this.modifyHooks.get(type);
    if (!handlers?.length) return { modified: ctx, stopped: false };

    let current = ctx;
    for (const handler of handlers) {
      try {
        const result = handler(current);
        if (result.action === "stop") {
          return { modified: current, stopped: true, error: result.error };
        }
        if (result.action === "modify" && result.modified) {
          current = result.modified;
        }
        // "continue" 不做修改，继续下一个 handler
      } catch (e) {
        logWarn(`modify hook ${type} error:`, e);
      }
    }
    return { modified: current, stopped: false };
  }

  private syncTranscriptActors(): void {
    updateTranscriptActors(
      this.sessionId,
      this.getAll().map((a) => ({ id: a.id, name: a.role.name, model: a.modelOverride })),
    );
  }

  private buildDialogMessageRecallPatch(actorId: string): Pick<
    DialogMessage,
    | "memoryRecallAttempted"
    | "appliedMemoryPreview"
    | "transcriptRecallAttempted"
    | "transcriptRecallHitCount"
    | "appliedTranscriptPreview"
  > {
    const actor = this.actors.get(actorId);
    if (!actor) {
      return {};
    }
    const memoryPreview = collectDialogMessagePreview(actor.lastMemoryRecallPreview);
    const transcriptPreview = collectDialogMessagePreview(actor.lastTranscriptRecallPreview);
    const transcriptHitCount = Math.max(0, actor.lastTranscriptRecallHitCount ?? 0);
    return {
      ...(actor.lastMemoryRecallAttempted ? { memoryRecallAttempted: true } : {}),
      ...(memoryPreview ? { appliedMemoryPreview: memoryPreview } : {}),
      ...(actor.lastTranscriptRecallAttempted ? { transcriptRecallAttempted: true } : {}),
      ...(transcriptHitCount > 0 ? { transcriptRecallHitCount: transcriptHitCount } : {}),
      ...(transcriptPreview ? { appliedTranscriptPreview: transcriptPreview } : {}),
    };
  }

  private updateDialogMessage(messageId: string, patch: Partial<DialogMessage>): void {
    const idx = this.dialogHistory.findIndex((message) => message.id === messageId);
    if (idx < 0) return;
    this.dialogHistory[idx] = { ...this.dialogHistory[idx], ...patch };
  }
}
