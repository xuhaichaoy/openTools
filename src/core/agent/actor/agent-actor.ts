import {
  filterExportableStructuredResults,
} from "./dynamic-workbook-builder";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import {
  ReActAgent,
  WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
  WaitForSpawnedTasksInterrupt,
  type AgentTool,
  type AgentStep,
  type DangerousActionConfirmationContext,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import { applyIncomingAgentStep } from "@/plugins/builtin/SmartAgent/core/agent-task-state";
import {
  createBuiltinAgentTools,
  type AskUserQuestion,
  type AskUserAnswers,
} from "@/plugins/builtin/SmartAgent/core/default-tools";
import type { AgentRole } from "@/core/agent/cluster/types";
import type { ExecutionContract } from "@/core/collaboration/types";
import type { ActorSystem } from "./actor-system";
import {
  buildFinalSynthesisPrompt,
  buildFollowUpPromptFromRenderedMessages,
  buildStructuredTaskSummaryBlock,
  summarizeFollowUpMessages,
  type FollowUpPromptDescriptor,
} from "./actor-follow-up-prompt";
import type { DialogStructuredSubtaskResult } from "./dialog-subtask-runtime";
import { autoExtractMemories } from "./actor-memory";
import {
  isDialogContextPressureError,
  recoverDialogRoomCompactionFromContextPressure,
} from "./dialog-context-pressure";
import { validateActorTaskResult, validateSpawnedTaskResult } from "./spawned-task-result-validator";
import { appendToolCallSync as appendToolCall, appendToolResultSync as appendToolResult } from "./actor-transcript";
import type { ActorRunContext } from "./actor-middleware";
import { runMiddlewareChain } from "./actor-middleware";
import { isLegacySingleDefaultDialogLead } from "./dialog-actor-persistence";
import {
  DIALOG_PLAN_MODE_EXECUTION_POLICY,
  DIALOG_PLAN_MODE_TOOL_POLICY,
  clampAccessMode,
  clampApprovalMode,
  compactMiddlewareOverridesForPersistence,
  normalizeExecutionPolicyWithMiddlewareCompat,
  synchronizeExecutionPolicyCompat,
  type NormalizedExecutionPolicy,
} from "./execution-policy";
import { resolveActorEffectiveMaxIterations } from "./iteration-budget";
import { ClarificationInterrupt, createDefaultMiddlewares } from "./middlewares";
import {
  DEFAULT_DIALOG_MAIN_BUDGET_SECONDS,
  DEFAULT_DIALOG_MAIN_IDLE_LEASE_SECONDS,
  TIMEOUT_CHECK_INTERVAL_MS,
  formatTimeoutError,
  isTimeoutErrorMessage,
} from "./timeout-policy";
import { isLikelyExecutionPlanReply } from "./result-shape-detection";
import { traceDialogFlowEvent } from "./dialog-step-trace";
import {
  getStructuredDeliveryStrategyReferenceId,
  isStructuredDeliveryAdapterEnabled,
  resolveRequestedSpreadsheetExtensions,
  resolveStructuredDeliveryManifest,
  resolveStructuredDeliveryStrategyById,
  resolveStructuredDeliveryStrategy,
  taskRequestsSpreadsheetOutput,
  type StructuredDeliveryManifest,
  type StructuredDeliveryRepairPlan,
} from "./structured-delivery-strategy";
import {
  AUTO_SOURCE_GROUNDING_HEADER,
  buildSourceGroundingSnapshot,
  type SourceGroundingSnapshot,
} from "./source-grounding";
import type {
  AgentCapabilities,
  ActorConfig,
  ActorEvent,
  ActorEventType,
  ActorRunOverrides,
  ActorStatus,
  ActorTask,
  DialogArtifactRecord,
  DialogExecutionMode,
  ExecutionPolicy,
  InboxMessage,
  MiddlewareOverrides,
  ThinkingLevel,
  ToolPolicy,
} from "./types";

const generateId = () =>
  Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

import { estimateTokens } from "@/core/ai/token-utils";
import { createLogger } from "@/core/logger";
import { useAIStore } from "@/store/ai-store";

const _agentActorLogger = createLogger("AgentActor");
const formatActorLog = (name: string, args: unknown[]) =>
  `[${name}] ${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}`;
const actorDebugLog = (name: string, ...args: unknown[]) => {
  _agentActorLogger.debug(formatActorLog(name, args));
};
const actorInfoLog = (name: string, ...args: unknown[]) => {
  _agentActorLogger.info(formatActorLog(name, args));
};
const actorWarnLog = (name: string, ...args: unknown[]) => {
  _agentActorLogger.warn(formatActorLog(name, args));
};
const actorErrorLog = (name: string, ...args: unknown[]) => {
  _agentActorLogger.error(formatActorLog(name, args));
};

type ActorEventHandler = (event: ActorEvent) => void;
export type AskUserCallback = (questions: AskUserQuestion[]) => Promise<AskUserAnswers>;
export type ConfirmDangerousAction = (
  toolName: string,
  params: Record<string, unknown>,
  context?: DangerousActionConfirmationContext,
) => Promise<boolean>;

const ARTIFACT_TOOL_NAMES = new Set(["write_file", "export_document", "str_replace_edit", "json_edit"]);
const INTERIM_SYNTHESIS_PATTERNS = [
  /(正在|继续|稍后|马上|随后).*(整理|汇总|整合|输出|总结)/u,
  /(先|我会|正在).*(看|检查|处理|拉齐)/u,
  /(working on it|pulling .* together|give me a few|let me compile|i'?ll gather)/i,
];
const TAKEOVER_DENIED_TOOL_NAMES = [
  "spawn_task",
  "delegate_task",
  "delegate_subtask",
  "wait_for_spawned_tasks",
  "ask_user",
  "ask_clarification",
  "send_message",
  "agents",
  "enter_plan_mode",
  "exit_plan_mode",
  "memory_*",
  "session_history",
  "session_list",
] as const;
const AGGREGATION_ALLOWED_TOOL_NAMES = [
  "task_done",
  "export_spreadsheet",
  "export_document",
] as const;
const AGGREGATION_DENIED_TOOL_NAMES = [
  ...TAKEOVER_DENIED_TOOL_NAMES,
  "list_directory",
  "read_file",
  "read_document",
  "search_in_files",
  "run_shell_command",
  "persistent_shell",
  "write_file",
  "str_replace_edit",
  "json_edit",
  "delete_file",
  "send_local_media",
] as const;
const STRUCTURED_STATUS_ONLY_PATTERNS = [
  /已(?:收到|汇总|整合|同步|整理).*(?:子任务|协作|反馈|结果|回报|状态)/u,
  /目前已收到.*(?:反馈|结果)/u,
  /(?:各|所有)?子任务.*(?:反馈|结果).*(?:已收到|已汇总|已整合)/u,
  /(?:结果|反馈).*(?:已齐|齐了|齐全)/u,
  /(?:等待|准备|接下来).*(?:整理|汇总|整合|输出|收尾)/u,
];
const CONCRETE_FINAL_RESULT_PATTERNS = [
  /\/[^\s"'`]+\.(?:tsx?|jsx?|vue|html|css|scss|less|json|rs|py|go|java|kt|swift|md|docx?|pdf|xlsx?|csv|pptx?)/i,
  /```/,
  /<!doctype html>|<html|<div|<section|<main|<template|<script|<style/i,
  /\bimport\s+|\bexport\s+|\bfunction\s+\w+|\bclass\s+\w+|\bconst\s+\w+\s*=|\blet\s+\w+\s*=/i,
  /最终产物|产物位置|文件路径|保存到|导出为|已创建|已生成|已修改|已修复|验证通过|测试通过|构建通过|lint\s*通过|阻塞原因|无法完成|缺失条件|真实缺口/i,
];
const INITIAL_STRUCTURED_DELIVERY_ALLOWED_TOOL_NAMES = [
  "read_document",
  "spawn_task",
  "wait_for_spawned_tasks",
  "export_spreadsheet",
  "task_done",
] as const;
const INITIAL_STRUCTURED_DELIVERY_DENIED_TOOL_NAMES = [
  "list_directory",
  "read_file",
  "search_in_files",
  "run_shell_command",
  "persistent_shell",
  "agents",
  "memory_*",
  "send_message",
  "ask_user",
  "ask_clarification",
  "delegate_task",
  "delegate_subtask",
  "enter_plan_mode",
  "exit_plan_mode",
  "send_local_media",
] as const;
const DIALOG_SUBAGENT_DISABLED_DENIED_TOOL_NAMES = [
  "spawn_task",
  "wait_for_spawned_tasks",
  "send_message",
  "agents",
] as const;

type ActorSuccessLock = {
  result: string;
  artifactPath?: string;
  source: "host_export" | "artifact_recovery";
  reason: string;
  lockedAt: number;
};

function basename(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function previewActorText(value?: string, maxLength = 120): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function inferArtifactLanguage(path: string): string | undefined {
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
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return ext || undefined;
  }
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

function mergeExecutionPolicies(
  basePolicy: ExecutionPolicy | undefined,
  overridePolicy: ExecutionPolicy | undefined,
): ExecutionPolicy | undefined {
  if (!basePolicy && !overridePolicy) return undefined;
  return {
    accessMode: clampAccessMode(basePolicy?.accessMode, overridePolicy?.accessMode),
    approvalMode: clampApprovalMode(basePolicy?.approvalMode, overridePolicy?.approvalMode),
  };
}

function resolveAggregationAllowedToolNames(): string[] {
  return [...AGGREGATION_ALLOWED_TOOL_NAMES];
}

function buildStructuredDispatchPlanFromContract(params: {
  contract: ExecutionContract | null | undefined;
  strategyId?: string;
  deliveryContract: string;
  parentContract: string;
  tracePreview?: string;
}): {
  strategyId: string;
  deliveryContract: string;
  parentContract: string;
  tracePreview?: string;
  observationText?: string;
  shards: Array<{
    plannedDelegationId?: string;
    targetActorId?: string;
    targetActorName?: string;
    label: string;
    task: string;
    roleBoundary?: "reviewer" | "validator" | "executor" | "general";
    createIfMissing?: boolean;
    overrides?: ActorRunOverrides;
  }>;
} | null {
  const delegations = (params.contract?.plannedDelegations ?? []).filter((delegation) => (
    delegation.overrides?.resultContract === "inline_structured_result"
    || Boolean(delegation.overrides?.deliveryTargetId)
    || Boolean(delegation.overrides?.deliveryTargetLabel)
    || delegation.overrides?.workerProfileId === "content_worker"
    || delegation.overrides?.workerProfileId === "spreadsheet_worker"
    || delegation.overrides?.executionIntent === "content_executor"
  ));
  if (delegations.length === 0) return null;
  return {
    strategyId: params.strategyId ?? "contract_structured_delivery",
    deliveryContract: params.deliveryContract,
    parentContract: params.parentContract,
    tracePreview: params.tracePreview,
    observationText: `已根据审批后的 structured delegations 派发 ${delegations.length} 个子任务，等待结果。`,
    shards: delegations.map((delegation) => ({
      plannedDelegationId: delegation.id,
      targetActorId: delegation.targetActorId,
      targetActorName: delegation.targetActorName,
      label: delegation.label || delegation.targetActorName || delegation.targetActorId,
      task: delegation.task,
      roleBoundary: delegation.roleBoundary,
      createIfMissing: delegation.createIfMissing,
      overrides: delegation.overrides,
    })),
  };
}

function buildStructuredDeliveryPlanBlock(params: {
  taskText: string;
  structuredResults: readonly DialogStructuredSubtaskResult[];
}): string | undefined {
  if (!taskRequestsSpreadsheetOutput(params.taskText)) return undefined;
  const strategy = resolveStructuredDeliveryStrategy(params.taskText);
  const manifest = resolveStructuredDeliveryManifest(params.taskText);
  const strategyPlanBlock = strategy?.buildDeliveryPlanBlock?.({
    ...params,
    manifest,
  });
  if (strategyPlanBlock) return strategyPlanBlock;
  const lines = [
    "## 系统锁定的最终交付计划",
    "- 你现在只能消费当前 run 的 structured child results 与当前 run artifacts。",
    "- 最终只允许交付一个 Excel 工作簿；禁止输出多个分散的 xlsx/csv/tsv 文件。",
    "- 禁止用 JSON / Markdown / TSV / 历史文件确认代替 Excel 成功交付。",
    "- 若结构化结果足够，请直接调用 `export_spreadsheet`；若仍不足，请返回真实 blocker。",
    "- 如有 source snapshot / 分片结果，请优先按它们聚合，不要重新猜测 schema 或扫描历史目录。",
  ];
  if (params.structuredResults.length > 0) {
    lines.push(`- 当前可用 structured child results 数量：${params.structuredResults.length}。`);
  }
  return lines.join("\n");
}

function buildStructuredRepairPlanBlock(
  repairPlan?: StructuredDeliveryRepairPlan,
): string | undefined {
  if (!repairPlan) return undefined;
  const lines = [
    "## 系统建议的修复路径",
    `- 当前 host export 被 quality gate 拦截：${repairPlan.summary}`,
    repairPlan.nextStepHint ? `- ${repairPlan.nextStepHint}` : "",
    repairPlan.missingThemes?.length
      ? `- 缺失主题：${repairPlan.missingThemes.slice(0, 8).join("、")}`
      : "",
    repairPlan.missingSourceItemIds?.length
      ? `- 缺失 source items：${repairPlan.missingSourceItemIds.slice(0, 12).join("、")}`
      : "",
    "- 若决定补派，请优先只补派缺口分片，不要重写已覆盖主题。",
    "- 若不补派，则必须明确说明为什么当前缺口无法补齐，并给出真实 blocker。",
  ].filter(Boolean);
  repairPlan.suggestions.slice(0, 8).forEach((suggestion, index) => {
    lines.push(
      `${index + 1}. ${suggestion.label}`,
      `- reason: ${suggestion.reason}`,
      suggestion.missingThemes?.length ? `- missing_themes: ${suggestion.missingThemes.join("、")}` : "",
      suggestion.sourceItemIds?.length ? `- source_item_ids: ${suggestion.sourceItemIds.join("、")}` : "",
      suggestion.roleBoundary ? `- role_boundary: ${suggestion.roleBoundary}` : "",
      suggestion.task ? `- task_preview: ${previewActorText(suggestion.task, 180) ?? ""}` : "",
    );
  });
  if (repairPlan.suggestions.length > 8) {
    lines.push(`- 其余 ${repairPlan.suggestions.length - 8} 个 repair suggestions 可按需继续补派。`);
  }
  return lines.join("\n");
}

function buildStructuredRepairSuggestionKey(params: {
  label?: string;
  sourceItemIds?: readonly string[];
  missingThemes?: readonly string[];
}): string {
  return [
    String(params.label ?? "").trim() || "repair",
    uniqueNonEmptyStrings([...(params.sourceItemIds ?? [])]).join(",") || "-",
    uniqueNonEmptyStrings([...(params.missingThemes ?? [])]).join(",") || "-",
  ].join("|");
}

function buildStructuredDispatchSuggestionBlock(params: {
  dispatchPlan: {
    strategyId: string;
    deliveryContract: string;
    parentContract: string;
    shards: Array<{
      label: string;
      task: string;
      roleBoundary?: string;
      overrides?: {
        deliveryTargetLabel?: string;
        sourceItemCount?: number;
      };
    }>;
  };
}): string {
  const lines = [
    "## 推荐的结构化派工建议",
    `- strategy: ${params.dispatchPlan.strategyId}`,
    `- delivery_contract: ${params.dispatchPlan.deliveryContract} / ${params.dispatchPlan.parentContract}`,
    `- 推荐分片数：${params.dispatchPlan.shards.length}`,
    "- 这些只是系统根据 source snapshot 给出的建议，不是强制自动派工。",
    "- 你需要先判断是否真的要派工；如果派工，请优先复用这些 label / delivery target / source item count。",
  ];
  params.dispatchPlan.shards.slice(0, 12).forEach((shard, index) => {
    lines.push(
      `${index + 1}. ${shard.label}`,
      `- role_boundary: ${shard.roleBoundary ?? "executor"}`,
      shard.overrides?.deliveryTargetLabel ? `- delivery_target: ${shard.overrides.deliveryTargetLabel}` : "",
      typeof shard.overrides?.sourceItemCount === "number" ? `- source_item_count: ${shard.overrides.sourceItemCount}` : "",
      `- task_preview: ${previewActorText(shard.task, 180) ?? ""}`,
    );
  });
  if (params.dispatchPlan.shards.length > 12) {
    lines.push(`- 其余 ${params.dispatchPlan.shards.length - 12} 个建议分片可按需继续派发。`);
  }
  return lines.filter(Boolean).join("\n");
}

function summarizeSourceSnapshot(snapshot?: SourceGroundingSnapshot): string[] {
  if (!snapshot) return [];
  const lines: string[] = [];
  if (snapshot.sourcePaths.length > 0) {
    lines.push(`- source_paths: ${snapshot.sourcePaths.slice(0, 3).join("、")}`);
  }
  const itemCount = snapshot.items.length || snapshot.expectedItemCount;
  if (typeof itemCount === "number" && itemCount > 0) {
    lines.push(`- source_item_count: ${itemCount}`);
  }
  if (snapshot.sections.length > 0) {
    lines.push(`- source_sections: ${snapshot.sections.slice(0, 6).map((section) => section.label).join("、")}`);
  }
  if (snapshot.warnings.length > 0) {
    lines.push(`- source_warnings: ${snapshot.warnings.slice(0, 3).join("；")}`);
  }
  return lines;
}

function buildStructuredDeliveryGuidanceBlock(params: {
  manifest: StructuredDeliveryManifest;
}): string {
  const { manifest } = params;
  const adapterEngaged = isStructuredDeliveryAdapterEnabled(manifest);
  const lines = [
    adapterEngaged
      ? "## 当前已启用的 structured delivery adapter"
      : "## 当前结构化交付上下文",
    adapterEngaged
      ? "- 当前任务已经进入 structured delivery adapter 模式；你仍然是主 Agent，adapter 只提供更强的结果合同与导出约束。"
      : "- 当前任务已经带着 planner/runtime 下发的结构化交付上下文；请按该上下文执行，但仍由你负责最终判断与交付。",
    "- 优先把当前用户附件、当前 source snapshot 与本轮 artifacts 作为真相来源，避免先扫描历史目录。",
    "- 这不是默认 workflow；除非上下文已经明确启用，否则不要把自己当成固定流程操作员。",
  ];
  lines.push(`- adapter_status: ${adapterEngaged ? "engaged" : "contract_bound"}`);
  const recommendedStrategyId = getStructuredDeliveryStrategyReferenceId(manifest);
  if (recommendedStrategyId) {
    lines.push(`- 推荐 adapter: ${recommendedStrategyId}`);
  }
  lines.push(`- delivery_contract: ${manifest.deliveryContract} / ${manifest.parentContract}`);
  lines.push(...summarizeSourceSnapshot(manifest.sourceSnapshot));
  if (manifest.resultSchema?.fields?.length) {
    lines.push(`- 推荐 schema: ${manifest.resultSchema.fields.map((field) => field.label).join("、")}`);
  }
  const targetLabels = [...new Set((manifest.targets ?? []).map((target) => target.label).filter(Boolean))];
  if (targetLabels.length > 0) {
    lines.push(`- 推荐 shard 分组: ${targetLabels.join("、")}`);
  }
  lines.push("- 如果你判断确实需要派工，优先复用推荐的 shard / delivery target，并让子任务返回 inline structured result。");
  return lines.join("\n");
}


function extractPathsByExtensions(value: string | undefined, extensions: readonly string[]): string[] {
  const normalized = String(value ?? "");
  if (!normalized) return [];
  const pattern = new RegExp(String.raw`\/[^\s'"]+\.(?:${extensions.join("|")})\b`, "ig");
  return [...new Set(normalized.match(pattern) ?? [])];
}

function buildArtifactPayloadFromToolCall(
  actorId: string,
  actorSystem: ActorSystem,
  toolName: string,
  params: Record<string, unknown>,
): void {
  if (!ARTIFACT_TOOL_NAMES.has(toolName)) return;
  const path = typeof params.path === "string" ? params.path.trim() : "";
  if (!path) return;

  let summary = "生成文件产物";
  let preview: string | undefined;
  let fullContent: string | undefined;

  if (toolName === "write_file") {
    summary = "通过 write_file 生成文件";
    if (typeof params.content === "string") {
      fullContent = params.content;
      preview = params.content.slice(0, 1200);
    }
  } else if (toolName === "export_document") {
    summary = "通过 export_document 导出文档";
    if (typeof params.content === "string") {
      fullContent = params.content;
      preview = params.content.slice(0, 1200);
    }
  } else if (toolName === "str_replace_edit") {
    summary = "通过 str_replace_edit 修改文件";
    if (typeof params.newText === "string") {
      fullContent = params.newText;
      preview = params.newText.slice(0, 1200);
    } else if (typeof params.oldText === "string") {
      preview = params.oldText.slice(0, 1200);
    }
  } else if (toolName === "json_edit") {
    summary = "通过 json_edit 修改结构化文件";
    preview = JSON.stringify(params, null, 2).slice(0, 1200);
  }

  const relatedRun = actorSystem
    .getSpawnedTasksSnapshot()
    .filter((record) =>
      record.targetActorId === actorId
      && (
        record.status === "running"
        || (record.mode === "session" && record.sessionOpen)
      ))
    .sort((a, b) => (b.lastActiveAt ?? b.spawnedAt) - (a.lastActiveAt ?? a.spawnedAt))[0];

  actorSystem.recordArtifact({
    actorId,
    path,
    source: toolName === "write_file" || toolName === "export_document" ? "tool_write" : "tool_edit",
    toolName,
    summary,
    preview,
    fullContent,
    language: inferArtifactLanguage(path),
    timestamp: Date.now(),
    relatedRunId: relatedRun?.runId,
  });
}

function extractPathFromToolOutput(toolName: string, toolOutput: unknown): string | null {
  const normalized = typeof toolOutput === "string"
    ? toolOutput.trim()
    : typeof toolOutput === "object" && toolOutput !== null
      ? JSON.stringify(toolOutput)
      : "";
  if (!normalized) return null;

  if (toolName === "export_spreadsheet") {
    const match = normalized.match(/已导出\s*Excel\s*文件[:：]\s*(\/[^\s"'`]+?\.(?:xlsx|xls|csv))/iu);
    return match?.[1]?.trim() || null;
  }

  return null;
}

function buildArtifactPayloadFromToolResult(
  actorId: string,
  actorSystem: ActorSystem,
  toolName: string,
  toolOutput: unknown,
): void {
  const path = extractPathFromToolOutput(toolName, toolOutput);
  if (!path) return;

  const relatedRun = actorSystem
    .getSpawnedTasksSnapshot()
    .filter((record) =>
      record.targetActorId === actorId
      && (
        record.status === "running"
        || (record.mode === "session" && record.sessionOpen)
      ))
    .sort((a, b) => (b.lastActiveAt ?? b.spawnedAt) - (a.lastActiveAt ?? a.spawnedAt))[0];

  actorSystem.recordArtifact({
    actorId,
    path,
    source: "tool_write",
    toolName,
    summary: toolName === "export_spreadsheet" ? "通过 export_spreadsheet 导出表格" : "通过工具生成文件",
    timestamp: Date.now(),
    relatedRunId: relatedRun?.runId,
  });
}

function isLikelyInterimSynthesisReply(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return true;
  if (isLikelyExecutionPlanReply(normalized)) return true;
  if (normalized.length > 220) return false;
  return INTERIM_SYNTHESIS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function collectStructuredReferenceHints(
  structuredResults: readonly DialogStructuredSubtaskResult[],
): string[] {
  const hints: string[] = [];
  for (const task of structuredResults) {
    hints.push(task.targetActorName, task.task);
    if (task.label) hints.push(task.label);
    for (const text of [task.progressSummary, task.terminalResult, task.terminalError]) {
      if (!text) continue;
      const paths = text.match(/\/[^\s"'`]+/g) ?? [];
      hints.push(...paths, ...paths.map((path) => basename(path)));
    }
  }
  return uniqueNonEmptyStrings(hints)
    .map((hint) => hint.trim())
    .filter((hint) => hint.length >= 2);
}

function candidateMentionsStructuredResults(
  candidate: string,
  structuredResults: readonly DialogStructuredSubtaskResult[],
): boolean {
  const normalizedCandidate = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalizedCandidate) return false;
  return collectStructuredReferenceHints(structuredResults).some((hint) =>
    normalizedCandidate.includes(hint.replace(/\s+/g, " ").trim().toLowerCase()),
  );
}

function hasConcreteFinalResultMarkers(candidate: string): boolean {
  const normalized = candidate.trim();
  if (!normalized) return false;
  return CONCRETE_FINAL_RESULT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isConcretePublishableFinalResult(candidate: string): boolean {
  const normalized = candidate.trim();
  if (!normalized) return false;
  if (isLikelyExecutionPlanReply(normalized)) return false;
  if (isLikelyInterimSynthesisReply(normalized)) return false;
  const statusOnly = STRUCTURED_STATUS_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
  if (statusOnly && !hasConcreteFinalResultMarkers(normalized)) return false;
  return hasConcreteFinalResultMarkers(normalized);
}

function collectActorArtifactsForTask(params: {
  actorId: string;
  task: Pick<ActorTask, "startedAt" | "finishedAt">;
  actorSystem?: Pick<ActorSystem, "getArtifactRecordsSnapshot">;
}): DialogArtifactRecord[] {
  const startedAt = params.task.startedAt ?? Number.NEGATIVE_INFINITY;
  const finishedAt = params.task.finishedAt ?? Date.now();
  return (params.actorSystem?.getArtifactRecordsSnapshot?.() ?? [])
    .filter((artifact) =>
      artifact.actorId === params.actorId
      && artifact.timestamp >= startedAt - 1000
      && artifact.timestamp <= finishedAt + 1000)
    .sort((left, right) => right.timestamp - left.timestamp);
}

function buildConcreteResultFromArtifacts(params: {
  result?: string;
  taskText: string;
  actorId: string;
  task: Pick<ActorTask, "startedAt" | "finishedAt">;
  actorSystem?: Pick<ActorSystem, "getArtifactRecordsSnapshot">;
  structuredResults: readonly DialogStructuredSubtaskResult[];
}): { result?: string; blockedReason?: string } {
  const candidate = String(params.result ?? "").trim();
  if (isConcretePublishableFinalResult(candidate)) return { result: candidate };

  const artifacts = collectActorArtifactsForTask({
    actorId: params.actorId,
    task: params.task,
    actorSystem: params.actorSystem,
  });
  if (artifacts.length === 0) return {};

  const spreadsheetRequired = taskRequestsSpreadsheetOutput(params.taskText);
  const requestedSpreadsheetExtensions = resolveRequestedSpreadsheetExtensions(params.taskText);
  const spreadsheetArtifacts = artifacts.filter((artifact) =>
    requestedSpreadsheetExtensions.some((extension) => artifact.path.toLowerCase().endsWith(`.${extension}`)),
  );

  if (spreadsheetArtifacts.length > 1) {
    return {
      blockedReason: `当前 run 检测到多个 ${requestedSpreadsheetExtensions.join('/')} 产物（${spreadsheetArtifacts.map((artifact) => artifact.path).join('、')}），禁止改写成单个成功结果。`,
    };
  }

  const latestSpreadsheet = spreadsheetArtifacts[0];
  if (latestSpreadsheet) {
    const lines = [`已导出 Excel 文件：${latestSpreadsheet.path}`];
    if (params.structuredResults.length > 0) {
      lines.push(`本轮已汇总 ${params.structuredResults.length} 个子任务的结构化结果。`);
    }
    return { result: lines.join("\n") };
  }

  if (spreadsheetRequired) {
    return {
      blockedReason: `当前任务要求表格交付，但当前 run 没有可用的 ${requestedSpreadsheetExtensions.join('/')} 产物，禁止改写成泛化文件成功提示。`,
    };
  }

  const latestArtifact = artifacts[0];
  if (!latestArtifact?.path) return {};
  return { result: `已生成文件：${latestArtifact.path}` };
}

function hasStructuredRowEvidence(
  structuredResults: readonly DialogStructuredSubtaskResult[],
): boolean {
  return filterExportableStructuredResults({
    structuredResults,
  }).length > 0;
}

function buildSpreadsheetTerminalBlocker(params: {
  taskText: string;
  candidateResult?: string;
  structuredResults: readonly DialogStructuredSubtaskResult[];
  hostExportRepairPlan?: StructuredDeliveryRepairPlan;
  fallbackReason?: string;
}): string | undefined {
  const candidate = String(params.candidateResult ?? "").trim();
  if (!taskRequestsSpreadsheetOutput(params.taskText)) return undefined;
  if (!candidate) {
    return params.hostExportRepairPlan?.summary ?? params.fallbackReason;
  }
  if (/阻塞(?:原因|点)?[:：]?/u.test(candidate) || /无法(?:完成|导出|生成|写入|交付)/u.test(candidate)) {
    return candidate;
  }
  if (isLikelyExecutionPlanReply(candidate) || isLikelyInterimSynthesisReply(candidate)) {
    return params.hostExportRepairPlan?.summary
      ?? params.fallbackReason
      ?? "阻塞原因：当前表格任务尚未产生可交付的 Excel 文件，也没有足够的结构化 rows 可供 host 导出。";
  }
  if (!hasStructuredRowEvidence(params.structuredResults)) {
    return params.hostExportRepairPlan?.summary
      ?? params.fallbackReason
      ?? "阻塞原因：当前所有子任务都没有返回可导出的结构化 rows，无法构建最终工作簿。";
  }
  return undefined;
}

function canDeterministicallyExportStructuredSpreadsheet(
  manifest: StructuredDeliveryManifest | null | undefined,
): boolean {
  if (!manifest || manifest.deliveryContract !== "spreadsheet") return false;
  const strategy = resolveStructuredDeliveryStrategyById(
    manifest.strategyId ?? manifest.recommendedStrategyId,
  );
  return Boolean(strategy?.buildHostExportPlan);
}

function resolveSuccessArtifactPath(params: {
  taskText: string;
  candidateResult?: string;
  actorId: string;
  task: Pick<ActorTask, "startedAt" | "finishedAt">;
  actorSystem?: Pick<ActorSystem, "getArtifactRecordsSnapshot">;
}): string | undefined {
  const requestedSpreadsheetExtensions = resolveRequestedSpreadsheetExtensions(params.taskText);
  const resultPaths = taskRequestsSpreadsheetOutput(params.taskText)
    ? extractPathsByExtensions(params.candidateResult, requestedSpreadsheetExtensions)
    : [];
  if (resultPaths.length > 0) return resultPaths[0];

  const artifacts = collectActorArtifactsForTask({
    actorId: params.actorId,
    task: params.task,
    actorSystem: params.actorSystem,
  });
  if (taskRequestsSpreadsheetOutput(params.taskText)) {
    return artifacts.find((artifact) =>
      requestedSpreadsheetExtensions.some((extension) => artifact.path.toLowerCase().endsWith(`.${extension}`))
    )?.path;
  }
  return artifacts[0]?.path;
}

function shouldForceStructuredFinalSynthesis(params: {
  hadFailedSpawnFollowUp: boolean;
  structuredResults: readonly DialogStructuredSubtaskResult[];
  candidateResult?: string;
  finalValidation: ReturnType<typeof validateActorTaskResult>;
}): boolean {
  if (params.structuredResults.length === 0) return false;

  const candidate = String(params.candidateResult ?? "").trim();
  if (!candidate) return true;
  if (params.finalValidation.accepted === false) return true;
  const concretePublishable = isConcretePublishableFinalResult(candidate);
  if (params.hadFailedSpawnFollowUp) {
    return !concretePublishable;
  }
  if (isLikelyInterimSynthesisReply(candidate)) return true;

  const statusOnly = STRUCTURED_STATUS_ONLY_PATTERNS.some((pattern) => pattern.test(candidate));
  const hasConcreteMarkers = concretePublishable || hasConcreteFinalResultMarkers(candidate);
  if (statusOnly && !hasConcreteMarkers) return true;
  if (!candidateMentionsStructuredResults(candidate, params.structuredResults) && !hasConcreteMarkers) {
    return true;
  }

  return false;
}

/** Dialog 模式下每个 Agent 使用的全能角色（不做工具过滤） */
export const DIALOG_FULL_ROLE: AgentRole = {
  id: "dialog_agent",
  name: "Agent",
  systemPrompt: `你是一个始终在线的核心 Agent，拥有完整的工具能力（代码读写、Shell、网络搜索等）。你能记住之前的对话内容。

## 关键原则

- **禁止社交客套**。不要发"收到""好的""感谢"。收到任务直接行动。
- **默认先自己完成**。先判断你是否已经能直接解决，能直接做就不要先拆任务。
- **必要时才协作**。只有当任务能拆成 2 个以上真正有价值、可并行且边界清晰的子任务时，才考虑协作。
- **信息不足先澄清**。如果关键信息缺失、存在多种合理解法，或要做高风险/高成本动作，先问清再执行。
- **优先交付真实结果**。用工具产出文件、代码、命令结果或明确 blocker；不要用执行计划、过程纪要或状态总结代替完成。
- **最终结果由你锁定**。无论是否使用子 Agent 或 adapter，最终综合、验收和发布都由你负责。
- **用名称而非 ID**。
- **用中文交流**。
`,
  capabilities: ["code_write", "code_analysis", "file_write", "shell_execute", "information_retrieval", "web_search", "code_review"],
  maxIterations: 20,
  temperature: 0.5,
};

/**
 * AgentActor — 一个独立运行的 Agent 实体（Actor 模型）。
 *
 * 每个 Actor 拥有：
 * - 独立的 inbox（收件箱），任何时候都可以接收消息
 * - 独立的任务队列和生命周期
 * - 可配置的 LLM 模型和角色
 * - 通过 inboxDrain 钩子在 ReAct 循环的每个 iteration 间隙处理消息
 */
export class AgentActor {
  readonly id: string;
  readonly role: AgentRole;
  readonly persistent: boolean;
  modelOverride?: string;
  private _capabilities?: AgentCapabilities;

  private _status: ActorStatus = "idle";
  private inbox: InboxMessage[] = [];
  private inboxWaiters = new Set<() => void>();
  private _draining = false;
  private tasks: ActorTask[] = [];
  private abortController: AbortController | null = null;
  private eventHandlers: ActorEventHandler[] = [];
  private extraTools: AgentTool[] = [];
  private askUser?: AskUserCallback;
  private confirmDangerousAction?: ConfirmDangerousAction;
  private maxIterations: number;
  private readonly hasExplicitMaxIterations: boolean;
  private systemPromptOverride?: string;
  private actorSystem?: ActorSystem;
  private toolPolicy?: ToolPolicy;
  private _timeoutSeconds?: number;
  private _idleLeaseSeconds?: number;
  private _workspace?: string;
  private _contextTokens?: number;
  private _thinkingLevel?: ThinkingLevel;
  private _executionPolicy?: ExecutionPolicy;
  private _middlewareOverrides?: import("./types").MiddlewareOverrides;
  private _dialogExecutionMode: DialogExecutionMode = "execute";
  private _lastProgressAt = 0;
  private _abortReason: string | null = null;

  /** 会话记忆：跨任务保留对话上下文（对标 OpenClaw 持久会话） */
  private sessionHistory: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [];

  /** inboxDrain 捕获的真实用户消息（用于替代 "[inbox]" 占位符写入 sessionHistory） */
  private _capturedInboxUserQuery?: string;
  private _lastMemoryRecallAttempted = false;
  private _lastMemoryRecallPreview: string[] = [];
  private _lastTranscriptRecallAttempted = false;
  private _lastTranscriptRecallHitCount = 0;
  private _lastTranscriptRecallPreview: string[] = [];
  private engagedStructuredDeliveryManifest: StructuredDeliveryManifest | null = null;

  private traceFlow(
    event: string,
    detail?: Record<string, unknown>,
    actorId?: string | null,
  ): void {
    if (!this.actorSystem) return;
    this.actorSystem.recordDialogFlowEvent({
      event,
      actorId: actorId ?? this.id,
      detail,
    });
    traceDialogFlowEvent({
      sessionId: this.actorSystem.sessionId,
      actorId: actorId ?? this.id,
      event,
      detail,
    });
  }

  constructor(config: ActorConfig, opts?: {
    askUser?: AskUserCallback;
    confirmDangerousAction?: ConfirmDangerousAction;
    actorSystem?: ActorSystem;
  }) {
    this.id = config.id;
    this.role = config.role;
    this.persistent = config.persistent !== false;
    this.modelOverride = config.modelOverride;
    this._capabilities = config.capabilities;
    this.hasExplicitMaxIterations = typeof config.maxIterations === "number";
    this.maxIterations = config.maxIterations ?? config.role.maxIterations ?? 15;
    this.systemPromptOverride = config.systemPromptOverride;
    this.toolPolicy = config.toolPolicy;
    this._timeoutSeconds = config.timeoutSeconds ?? (config.role.name === "Lead"
      ? DEFAULT_DIALOG_MAIN_BUDGET_SECONDS
      : undefined);
    this._idleLeaseSeconds = config.idleLeaseSeconds ?? (config.role.name === "Lead"
      ? DEFAULT_DIALOG_MAIN_IDLE_LEASE_SECONDS
      : undefined);
    this._workspace = config.workspace;
    this._contextTokens = config.contextTokens;
    this._thinkingLevel = config.thinkingLevel;
    const compatState = synchronizeExecutionPolicyCompat({
      executionPolicy: config.executionPolicy,
      middlewareOverrides: config.middlewareOverrides,
    });
    this._executionPolicy = compatState.executionPolicy;
    this._middlewareOverrides = compatState.middlewareOverrides;
    this.confirmDangerousAction = opts?.confirmDangerousAction;
    this.actorSystem = opts?.actorSystem;

    if (opts?.askUser) {
      this.askUser = opts.askUser;
    } else if (this.actorSystem) {
      this.askUser = this.createChatAskUser();
    }
  }

  /**
   * 创建基于聊天流的 askUser 回调。
   * Agent 调用 ask_user 时，问题直接发到对话流，用户在输入框回复。
   */
  private createChatAskUser(): AskUserCallback {
    return async (questions) => {
      if (!this.actorSystem) throw new Error("No ActorSystem");
      actorDebugLog(this.role.name, `askUser: ${questions.length} questions, awaiting user reply...`);
      let questionText = questions.map((q, i) => {
        let line = `**问题${questions.length > 1 ? ` ${i + 1}` : ""}**: ${q.question}`;
        if (q.options?.length) {
          line += `\n选项: ${q.options.join(" / ")}`;
        }
        return line;
      }).join("\n\n");
      if (questions.length > 1) {
        questionText += `\n\n请按以下格式逐行回答：\n${questions
          .map((_, i) => `q${i + 1}: ...`)
          .join("\n")}`;
      }
      const interaction = await this.actorSystem.askUserInChat(this.id, questionText, {
        interactionType: "question",
      });
      if (interaction.status !== "answered") {
        throw new Error(interaction.status === "timed_out" ? "用户未回复" : "交互已取消");
      }
      const reply = interaction.content;
      const replyImages = interaction.message?.images ?? [];
      if (replyImages.length > 0) {
        this.receive({
          id: generateId(),
          from: "user",
          content: [
            "[ask_user 图片补充]",
            `用户在回答你刚才的问题时附带了 ${replyImages.length} 张图片。`,
            reply ? `文字回复：${reply}` : "",
            "请在继续处理当前任务时结合这些图片理解上下文。",
          ].filter(Boolean).join("\n"),
          timestamp: Date.now(),
          priority: "normal",
          images: replyImages,
        });
      }
      actorDebugLog(this.role.name, `askUser: got reply="${reply.slice(0, 60)}"`);

      const parseReplies = (): string[] => {
        const keyed = new Map<number, string>();
        for (const line of reply.split(/\r?\n/)) {
          const match = line.match(/^\s*(?:q(\d+)|问题\s*(\d+))\s*[:：=]\s*(.+)\s*$/i);
          if (!match) continue;
          const index = Number(match[1] ?? match[2]) - 1;
          if (Number.isNaN(index) || index < 0 || index >= questions.length) continue;
          keyed.set(index, match[3].trim());
        }
        if (keyed.size > 0) {
          return questions.map((_, i) => keyed.get(i) ?? "");
        }

        const byLine = reply.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (byLine.length === questions.length) return byLine;

        const bySemicolon = reply.split(/[；;]+/).map((s) => s.trim()).filter(Boolean);
        if (bySemicolon.length === questions.length) return bySemicolon;

        return questions.map((_, i) => (i === 0 ? reply : ""));
      };

      const parsedReplies = parseReplies();
      const answers: AskUserAnswers = {};
      questions.forEach((q, i) => {
        answers[q.question] = parsedReplies[i] ?? "";
      });
      return answers;
    };
  }

  // ── Public API ──

  get status(): ActorStatus {
    return this._status;
  }

  get currentTask(): ActorTask | undefined {
    return this.tasks.find((t) => t.status === "running");
  }

  get allTasks(): readonly ActorTask[] {
    return this.tasks;
  }

  get configuredMaxIterations(): number {
    return this.maxIterations;
  }

  get hasExplicitMaxIterationsConfig(): boolean {
    return this.hasExplicitMaxIterations;
  }

  get pendingInboxCount(): number {
    return this.inbox.length;
  }

  get workspace(): string | undefined {
    return this._workspace;
  }

  getEngagedStructuredDeliveryManifest(): StructuredDeliveryManifest | null {
    return this.engagedStructuredDeliveryManifest
      ? { ...this.engagedStructuredDeliveryManifest }
      : null;
  }

  engageStructuredDeliveryAdapter(manifest: StructuredDeliveryManifest): void {
    this.engagedStructuredDeliveryManifest = { ...manifest };
  }

  clearEngagedStructuredDeliveryAdapter(): void {
    this.engagedStructuredDeliveryManifest = null;
  }

  get timeoutSeconds(): number | undefined {
    return this._timeoutSeconds;
  }

  get idleLeaseSeconds(): number | undefined {
    return this._idleLeaseSeconds;
  }

  get contextTokens(): number | undefined {
    return this._contextTokens;
  }

  get thinkingLevel(): ThinkingLevel | undefined {
    return this._thinkingLevel;
  }

  get toolPolicyConfig(): ToolPolicy | undefined {
    const effective = mergeToolPolicies(
      this.toolPolicy,
      this.getDialogExecutionModeToolPolicy(),
      this.getDialogSubagentToolPolicy(),
    );
    if (!effective) return undefined;
    return {
      allow: effective.allow ? [...effective.allow] : undefined,
      deny: effective.deny ? [...effective.deny] : undefined,
    };
  }

  get persistedToolPolicyConfig(): ToolPolicy | undefined {
    if (!this.toolPolicy) return undefined;
    return {
      allow: this.toolPolicy.allow ? [...this.toolPolicy.allow] : undefined,
      deny: this.toolPolicy.deny ? [...this.toolPolicy.deny] : undefined,
    };
  }

  get executionPolicy(): ExecutionPolicy | undefined {
    const effective = mergeExecutionPolicies(this._executionPolicy, this.getDialogExecutionModeExecutionPolicy());
    if (!effective) return undefined;
    return {
      ...(effective.accessMode ? { accessMode: effective.accessMode } : {}),
      ...(effective.approvalMode ? { approvalMode: effective.approvalMode } : {}),
    };
  }

  get normalizedExecutionPolicy(): NormalizedExecutionPolicy {
    return normalizeExecutionPolicyWithMiddlewareCompat(
      this.executionPolicy,
      this._middlewareOverrides,
    );
  }

  get persistedExecutionPolicy(): ExecutionPolicy | undefined {
    if (!this._executionPolicy) return undefined;
    return {
      ...(this._executionPolicy.accessMode ? { accessMode: this._executionPolicy.accessMode } : {}),
      ...(this._executionPolicy.approvalMode ? { approvalMode: this._executionPolicy.approvalMode } : {}),
    };
  }

  get persistedNormalizedExecutionPolicy(): NormalizedExecutionPolicy {
    return normalizeExecutionPolicyWithMiddlewareCompat(
      this._executionPolicy,
      this._middlewareOverrides,
    );
  }

  get dialogExecutionMode(): DialogExecutionMode {
    return this._dialogExecutionMode;
  }

  get middlewareOverrides(): MiddlewareOverrides | undefined {
    if (!this._middlewareOverrides) return undefined;
    return {
      disable: this._middlewareOverrides.disable ? [...this._middlewareOverrides.disable] : undefined,
      approvalLevel: this._middlewareOverrides.approvalLevel,
    };
  }

  get capabilities(): AgentCapabilities | undefined {
    return this._capabilities;
  }

  /**
   * 热更新 Actor 配置（仅 idle 状态允许）。
   * 修改名称、模型、工作区、能力等，无需销毁重建。
   */
  updateConfig(patch: {
    name?: string;
    modelOverride?: string;
    workspace?: string;
    timeoutSeconds?: number;
    idleLeaseSeconds?: number;
    thinkingLevel?: ThinkingLevel;
    toolPolicy?: ToolPolicy;
    executionPolicy?: ExecutionPolicy;
    middlewareOverrides?: MiddlewareOverrides;
    capabilities?: AgentCapabilities;
  }): void {
    if (this._status !== "idle") throw new Error("Cannot update config while running");
    if ("name" in patch && patch.name !== undefined) this.role.name = patch.name;
    if ("modelOverride" in patch) this.modelOverride = patch.modelOverride || undefined;
    if ("workspace" in patch) this._workspace = patch.workspace || undefined;
    if ("timeoutSeconds" in patch) this._timeoutSeconds = patch.timeoutSeconds;
    if ("idleLeaseSeconds" in patch) this._idleLeaseSeconds = patch.idleLeaseSeconds;
    if ("thinkingLevel" in patch) this._thinkingLevel = patch.thinkingLevel;
    if ("toolPolicy" in patch) this.toolPolicy = patch.toolPolicy;
    if ("executionPolicy" in patch || "middlewareOverrides" in patch) {
      const compatState = synchronizeExecutionPolicyCompat({
        executionPolicy: "executionPolicy" in patch
          ? patch.executionPolicy
          : this._executionPolicy,
        middlewareOverrides: "middlewareOverrides" in patch
          ? patch.middlewareOverrides
          : ("executionPolicy" in patch
            ? compactMiddlewareOverridesForPersistence(this._middlewareOverrides)
            : this._middlewareOverrides),
      });
      this._executionPolicy = compatState.executionPolicy;
      this._middlewareOverrides = compatState.middlewareOverrides;
    }
    if ("capabilities" in patch) this._capabilities = patch.capabilities;
  }

  setDialogExecutionMode(mode: DialogExecutionMode): void {
    if (this._status !== "idle") throw new Error("Cannot change dialog execution mode while running");
    this._dialogExecutionMode = mode === "plan" ? "plan" : "execute";
  }

  private getDialogExecutionModeExecutionPolicy(): ExecutionPolicy | undefined {
    return this._dialogExecutionMode === "plan"
      ? { ...DIALOG_PLAN_MODE_EXECUTION_POLICY }
      : undefined;
  }

  private getDialogExecutionModeToolPolicy(): ToolPolicy | undefined {
    return this._dialogExecutionMode === "plan"
      ? {
          ...(DIALOG_PLAN_MODE_TOOL_POLICY.allow
            ? { allow: [...DIALOG_PLAN_MODE_TOOL_POLICY.allow] }
            : {}),
          ...(DIALOG_PLAN_MODE_TOOL_POLICY.deny
            ? { deny: [...DIALOG_PLAN_MODE_TOOL_POLICY.deny] }
            : {}),
        }
      : undefined;
  }

  private getDialogSubagentToolPolicy(params?: { activeOwnerRecord?: boolean }): ToolPolicy | undefined {
    if (params?.activeOwnerRecord) return undefined;
    const subagentEnabled = this.actorSystem?.getDialogSubagentEnabled?.() === true;
    const liveSubagentContext = this.actorSystem?.hasLiveDialogSubagentContext?.() === true;
    if (!this.actorSystem || subagentEnabled || liveSubagentContext) {
      return undefined;
    }
    return {
      deny: [...DIALOG_SUBAGENT_DISABLED_DENIED_TOOL_NAMES],
    };
  }

  get lastMemoryRecallAttempted(): boolean {
    return this._lastMemoryRecallAttempted;
  }

  get lastMemoryRecallPreview(): string[] {
    return [...this._lastMemoryRecallPreview];
  }

  get lastTranscriptRecallAttempted(): boolean {
    return this._lastTranscriptRecallAttempted;
  }

  get lastTranscriptRecallHitCount(): number {
    return this._lastTranscriptRecallHitCount;
  }

  get lastTranscriptRecallPreview(): string[] {
    return [...this._lastTranscriptRecallPreview];
  }

  /** 注入额外的 AgentTool（如 spawn_task / send_message / agents 等通信工具） */
  setExtraTools(tools: AgentTool[]): void {
    this.extraTools = tools;
  }

  /** 接收消息（线程安全——JS 单线程，任何时候都可调用） */
  receive(message: InboxMessage): void {
    const senderName = message.from === "user" ? "用户" : (this.actorSystem?.get(message.from)?.role.name ?? message.from);
    actorDebugLog(this.role.name, `receive: from=${senderName}, status=${this._status}, inboxSize=${this.inbox.length + 1}, content="${String(message.content).slice(0, 60)}"`);
    this.inbox.push(message);
    actorInfoLog(this.role.name, "receive queued", {
      actorId: this.id,
      from: senderName,
      messageFrom: message.from,
      currentStatus: this._status,
      inboxSize: this.inbox.length,
      hasImages: (message.images?.length ?? 0) > 0,
      contentPreview: previewActorText(message.content),
    });
    this.wakeInboxWaiters();
    this.emit("message_received", { message });

    if (this._status === "idle") {
      actorDebugLog(this.role.name, "receive: idle → triggering wakeUpForInbox");
      this.wakeUpForInbox();
    } else {
      actorInfoLog(this.role.name, "receive deferred because actor busy", {
        actorId: this.id,
        currentStatus: this._status,
        inboxSize: this.inbox.length,
        currentTaskId: this.currentTask?.id,
      });
    }
  }

  /**
   * 空闲时收到消息，自动启动一个轻量任务来处理 inbox。
   * 使用 queueMicrotask 延迟，让同一 tick 内的多条消息合并处理。
   * 预先 drain inbox 并将真实用户内容作为 query，避免 "[inbox]" 占位符误导 Agent。
   * 执行期间新到达的消息仍通过 inboxDrain 钩子正常注入。
   */
  private _wakeUpScheduled = false;
  private wakeUpForInbox(): void {
    if (this._wakeUpScheduled) {
      actorDebugLog(this.role.name, "wakeUpForInbox: already scheduled");
      return;
    }
    this._wakeUpScheduled = true;
    queueMicrotask(() => {
      this._wakeUpScheduled = false;
      if (this._status !== "idle" || this.inbox.length === 0) {
        actorDebugLog(this.role.name, `wakeUpForInbox: skipped (status=${this._status}, inbox=${this.inbox.length})`);
        actorInfoLog(this.role.name, "wakeUpForInbox skipped", {
          actorId: this.id,
          currentStatus: this._status,
          inboxSize: this.inbox.length,
        });
        return;
      }

      const messages = this.drainInbox();
      actorDebugLog(this.role.name, `wakeUpForInbox: drained ${messages.length} messages`);

      const userMsgs = messages.filter((m) => m.from === "user");
      let query: string;
      if (userMsgs.length === 1 && messages.length === 1) {
        query = userMsgs[0].content;
      } else if (userMsgs.length > 0 && messages.length === userMsgs.length) {
        query = userMsgs.map((m) => m.content).join("\n\n");
      } else {
        query = messages.map((m) => {
          const sender = m.from === "user" ? "用户"
            : (this.actorSystem?.get(m.from)?.role.name ?? m.from);
          return `[${sender}]: ${m.content}`;
        }).join("\n\n");
      }

      const allImages = messages.flatMap((m) => m.images ?? []);
      actorInfoLog(this.role.name, "wakeUpForInbox dispatch task", {
        actorId: this.id,
        drainedMessageCount: messages.length,
        userMessageCount: userMsgs.length,
        imageCount: allImages.length,
        queryPreview: previewActorText(query),
      });
      this.traceFlow("inbox_drained", {
        count: messages.length,
        user_count: userMsgs.length,
        image_count: allImages.length,
        preview: previewActorText(query),
      });
      void this.assignTask(query, allImages.length > 0 ? allImages : undefined);
    });
  }

  /** 手动读取并清空 inbox（带重入保护，防止并发 drain 丢消息） */
  drainInbox(): InboxMessage[] {
    if (this._draining) {
      actorDebugLog(this.role.name, `drainInbox: re-entrant call blocked`);
      return [];
    }
    this._draining = true;
    try {
      const messages = this.inbox.splice(0);
      return messages;
    } finally {
      this._draining = false;
    }
  }

  /**
   * 分配任务并异步执行。
   * 包含会话记忆（上下文连续）和等待循环（等待 spawned tasks 完成后整合）。
   */
  async assignTask(
    query: string,
    images?: string[],
    opts?: { publishResult?: boolean; runOverrides?: ActorRunOverrides },
  ): Promise<ActorTask> {
    actorDebugLog(this.role.name, `📋 assignTask START: query="${query.slice(0, 80)}", status=${this._status}, publishResult=${opts?.publishResult !== false}, inbox=${this.inbox.length}`);
    this.clearEngagedStructuredDeliveryAdapter();
    const task: ActorTask = {
      id: generateId(),
      query,
      status: "pending",
      steps: [],
    };
    this.tasks.push(task);
    actorInfoLog(this.role.name, "assignTask start", {
      actorId: this.id,
      taskId: task.id,
      currentStatus: this._status,
      inboxSize: this.inbox.length,
      publishResult: opts?.publishResult !== false,
      imageCount: images?.length ?? 0,
      queryPreview: previewActorText(query),
    });
    this.traceFlow("actor_task_started", {
      task_id: task.id,
      status: "pending",
      image_count: images?.length ?? 0,
      preview: previewActorText(query),
    });
    const traceTaskFlow = (event: string, detail?: Record<string, unknown>) => {
      this.traceFlow(event, {
        task_id: task.id,
        ...(detail ?? {}),
      });
    };
    const getActiveOwnerRecord = () => this.actorSystem?.getSpawnedTasksSnapshot?.()
      .filter((record) =>
        record.targetActorId === this.id
        && (record.status === "running" || (record.mode === "session" && record.sessionOpen))
      )
      .sort((left, right) => (right.lastActiveAt ?? right.spawnedAt) - (left.lastActiveAt ?? left.spawnedAt))[0];
    const isTaskActive = () => (
      task.status === "running"
      && this.status === "running"
      && this.currentTask?.id === task.id
    );
    let structuredTaskResultsForRecovery: DialogStructuredSubtaskResult[] = [];
    let hostExportTracedPath: string | undefined;
    let hostExportRepairPlan: StructuredDeliveryRepairPlan | undefined;
    const MAX_HOST_EXPORT_REPAIR_ROUNDS = 1;
    let hostExportRepairRoundCount = 0;
    const dispatchedRepairSuggestionKeys = new Set<string>();
    let successLock: ActorSuccessLock | null = null;
    const validateCandidateFinalResult = (candidate: string | undefined) => {
      const ownerRecord = getActiveOwnerRecord();
      if (ownerRecord) {
        return validateSpawnedTaskResult({
          task: ownerRecord,
          result: candidate ?? "",
          artifacts: this.actorSystem?.getArtifactRecordsSnapshot(),
        });
      }
      return validateActorTaskResult({
        taskText: query,
        result: candidate,
        actorId: this.id,
        startedAt: task.startedAt,
        completedAt: Date.now(),
        artifacts: this.actorSystem?.getArtifactRecordsSnapshot(),
        steps: task.steps,
      });
    };
    const rememberSuccessLock = (params: {
      candidateResult?: string;
      artifactPath?: string;
      reason: string;
      source: ActorSuccessLock["source"];
    }): boolean => {
      const candidate = String(params.candidateResult ?? "").trim();
      if (!candidate) return false;
      const validation = validateCandidateFinalResult(candidate);
      if (!validation.accepted) return false;
      const resolvedArtifactPath = params.artifactPath?.trim() || resolveSuccessArtifactPath({
        taskText: query,
        candidateResult: candidate,
        actorId: this.id,
        task,
        actorSystem: this.actorSystem,
      });
      if (taskRequestsSpreadsheetOutput(query) && !resolvedArtifactPath) {
        return false;
      }
      successLock = {
        result: candidate,
        artifactPath: resolvedArtifactPath,
        source: params.source,
        reason: params.reason,
        lockedAt: Date.now(),
      };
      task.successLocked = true;
      task.successLockReason = params.reason;
      task.successArtifactPath = resolvedArtifactPath;
      traceTaskFlow("success_locked", {
        source: params.source,
        preview: previewActorText(resolvedArtifactPath ?? candidate),
        reason: params.reason,
      });
      return true;
    };
    const tryRecoverSuccessLockFromArtifacts = (reason: string): boolean => {
      const recovered = buildConcreteResultFromArtifacts({
        result: successLock?.result,
        taskText: query,
        actorId: this.id,
        task,
        actorSystem: this.actorSystem,
        structuredResults: structuredTaskResultsForRecovery,
      });
      if (!recovered.result) return false;
      return rememberSuccessLock({
        candidateResult: recovered.result,
        reason,
        source: "artifact_recovery",
      });
    };
    const getOrRecoverSuccessLock = (reason: string): ActorSuccessLock | null => {
      if (successLock) return successLock;
      return tryRecoverSuccessLockFromArtifacts(reason) ? successLock : null;
    };

    let timeoutGuardId: ReturnType<typeof setInterval> | undefined;
      const rerunDiagnostics = {
        spawnFollowUpRuns: 0,
        finalSynthesisTriggered: false,
        validationRepairTriggered: false,
        answerStreamRestarts: 0,
    };
    let timeoutErrorMessage: string | null = null;
    let lastObservedSpawnActivityAt = 0;
    let lastStreamingAnswerLength = 0;
      let lastStreamingAnswerSnapshot = "";
      let lastAnswerClearedBy: string | null = null;
      let hasLoggedStreamingAnswerClear = false;
      let hasLoggedStreamingAnswerStart = false;
      let hasLoggedToolStreamStart = false;
      let budgetPausedAt: number | null = null;
      let pausedBudgetMs = 0;
      const budgetPauseReasons = new Set<string>();
      const WAIT_LOOP_BUDGET_PAUSE_REASON = "spawn_wait_loop";
      const WAIT_TOOL_BUDGET_PAUSE_REASON = "wait_for_spawned_tasks_tool";

    try {
      task.status = "running";
      task.startedAt = Date.now();
      const effectiveTimeoutSeconds = opts?.runOverrides?.timeoutSeconds ?? this._timeoutSeconds;
      const effectiveIdleLeaseSeconds = opts?.runOverrides?.idleLeaseSeconds ?? this._idleLeaseSeconds;
      const timeoutAbort = new AbortController();
      const runWithTimeoutGuard = <T,>(promise: Promise<T>): Promise<T> => {
        if (
          !(effectiveTimeoutSeconds && effectiveTimeoutSeconds > 0)
          && !(effectiveIdleLeaseSeconds && effectiveIdleLeaseSeconds > 0)
        ) {
          return promise;
        }
        if (timeoutAbort.signal.aborted) {
          return Promise.reject(new Error(String(timeoutAbort.signal.reason ?? timeoutErrorMessage ?? "Aborted")));
        }
        return Promise.race([
          promise,
          new Promise<T>((_, reject) => {
            const onAbort = () => {
              reject(new Error(String(timeoutAbort.signal.reason ?? timeoutErrorMessage ?? "Aborted")));
            };
            timeoutAbort.signal.addEventListener("abort", onAbort, { once: true });
            void promise.then(
              () => {
                timeoutAbort.signal.removeEventListener("abort", onAbort);
              },
              () => {
                timeoutAbort.signal.removeEventListener("abort", onAbort);
              },
            );
          }),
        ]);
      };
      this.setStatus("running");
      actorDebugLog(this.role.name, `📋 assignTask RUNNING: taskId=${task.id}, status changed to running`);
      this.traceFlow("actor_task_running", {
        task_id: task.id,
        status: "running",
      });
      this.emit("task_started", { taskId: task.id, query });
      this._lastProgressAt = task.startedAt;
      const markProgress = (timestamp = Date.now()) => {
        this._lastProgressAt = Math.max(this._lastProgressAt, timestamp);
      };
      const pauseBudgetCountdown = (timestamp = Date.now()) => {
        if (!(effectiveTimeoutSeconds && effectiveTimeoutSeconds > 0)) return;
        if (budgetPauseReasons.size === 0 && budgetPausedAt === null) {
          budgetPausedAt = timestamp;
        }
      };
      const resumeBudgetCountdown = (timestamp = Date.now()) => {
        if (budgetPausedAt === null || budgetPauseReasons.size > 0) return;
        pausedBudgetMs += Math.max(0, timestamp - budgetPausedAt);
        budgetPausedAt = null;
      };
      const pauseBudgetCountdownFor = (reason: string, timestamp = Date.now()) => {
        if (!(effectiveTimeoutSeconds && effectiveTimeoutSeconds > 0)) return;
        const hadPauses = budgetPauseReasons.size > 0;
        budgetPauseReasons.add(reason);
        if (!hadPauses && budgetPausedAt === null) {
          budgetPausedAt = timestamp;
        }
      };
      const resumeBudgetCountdownFor = (reason: string, timestamp = Date.now()) => {
        if (!(effectiveTimeoutSeconds && effectiveTimeoutSeconds > 0)) return;
        if (!budgetPauseReasons.delete(reason)) return;
        if (budgetPauseReasons.size === 0) {
          resumeBudgetCountdown(timestamp);
        }
      };
      const runWithBudgetPause = async <T,>(reason: string, fn: () => Promise<T>): Promise<T> => {
        pauseBudgetCountdownFor(reason);
        try {
          return await fn();
        } finally {
          resumeBudgetCountdownFor(reason);
        }
      };
      const getEffectiveBudgetElapsedMs = (now = Date.now()) => {
        if (!task.startedAt) return 0;
        const activePausedMs = budgetPausedAt === null ? 0 : Math.max(0, now - budgetPausedAt);
        return Math.max(0, now - task.startedAt - pausedBudgetMs - activePausedMs);
      };
      const getLatestSpawnActivityAt = (): number => {
        const activeTasks = this.actorSystem?.getActiveSpawnedTasks(this.id) ?? [];
        return activeTasks.reduce((latest, record) => Math.max(latest, record.lastActiveAt ?? record.spawnedAt), 0);
      };
      const refreshSpawnActivity = () => {
        const latestSpawnActivityAt = getLatestSpawnActivityAt();
        if (latestSpawnActivityAt > lastObservedSpawnActivityAt) {
          lastObservedSpawnActivityAt = latestSpawnActivityAt;
          markProgress(latestSpawnActivityAt);
        }
      };
      const requestTimeoutAbort = (reason: "idle" | "budget", seconds: number, observation: string) => {
        if (timeoutErrorMessage) return;
        timeoutErrorMessage = formatTimeoutError(reason, seconds);
        traceTaskFlow("timeout_abort_requested", {
          status: reason,
          elapsed_ms: task.startedAt ? Date.now() - task.startedAt : undefined,
          preview: previewActorText(observation),
        });
        actorWarnLog(this.role.name, "assignTask: timeout guard triggered", {
          taskId: task.id,
          timeoutReason: reason,
          seconds,
          lastProgressAt: this._lastProgressAt,
          startedAt: task.startedAt,
        });
        if (!timeoutAbort.signal.aborted) {
          timeoutAbort.abort(timeoutErrorMessage);
        }
        this.wakeInboxWaiters();
        this.abort(timeoutErrorMessage);
      };
      const throwIfTimedOut = () => {
        if (timeoutErrorMessage) throw new Error(timeoutErrorMessage);
      };
      const emitTaskStep = (step: AgentStep) => {
        if (!isTaskActive()) return;
        const stepTimestamp = step.timestamp ?? Date.now();
        markProgress(stepTimestamp);
        if (step.toolName === "wait_for_spawned_tasks") {
          if (step.type === "action") {
            pauseBudgetCountdownFor(WAIT_TOOL_BUDGET_PAUSE_REASON, stepTimestamp);
          } else {
            resumeBudgetCountdownFor(WAIT_TOOL_BUDGET_PAUSE_REASON, stepTimestamp);
          }
        }
        if (step.type === "answer" && step.streaming) {
          const currentLength = step.content.trim().length;
          if (!hasLoggedStreamingAnswerStart && currentLength > 0) {
            hasLoggedStreamingAnswerStart = true;
            this.traceFlow("stream_answer_started", {
              task_id: task.id,
              preview: previewActorText(step.content),
            });
          }
          const looksLikeRestart =
            lastStreamingAnswerLength >= 320
            && currentLength > 0
            && currentLength <= 120
            && currentLength + 160 < lastStreamingAnswerLength;
          if (looksLikeRestart) {
            rerunDiagnostics.answerStreamRestarts += 1;
            this.traceFlow("stream_answer_restarted", {
              task_id: task.id,
              count: rerunDiagnostics.answerStreamRestarts,
              preview: previewActorText(step.content),
            });
            actorWarnLog(this.role.name, "assignTask: streaming answer appears to restart", {
              taskId: task.id,
              restartCount: rerunDiagnostics.answerStreamRestarts,
              previousLength: lastStreamingAnswerLength,
              currentLength,
              clearedBy: lastAnswerClearedBy,
              previousPreview: lastStreamingAnswerSnapshot.slice(0, 120),
              currentPreview: step.content.slice(0, 120),
            });
          }
          lastStreamingAnswerLength = currentLength;
          lastStreamingAnswerSnapshot = step.content;
          lastAnswerClearedBy = null;
          hasLoggedStreamingAnswerClear = false;
        } else if (step.type === "tool_streaming" && step.streaming) {
          if (!hasLoggedToolStreamStart) {
            hasLoggedToolStreamStart = true;
            this.traceFlow("tool_stream_started", {
              task_id: task.id,
              preview: previewActorText(step.content),
            });
          }
        } else if (step.type === "tool_streaming" && !step.streaming) {
          this.traceFlow("tool_stream_finalized", {
            task_id: task.id,
            preview: previewActorText(step.content),
          });
        } else if (step.type === "answer" && !step.streaming) {
          this.traceFlow("stream_answer_finalized", {
            task_id: task.id,
            preview: previewActorText(step.content),
          });
        } else if (
          step.type === "action"
          && lastStreamingAnswerLength >= 320
          && !hasLoggedStreamingAnswerClear
        ) {
          lastAnswerClearedBy = `action:${step.toolName ?? "unknown"}`;
          hasLoggedStreamingAnswerClear = true;
          actorInfoLog(this.role.name, "assignTask: long streaming answer cleared before next phase", {
            taskId: task.id,
            previousLength: lastStreamingAnswerLength,
            trigger: lastAnswerClearedBy,
            preview: lastStreamingAnswerSnapshot.slice(0, 120),
          });
        }
        if (this.actorSystem && step.toolName) {
          if (step.type === "action" && step.toolInput) {
            appendToolCall(this.actorSystem.sessionId, this.id, step.toolName, step.toolInput);
            buildArtifactPayloadFromToolCall(this.id, this.actorSystem, step.toolName, step.toolInput);
          } else if (step.type === "observation" && step.toolOutput !== undefined) {
            appendToolResult(this.actorSystem.sessionId, this.id, step.toolName, step.toolOutput);
            buildArtifactPayloadFromToolResult(this.id, this.actorSystem, step.toolName, step.toolOutput);
          }
        }
        task.steps = applyIncomingAgentStep(task.steps, step);
        this.emit("step", { taskId: task.id, step });
      };
      if (
        (effectiveTimeoutSeconds && effectiveTimeoutSeconds > 0)
        || (effectiveIdleLeaseSeconds && effectiveIdleLeaseSeconds > 0)
      ) {
        timeoutGuardId = setInterval(() => {
          if (task.status !== "running") return;
          const now = Date.now();
          if (
            effectiveTimeoutSeconds
            && effectiveTimeoutSeconds > 0
            && task.startedAt
            && getEffectiveBudgetElapsedMs(now) >= effectiveTimeoutSeconds * 1000
          ) {
            requestTimeoutAbort(
              "budget",
              effectiveTimeoutSeconds,
              `超过总预算，已停止当前主 Agent（${effectiveTimeoutSeconds}s）。`,
            );
            return;
          }
          if (
            effectiveIdleLeaseSeconds
            && effectiveIdleLeaseSeconds > 0
            && this._lastProgressAt > 0
            && now - this._lastProgressAt >= effectiveIdleLeaseSeconds * 1000
          ) {
            requestTimeoutAbort(
              "idle",
              effectiveIdleLeaseSeconds,
              `长时间无进展，准备接管（${effectiveIdleLeaseSeconds}s）。`,
            );
          }
        }, TIMEOUT_CHECK_INTERVAL_MS);
      }

      actorDebugLog(this.role.name, `📝 assignTask: executing with sessionHistory=${this.sessionHistory.length} entries, inbox=${this.inbox.length}`);
      this._capturedInboxUserQuery = undefined;
      const { result: initialResult, finalQuery: executedQuery } = await runWithTimeoutGuard(
        this.runWithClarifications(
          query,
          images,
          emitTaskStep,
          opts?.runOverrides,
          isTaskActive,
        ),
      );
      throwIfTimedOut();
      const yieldedForSpawnWait = initialResult === WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT;
      let result = yieldedForSpawnWait ? "" : initialResult;
      const historyQuery = this._capturedInboxUserQuery || executedQuery;
      this._capturedInboxUserQuery = undefined;
      this.appendSessionHistory("user", historyQuery);
      if (!yieldedForSpawnWait) {
        this.appendSessionHistory("assistant", result ?? "");
      }

      // 等待循环：如果有未完成的 spawned tasks，保持运行等待结果回送
      const WAIT_POLL_MIN_MS = 3_000;
      const WAIT_POLL_MAX_MS = 30_000;
      const MAX_WAIT_ROUNDS = 600;
      let waitRound = 0;
      const getWaitPollMs = (round: number) =>
        Math.min(WAIT_POLL_MIN_MS * Math.pow(1.5, Math.min(round, 12)), WAIT_POLL_MAX_MS);
      let processedSpawnFollowUps = 0;
      let hadFailedSpawnFollowUp = false;
      const failedSpawnTaskLabels: string[] = [];
      const processedStructuredRunIds = new Set<string>();
      const accumulatedStructuredTaskResults = new Map<string, DialogStructuredSubtaskResult>();
      let waitWasActive = false;
      const rememberStructuredTaskResults = (tasks: readonly DialogStructuredSubtaskResult[]) => {
        tasks.forEach((taskResult) => {
          processedStructuredRunIds.add(taskResult.runId);
          accumulatedStructuredTaskResults.set(taskResult.runId, taskResult);
        });
      };
      const readSpawnRuntimeCounts = () => ({
        activeCount: this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0,
        queuedCount: this.actorSystem?.getPendingDeferredSpawnTaskCount?.(this.id) ?? 0,
      });
      const collectStructuredSpawnFollowUps = (): DialogStructuredSubtaskResult[] =>
        this.actorSystem?.collectStructuredSpawnedTaskResults?.(this.id, {
          terminalOnly: true,
          excludeRunIds: processedStructuredRunIds,
        }) ?? [];
      const buildAggregationRunOverrides = (params?: {
        stage?: "spawn_follow_up" | "final_synthesis" | "validation_repair";
        aggregateOnly?: boolean;
      }): ActorRunOverrides => {
        const spreadsheetOnly = taskRequestsSpreadsheetOutput(query);
        const deterministicSpreadsheetHostExport = (() => {
          const manifest = this.actorSystem?.getActiveExecutionContract?.()?.structuredDeliveryManifest
            ?? this.getEngagedStructuredDeliveryManifest()
            ?? resolveStructuredDeliveryManifest(query);
          return spreadsheetOnly && canDeterministicallyExportStructuredSpreadsheet(manifest);
        })();
        const aggregateOnlySpreadsheet = spreadsheetOnly
          && params?.aggregateOnly === true
          && deterministicSpreadsheetHostExport;
        const stageLabel = params?.stage === "validation_repair"
          ? "结果修复"
          : params?.stage === "final_synthesis"
            ? "最终综合"
            : "协作收尾";
        const aggregationInstruction = [
          `## ${stageLabel}阶段（高优先级）`,
          "你当前处于父 Agent 的收尾/聚合阶段。",
          "- 本阶段只允许消费结构化子任务结果与当前 run 关联 artifacts，并完成最终交付。",
          "- 默认不要再次调用 `spawn_task`、`wait_for_spawned_tasks`、`ask_user`、`ask_clarification`、`send_message`、`agents`、`memory_*`、`list_directory`、`read_file`、`read_document`、shell 工具。",
          "- 优先把结构化子任务结果当作主要事实来源，直接完成最终收尾。",
          "- 如果结构化结果里已经有 terminal_result / terminal_error / progressSummary，就不要为了“再确认一次”而重复猜测或重跑派工。",
          "- 只允许引用当前 run 关联 artifacts；禁止扫描 Downloads、历史目录、旧文件和记忆结果。",
          aggregateOnlySpreadsheet
            ? "- 本阶段是 aggregate-only：只能聚合已有 structured rows、terminal facts 与当前 run artifacts；禁止重新生成课程内容、重新压缩主题或自由构造 workbook 参数。"
            : "",
          deterministicSpreadsheetHostExport
            ? "- 这是 host-managed 的表格交付任务：不要自己调用 `export_spreadsheet`；你只需基于结构化结果给出 blocker 或补充说明，真正导出由 host 统一完成。"
            : "- 如果原任务要求 Excel / 表格文件，并且当前结构化结果已经足够，请直接调用 `export_spreadsheet` 完成交付；不要先写执行计划。",
          spreadsheetOnly && !deterministicSpreadsheetHostExport
            ? "- 这是表格交付任务：本轮首要动作就是构造表格数据并直接调用 `export_spreadsheet`；不得先输出执行计划、步骤清单或待办说明。"
            : "",
          "- 本地 Dialog / Review 会话不要尝试 `send_local_media`；只有外部 IM 渠道才允许回发媒体。",
          "- 禁止停留在“继续整理 / 稍后汇总 / 我先检查”这类中间态话术。",
        ].join("\n");
        const allowedTools = spreadsheetOnly
          ? (
              (aggregateOnlySpreadsheet || (deterministicSpreadsheetHostExport && params?.stage === "final_synthesis"))
                ? ["task_done"]
                : ["task_done", "export_spreadsheet"]
            )
          : resolveAggregationAllowedToolNames();
        return {
          ...(opts?.runOverrides ?? {}),
          toolPolicy: mergeToolPolicies(
            opts?.runOverrides?.toolPolicy,
            {
              allow: allowedTools,
              deny: [...AGGREGATION_DENIED_TOOL_NAMES],
            },
          ),
          systemPromptAppend: [opts?.runOverrides?.systemPromptAppend, aggregationInstruction]
            .filter(Boolean)
            .join("\n\n"),
        };
      };
      const buildTakeoverRunOverrides = (params?: {
        failedTaskLabels?: string[];
        stage?: "failure_follow_up" | "final_synthesis" | "validation_repair";
        aggregateOnly?: boolean;
      }): ActorRunOverrides => {
        const labels = uniqueNonEmptyStrings(params?.failedTaskLabels ?? []);
        const spreadsheetOnly = taskRequestsSpreadsheetOutput(query);
        const deterministicSpreadsheetHostExport = (() => {
          const manifest = this.actorSystem?.getActiveExecutionContract?.()?.structuredDeliveryManifest
            ?? this.getEngagedStructuredDeliveryManifest()
            ?? resolveStructuredDeliveryManifest(query);
          return spreadsheetOnly && canDeterministicallyExportStructuredSpreadsheet(manifest);
        })();
        const aggregateOnlySpreadsheet = spreadsheetOnly
          && params?.aggregateOnly === true
          && deterministicSpreadsheetHostExport;
        const stageLabel = params?.stage === "validation_repair"
          ? "结果修复"
          : params?.stage === "final_synthesis"
            ? "最终收尾"
            : "失败接管";
        const takeoverInstruction = [
          "## 主 Agent 接管模式（高优先级）",
          `当前处于${stageLabel}阶段。此前子任务已经失败或结束，你必须由主 Agent 自己收尾。`,
          labels.length > 0 ? `需要优先接管的失败子任务：${labels.join("、")}` : "",
          "- 本阶段只允许消费结构化子任务结果与当前 run 关联 artifacts，并完成最终交付。",
          "- 本轮禁止继续调用 `spawn_task` / `delegate_task` / `wait_for_spawned_tasks`。",
          "- 本轮禁止调用 `ask_user` / `ask_clarification` / `send_message` / `agents` / `memory_*` / `list_directory` / `read_file` / `read_document` / `search_in_files` / shell / `send_local_media`。",
          "- 若用户已经指定文件格式/路径，直接按原要求完成，不要改成中间产物或过程汇报。",
          "- 优先直接产出真实结果：文件路径、导出结果或明确 blocker。",
          aggregateOnlySpreadsheet
            ? "- 本阶段是 aggregate-only：只能聚合已有 structured rows、terminal facts 与当前 run artifacts；禁止重新生成课程内容、重新压缩主题或重写 workbook rows。"
            : "",
          (aggregateOnlySpreadsheet || (deterministicSpreadsheetHostExport && params?.stage === "final_synthesis"))
            ? "- 这是 host-managed 的表格交付任务：你不能自行导出 Excel。请基于结构化结果说明真实 blocker 或补充必要结论，导出由 host 统一完成。"
            : spreadsheetOnly
              ? "- 这是表格交付任务：本轮只允许直接导出 Excel/表格文件或返回真实 blocker；禁止退化成 TSV / Markdown / JSON 作为成功结果。"
              : "- 如果用户明确要求 Word / PDF / 代码文件等特定交付格式，必须交付对应格式；JSON 中间文件、执行计划、过程清单都不算完成。",
          "- 禁止再次停在“继续整理/等待汇总/稍后输出”等中间态。",
        ].filter(Boolean).join("\n");

        const allowedTools = spreadsheetOnly
          ? ((aggregateOnlySpreadsheet || (deterministicSpreadsheetHostExport && params?.stage === "final_synthesis"))
              ? ["task_done"]
              : (params?.stage === "failure_follow_up"
                  ? ["task_done"]
                  : ["task_done", "export_spreadsheet"]))
          : resolveAggregationAllowedToolNames();
        return {
          ...(opts?.runOverrides ?? {}),
          toolPolicy: mergeToolPolicies(
            opts?.runOverrides?.toolPolicy,
            {
              allow: allowedTools,
              deny: [...AGGREGATION_DENIED_TOOL_NAMES],
            },
          ),
          systemPromptAppend: [opts?.runOverrides?.systemPromptAppend, takeoverInstruction]
            .filter(Boolean)
            .join("\n\n"),
        };
      };
      const processSpawnFollowUpMessages = async (
        drainedMessages: InboxMessage[],
        structuredTasks: DialogStructuredSubtaskResult[] = [],
      ) => {
        if (drainedMessages.length === 0 && structuredTasks.length === 0) return;
        const mergedStructuredTasks = [
          ...structuredTasks,
          ...drainedMessages.flatMap((message) => message.spawnedTaskResult ? [message.spawnedTaskResult] : []),
        ].filter((taskResult, index, list) => list.findIndex((candidate) => candidate.runId === taskResult.runId) === index);
        const newStructuredTasks = mergedStructuredTasks.filter(
          (taskResult) => !processedStructuredRunIds.has(taskResult.runId),
        );
        newStructuredTasks.forEach((taskResult) => {
          traceTaskFlow("child_terminal_result_received", {
            run_id: taskResult.runId,
            status: taskResult.status,
            profile: taskResult.profile,
            preview: previewActorText(taskResult.terminalResult ?? taskResult.terminalError),
          });
        });
        rememberStructuredTaskResults(mergedStructuredTasks);
        const followUp = this.buildFollowUpFromMessages(drainedMessages, newStructuredTasks);
        const { activeCount, queuedCount } = readSpawnRuntimeCounts();
        const bufferedStructuredCount = accumulatedStructuredTaskResults.size;
        if (followUp.summary.hasTaskFailure) {
          hadFailedSpawnFollowUp = true;
          failedSpawnTaskLabels.push(...followUp.summary.failedTaskLabels);
          const shouldDeferFailureTakeover = mergedStructuredTasks.length > 0;
          if (activeCount > 0 || queuedCount > 0 || shouldDeferFailureTakeover) {
            if (activeCount > 0 || queuedCount > 0) {
              traceTaskFlow("takeover_suppressed", {
                count: followUp.summary.failedTaskLabels.length,
                active_count: activeCount,
                queued_count: queuedCount,
                buffered_structured_count: bufferedStructuredCount,
                artifact_scope: "current_run",
                rerun_policy: "all_terminal_only",
                preview: previewActorText(followUp.summary.failedTaskLabels.join("、")),
              });
            } else {
              traceTaskFlow("child_takeover_required", {
                count: followUp.summary.failedTaskLabels.length,
                active_count: activeCount,
                queued_count: queuedCount,
                buffered_structured_count: bufferedStructuredCount,
                artifact_scope: "current_run",
                rerun_policy: "final_synthesis_takeover",
                preview: previewActorText(followUp.summary.failedTaskLabels.join("、")),
              });
            }
            traceTaskFlow("follow_up_buffered", {
              message_count: drainedMessages.length,
              structured_count: mergedStructuredTasks.length,
              active_count: activeCount,
              queued_count: queuedCount,
              buffered_structured_count: bufferedStructuredCount,
              artifact_scope: "current_run",
              rerun_policy: activeCount > 0 || queuedCount > 0 ? "all_terminal_only" : "final_synthesis_takeover",
              status: "spawn_failure",
              preview: previewActorText(
                mergedStructuredTasks
                  .map((taskResult) => taskResult.label ?? taskResult.task)
                  .join("、"),
              ),
            });
            return;
          }
          traceTaskFlow("child_takeover_required", {
            count: followUp.summary.failedTaskLabels.length,
            preview: previewActorText(followUp.summary.failedTaskLabels.join("、")),
          });
        } else {
          traceTaskFlow("follow_up_buffered", {
            message_count: drainedMessages.length,
            structured_count: mergedStructuredTasks.length,
            active_count: activeCount,
            queued_count: queuedCount,
            buffered_structured_count: bufferedStructuredCount,
            artifact_scope: "current_run",
            rerun_policy: "all_terminal_only",
            preview: previewActorText(
              mergedStructuredTasks
                .map((taskResult) => taskResult.label ?? taskResult.task)
                .join("、"),
            ),
          });
        }
        actorDebugLog(
          this.role.name,
          `assignTask: processing ${drainedMessages.length} inbox messages in follow-up run`,
          {
            mode: followUp.mode,
            failedTasks: followUp.summary.failedTaskLabels,
            completedTasks: followUp.summary.completedTaskLabels,
            userMessages: followUp.summary.userMessageCount,
            structuredTasks: newStructuredTasks.map((task) => task.runId),
          },
        );
        if (!followUp.summary.hasTaskFailure) {
          if (mergedStructuredTasks.length > 0 && (activeCount > 0 || queuedCount > 0)) {
            traceTaskFlow("aggregation_deferred", {
              active_count: activeCount,
              queued_count: queuedCount,
              buffered_structured_count: bufferedStructuredCount,
              artifact_scope: "current_run",
              rerun_policy: "all_terminal_only",
            });
            return;
          }
          if (mergedStructuredTasks.length > 0) {
            return;
          }
          if (drainedMessages.length === 0) {
            return;
          }
        }
        rerunDiagnostics.spawnFollowUpRuns += 1;
        actorWarnLog(this.role.name, "assignTask: rerun triggered by follow-up inbox messages", {
          taskId: task.id,
          rerunIndex: rerunDiagnostics.spawnFollowUpRuns,
          drainedMessageCount: drainedMessages.length,
          structuredTaskCount: newStructuredTasks.length,
          mode: followUp.mode,
          failedTasks: followUp.summary.failedTaskLabels,
          completedTasks: followUp.summary.completedTaskLabels,
          userMessageCount: followUp.summary.userMessageCount,
        });
        traceTaskFlow("follow_up_rerun_started", {
          count: rerunDiagnostics.spawnFollowUpRuns,
          message_count: drainedMessages.length,
          structured_count: newStructuredTasks.length,
          active_count: activeCount,
          queued_count: queuedCount,
          buffered_structured_count: bufferedStructuredCount,
          artifact_scope: "current_run",
          status: followUp.mode,
          preview: previewActorText(followUp.prompt),
        });
        const followUpRunOverrides = followUp.summary.hasTaskFailure
          ? buildTakeoverRunOverrides({
              failedTaskLabels: followUp.summary.failedTaskLabels,
              stage: "failure_follow_up",
            })
          : buildAggregationRunOverrides({ stage: "spawn_follow_up" });
        if (followUp.summary.hasTaskFailure) {
          emitTaskStep({
            type: "observation",
            content: "子任务失败，主 Agent 正在直接接管收尾，并临时禁用继续派工。",
            timestamp: Date.now(),
          });
        }
        const { result: followUpResult, finalQuery: followUpHistoryQuery } = await runWithBudgetPause(
          "spawn_follow_up",
          () => runWithTimeoutGuard(
            this.runWithClarifications(
              followUp.prompt,
              followUp.images,
              emitTaskStep,
              followUpRunOverrides,
              isTaskActive,
            ),
          ),
        );
        this.appendSessionHistory("user", followUpHistoryQuery);
        this.appendSessionHistory("assistant", followUpResult ?? "");
        result = followUpResult ?? result;
        processedSpawnFollowUps++;
        traceTaskFlow("follow_up_rerun_completed", {
          count: processedSpawnFollowUps,
          status: followUp.summary.hasTaskFailure ? "takeover" : "completed",
          active_count: this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0,
          queued_count: readSpawnRuntimeCounts().queuedCount,
          buffered_structured_count: accumulatedStructuredTaskResults.size,
          artifact_scope: "current_run",
          preview: previewActorText(followUpResult),
        });
      };
      const getPendingDeferredSpawnCount = () => this.actorSystem?.getPendingDeferredSpawnTaskCount?.(this.id) ?? 0;
      const waitForSpawnedTasksToDrain = async (params?: {
        phase?: "primary" | "repair_round";
      }) => {
        const phase = params?.phase ?? "primary";
        let localWaitWasActive = false;
        let localWaitRound = 0;
        while (
          (
            (this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0) > 0
            || getPendingDeferredSpawnCount() > 0
          )
          && waitRound < MAX_WAIT_ROUNDS
        ) {
          this.actorSystem?.dispatchDeferredSpawnTasks?.(this.id);
          if (!localWaitWasActive) {
            localWaitWasActive = true;
            waitWasActive = true;
            const activeAtStart = this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0;
            const queuedAtStart = getPendingDeferredSpawnCount();
            traceTaskFlow("wait_started", {
              phase,
              active_count: activeAtStart,
              queued_count: queuedAtStart,
              timeout_ms: WAIT_POLL_MIN_MS,
            });
            traceTaskFlow("spawn_wait_entered", {
              phase,
              active_count: activeAtStart,
              queued_count: queuedAtStart,
              timeout_ms: WAIT_POLL_MIN_MS,
            });
          }
          refreshSpawnActivity();
          const activeCount = this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0;
          const queuedCount = getPendingDeferredSpawnCount();
          actorDebugLog(this.role.name, `assignTask: waiting for ${activeCount} spawned tasks (round ${waitRound + 1})...`);
          traceTaskFlow("wait_round", {
            phase,
            count: waitRound + 1,
            active_count: activeCount,
            queued_count: queuedCount,
            inbox_count: this.inbox.length,
          });
          pauseBudgetCountdownFor(WAIT_LOOP_BUDGET_PAUSE_REASON);
          try {
            await this.waitForInbox(getWaitPollMs(waitRound), () => Boolean(timeoutErrorMessage));
          } finally {
            resumeBudgetCountdownFor(WAIT_LOOP_BUDGET_PAUSE_REASON);
          }
          throwIfTimedOut();
          refreshSpawnActivity();
          this.actorSystem?.dispatchDeferredSpawnTasks?.(this.id);
          traceTaskFlow("wait_resumed", {
            phase,
            count: waitRound + 1,
            active_count: this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0,
            queued_count: getPendingDeferredSpawnCount(),
            inbox_count: this.inbox.length,
          });
          const structuredTasks = collectStructuredSpawnFollowUps();
          if (this.inbox.length > 0 || structuredTasks.length > 0) {
            await processSpawnFollowUpMessages(
              this.inbox.length > 0 ? this.drainInbox() : [],
              structuredTasks,
            );
            throwIfTimedOut();
          }
          waitRound++;
          localWaitRound++;
          if (waitRound % 12 === 0) {
            const activeNow = this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0;
            actorDebugLog(this.role.name, `assignTask: still waiting, round=${waitRound}, active=${activeNow}, queued=${getPendingDeferredSpawnCount()}, pollMs=${getWaitPollMs(waitRound)}`);
          }
        }

        while (this.inbox.length > 0 || collectStructuredSpawnFollowUps().length > 0) {
          actorWarnLog(this.role.name, "assignTask: processing residual inbox after spawned-task wait loop", {
            taskId: task.id,
            phase,
            pendingMessages: this.inbox.length,
          });
          await processSpawnFollowUpMessages(
            this.inbox.length > 0 ? this.drainInbox() : [],
            collectStructuredSpawnFollowUps(),
          );
          throwIfTimedOut();
        }

        if (!localWaitWasActive) return;
        const structuredTaskResults = [...accumulatedStructuredTaskResults.values()];
        const failedCount = structuredTaskResults.filter((taskResult) => taskResult.status === "error").length;
        const timedOutCount = structuredTaskResults.filter((taskResult) => taskResult.status === "aborted").length;
        if (structuredTaskResults.length > 0) {
          traceTaskFlow("all_children_terminal", {
            phase,
            active_count: this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0,
            queued_count: getPendingDeferredSpawnCount(),
            buffered_structured_count: structuredTaskResults.length,
            artifact_scope: "current_run",
            rerun_policy: "all_terminal_only",
          });
        }
        traceTaskFlow("spawn_wait_cleared", {
          phase,
          local_wait_rounds: localWaitRound,
          count: processedSpawnFollowUps,
          active_count: this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0,
          queued_count: getPendingDeferredSpawnCount(),
          completed_count: structuredTaskResults.filter((taskResult) => taskResult.status === "completed").length,
          failed_count: failedCount + timedOutCount,
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
        });
      };
      await waitForSpawnedTasksToDrain({ phase: "primary" });

      const validateFinalResult = validateCandidateFinalResult;

      let finalValidation = validateFinalResult(result);
      let structuredTaskResults = [...accumulatedStructuredTaskResults.values()];
      const refreshStructuredTaskResults = () => {
        structuredTaskResults = [...accumulatedStructuredTaskResults.values()];
        structuredTaskResultsForRecovery = structuredTaskResults;
        return structuredTaskResults;
      };
      refreshStructuredTaskResults();
      const contractStructuredDeliveryManifest = !getActiveOwnerRecord()
        ? this.actorSystem?.getActiveExecutionContract?.()?.structuredDeliveryManifest
          ?? this.getEngagedStructuredDeliveryManifest()
        : undefined;
      const structuredDeliveryManifest = !getActiveOwnerRecord()
        ? contractStructuredDeliveryManifest ?? resolveStructuredDeliveryManifest(query)
        : resolveStructuredDeliveryManifest(null);
      const structuredDeliveryStrategy = !getActiveOwnerRecord()
        ? resolveStructuredDeliveryStrategyById(
            structuredDeliveryManifest.strategyId
            ?? structuredDeliveryManifest.recommendedStrategyId,
          )
        : null;
      const recoverConcreteArtifactResult = () => {
        const concreteRewrite = buildConcreteResultFromArtifacts({
          result,
          taskText: query,
          actorId: this.id,
          task,
          actorSystem: this.actorSystem,
          structuredResults: structuredTaskResults,
        });
        if (concreteRewrite.blockedReason) {
          traceTaskFlow("rewrite_guard_triggered", {
            status: "blocked",
            buffered_structured_count: structuredTaskResults.length,
            artifact_scope: "current_run",
            preview: previewActorText(concreteRewrite.blockedReason),
          });
        }
        if (concreteRewrite.result && concreteRewrite.result !== result) {
          actorInfoLog(this.role.name, "assignTask: recovered concrete final result from current-run artifacts", {
            taskId: task.id,
            originalPreview: String(result ?? "").slice(0, 120),
            rewrittenPreview: concreteRewrite.result.slice(0, 120),
          });
          traceTaskFlow("final_reply_rewritten", {
            preview: previewActorText(concreteRewrite.result),
            buffered_structured_count: structuredTaskResults.length,
            artifact_scope: "current_run",
          });
          result = concreteRewrite.result;
          finalValidation = validateFinalResult(result);
          rememberSuccessLock({
            candidateResult: result,
            reason: "current-run artifact confirmed as final deliverable",
            source: "artifact_recovery",
          });
          return true;
        }
        return false;
      };
      const canAttemptDeterministicHostExport = () => Boolean(
        !getActiveOwnerRecord()
        && structuredDeliveryStrategy?.buildHostExportPlan
        && taskRequestsSpreadsheetOutput(query)
        && structuredDeliveryManifest.deliveryContract === "spreadsheet"
        && hasStructuredRowEvidence(structuredTaskResults)
        && structuredTaskResults.every((taskResult) => taskResult.status !== "running"),
      );
      const executeDeterministicHostExport = async (): Promise<"completed" | "blocked" | "skipped"> => {
        if (!canAttemptDeterministicHostExport()) return "skipped";
        const hostExportPlan = structuredDeliveryStrategy?.buildHostExportPlan?.({
          taskText: query,
          manifest: structuredDeliveryManifest,
          structuredResults: structuredTaskResults,
        });
        hostExportRepairPlan = undefined;
        const exportableStructuredCount = filterExportableStructuredResults({
          structuredResults: structuredTaskResults,
        }).length;
        if (!hostExportPlan) {
          traceTaskFlow("host_export_blocked", {
            phase: "host_export",
            status: "missing_plan",
            buffered_structured_count: structuredTaskResults.length,
            exportable_structured_count: exportableStructuredCount,
            artifact_scope: "current_run",
            preview: "structured delivery strategy returned no host export plan",
          });
          return "blocked";
        }
        if ("blocker" in hostExportPlan) {
          hostExportRepairPlan = hostExportPlan.repairPlan;
          traceTaskFlow("host_export_blocked", {
            phase: "host_export",
            status: "blocked",
            buffered_structured_count: structuredTaskResults.length,
            exportable_structured_count: exportableStructuredCount,
            artifact_scope: "current_run",
            preview: previewActorText(hostExportPlan.blocker),
          });
          return "blocked";
        }
        const builtinTools = createBuiltinAgentTools(
          async () => true,
          this.askUser,
          {
            getCurrentQuery: () => query,
            scheduleClawHubResume: async () => undefined,
          },
        );
        const exportTool = builtinTools.tools.find((tool) => tool.name === hostExportPlan.toolName);
        if (!exportTool) {
          traceTaskFlow("host_export_blocked", {
            phase: "host_export",
            status: "missing_tool",
            buffered_structured_count: structuredTaskResults.length,
            artifact_scope: "current_run",
            preview: `${hostExportPlan.toolName} unavailable`,
          });
          return "blocked";
        }
        traceTaskFlow("single_workbook_mode", {
          phase: "host_export",
          status: "enabled",
          delivery_contract: hostExportPlan.deliveryContract,
          parent_contract: hostExportPlan.parentContract,
          artifact_scope: "current_run",
          preview: previewActorText(hostExportPlan.targetPreview),
        });
        traceTaskFlow("export_plan_selected", {
          phase: "host_export",
          status: hostExportPlan.deliveryContract,
          delivery_contract: hostExportPlan.deliveryContract,
          parent_contract: hostExportPlan.parentContract,
          artifact_scope: "current_run",
          count: hostExportPlan.operationCount,
          preview: previewActorText(hostExportPlan.tracePreview),
        });
        const exportParams = hostExportPlan.toolInput;
        emitTaskStep({
          type: "action",
          content: `调用 ${hostExportPlan.toolName}`,
          toolName: hostExportPlan.toolName,
          toolInput: exportParams,
          timestamp: Date.now(),
        });
        traceTaskFlow("tool_call_started", {
          tool: hostExportPlan.toolName,
          phase: "host_export",
          count: hostExportPlan.operationCount,
          preview: previewActorText(hostExportPlan.tracePreview),
        });
        const exportResult = await exportTool.execute(exportParams);
        emitTaskStep({
          type: "observation",
          content: typeof exportResult === "string"
            ? exportResult
            : JSON.stringify(exportResult),
          toolName: hostExportPlan.toolName,
          toolOutput: exportResult,
          timestamp: Date.now(),
        });
        if (typeof exportResult === "object" && exportResult !== null && "error" in exportResult) {
          traceTaskFlow("tool_call_failed", {
            tool: hostExportPlan.toolName,
            phase: "host_export",
            artifact_scope: "current_run",
            preview: previewActorText(String(exportResult.error ?? "导出失败")),
          });
          traceTaskFlow("host_export_blocked", {
            phase: "host_export",
            status: "tool_error",
            buffered_structured_count: structuredTaskResults.length,
            artifact_scope: "current_run",
            preview: previewActorText(String(exportResult.error ?? "导出失败")),
          });
          return "blocked";
        }
        const exportPath = extractPathsByExtensions(
          typeof exportResult === "string" ? exportResult : JSON.stringify(exportResult),
          hostExportPlan.expectedArtifactExtensions,
        )[0];
        traceTaskFlow("tool_call_completed", {
          tool: hostExportPlan.toolName,
          phase: "host_export",
          artifact_scope: "current_run",
          preview: previewActorText(exportPath ?? hostExportPlan.tracePreview),
        });
        traceTaskFlow("tool_result_recorded", {
          tool: hostExportPlan.toolName,
          phase: "host_export",
          artifact_scope: "current_run",
          preview: previewActorText(exportPath ?? hostExportPlan.tracePreview),
        });
        if (!exportPath) {
          traceTaskFlow("host_export_blocked", {
            phase: "host_export",
            status: "missing_path",
            buffered_structured_count: structuredTaskResults.length,
            artifact_scope: "current_run",
            preview: previewActorText(typeof exportResult === "string" ? exportResult : JSON.stringify(exportResult)),
          });
          return "blocked";
        }
        traceTaskFlow("host_export_completed", {
          phase: "host_export",
          status: "completed",
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          preview: previewActorText(exportPath),
        });
        traceTaskFlow("export_plan_executed", {
          status: "completed",
          delivery_contract: hostExportPlan.deliveryContract,
          parent_contract: hostExportPlan.parentContract,
          artifact_scope: "current_run",
          count: 1,
          preview: previewActorText(exportPath),
        });
        hostExportTracedPath = exportPath;
        result = hostExportPlan.successReply.replace("__EXPORT_PATH__", exportPath);
        finalValidation = validateFinalResult(result);
        rememberSuccessLock({
          candidateResult: result,
          artifactPath: exportPath,
          reason: "host export succeeded and quality gate passed",
          source: "host_export",
        });
        return "completed";
      };
      const dispatchStructuredRepairRound = async (): Promise<boolean> => {
        if (!hostExportRepairPlan?.suggestions?.length) return false;
        if (hostExportRepairRoundCount >= MAX_HOST_EXPORT_REPAIR_ROUNDS) return false;
        if (!this.actorSystem?.spawnTask && !this.actorSystem?.enqueueDeferredSpawnTask) return false;
        const dispatchableSuggestions = hostExportRepairPlan.suggestions.filter((suggestion) => {
          const key = buildStructuredRepairSuggestionKey({
            label: suggestion.label,
            sourceItemIds: suggestion.sourceItemIds,
            missingThemes: suggestion.missingThemes,
          });
          return Boolean(suggestion.task?.trim()) && !dispatchedRepairSuggestionKeys.has(key);
        });
        if (dispatchableSuggestions.length === 0) return false;

        const acceptedRepairLabels: string[] = [];
        const failedRepairLabels: string[] = [];
        const concurrencyLimit = Math.max(1, this.actorSystem?.getDialogSpawnConcurrencyLimit?.() ?? dispatchableSuggestions.length);
        let projectedActiveCount = this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0;

        for (const suggestion of dispatchableSuggestions) {
          const suggestionTask = suggestion.task?.trim();
          if (!suggestionTask) continue;
          const suggestionKey = buildStructuredRepairSuggestionKey({
            label: suggestion.label,
            sourceItemIds: suggestion.sourceItemIds,
            missingThemes: suggestion.missingThemes,
          });
          const targetActorName = suggestion.label?.trim() || `repair-shard-${acceptedRepairLabels.length + failedRepairLabels.length + 1}`;
          const spawnOptions = {
            label: suggestion.label?.trim() || targetActorName,
            roleBoundary: suggestion.roleBoundary ?? "executor",
            createIfMissing: suggestion.createIfMissing ?? true,
            overrides: suggestion.overrides,
          };

          if (
            projectedActiveCount >= concurrencyLimit
            && this.actorSystem?.enqueueDeferredSpawnTask
          ) {
            this.actorSystem.enqueueDeferredSpawnTask(
              this.id,
              targetActorName,
              suggestionTask,
              spawnOptions,
            );
            dispatchedRepairSuggestionKeys.add(suggestionKey);
            acceptedRepairLabels.push(spawnOptions.label);
            continue;
          }

          const spawned = this.actorSystem?.spawnTask?.(
            this.id,
            targetActorName,
            suggestionTask,
            spawnOptions,
          );
          if (spawned && "runId" in spawned) {
            projectedActiveCount += 1;
            dispatchedRepairSuggestionKeys.add(suggestionKey);
            acceptedRepairLabels.push(spawnOptions.label);
            continue;
          }

          const failureMessage = spawned && "error" in spawned
            ? spawned.error
            : "repair shard 派发失败";
          failedRepairLabels.push(spawnOptions.label);
          hadFailedSpawnFollowUp = true;
          failedSpawnTaskLabels.push(spawnOptions.label);
          traceTaskFlow("repair_round_dispatch_failed", {
            label: spawnOptions.label,
            buffered_structured_count: structuredTaskResults.length,
            artifact_scope: "current_run",
            preview: previewActorText(failureMessage),
          });
        }

        if (acceptedRepairLabels.length === 0) return false;

        hostExportRepairRoundCount += 1;
        emitTaskStep({
          type: "observation",
          content: `host export 被 quality gate 拦截，系统正在按 repair plan 补派 ${acceptedRepairLabels.length} 个 repair shards。`,
          timestamp: Date.now(),
        });
        traceTaskFlow("repair_round_started", {
          round: hostExportRepairRoundCount,
          accepted_count: acceptedRepairLabels.length,
          failed_count: failedRepairLabels.length,
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          preview: previewActorText(acceptedRepairLabels.join("、")),
        });
        await waitForSpawnedTasksToDrain({ phase: "repair_round" });
        refreshStructuredTaskResults();
        traceTaskFlow("repair_round_completed", {
          round: hostExportRepairRoundCount,
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          preview: previewActorText(
            structuredTaskResults
              .map((taskResult) => taskResult.label ?? taskResult.task)
              .join("、"),
          ),
        });
        return true;
      };
      const initialHostExportStatus = await executeDeterministicHostExport();
      if (
        initialHostExportStatus === "blocked"
        && await dispatchStructuredRepairRound()
      ) {
        finalValidation = validateFinalResult(result);
        await executeDeterministicHostExport();
      }
      recoverConcreteArtifactResult();
      if (
        structuredTaskResults.length > 0
        && (waitWasActive || yieldedForSpawnWait || processedSpawnFollowUps > 0)
        && shouldForceStructuredFinalSynthesis({
          hadFailedSpawnFollowUp,
          structuredResults: structuredTaskResults,
          candidateResult: result,
          finalValidation,
        })
      ) {
        emitTaskStep({
          type: "observation",
          content: hadFailedSpawnFollowUp
            ? "检测到子任务失败，正在触发一次主协调复核，避免直接停在状态总结。"
            : finalValidation.accepted === false
              ? "结构化子任务已结束，但当前答复仍缺少可交付结果，正在触发一次最终综合。"
              : "所有子任务已结束，正在触发一次最终综合，避免停留在中间态回复。",
          timestamp: Date.now(),
        });
        rerunDiagnostics.finalSynthesisTriggered = true;
        const deliveryPlanBlock = buildStructuredDeliveryPlanBlock({
          taskText: query,
          structuredResults: structuredTaskResults,
        });
        const repairPlanBlock = buildStructuredRepairPlanBlock(hostExportRepairPlan);
        const synthesisPlanBlock = [deliveryPlanBlock, repairPlanBlock].filter(Boolean).join("\n\n") || undefined;
        const finalSynthesisAggregateOnly = taskRequestsSpreadsheetOutput(query)
          && canDeterministicallyExportStructuredSpreadsheet(structuredDeliveryManifest)
          && hasStructuredRowEvidence(structuredTaskResults);
        if (synthesisPlanBlock) {
          traceTaskFlow("single_workbook_mode", {
            phase: "final_synthesis",
            status: "enabled",
            delivery_contract: "spreadsheet",
            parent_contract: "single_workbook",
            artifact_scope: "current_run",
            preview: "grouped_delivery_targets",
          });
          traceTaskFlow("export_plan_selected", {
            phase: "final_synthesis",
            status: "spreadsheet",
            delivery_contract: "spreadsheet",
            parent_contract: "single_workbook",
            artifact_scope: "current_run",
            preview: previewActorText(synthesisPlanBlock, 160),
          });
        }
        const finalSynthesisPrompt = buildFinalSynthesisPrompt({
          hadFailedSpawnFollowUp,
          failedTaskLabels: failedSpawnTaskLabels,
          structuredTasks: structuredTaskResults,
          deliveryPlanBlock: synthesisPlanBlock,
          aggregateOnly: finalSynthesisAggregateOnly,
          hostExportPath: hostExportTracedPath,
        });
        traceTaskFlow("aggregation_started", {
          count: structuredTaskResults.length,
          active_count: this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0,
          queued_count: getPendingDeferredSpawnCount(),
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          rerun_policy: hadFailedSpawnFollowUp ? "takeover_fallback" : "all_terminal_only",
          status: hadFailedSpawnFollowUp ? "takeover" : "normal",
        });
        traceTaskFlow("final_synthesis_started", {
          count: structuredTaskResults.length,
          failed_count: structuredTaskResults.filter((taskResult) => taskResult.status === "error" || taskResult.status === "aborted").length,
          status: hadFailedSpawnFollowUp ? "takeover" : "normal",
          active_count: this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0,
          queued_count: getPendingDeferredSpawnCount(),
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          rerun_policy: hadFailedSpawnFollowUp ? "takeover_fallback" : "all_terminal_only",
          preview: previewActorText(finalSynthesisPrompt),
        });
        actorWarnLog(this.role.name, "assignTask: rerun triggered by final synthesis", {
          taskId: task.id,
          hadFailedSpawnFollowUp,
          failedSpawnTaskLabels: [...new Set(failedSpawnTaskLabels.filter(Boolean))],
          structuredRunIds: structuredTaskResults.map((taskResult) => taskResult.runId),
          validationAccepted: finalValidation.accepted,
          validationReason: finalValidation.reason,
          resultPreview: String(result ?? "").slice(0, 120),
        });
        const finalSynthesisRunOverrides = hadFailedSpawnFollowUp
          ? buildTakeoverRunOverrides({
              failedTaskLabels: failedSpawnTaskLabels,
              stage: "final_synthesis",
              aggregateOnly: finalSynthesisAggregateOnly,
            })
          : buildAggregationRunOverrides({
              stage: "final_synthesis",
              aggregateOnly: finalSynthesisAggregateOnly,
            });
        const { result: finalSynthesisResult, finalQuery: finalSynthesisQuery } = await runWithBudgetPause(
          "final_synthesis",
          () => runWithTimeoutGuard(
            this.runWithClarifications(
              finalSynthesisPrompt,
              undefined,
              emitTaskStep,
              finalSynthesisRunOverrides,
              isTaskActive,
            ),
          ),
        );
        throwIfTimedOut();
        this.appendSessionHistory("user", finalSynthesisQuery);
        this.appendSessionHistory("assistant", finalSynthesisResult ?? "");
        result = finalSynthesisResult ?? result;
        traceTaskFlow("aggregation_completed", {
          status: "completed",
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          rerun_policy: hadFailedSpawnFollowUp ? "takeover_fallback" : "all_terminal_only",
          preview: previewActorText(finalSynthesisResult),
        });
        traceTaskFlow("final_synthesis_completed", {
          status: "completed",
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          preview: previewActorText(finalSynthesisResult),
        });
        finalValidation = validateFinalResult(result);
        const spreadsheetTerminalBlocker = buildSpreadsheetTerminalBlocker({
          taskText: query,
          candidateResult: result,
          structuredResults: structuredTaskResults,
          hostExportRepairPlan,
          fallbackReason: finalValidation.reason,
        });
        if (spreadsheetTerminalBlocker) {
          traceTaskFlow("spreadsheet_terminal_guard_triggered", {
            status: "blocked",
            buffered_structured_count: structuredTaskResults.length,
            exportable_structured_count: filterExportableStructuredResults({ structuredResults: structuredTaskResults }).length,
            artifact_scope: "current_run",
            preview: previewActorText(result),
          });
          result = spreadsheetTerminalBlocker.startsWith("阻塞原因")
            ? spreadsheetTerminalBlocker
            : `阻塞原因：${spreadsheetTerminalBlocker}`;
          finalValidation = validateFinalResult(result);
        }
        recoverConcreteArtifactResult();
      }
      if (!finalValidation.accepted) {
        actorWarnLog(this.role.name, "assignTask: final result validation failed", {
          reason: finalValidation.reason,
          resultPreview: String(result ?? "").slice(0, 120),
          queryPreview: query.slice(0, 120),
        });
        recoverConcreteArtifactResult();
      }
      if (!finalValidation.accepted) {
        emitTaskStep({
          type: "observation",
          content: `最终答复未通过结果校验，正在触发一次纠偏：${finalValidation.reason}`,
          timestamp: Date.now(),
        });
        rerunDiagnostics.validationRepairTriggered = true;
        traceTaskFlow("repair_started", {
          status: "repairing",
          active_count: this.actorSystem?.getActiveSpawnedTasks(this.id).length ?? 0,
          queued_count: getPendingDeferredSpawnCount(),
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          rerun_policy: hadFailedSpawnFollowUp ? "takeover_fallback" : "all_terminal_only",
          preview: previewActorText(finalValidation.reason),
        });
        traceTaskFlow("validation_repair_started", {
          status: "repairing",
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          preview: previewActorText(finalValidation.reason),
        });
        if (taskRequestsSpreadsheetOutput(query)) {
          traceTaskFlow("delivery_mode_selected", {
            phase: "validation_repair",
            status: "spreadsheet",
            delivery_contract: "spreadsheet",
            preview: "task_done, export_spreadsheet",
          });
        }
        actorWarnLog(this.role.name, "assignTask: rerun triggered by final-result validation repair", {
          taskId: task.id,
          reason: finalValidation.reason,
          resultPreview: String(result ?? "").slice(0, 120),
        });
        const repairDeliveryPlanBlock = buildStructuredDeliveryPlanBlock({
          taskText: query,
          structuredResults: structuredTaskResults,
        });
        const repairPlanBlock = buildStructuredRepairPlanBlock(hostExportRepairPlan);
        const repairPlanContextBlock = [repairDeliveryPlanBlock, repairPlanBlock].filter(Boolean).join("\n\n") || undefined;
        if (repairPlanContextBlock) {
          traceTaskFlow("single_workbook_mode", {
            phase: "validation_repair",
            status: "enabled",
            delivery_contract: "spreadsheet",
            parent_contract: "single_workbook",
            artifact_scope: "current_run",
            preview: "grouped_delivery_targets",
          });
          traceTaskFlow("export_plan_selected", {
            phase: "validation_repair",
            status: "spreadsheet",
            delivery_contract: "spreadsheet",
            parent_contract: "single_workbook",
            artifact_scope: "current_run",
            preview: previewActorText(repairPlanContextBlock, 160),
          });
        }
        const repairPrompt = [
          "你的上一条答复未通过结果校验。",
          `原因：${finalValidation.reason}`,
          `原始任务：${query}`,
          structuredTaskResults.length > 0
            ? buildStructuredTaskSummaryBlock(structuredTaskResults)
            : "",
          repairPlanContextBlock ?? "",
          "",
          "请立刻纠偏并给出真正可交付的最终结果：",
          "1. 如果任务需要生成网页、代码、文档或文件，请给出真实文件路径、关键内容或明确的产物说明。",
          "2. 如果你实际上还没有完成，就继续执行，不要输出无关算术、占位文本或空泛总结。",
          "3. 如果确实无法完成，请直接说明真实阻塞原因和缺失条件，不要假装完成。",
          /excel|xlsx|xls|csv|表格/iu.test(finalValidation.reason ?? "")
            ? "4. 本轮要求的是表格文件交付。最终答复必须显式写出“已导出 Excel 文件：<绝对路径>”或真实 blocker；禁止只做存在性确认、历史确认或记忆总结。"
            : "",
          ...(hadFailedSpawnFollowUp
            ? [
                `${/excel|xlsx|xls|csv|表格/iu.test(finalValidation.reason ?? "") ? "5" : "4"}. 本轮存在失败子任务${failedSpawnTaskLabels.length ? `（${[...new Set(failedSpawnTaskLabels.filter(Boolean))].join("、")}）` : ""}。你必须先完成一次主协调复核：自己接管补齐，或在补充清晰输出路径与验收标准后重派一次子任务；禁止只汇报过程状态。`,
              ]
            : []),
          ...(finalValidation.reason?.includes("算术结果")
            ? [`${hadFailedSpawnFollowUp ? (/excel|xlsx|xls|csv|表格/iu.test(finalValidation.reason ?? "") ? "6" : "5") : (/excel|xlsx|xls|csv|表格/iu.test(finalValidation.reason ?? "") ? "5" : "4")}. 这不是数学题，禁止调用 calculate 工具，也不要返回算式结果。请继续围绕真实产物执行。`]
            : []),
        ].join("\n");
        const repairRunOverrides = hadFailedSpawnFollowUp
          ? buildTakeoverRunOverrides({
              failedTaskLabels: failedSpawnTaskLabels,
              stage: "validation_repair",
            })
          : buildAggregationRunOverrides({ stage: "validation_repair" });
        const { result: repairedResult, finalQuery: repairedQuery } = await runWithBudgetPause(
          "validation_repair",
          () => runWithTimeoutGuard(
            this.runWithClarifications(
              repairPrompt,
              undefined,
              emitTaskStep,
              repairRunOverrides,
              isTaskActive,
            ),
          ),
        );
        throwIfTimedOut();
        this.appendSessionHistory("user", repairedQuery);
        this.appendSessionHistory("assistant", repairedResult ?? "");
        result = repairedResult ?? result;
        traceTaskFlow("repair_completed", {
          status: "completed",
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          rerun_policy: hadFailedSpawnFollowUp ? "takeover_fallback" : "all_terminal_only",
          preview: previewActorText(repairedResult),
        });
        traceTaskFlow("validation_repair_completed", {
          status: "completed",
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          preview: previewActorText(repairedResult),
        });
        finalValidation = validateFinalResult(result);
        const spreadsheetTerminalBlocker = buildSpreadsheetTerminalBlocker({
          taskText: query,
          candidateResult: result,
          structuredResults: structuredTaskResults,
          hostExportRepairPlan,
          fallbackReason: finalValidation.reason,
        });
        if (spreadsheetTerminalBlocker) {
          traceTaskFlow("final_result_rejected_as_plan_for_spreadsheet", {
            status: "blocked",
            buffered_structured_count: structuredTaskResults.length,
            exportable_structured_count: filterExportableStructuredResults({ structuredResults: structuredTaskResults }).length,
            artifact_scope: "current_run",
            preview: previewActorText(result),
          });
          result = spreadsheetTerminalBlocker.startsWith("阻塞原因")
            ? spreadsheetTerminalBlocker
            : `阻塞原因：${spreadsheetTerminalBlocker}`;
          finalValidation = validateFinalResult(result);
        }
        actorDebugLog(this.role.name, "assignTask: final result revalidation", {
          accepted: finalValidation.accepted,
          reason: finalValidation.reason,
          resultPreview: String(result ?? "").slice(0, 120),
        });
        if (!finalValidation.accepted) {
          const lockedSuccess = getOrRecoverSuccessLock("validation repair failed after a concrete artifact had already been produced");
          if (lockedSuccess) {
            result = lockedSuccess.result;
            finalValidation = validateFinalResult(result);
          }
        }
        if (!finalValidation.accepted) {
          throw new Error(finalValidation.reason ?? "最终结果未通过有效性校验");
        }
      }

      if (timeoutGuardId) clearInterval(timeoutGuardId);

      const concreteRewrite = buildConcreteResultFromArtifacts({
        result,
        taskText: query,
        actorId: this.id,
        task,
        actorSystem: this.actorSystem,
        structuredResults: structuredTaskResults,
      });
      if (concreteRewrite.blockedReason) {
        traceTaskFlow("rewrite_guard_triggered", {
          status: "blocked",
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          preview: previewActorText(concreteRewrite.blockedReason),
        });
      }
      const concreteResult = concreteRewrite.result;
      if (concreteResult && concreteResult !== result) {
        actorInfoLog(this.role.name, "assignTask: rewriting plan-like final reply into concrete publishable result", {
          taskId: task.id,
          originalPreview: String(result ?? "").slice(0, 120),
          rewrittenPreview: concreteResult.slice(0, 120),
        });
        traceTaskFlow("final_reply_rewritten", {
          preview: previewActorText(concreteResult),
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
        });
        result = concreteResult;
      }
      finalValidation = validateFinalResult(result);
      if (taskRequestsSpreadsheetOutput(query)) {
        const requestedExtensions = resolveRequestedSpreadsheetExtensions(query);
        const exportPaths = [
          ...extractPathsByExtensions(result, requestedExtensions),
          ...collectActorArtifactsForTask({
            actorId: this.id,
            task,
            actorSystem: this.actorSystem,
          })
            .map((artifact) => artifact.path)
            .filter((artifactPath) => requestedExtensions.some((extension) => artifactPath.toLowerCase().endsWith(`.${extension}`))),
        ].filter((path, index, list) => list.indexOf(path) === index);
        if (exportPaths.length === 1 && exportPaths[0] !== hostExportTracedPath) {
          traceTaskFlow("export_plan_executed", {
            status: "completed",
            delivery_contract: "spreadsheet",
            parent_contract: "single_workbook",
            artifact_scope: "current_run",
            count: 1,
            preview: previewActorText(exportPaths[0]),
          });
        }
      }
      if (!finalValidation.accepted) {
        const lockedSuccess = getOrRecoverSuccessLock("final validation failed after a concrete artifact had already been produced");
        if (lockedSuccess) {
          result = lockedSuccess.result;
          finalValidation = validateFinalResult(result);
        }
      }
      if (!finalValidation.accepted) {
        traceTaskFlow("rewrite_guard_triggered", {
          status: "rejected",
          buffered_structured_count: structuredTaskResults.length,
          artifact_scope: "current_run",
          preview: previewActorText(finalValidation.reason),
        });
        throw new Error(finalValidation.reason ?? "最终结果未通过有效性校验");
      }

      const abortLingeringChildren = (phase: "final" | "failure", reason: string) => {
        const activeChildren = this.actorSystem?.getActiveSpawnedTasks?.(this.id) ?? [];
        if (activeChildren.length === 0) return;
        traceTaskFlow("orphan_child_abort_requested", {
          phase,
          count: activeChildren.length,
          preview: previewActorText(
            activeChildren.map((record) => record.label ?? record.task).join("、"),
          ),
        });
        const abortedCount = this.actorSystem?.abortActiveRunSpawnedTasks?.(this.id, reason) ?? 0;
        traceTaskFlow("orphan_child_aborted", {
          phase,
          count: abortedCount,
          active_count: this.actorSystem?.getActiveSpawnedTasks?.(this.id).length ?? 0,
          preview: previewActorText(
            activeChildren.map((record) => record.label ?? record.task).join("、"),
          ),
        });
      };

      task.status = "completed";
      this.applyLatestRecallToTask(task);
      task.result = result;
      task.finishedAt = Date.now();
      const elapsed = task.finishedAt - (task.startedAt ?? task.finishedAt);
      actorDebugLog(this.role.name, `✅ assignTask COMPLETED: taskId=${task.id}, elapsed=${elapsed}ms, result="${(result ?? "").slice(0, 80)}"`);
      if (
        rerunDiagnostics.spawnFollowUpRuns > 0
        || rerunDiagnostics.finalSynthesisTriggered
        || rerunDiagnostics.validationRepairTriggered
        || rerunDiagnostics.answerStreamRestarts > 0
      ) {
        actorInfoLog(this.role.name, "assignTask: rerun diagnostics summary", {
          taskId: task.id,
          elapsed,
          spawnFollowUpRuns: rerunDiagnostics.spawnFollowUpRuns,
          finalSynthesisTriggered: rerunDiagnostics.finalSynthesisTriggered,
          validationRepairTriggered: rerunDiagnostics.validationRepairTriggered,
          answerStreamRestarts: rerunDiagnostics.answerStreamRestarts,
          finalResultPreview: String(result ?? "").slice(0, 160),
        });
      }
      traceTaskFlow("actor_task_completed", {
        status: "completed",
        elapsed_ms: elapsed,
        preview: previewActorText(result),
      });
      this._abortReason = null;
      this.setStatus("idle");

      // 自动提取记忆（对标 OpenClaw session-memory hook）
      const memContent = `${query}\n${result ?? ""}`;
      autoExtractMemories(memContent, task.id, {
        sourceMode: "dialog",
        workspaceId: this._workspace,
      }).catch((err) => {
        actorWarnLog(this.role.name, `autoExtractMemories failed (non-blocking):`, err instanceof Error ? err.message : err);
      });
      if (this.actorSystem && opts?.publishResult !== false) {
        abortLingeringChildren("final", "主 Agent 已完成最终发布，终止遗留子任务。");
        let output = String(result ?? "").trim() || "（任务已完成，但未生成可展示的文本结果）";
        const iterExhausted = task.steps?.some((s) => s.type === "error" && s.content === "iteration_exhausted");
        if (iterExhausted) {
          output += "\n\n（注意：任务在迭代限制内未能完全完成）";
        }
        try {
          this.actorSystem.publishResult(this.id, output, {
            suppressLowSignal: false,
            phase: "final",
          });
        } catch (publishError) {
          traceTaskFlow("publish_result_failed", {
            phase: "final",
            preview: previewActorText(
              publishError instanceof Error ? publishError.message : String(publishError),
            ),
          });
          actorWarnLog(this.role.name, "assignTask: publishResult failed after task completion", {
            taskId: task.id,
            error: publishError instanceof Error ? publishError.message : String(publishError),
          });
        }
      }
      this.emit("task_completed", { taskId: task.id, result, elapsed });
      return task;
    } catch (e) {
      if (timeoutGuardId) clearInterval(timeoutGuardId);

      const rawError = e instanceof Error ? e.message : String(e);
      const abortReason = this._abortReason;
      const error = rawError === "Aborted"
        ? this.consumeAbortReason()
        : rawError;
      if (abortReason && abortReason === rawError) {
        this.consumeAbortReason(rawError);
      }
      const lockedSuccess = getOrRecoverSuccessLock(`run failed after a concrete artifact had already been produced: ${error}`);
      if (lockedSuccess) {
        task.status = "completed";
        this.applyLatestRecallToTask(task);
        task.result = lockedSuccess.result;
        task.error = undefined;
        task.successLocked = true;
        task.successLockReason = lockedSuccess.reason;
        task.successArtifactPath = lockedSuccess.artifactPath;
        task.finishedAt = Date.now();
        const lockedElapsed = task.finishedAt - (task.startedAt ?? task.finishedAt);
        traceTaskFlow("success_lock_preserved_after_error", {
          elapsed_ms: lockedElapsed,
          source: lockedSuccess.source,
          preview: previewActorText(lockedSuccess.artifactPath ?? lockedSuccess.result),
          reason: previewActorText(error),
        });
        actorWarnLog(this.role.name, "assignTask: preserved success lock after downstream error", {
          taskId: task.id,
          elapsed: lockedElapsed,
          source: lockedSuccess.source,
          successArtifactPath: lockedSuccess.artifactPath,
          error,
        });
        this._abortReason = null;
        this.setStatus("idle");
        if (this.actorSystem && opts?.publishResult !== false) {
          const activeChildren = this.actorSystem.getActiveSpawnedTasks?.(this.id) ?? [];
          if (activeChildren.length > 0) {
            traceTaskFlow("orphan_child_abort_requested", {
              phase: "final",
              count: activeChildren.length,
              preview: previewActorText(
                activeChildren.map((record) => record.label ?? record.task).join("、"),
              ),
            });
            const abortedCount = this.actorSystem.abortActiveRunSpawnedTasks?.(this.id, "主 Agent 已锁定成功结果，终止遗留子任务。") ?? 0;
            traceTaskFlow("orphan_child_aborted", {
              phase: "final",
              count: abortedCount,
              active_count: this.actorSystem.getActiveSpawnedTasks?.(this.id).length ?? 0,
              preview: previewActorText(
                activeChildren.map((record) => record.label ?? record.task).join("、"),
              ),
            });
          }
          try {
            this.actorSystem.publishResult(this.id, lockedSuccess.result, {
              suppressLowSignal: false,
              phase: "final",
            });
          } catch (publishError) {
            traceTaskFlow("publish_result_failed", {
              phase: "final",
              preview: previewActorText(
                publishError instanceof Error ? publishError.message : String(publishError),
              ),
            });
            actorWarnLog(this.role.name, "assignTask: publishResult failed after success-lock recovery", {
              taskId: task.id,
              error: publishError instanceof Error ? publishError.message : String(publishError),
            });
          }
        }
        this.emit("task_completed", {
          taskId: task.id,
          result: lockedSuccess.result,
          elapsed: lockedElapsed,
          successLocked: true,
        });
        return task;
      }
      const isTimeoutAbort = isTimeoutErrorMessage(error);
      task.status = rawError === "Aborted" || Boolean(abortReason) || isTimeoutAbort ? "aborted" : "error";
      this.applyLatestRecallToTask(task);
      task.error = error;
      task.finishedAt = Date.now();
      const errorElapsed = task.finishedAt - (task.startedAt ?? task.finishedAt);
      actorErrorLog(this.role.name, `assignTask: ERROR - ${error}`);
      if (
        rerunDiagnostics.spawnFollowUpRuns > 0
        || rerunDiagnostics.finalSynthesisTriggered
        || rerunDiagnostics.validationRepairTriggered
        || rerunDiagnostics.answerStreamRestarts > 0
      ) {
        actorWarnLog(this.role.name, "assignTask: rerun diagnostics before error exit", {
          taskId: task.id,
          elapsed: errorElapsed,
          spawnFollowUpRuns: rerunDiagnostics.spawnFollowUpRuns,
          finalSynthesisTriggered: rerunDiagnostics.finalSynthesisTriggered,
          validationRepairTriggered: rerunDiagnostics.validationRepairTriggered,
          answerStreamRestarts: rerunDiagnostics.answerStreamRestarts,
          error,
        });
      }
      traceTaskFlow(task.status === "aborted" ? "actor_task_aborted" : "actor_task_failed", {
        status: task.status,
        elapsed_ms: errorElapsed,
        preview: previewActorText(error),
      });
      this._abortReason = null;
      this.setStatus("idle");
      if (this.actorSystem && opts?.publishResult !== false) {
        const activeChildren = this.actorSystem.getActiveSpawnedTasks?.(this.id) ?? [];
        if (activeChildren.length > 0) {
          traceTaskFlow("orphan_child_abort_requested", {
            phase: "failure",
            count: activeChildren.length,
            preview: previewActorText(
              activeChildren.map((record) => record.label ?? record.task).join("、"),
            ),
          });
          const abortedCount = this.actorSystem.abortActiveRunSpawnedTasks?.(this.id, `主 Agent 已退出，终止遗留子任务：${error}`) ?? 0;
          traceTaskFlow("orphan_child_aborted", {
            phase: "failure",
            count: abortedCount,
            active_count: this.actorSystem.getActiveSpawnedTasks?.(this.id).length ?? 0,
            preview: previewActorText(
              activeChildren.map((record) => record.label ?? record.task).join("、"),
            ),
          });
        }
        this.actorSystem.publishResult(
          this.id,
          `任务执行失败：${error}`,
          {
            suppressLowSignal: false,
            phase: "failure",
          },
        );
      }
      this.emit("task_error", { taskId: task.id, error, elapsed: errorElapsed });
      return task;
    }
  }

  /** Build context messages from session history within token budget */
  private buildContextMessages(): Array<{ role: "user" | "assistant"; content: string }> {
    if (this.sessionHistory.length === 0) return [];
    const budget = this._contextTokens ?? 8000;
    let used = 0;
    const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = this.sessionHistory.length - 1; i >= 0; i--) {
      const entry = this.sessionHistory[i];
      const tokens = estimateTokens(entry.content);
      if (used + tokens > budget) break;
      selected.unshift({ role: entry.role, content: entry.content });
      used += tokens;
    }
    return selected;
  }

  /** 导出 sessionHistory（用于持久化） */
  getSessionHistory(): Array<{ role: "user" | "assistant"; content: string; timestamp: number }> {
    return [...this.sessionHistory];
  }

  /** 导入 sessionHistory（用于恢复） */
  loadSessionHistory(history: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>): void {
    this.sessionHistory = history.slice(-50); // 限制大小
  }

  /** 清空 sessionHistory（重置 session 时调用） */
  clearSessionHistory(): void {
    this.sessionHistory = [];
  }

  /** 获取 systemPromptOverride（用于快照） */
  getSystemPromptOverride(): string | undefined {
    return this.systemPromptOverride;
  }

  /** 追加到会话记忆 */
  private appendSessionHistory(role: "user" | "assistant", content: string): void {
    this.sessionHistory.push({ role, content, timestamp: Date.now() });
    const MAX_TOTAL = 50;
    if (this.sessionHistory.length > MAX_TOTAL) {
      this.sessionHistory = this.sessionHistory.slice(-MAX_TOTAL);
    }
  }

  /** 从已 drain 的消息构建后续查询（用于等待循环） */
  private buildFollowUpFromMessages(
    drained: InboxMessage[],
    structuredTasks: DialogStructuredSubtaskResult[] = [],
  ): FollowUpPromptDescriptor {
    const mergedStructuredTasks = [
      ...structuredTasks,
      ...drained.flatMap((message) => message.spawnedTaskResult ? [message.spawnedTaskResult] : []),
    ].filter((task, index, list) => list.findIndex((candidate) => candidate.runId === task.runId) === index);
    const structuredRunIds = new Set(mergedStructuredTasks.map((task) => task.runId));
    const filteredMessages = drained.filter((message) => {
      const relatedRunId = (message as InboxMessage & { relatedRunId?: string }).relatedRunId;
      return !relatedRunId || !structuredRunIds.has(relatedRunId);
    });
    const inheritedImages = filteredMessages.flatMap((message) => message.images ?? []);
    const messages = filteredMessages.map((m) => {
      const sender = m.from === "user" ? "用户" : (this.actorSystem?.get(m.from)?.role.name ?? m.from);
      const imageNote = m.images?.length ? `（附带 ${m.images.length} 张图片）` : "";
      return `[${sender}${imageNote}]: ${m.content.slice(0, 300)}`;
    });
    const descriptor = buildFollowUpPromptFromRenderedMessages({
      renderedMessages: messages,
      summary: summarizeFollowUpMessages(filteredMessages),
      structuredTasks: mergedStructuredTasks,
    });
    if (inheritedImages.length > 0) {
      descriptor.images = [...new Set(inheritedImages)];
    }
    return descriptor;
  }

  /** 等待 inbox 有消息或超时 */
  private waitForInbox(timeoutMs: number, shouldStop?: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (this.inbox.length > 0 || shouldStop?.()) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inboxWaiters.delete(onInboxWake);
        resolve();
      };
      const onInboxWake = () => finish();
      this.inboxWaiters.add(onInboxWake);

      const timer = setTimeout(() => finish(), timeoutMs);
      if (this.actorSystem?.waitForSpawnedTaskUpdate) {
        void this.actorSystem.waitForSpawnedTaskUpdate(this.id, timeoutMs)
          .then(() => finish())
          .catch(() => finish());
      }
    });
  }

  private wakeInboxWaiters(): void {
    for (const wake of [...this.inboxWaiters]) {
      wake();
    }
  }

  /** 停止当前任务 */
  abort(reason?: string): void {
    this.actorSystem?.abortActiveRunSpawnedTasks?.(this.id, reason ?? "父任务被终止");
    if (reason) {
      this._abortReason = reason;
    }
    this.actorSystem?.cancelPendingInteractionsForActor(this.id);
    this.abortController?.abort();
  }

  private async runWithClarifications(
    query: string,
    images?: string[],
    onStep?: (step: AgentStep) => void,
    runOverrides?: ActorRunOverrides,
    isTaskActive?: () => boolean,
  ): Promise<{ result: string; finalQuery: string }> {
    let currentQuery = query;
    let currentImages = images;
    let clarificationRound = 0;

    while (true) {
      clarificationRound += 1;
      this.traceFlow("clarification_loop_started", {
        count: clarificationRound,
        image_count: currentImages?.length ?? 0,
        preview: previewActorText(currentQuery),
      });
      try {
        const result = await this.runWithInbox(
          currentQuery,
          currentImages,
          onStep,
          runOverrides,
          true,
          isTaskActive,
        );
        return { result, finalQuery: currentQuery };
      } catch (error) {
        if (!(error instanceof ClarificationInterrupt)) {
          throw error;
        }

        const resolution = await this.waitForClarification(error, onStep);
        currentQuery = this.buildClarificationResumeQuery(currentQuery, error, resolution);
        if (resolution.images?.length) {
          currentImages = [...new Set([...(currentImages ?? []), ...resolution.images])];
        }
      }
    }
  }

  private async waitForClarification(
    interrupt: ClarificationInterrupt,
    onStep?: (step: AgentStep) => void,
  ): Promise<{
    status: "answered" | "timed_out" | "cancelled";
    answer: string;
    rawInput?: string;
    wasOptionSelection?: boolean;
    images?: string[];
  }> {
    const question = interrupt.question.trim();
    onStep?.({
      type: "observation",
      content: `等待用户澄清：${question}`,
      toolName: "ask_clarification",
      timestamp: Date.now(),
    });

    if (!interrupt.waitForReply) {
      return { status: "timed_out", answer: "" };
    }

    this.setStatus("waiting");
    const waitingAbort = new AbortController();
    this.abortController = waitingAbort;

    try {
      const resolution = await Promise.race([
        interrupt.waitForReply(),
        new Promise<never>((_, reject) => {
          waitingAbort.signal.addEventListener(
            "abort",
            () => reject(new Error(this._abortReason ?? "Aborted")),
            { once: true },
          );
        }),
      ]);

      if (resolution.status === "answered") {
        onStep?.({
          type: "observation",
          content: resolution.images?.length
            ? `用户澄清：${resolution.answer}（附带 ${resolution.images.length} 张图片）`
            : `用户澄清：${resolution.answer}`,
          toolName: "ask_clarification",
          timestamp: Date.now(),
        });
      } else {
        onStep?.({
          type: "observation",
          content: resolution.status === "timed_out"
            ? "用户未在规定时间内回答澄清问题，将基于已有信息继续执行。"
            : "澄清交互已取消，将基于已有信息继续执行。",
          toolName: "ask_clarification",
          timestamp: Date.now(),
        });
      }

      return resolution;
    } finally {
      if (this.abortController === waitingAbort) {
        this.abortController = null;
      }
      if (!waitingAbort.signal.aborted && this._status !== "stopped") {
        this.setStatus("running");
      }
    }
  }

  private buildClarificationResumeQuery(
    baseQuery: string,
    interrupt: ClarificationInterrupt,
    resolution: {
      status: "answered" | "timed_out" | "cancelled";
      answer: string;
      rawInput?: string;
      wasOptionSelection?: boolean;
      images?: string[];
    },
  ): string {
    const clarificationBlock = resolution.status === "answered"
      ? [
          "[用户澄清补充]",
          `问题：${interrupt.question}`,
          `回答：${resolution.answer}`,
          resolution.images?.length ? `附带图片：\n${resolution.images.map((image) => `- ${image}`).join("\n")}` : "",
          resolution.wasOptionSelection ? `原始输入：${resolution.rawInput ?? resolution.answer}` : "",
          "请基于这个澄清继续原任务，不要重复之前已经完成的工作。",
        ].filter(Boolean).join("\n")
      : [
          "[澄清未完成]",
          `问题：${interrupt.question}`,
          resolution.status === "timed_out"
            ? "用户暂未回复，请基于已有信息继续执行，并在结果中明确你的假设。"
            : "本次澄清已取消，请基于已有信息继续执行，并在结果中明确你的假设。",
        ].join("\n");

    return `${baseQuery}\n\n${clarificationBlock}`;
  }

  private consumeAbortReason(fallback = "Aborted"): string {
    const resolved = this._abortReason ?? fallback;
    this._abortReason = null;
    return resolved;
  }

  /** 完全停止 Actor */
  stop(): void {
    this.abort();
    this.setStatus("stopped");
    this.inbox = [];
  }

  // ── Events ──

  on(handler: ActorEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  // ── Internal ──

  private setStatus(status: ActorStatus): void {
    if (this._status === status) return;
    const prev = this._status;
    this._status = status;
    actorInfoLog(this.role.name, "status change", {
      actorId: this.id,
      prevStatus: prev,
      nextStatus: status,
      inboxSize: this.inbox.length,
      currentTaskId: this.currentTask?.id,
    });
    this.emit("status_change", { prev, next: status });
    if (status === "idle" && this.inbox.length > 0) {
      actorDebugLog(
        this.role.name,
        `setStatus: idle with queued inbox=${this.inbox.length}, triggering wakeUpForInbox`,
      );
      this.wakeUpForInbox();
    }
  }

  private emit(type: ActorEventType, detail?: unknown): void {
    const event: ActorEvent = {
      type,
      actorId: this.id,
      timestamp: Date.now(),
      detail,
    };
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch { /* non-critical */ }
    }
  }

  private applyLatestRecallToTask(task: ActorTask): void {
    task.memoryRecallAttempted = this._lastMemoryRecallAttempted;
    task.appliedMemoryPreview = [...this._lastMemoryRecallPreview];
    task.transcriptRecallAttempted = this._lastTranscriptRecallAttempted;
    task.transcriptRecallHitCount = this._lastTranscriptRecallHitCount;
    task.appliedTranscriptPreview = [...this._lastTranscriptRecallPreview];
  }

  /**
   * Build the ActorRunContext from current actor state, run the middleware chain,
   * then create and execute the ReActAgent.
   */
  private async runWithInbox(
    query: string,
    images?: string[],
    onStep?: (step: AgentStep) => void,
    runOverrides?: ActorRunOverrides,
    allowContextRecovery = true,
    isTaskActive?: () => boolean,
  ): Promise<string> {
    const ensureTaskStillActive = () => {
      if (isTaskActive?.() === false) {
        throw new Error(this._abortReason ?? "Aborted");
      }
    };
    const activeImageRefs = new Set<string>((images ?? []).filter(Boolean));
    const activeOwnerRecord = this.actorSystem?.getSpawnedTasksSnapshot?.()
      .filter((record) =>
        record.targetActorId === this.id
        && (record.status === "running" || (record.mode === "session" && record.sessionOpen))
      )
      .sort((left, right) => (right.lastActiveAt ?? right.spawnedAt) - (left.lastActiveAt ?? left.spawnedAt))[0];
    const activeExecutionContract = !activeOwnerRecord
      ? this.actorSystem?.getActiveExecutionContract?.() ?? null
      : null;
    const contractStructuredDeliveryManifest = !activeOwnerRecord
      ? activeExecutionContract?.structuredDeliveryManifest
        ?? this.getEngagedStructuredDeliveryManifest()
      : undefined;
    const autoGroundSpreadsheetTaskText = async (
      taskText: string,
      existingManifest?: ReturnType<typeof resolveStructuredDeliveryManifest>,
    ): Promise<string> => {
      if (!taskRequestsSpreadsheetOutput(taskText)) return taskText;
      if (/(?:结构化子任务摘要|你派发的子任务现在都已经结束|你的上一条答复未通过结果校验)/u.test(taskText)) {
        return taskText;
      }
      if ((existingManifest?.sourceSnapshot?.items.length ?? 0) > 0) {
        return taskText;
      }
      const initialSnapshot = buildSourceGroundingSnapshot(taskText);
      const sourcePaths = existingManifest?.sourceSnapshot?.sourcePaths?.length
        ? existingManifest.sourceSnapshot.sourcePaths
        : initialSnapshot.sourcePaths;
      const shouldReadSourceDocuments = sourcePaths.length > 0 && (
        initialSnapshot.items.length === 0
        || (
          typeof initialSnapshot.expectedItemCount === "number"
          && initialSnapshot.expectedItemCount !== initialSnapshot.items.length
        )
      );
      if (!shouldReadSourceDocuments) return taskText;

      const builtinTools = createBuiltinAgentTools(
        async () => true,
        this.askUser,
        {
          getCurrentQuery: () => taskText,
          scheduleClawHubResume: async () => undefined,
        },
      );
      const readDocumentTool = builtinTools.tools.find((tool) => tool.name === "read_document");
      if (!readDocumentTool) return taskText;

      const groundedSections: string[] = [];
      for (const sourcePath of sourcePaths.slice(0, 2)) {
        this.traceFlow("source_grounding_started", {
          task_id: this.currentTask?.id,
          phase: "source_grounding",
          preview: previewActorText(sourcePath),
        });
        try {
          const result = await readDocumentTool.execute({
            path: sourcePath,
            max_rows: 200,
          });
          if (typeof result === "string" && result.trim()) {
            groundedSections.push(`### 文件 ${sourcePath}\n${result.trim().slice(0, 12000)}`);
            this.traceFlow("source_grounding_completed", {
              task_id: this.currentTask?.id,
              phase: "source_grounding",
              preview: previewActorText(sourcePath),
            });
          } else {
            this.traceFlow("source_grounding_blocked", {
              task_id: this.currentTask?.id,
              phase: "source_grounding",
              preview: previewActorText(JSON.stringify(result)),
            });
          }
        } catch (error) {
          this.traceFlow("source_grounding_blocked", {
            task_id: this.currentTask?.id,
            phase: "source_grounding",
            preview: previewActorText(String(error)),
          });
        }
      }
      if (groundedSections.length === 0) return taskText;
      return [
        taskText,
        "",
        AUTO_SOURCE_GROUNDING_HEADER,
        groundedSections.join("\n\n"),
      ].join("\n");
    };
    const effectiveStructuredTaskText = !activeOwnerRecord
      ? await autoGroundSpreadsheetTaskText(query, contractStructuredDeliveryManifest ?? undefined)
      : query;
    const groundedStructuredDeliveryManifest = !activeOwnerRecord
      ? resolveStructuredDeliveryManifest(effectiveStructuredTaskText)
      : resolveStructuredDeliveryManifest(null);
    const structuredDeliveryManifest = !activeOwnerRecord
      ? (
          contractStructuredDeliveryManifest?.targets?.length
            ? contractStructuredDeliveryManifest
            : groundedStructuredDeliveryManifest
        )
      : groundedStructuredDeliveryManifest;
    const structuredDeliveryStrategyReferenceId = getStructuredDeliveryStrategyReferenceId(structuredDeliveryManifest);
    const structuredDeliveryStrategy = !activeOwnerRecord
      ? resolveStructuredDeliveryStrategyById(structuredDeliveryStrategyReferenceId)
      : null;
    const adapterExplicitlyEngaged = !activeOwnerRecord
      && isStructuredDeliveryAdapterEnabled(structuredDeliveryManifest);
    const hasPlannerOwnedStructuredDeliveryContext = !activeOwnerRecord && (
      contractStructuredDeliveryManifest?.source === "planner"
      || contractStructuredDeliveryManifest?.source === "runtime"
      || (
        Boolean(activeExecutionContract)
        && activeExecutionContract?.state !== "completed"
        && activeExecutionContract?.state !== "failed"
        && activeExecutionContract?.state !== "superseded"
      )
    );
    const hasExplicitStructuredDeliveryContext =
      !activeOwnerRecord
      && (adapterExplicitlyEngaged || hasPlannerOwnedStructuredDeliveryContext);
    const shouldApplyInitialStructuredDeliveryIsolation =
      hasExplicitStructuredDeliveryContext && structuredDeliveryManifest.applyInitialIsolation;
    const shouldSuggestStructuredDeliveryAdapter = hasExplicitStructuredDeliveryContext && (
      Boolean(structuredDeliveryStrategyReferenceId)
      || (structuredDeliveryManifest.targets?.length ?? 0) > 0
      || (structuredDeliveryManifest.resultSchema?.fields?.length ?? 0) > 0
      || (structuredDeliveryManifest.sourceSnapshot?.items.length ?? structuredDeliveryManifest.sourceSnapshot?.expectedItemCount ?? 0) > 0
      || structuredDeliveryManifest.deliveryContract !== "general"
    );
    const structuredDeliveryContract = structuredDeliveryManifest.deliveryContract;
    if (shouldSuggestStructuredDeliveryAdapter) {
      this.traceFlow("structured_delivery_guidance_enabled", {
        task_id: this.currentTask?.id,
        phase: "initial_orchestration",
        mode: shouldApplyInitialStructuredDeliveryIsolation ? "isolated" : "suggest_only",
        manifest_source: structuredDeliveryManifest.source,
        strategy_id: structuredDeliveryStrategyReferenceId,
        delivery_contract: structuredDeliveryContract,
        parent_contract: structuredDeliveryManifest.parentContract,
        preview: previewActorText(structuredDeliveryManifest.tracePreview ?? query),
      });
    }
    const initialStructuredDeliveryInstruction = shouldSuggestStructuredDeliveryAdapter
      ? buildStructuredDeliveryGuidanceBlock({
          manifest: structuredDeliveryManifest,
        })
      : "";
    const mergeActiveImages = (nextImages?: string[]) => {
      if (!nextImages?.length) return;
      for (const image of nextImages) {
        const normalized = String(image ?? "").trim();
        if (normalized) activeImageRefs.add(normalized);
      }
    };
    const structuredDispatchPlan = shouldSuggestStructuredDeliveryAdapter
      && !/(?:结构化子任务摘要|你派发的子任务现在都已经结束)/u.test(query)
      ? buildStructuredDispatchPlanFromContract({
        contract: activeExecutionContract,
        strategyId: structuredDeliveryStrategyReferenceId,
        deliveryContract: structuredDeliveryManifest.deliveryContract,
        parentContract: structuredDeliveryManifest.parentContract,
        tracePreview: structuredDeliveryManifest.tracePreview,
      }) ?? structuredDeliveryStrategy?.buildInitialDispatchPlan?.({
        taskText: effectiveStructuredTaskText,
        manifest: structuredDeliveryManifest,
      }) ?? null
      : null;
    const initialStructuredDispatchSuggestion = structuredDispatchPlan
      ? buildStructuredDispatchSuggestionBlock({
          dispatchPlan: structuredDispatchPlan,
        })
      : "";
    if (structuredDispatchPlan && this.actorSystem) {
      this.traceFlow("structured_dispatch_suggestion_prepared", {
        task_id: this.currentTask?.id,
        phase: "initial_orchestration",
        delivery_contract: structuredDispatchPlan.deliveryContract,
        parent_contract: structuredDispatchPlan.parentContract,
        count: structuredDispatchPlan.shards.length,
        preview: previewActorText(structuredDispatchPlan.tracePreview),
      });
    }
    const effectiveModelOverride = runOverrides?.model ?? this.modelOverride;
    const actorCount = this.actorSystem?.getAll().length ?? 0;
    const baselineMaxIterations = !this.hasExplicitMaxIterations
      && this.actorSystem
      && isLegacySingleDefaultDialogLead({
        roleName: this.role.name,
        capabilities: this._capabilities,
      }, actorCount)
      ? Math.max(this.maxIterations, 40)
      : this.maxIterations;
    const effectiveMaxIterations = resolveActorEffectiveMaxIterations({
      actorMaxIterations: baselineMaxIterations,
      actorHasExplicitMaxIterations: this.hasExplicitMaxIterations,
      globalConfiguredMaxIterations: useAIStore.getState().config.agent_max_iterations,
      runOverrideMaxIterations: runOverrides?.maxIterations,
    });
    const effectiveSystemPromptOverride = [
      this.systemPromptOverride ?? this.role.systemPrompt,
      initialStructuredDeliveryInstruction,
      initialStructuredDispatchSuggestion,
      runOverrides?.systemPromptAppend,
    ]
      .filter(Boolean)
      .join("\n\n") || undefined;
    const effectiveContextTokens = runOverrides?.contextTokens ?? this._contextTokens;
    const effectiveToolPolicy = mergeToolPolicies(
      this.toolPolicy,
      this.getDialogExecutionModeToolPolicy(),
      this.getDialogSubagentToolPolicy({
        activeOwnerRecord: Boolean(activeOwnerRecord),
      }),
      shouldApplyInitialStructuredDeliveryIsolation
        ? {
            allow: [...INITIAL_STRUCTURED_DELIVERY_ALLOWED_TOOL_NAMES],
            deny: [...INITIAL_STRUCTURED_DELIVERY_DENIED_TOOL_NAMES],
          }
        : undefined,
      runOverrides?.toolPolicy,
    );
    const effectiveExecutionPolicy = mergeExecutionPolicies(
      mergeExecutionPolicies(this._executionPolicy, this.getDialogExecutionModeExecutionPolicy()),
      runOverrides?.executionPolicy,
    );
    const effectiveMiddlewareOverrides = runOverrides?.middlewareOverrides ?? this._middlewareOverrides;
    const effectiveThinkingLevel = runOverrides?.thinkingLevel ?? this._thinkingLevel;
    const effectiveTemperature = runOverrides?.temperature
      ?? this.role.temperature
      ?? useAIStore.getState().config.temperature
      ?? 0.7;

    actorDebugLog(
      this.role.name,
      `runWithInbox: model=${effectiveModelOverride ?? "default"}, maxIter=${effectiveMaxIterations}, thinking=${effectiveThinkingLevel ?? "adaptive"}, inboxSize=${this.inbox.length}`,
    );
    actorInfoLog(this.role.name, "runWithInbox start", {
      actorId: this.id,
      model: effectiveModelOverride ?? "default",
      maxIterations: effectiveMaxIterations,
      thinkingLevel: effectiveThinkingLevel ?? "adaptive",
      inboxSize: this.inbox.length,
      imageCount: activeImageRefs.size,
      queryPreview: previewActorText(query),
    });
    ensureTaskStillActive();
    this.traceFlow("llm_round_started", {
      task_id: this.currentTask?.id,
      model: effectiveModelOverride ?? "default",
      count: 1,
      image_count: activeImageRefs.size,
      preview: previewActorText(query),
    });

    const ctx: ActorRunContext = {
      query,
      images,
      getCurrentImages: () => (activeImageRefs.size > 0 ? [...activeImageRefs] : undefined),
      onStep,
      actorId: this.id,
      role: this.role,
      modelOverride: effectiveModelOverride,
      maxIterations: effectiveMaxIterations,
      systemPromptOverride: effectiveSystemPromptOverride,
      workspace: this._workspace,
      contextTokens: effectiveContextTokens,
      toolPolicy: effectiveToolPolicy,
      executionPolicy: effectiveExecutionPolicy,
      executionMode: this._dialogExecutionMode,
      actorSystem: this.actorSystem,
      askUser: this.askUser,
      confirmDangerousAction: this.confirmDangerousAction,
      extraTools: this.extraTools,
      middlewareOverrides: effectiveMiddlewareOverrides,
      tools: [],
      rolePrompt: "",
      hasCodingWorkflowSkill: false,
      fcCompatibilityKey: "",
      contextMessages: this.buildContextMessages(),
    };

    await runMiddlewareChain(createDefaultMiddlewares({
      isSubagent: Boolean(activeOwnerRecord),
    }), ctx);
    ensureTaskStillActive();
    actorInfoLog(this.role.name, "runWithInbox middleware completed", {
      actorId: this.id,
      toolCount: ctx.tools.length,
      contextMessageCount: ctx.contextMessages.length,
      hasSkillsPrompt: Boolean(ctx.skillsPrompt),
      hasMemoryPrompt: Boolean(ctx.userMemoryPrompt),
    });
    this._lastMemoryRecallAttempted = ctx.memoryRecallAttempted === true;
    this._lastMemoryRecallPreview = [...(ctx.appliedMemoryPreview ?? [])];
    this._lastTranscriptRecallAttempted = ctx.transcriptRecallAttempted === true;
    this._lastTranscriptRecallHitCount = Math.max(0, ctx.transcriptRecallHitCount ?? 0);
    this._lastTranscriptRecallPreview = [...(ctx.appliedTranscriptPreview ?? [])];

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const ai = getMToolsAI(this.actorSystem?.defaultProductMode ?? "dialog");

    const agent = new ReActAgent(
      ai,
      ctx.tools,
      {
        maxIterations: effectiveMaxIterations,
        verbose: true,
        onTraceEvent: (event, detail) => {
          if (isTaskActive?.() === false) return;
          this.traceFlow(event, {
            task_id: this.currentTask?.id,
            ...(detail ?? {}),
          });
        },
        fcCompatibilityKey: ctx.fcCompatibilityKey,
        temperature: effectiveTemperature,
        initialMode: "execute",
        userMemoryPrompt: ctx.userMemoryPrompt,
      skillsPrompt: ctx.skillsPrompt,
      skipInternalCodingBlock: ctx.hasCodingWorkflowSkill,
      roleOverride: ctx.rolePrompt || undefined,
      dangerousToolPatterns: ["write_file", "run_shell_command", "native_"],
      confirmDangerousAction: this.confirmDangerousAction,
        onToolExecuted: ctx.notifyToolCalled,
      modelOverride: effectiveModelOverride,
      thinkingLevel: effectiveThinkingLevel,
      contextBudget: effectiveContextTokens,
      contextMessages: ctx.contextMessages,
      patchDanglingToolCalls: ctx.patchDanglingToolCalls === true,
      loopDetection: ctx.loopDetectionConfig,
      authoritativeToolList: true,
      inboxDrain: () => {
          if (isTaskActive?.() === false) return [];
          const drained = this.drainInbox();
          if (drained.length > 0) {
            actorDebugLog(this.role.name, `inboxDrain: ${drained.length} messages drained`);
            drained.forEach((message) => mergeActiveImages(message.images));
            if (!this._capturedInboxUserQuery) {
              const userMsgs = drained.filter((m) => m.from === "user");
              if (userMsgs.length > 0) {
                this._capturedInboxUserQuery = userMsgs.map((m) => m.content).join("\n\n");
              }
            }
          }
          return drained.map((m) => ({
            ...m,
            from: (m.from === "user") ? "用户" : (this.actorSystem?.get(m.from)?.role.name ?? m.from),
          }));
        },
      },
      (step) => {
        if (isTaskActive?.() === false) return;
        onStep?.(step);
      },
    );
    const visibleToolNames = agent.listVisibleToolNames();
    this.traceFlow("tool_policy_snapshot", {
      task_id: this.currentTask?.id,
      count: visibleToolNames.length,
      allowed_tool_count: visibleToolNames.length,
      manifest_source: !activeOwnerRecord ? structuredDeliveryManifest.source : undefined,
      strategy_id: !activeOwnerRecord ? structuredDeliveryManifest.strategyId : undefined,
      recommended_strategy_id: !activeOwnerRecord ? structuredDeliveryManifest.recommendedStrategyId : undefined,
      delivery_contract: structuredDeliveryContract,
      task_contract: activeOwnerRecord ? "child_partial" : "parent_final",
      child_contract: activeOwnerRecord?.executionIntent === "content_executor"
        ? "structured_partial"
        : activeOwnerRecord?.executionIntent,
      parent_contract: !activeOwnerRecord
        ? structuredDeliveryManifest.parentContract
        : undefined,
      tool_policy_source: activeOwnerRecord?.executionIntent
        ? activeOwnerRecord.workerProfileId
          ? `${activeOwnerRecord.workerProfileId}_profile`
          : `${activeOwnerRecord.executionIntent}_intent`
        : shouldApplyInitialStructuredDeliveryIsolation
          ? "strict_orchestration"
          : "actor_runtime",
      worker_profile: activeOwnerRecord?.workerProfileId,
      execution_intent: activeOwnerRecord?.executionIntent,
      status: activeOwnerRecord?.roleBoundary ?? undefined,
      preview: previewActorText(visibleToolNames.slice(0, 12).join(", "), 160),
    });

    let llmAttempt = 0;
    try {
      actorInfoLog(this.role.name, "runWithInbox invoking llm", {
        actorId: this.id,
        model: effectiveModelOverride ?? "default",
        toolCount: ctx.tools.length,
        hasRetry: Boolean(ctx.withRetry && ctx.retryConfig),
        imageCount: activeImageRefs.size,
        queryPreview: previewActorText(query),
      });
      const invokeAgent = async () => {
        llmAttempt += 1;
        if (llmAttempt > 1) {
          this.traceFlow("llm_retry", {
            task_id: this.currentTask?.id,
            count: llmAttempt - 1,
            model: effectiveModelOverride ?? "default",
          });
        }
        return agent.run(query, signal, images);
      };
      if (ctx.withRetry && ctx.retryConfig) {
        const retryConf = ctx.retryConfig as Required<typeof ctx.retryConfig>;
        const answer = await ctx.withRetry(() => invokeAgent(), retryConf, `LLM call for ${this.role.name}`);
        ensureTaskStillActive();
        actorInfoLog(this.role.name, "runWithInbox llm completed", {
          actorId: this.id,
          answerPreview: previewActorText(answer),
        });
        this.traceFlow("llm_round_completed", {
          task_id: this.currentTask?.id,
          model: effectiveModelOverride ?? "default",
          status: "completed",
          count: llmAttempt,
          preview: previewActorText(answer),
        });
        return answer;
      }
      const answer = await invokeAgent();
      ensureTaskStillActive();
      actorInfoLog(this.role.name, "runWithInbox llm completed", {
        actorId: this.id,
        answerPreview: previewActorText(answer),
      });
      this.traceFlow("llm_round_completed", {
        task_id: this.currentTask?.id,
        model: effectiveModelOverride ?? "default",
        status: "completed",
        count: llmAttempt,
        preview: previewActorText(answer),
      });
      return answer;
    } catch (error) {
      if (error instanceof WaitForSpawnedTasksInterrupt) {
        actorInfoLog(this.role.name, "runWithInbox deferred to spawned-task wait", {
          actorId: this.id,
          pendingSummary: error.summary,
        });
        this.traceFlow("llm_round_completed", {
          task_id: this.currentTask?.id,
          model: effectiveModelOverride ?? "default",
          status: "spawn_wait",
          count: llmAttempt,
          preview: previewActorText(error.summary ?? "等待子任务结果"),
        });
        return WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT;
      }
      actorErrorLog(this.role.name, "runWithInbox llm failed", {
        actorId: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.traceFlow("llm_failed", {
        task_id: this.currentTask?.id,
        model: effectiveModelOverride ?? "default",
        status: "failed",
        preview: previewActorText(error instanceof Error ? error.message : String(error)),
      });
      const recovered = allowContextRecovery
        ? await this.tryRecoverDialogContextPressure(query, onStep, error)
        : false;
      if (recovered) {
        this.traceFlow("llm_retry", {
          task_id: this.currentTask?.id,
          model: effectiveModelOverride ?? "default",
          status: "context_recovered",
        });
        return this.runWithInbox(query, activeImageRefs.size > 0 ? [...activeImageRefs] : images, onStep, runOverrides, false);
      }
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  private async tryRecoverDialogContextPressure(
    query: string,
    onStep: ((step: AgentStep) => void) | undefined,
    error: unknown,
  ): Promise<boolean> {
    if (!this.actorSystem) return false;
    if (!isDialogContextPressureError(error)) return false;

    const recoveredCompaction = await recoverDialogRoomCompactionFromContextPressure(this.actorSystem)
      .catch(() => null);
    if (!recoveredCompaction) return false;

    const reasonText = (recoveredCompaction.triggerReasons ?? [])
      .slice(0, 2)
      .join("；");
    onStep?.({
      type: "observation",
      content:
        `检测到当前 Dialog 房间上下文压力过大，已自动压缩较早历史并保留续跑线索${reasonText ? `（${reasonText}）` : ""}，准备基于新摘要重试一次。`,
      toolName: "dialog_room_compaction",
      timestamp: Date.now(),
    });
    actorWarnLog(this.role.name, "runWithInbox: recovered from dialog context pressure", {
      queryPreview: query.slice(0, 120),
      compactedMessageCount: recoveredCompaction.compactedMessageCount,
      compactedSpawnedTaskCount: recoveredCompaction.compactedSpawnedTaskCount,
      compactedArtifactCount: recoveredCompaction.compactedArtifactCount,
    });
    return true;
  }
}
