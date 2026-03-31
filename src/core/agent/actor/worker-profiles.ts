import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import { getRoleBoundaryPolicyProfile } from "./execution-policy";
import type {
  DialogSubtaskExecutionIntent,
  SpawnTaskOverrides,
  SpawnedTaskRoleBoundary,
  ToolPolicy,
  WorkerProfileId,
} from "./types";
export type { WorkerProfileId } from "./types";

export interface WorkerProfile {
  id: WorkerProfileId;
  roleBoundary: SpawnedTaskRoleBoundary;
  executionIntent?: DialogSubtaskExecutionIntent;
  resultContract?: SpawnTaskOverrides["resultContract"];
  maxIterations?: number;
  systemPromptAppend?: string;
}

const STRUCTURED_CONTENT_TASK_PATTERNS = [
  /(?:根据|基于).*(?:附件|文档|表格|工作簿|数据|条目).*(?:生成|整理|汇总|输出|填充)/iu,
  /(?:字段|列|schema|结构化|表头|headers?)/iu,
  /(?:清单|列表|汇总|条目|记录|摘要表|结果表|结果集)/u,
] as const;
const GENERAL_TO_EXECUTOR_PROMOTION_PATTERNS = [
  /excel|xlsx|xls|csv|表格|工作簿/iu,
  /文档|报告|清单|汇总|提案|摘要|列表/u,
  /(?:字段|列|schema|结构化|表头|headers?)/iu,
] as const;
const STRONG_CODE_TASK_PATTERNS = [
  /repo|repository|codebase|仓库|项目结构|工程|源码/i,
  /代码|编码|编程|函数|类|模块|接口|重构|修复|debug|bug|报错/i,
  /\/[^\s"'`]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|vue|html|css|scss|less)\b/i,
] as const;
const CONTENT_EXECUTOR_ALLOW_TOOL_NAMES = [
  "read_document",
  "calculate",
  "task_done",
] as const;
const CONTENT_EXECUTOR_DENY_TOOL_NAMES = [
  "spawn_task",
  "delegate_task",
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
  "read_document",
  "read_file_range",
] as const;
const INLINE_STRUCTURED_RESULT_DENY_TOOL_NAMES = [
  ...CONTENT_EXECUTOR_DENY_TOOL_NAMES.filter(
    (toolName) => toolName !== "read_file_range",
  ),
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

const WORKER_PROFILES: Record<WorkerProfileId, WorkerProfile> = {
  general_worker: {
    id: "general_worker",
    roleBoundary: "general",
    executionIntent: "general",
  },
  content_worker: {
    id: "content_worker",
    roleBoundary: "executor",
    executionIntent: "content_executor",
    maxIterations: 18,
    systemPromptAppend: "专注于内容整理与结构化输出，不要写文件，不要再次派工。",
  },
  coding_worker: {
    id: "coding_worker",
    roleBoundary: "executor",
    executionIntent: "coding_executor",
    maxIterations: 24,
  },
  validator_worker: {
    id: "validator_worker",
    roleBoundary: "validator",
    executionIntent: "validator",
    maxIterations: 16,
  },
  review_worker: {
    id: "review_worker",
    roleBoundary: "reviewer",
    executionIntent: "reviewer",
    maxIterations: 16,
  },
  spreadsheet_worker: {
    id: "spreadsheet_worker",
    roleBoundary: "executor",
    executionIntent: "content_executor",
    resultContract: "inline_structured_result",
    maxIterations: 18,
    systemPromptAppend: [
      "本轮是通用表格内容生产子任务。",
      "只允许返回结构化 JSON 结果，不要写文件、不要导出表格、不要再次派工。",
      "不要只返回“已完成/已处理 N 条”这类摘要；必须返回真实 rows。",
      "每行都要保留 coverage 元数据：至少包含 sourceItemId、topicIndex、topicTitle、coverageType。",
      "如果输入不足以覆盖本组条目，直接返回 blocker，不要编造。",
    ].join("\n"),
  },
};

export function getWorkerProfile(profileId: WorkerProfileId): WorkerProfile {
  return WORKER_PROFILES[profileId];
}

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

function mergeToolPolicies(
  ...policies: Array<ToolPolicy | undefined>
): ToolPolicy | undefined {
  const allow = uniqueNonEmptyStrings(
    policies.flatMap((policy) => policy?.allow ?? []),
  );
  const deny = uniqueNonEmptyStrings(
    policies.flatMap((policy) => policy?.deny ?? []),
  );
  if (allow.length === 0 && deny.length === 0) return undefined;
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
  };
}

function overrideToolPolicyEnablesCoding(policy?: ToolPolicy): boolean {
  const allow = policy?.allow ?? [];
  return allow.some((toolName) => CODING_INTENT_TOOL_NAMES.has(String(toolName ?? "").trim()));
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

function resolveProfileFromExecutionIntent(params: {
  executionIntent: DialogSubtaskExecutionIntent;
  resultContract?: SpawnTaskOverrides["resultContract"];
}): WorkerProfileId {
  switch (params.executionIntent) {
    case "content_executor":
      return params.resultContract === "inline_structured_result"
        ? "spreadsheet_worker"
        : "content_worker";
    case "coding_executor":
      return "coding_worker";
    case "reviewer":
      return "review_worker";
    case "validator":
      return "validator_worker";
    default:
      return "general_worker";
  }
}

function shouldExecutorTaskUseCodingProfile(params: {
  task: string;
  overrideToolPolicy?: ToolPolicy;
}): boolean {
  if (overrideToolPolicyEnablesCoding(params.overrideToolPolicy)) return true;
  const inferred = inferCodingExecutionProfile({ query: params.task });
  return Boolean(inferred.profile.codingMode);
}

function looksLikeExecutorCandidate(task: string): boolean {
  const normalizedTask = String(task ?? "").trim();
  if (!normalizedTask) return false;
  if (taskLooksLikeStructuredContentTask(normalizedTask)) return true;
  const contentLike = GENERAL_TO_EXECUTOR_PROMOTION_PATTERNS.some((pattern) => pattern.test(normalizedTask));
  const strongCodeLike = STRONG_CODE_TASK_PATTERNS.some((pattern) => pattern.test(normalizedTask));
  return contentLike && !strongCodeLike;
}

export function taskLooksLikeStructuredContentTask(task: string | null | undefined): boolean {
  const normalizedTask = String(task ?? "").trim();
  if (!normalizedTask) return false;
  return STRUCTURED_CONTENT_TASK_PATTERNS.some((pattern) => pattern.test(normalizedTask));
}

export function resolveWorkerProfile(params: {
  roleBoundary?: SpawnedTaskRoleBoundary;
  task: string;
  overrideToolPolicy?: ToolPolicy;
  explicitWorkerProfileId?: WorkerProfileId;
  explicitExecutionIntent?: DialogSubtaskExecutionIntent;
  resultContract?: SpawnTaskOverrides["resultContract"];
  allowGeneralPromotion?: boolean;
}): WorkerProfile {
  if (params.explicitWorkerProfileId) {
    return getWorkerProfile(params.explicitWorkerProfileId);
  }
  if (params.explicitExecutionIntent) {
    return getWorkerProfile(resolveProfileFromExecutionIntent({
      executionIntent: params.explicitExecutionIntent,
      resultContract: params.resultContract,
    }));
  }

  switch (params.roleBoundary) {
    case "reviewer":
      return getWorkerProfile("review_worker");
    case "validator":
      return getWorkerProfile("validator_worker");
    case "executor":
      return getWorkerProfile(
        shouldExecutorTaskUseCodingProfile({
          task: params.task,
          overrideToolPolicy: params.overrideToolPolicy,
        })
          ? "coding_worker"
          : params.resultContract === "inline_structured_result"
            ? "spreadsheet_worker"
            : "content_worker",
      );
    default:
      if (params.allowGeneralPromotion && looksLikeExecutorCandidate(params.task)) {
        return getWorkerProfile(
          params.resultContract === "inline_structured_result"
            ? "spreadsheet_worker"
            : "content_worker",
        );
      }
      return getWorkerProfile("general_worker");
  }
}

export function buildWorkerProfileToolPolicy(params: {
  profileId: WorkerProfileId;
  resultContract?: SpawnTaskOverrides["resultContract"];
  overrideToolPolicy?: ToolPolicy;
}): ToolPolicy | undefined {
  switch (params.profileId) {
    case "spreadsheet_worker":
      return buildInlineStructuredResultToolPolicy(params.overrideToolPolicy);
    case "content_worker":
      return params.resultContract === "inline_structured_result"
        ? buildInlineStructuredResultToolPolicy(params.overrideToolPolicy)
        : buildStrictContentExecutorToolPolicy(params.overrideToolPolicy);
    case "coding_worker":
      return mergeToolPolicies(getRoleBoundaryPolicyProfile("executor").toolPolicy, params.overrideToolPolicy);
    case "review_worker":
      return mergeToolPolicies(getRoleBoundaryPolicyProfile("reviewer").toolPolicy, params.overrideToolPolicy);
    case "validator_worker":
      return mergeToolPolicies(getRoleBoundaryPolicyProfile("validator").toolPolicy, params.overrideToolPolicy);
    default:
      return params.overrideToolPolicy;
  }
}

export function buildWorkerProfileOverrides(profileId: WorkerProfileId): SpawnTaskOverrides {
  const profile = getWorkerProfile(profileId);
  return {
    workerProfileId: profile.id,
    ...(profile.executionIntent ? { executionIntent: profile.executionIntent } : {}),
    ...(profile.resultContract ? { resultContract: profile.resultContract } : {}),
    ...(typeof profile.maxIterations === "number" ? { maxIterations: profile.maxIterations } : {}),
    ...(profile.systemPromptAppend ? { systemPromptAppend: profile.systemPromptAppend } : {}),
  };
}

export function applyWorkerProfileDefaults(params: {
  profileId: WorkerProfileId;
  overrides?: SpawnTaskOverrides;
}): SpawnTaskOverrides {
  const profileDefaults = buildWorkerProfileOverrides(params.profileId);
  const overrideSystemPromptAppend = params.overrides?.systemPromptAppend;
  const mergedSystemPromptAppend = profileDefaults.systemPromptAppend
    ? overrideSystemPromptAppend?.includes(profileDefaults.systemPromptAppend)
      ? overrideSystemPromptAppend
      : [profileDefaults.systemPromptAppend, overrideSystemPromptAppend]
        .filter(Boolean)
        .join("\n\n")
    : overrideSystemPromptAppend;
  return {
    ...profileDefaults,
    ...(params.overrides ?? {}),
    workerProfileId: params.profileId,
    ...(profileDefaults.executionIntent ? { executionIntent: profileDefaults.executionIntent } : {}),
    ...(profileDefaults.resultContract ? { resultContract: profileDefaults.resultContract } : {}),
    ...(typeof params.overrides?.maxIterations === "number"
      ? { maxIterations: params.overrides.maxIterations }
      : typeof profileDefaults.maxIterations === "number"
        ? { maxIterations: profileDefaults.maxIterations }
        : {}),
    ...(mergedSystemPromptAppend
      ? {
          systemPromptAppend: mergedSystemPromptAppend,
        }
      : {}),
  };
}
