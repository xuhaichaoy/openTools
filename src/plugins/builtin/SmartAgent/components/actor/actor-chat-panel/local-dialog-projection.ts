import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { DialogFlowTraceEvent, DialogMessage } from "@/core/agent/actor/types";
import { buildToolStreamingPreview } from "./StreamingBlocks";

const TASK_RESULT_PREFIX = /^\[Task (completed|failed|timeout):/i;
const INLINE_SUBTASK_PREFIX = /^\[子任务\]/u;
const INLINE_SPAWN_PAYLOAD_PATTERNS = [
  /(?:^|\n)\s*派发(?:\s+\S+)?\s*子任务/u,
  /"target_agent"\s*:/u,
  /"create_if_missing"\s*:/u,
  /"agent_capabilities"\s*:/u,
  /"override_system_prompt_append"\s*:/u,
  /"timeout_seconds"\s*:/u,
];
const PLANNING_HEADER_PATTERN = /(执行计划|行动计划|实施计划|任务拆解|Execution Plan)/i;
const PLANNING_MARKERS = [
  /(?:^|\n)\s*(?:步骤\s*[0-9一二三四五六七八九十]+|Step\s*\d+)\s*[:：]/i,
  /(?:^|\n)\s*(?:工具|Tools?)\s*[:：]/i,
  /(?:^|\n)\s*(?:目的|目标|依赖|前置|Dependencies?|产出|输出)\s*[:：]/i,
  /(?:^|\n)\s*\d+\.\s*(?:第\s*\d+\s*步|Step\s*\d+|收集|分析|执行|验证|整理|检查)/i,
  /各步骤之间的依赖关系/,
];
const COLLABORATION_SUMMARY_MARKERS = [
  /已确认源文件/u,
  /已完成\s*\d+\s*个(?:分段|子)?任务/u,
  /当前(?:真实)?缺口|剩余缺口|尚缺|补未齐/u,
  /产物位置[:：]/u,
  /建议作为正式交付说明/u,
  /历史文档产物/u,
  /已收到详细文本/u,
  /仅确认完成状态/u,
  /wait_for_spawned_tasks|memory_search|agents/u,
];
const STRUCTURED_RESULT_KEYS = new Set([
  "tasks",
  "results",
  "rows",
  "items",
  "data",
  "artifacts",
  "task_tree",
  "agents",
  "structured_rows",
  "source_item_ids",
  "scoped_source_items",
  "schema_fields",
  "columns",
]);
const LOW_SIGNAL_CONTINUATION_TOOL_NAMES = new Set([
  "sequential_thinking",
]);
const LOW_SIGNAL_COLLABORATION_MESSAGE_PATTERNS = [
  /命令执行完成[，,、]?\s*分析输出/u,
  /搜索完成[，,、]?\s*分析结果/u,
  /已同步(?:子任务结果|协作状态)/u,
  /子任务(?:运行中|已收齐|已全部完成)/u,
  /协作状态已同步/u,
  /返回\s*\d+\s*条结果/u,
  /返回\s*\d+\s*个字段/u,
];
const REPAIR_CONTINUATION_PATTERNS = [
  /纠偏|修复|repair|blocker|未通过结果校验/u,
  /重新导出|补齐交付|再次导出/u,
];
const PUBLISHED_CONTINUATION_PATTERNS = [
  /最终产物|文件路径|保存到|导出为|已创建|已生成|已修改|验证通过|测试通过|构建通过|真实缺口|阻塞原因|无法完成/u,
  /\/[^\s"'`]+\.(?:tsx?|jsx?|vue|html|css|scss|less|json|rs|py|go|java|kt|swift|md|docx?|pdf|xlsx?|csv|pptx?)/i,
];

export type LocalDialogContinuationPhase =
  | "waiting_children"
  | "aggregating"
  | "repairing"
  | "published";

export type LocalDialogHostMilestoneKind =
  | "aggregation_started"
  | "repair_started"
  | "repair_completed"
  | "export_blocked"
  | "export_started"
  | "export_succeeded";

export interface LocalDialogHostMilestone {
  id: string;
  kind: LocalDialogHostMilestoneKind;
  timestamp: number;
  summary: string;
  artifactPath?: string;
}

export interface LocalDialogLiveContinuationState {
  latestOrchestrationIndex: number;
  latestContinuationIndex: number;
  latestContinuationTimestamp?: number;
  latestContinuationPreview?: string;
  isContinuingAfterOrchestration: boolean;
  phase?: LocalDialogContinuationPhase;
  hostMilestones?: LocalDialogHostMilestone[];
}

function compactProjectionText(value: string | undefined, maxLength = 160): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function findLastStepIndex(
  steps: readonly AgentStep[],
  predicate: (step: AgentStep) => boolean,
): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && predicate(step)) return index;
  }
  return -1;
}

function isOrchestrationAction(step: AgentStep): boolean {
  return step.type === "action"
    && (
      step.toolName === "spawn_task"
      || step.toolName === "wait_for_spawned_tasks"
      || step.toolName === "agents"
    );
}

function isSpawnStreamingStep(step: AgentStep): boolean {
  return step.type === "tool_streaming" && buildToolStreamingPreview(step.content).kind === "spawn";
}

function isPureOrchestrationObservation(content: string | undefined): boolean {
  const normalized = String(content ?? "").trim();
  if (!normalized || (!normalized.startsWith("{") && !normalized.startsWith("["))) {
    return false;
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.pending_count === "number"
      && typeof value.completed_count === "number"
      && typeof value.failed_count === "number"
      && Array.isArray(value.tasks)
    ) {
      return true;
    }
    return Array.isArray(value.agents) && Array.isArray(value.task_tree);
  } catch {
    return false;
  }
}

function extractStructuredPayloadCandidate(content: string | undefined): string | undefined {
  const normalized = String(content ?? "").trim();
  if (!normalized) return undefined;
  const codeBlockMatch = normalized.match(/^```(?:json)?\s*([\s\S]*?)```$/iu);
  if (codeBlockMatch?.[1]?.trim()) return codeBlockMatch[1].trim();
  if (normalized.startsWith("{") || normalized.startsWith("[")) return normalized;
  return undefined;
}

function parseStructuredPayload(content: string | undefined): unknown {
  const candidate = extractStructuredPayloadCandidate(content);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function parseStructuredObject(content: string | undefined): Record<string, unknown> | null {
  const parsed = parseStructuredPayload(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function isLowSignalStructuredReasoning(content: string | undefined): boolean {
  const parsed = parseStructuredObject(content);
  if (!parsed) return false;
  return typeof parsed.thought_number === "number"
    && typeof parsed.total_thoughts === "number"
    && "next_thought_needed" in parsed;
}

function isLiveContinuationStep(step: AgentStep): boolean {
  if (step.type === "answer") {
    return Boolean(step.streaming && step.content?.trim());
  }
  if (step.type === "thinking" || step.type === "thought") {
    return Boolean(step.content?.trim());
  }
  if (step.type === "tool_streaming") {
    return buildToolStreamingPreview(step.content).kind !== "spawn";
  }
  if (step.type === "action") {
    if (step.toolName && LOW_SIGNAL_CONTINUATION_TOOL_NAMES.has(step.toolName)) {
      return false;
    }
    return !isOrchestrationAction(step);
  }
  if (step.type === "observation" || step.type === "error") {
    if (step.toolName && LOW_SIGNAL_CONTINUATION_TOOL_NAMES.has(step.toolName)) {
      return false;
    }
    return Boolean(step.content?.trim())
      && !isPureOrchestrationObservation(step.content)
      && !isLowSignalStructuredReasoning(step.content);
  }
  return false;
}

function getLiveContinuationPreview(step: AgentStep | undefined): string | undefined {
  if (!step) return undefined;
  if (step.type === "tool_streaming") {
    const preview = buildToolStreamingPreview(step.content);
    return preview.kind === "spawn"
      ? undefined
      : compactProjectionText(`${preview.title} ${preview.body}`.trim());
  }
  return compactProjectionText(step.content);
}

function extractPathFromText(value: string | undefined, extensions?: readonly string[]): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  const extensionPattern = extensions?.length
    ? extensions.map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    : "[A-Za-z0-9]+";
  const pattern = new RegExp(`\\/[^\\s"'\\\`]+\\.(?:${extensionPattern})\\b`, "i");
  return normalized.match(pattern)?.[0];
}

function extractSpreadsheetExportTarget(step: AgentStep): string | undefined {
  if (!step.toolInput) return undefined;
  const outputPath = typeof step.toolInput.outputPath === "string" ? step.toolInput.outputPath.trim() : "";
  if (outputPath) return outputPath;
  const fileName = typeof step.toolInput.file_name === "string" ? step.toolInput.file_name.trim() : "";
  return fileName || undefined;
}

function extractSpreadsheetExportPath(step: AgentStep): string | undefined {
  if (typeof step.toolOutput === "string") {
    const fromOutput = extractPathFromText(step.toolOutput, ["xlsx", "xls", "csv"]);
    if (fromOutput) return fromOutput;
  }
  if (step.toolOutput && typeof step.toolOutput === "object") {
    const output = step.toolOutput as { path?: unknown; message?: unknown };
    if (typeof output.path === "string" && output.path.trim()) {
      return output.path.trim();
    }
    if (typeof output.message === "string") {
      const fromMessage = extractPathFromText(output.message, ["xlsx", "xls", "csv"]);
      if (fromMessage) return fromMessage;
    }
  }
  return extractPathFromText(step.content, ["xlsx", "xls", "csv"]);
}

function pushHostMilestone(
  milestones: LocalDialogHostMilestone[],
  seenKeys: Set<string>,
  milestone: LocalDialogHostMilestone | null,
): void {
  if (!milestone) return;
  const key = `${milestone.kind}:${milestone.summary}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  milestones.push(milestone);
}

function buildLocalDialogHostMilestones(
  steps: readonly AgentStep[],
  latestOrchestrationIndex: number,
): LocalDialogHostMilestone[] {
  if (latestOrchestrationIndex < 0) return [];
  const milestones: LocalDialogHostMilestone[] = [];
  const seenKeys = new Set<string>();
  let sawRepair = false;

  steps.slice(latestOrchestrationIndex + 1).forEach((step, index) => {
    const normalizedContent = String(step.content ?? "").trim();
    if (
      normalizedContent
      && (step.type === "observation" || step.type === "error" || step.type === "answer")
      && REPAIR_CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalizedContent))
    ) {
      sawRepair = true;
      pushHostMilestone(milestones, seenKeys, {
        id: `repair-started-${step.timestamp}-${index}`,
        kind: "repair_started",
        timestamp: step.timestamp,
        summary: `进入修复轮：${compactProjectionText(normalizedContent, 140) ?? "正在修复缺口并准备重新导出。"}`,
      });
      return;
    }

    if (step.type === "action" && step.toolName === "export_spreadsheet") {
      const target = extractSpreadsheetExportTarget(step) ?? "最终工作簿";
      pushHostMilestone(milestones, seenKeys, {
        id: `export-started-${step.timestamp}-${index}`,
        kind: "export_started",
        timestamp: step.timestamp,
        summary: `${sawRepair ? "开始重试导出工作簿" : "开始导出工作簿"}：${compactProjectionText(target, 120) ?? "最终工作簿"}`,
      });
      return;
    }

    if (step.toolName === "export_spreadsheet" && (step.type === "observation" || step.type === "answer")) {
      const exportPath = extractSpreadsheetExportPath(step);
      if (!exportPath) return;
      pushHostMilestone(milestones, seenKeys, {
        id: `export-succeeded-${step.timestamp}-${index}`,
        kind: "export_succeeded",
        timestamp: step.timestamp,
        artifactPath: exportPath,
        summary: `${sawRepair ? "重试导出成功" : "导出成功"}：${compactProjectionText(exportPath, 140) ?? exportPath}`,
      });
    }
  });

  return milestones.sort((left, right) => left.timestamp - right.timestamp);
}

export function buildLocalDialogHostMilestonesFromTraceEvents(
  events: readonly DialogFlowTraceEvent[] = [],
): LocalDialogHostMilestone[] {
  const sortedEvents = [...events].sort((left, right) => left.timestamp - right.timestamp);
  const milestones: LocalDialogHostMilestone[] = [];
  const seenKeys = new Set<string>();
  let sawRepair = false;

  sortedEvents.forEach((event, index) => {
    const detail = event.detail ?? {};
    if (event.event === "aggregation_started" || event.event === "final_synthesis_started") {
      const count = typeof detail.count === "number" ? detail.count : undefined;
      pushHostMilestone(milestones, seenKeys, {
        id: `trace-aggregation-started-${event.timestamp}-${index}`,
        kind: "aggregation_started",
        timestamp: event.timestamp,
        summary: count && count > 0
          ? `开始汇总子任务结果：当前聚合 ${count} 个结构化结果。`
          : "开始汇总子任务结果。",
      });
      return;
    }

    if (event.event === "host_export_blocked") {
      const preview = compactProjectionText(typeof detail.preview === "string" ? detail.preview : undefined, 140);
      const status = typeof detail.status === "string" ? detail.status : "";
      const prefix = status === "blocked"
        ? "导出被质量门禁拦截"
        : "导出暂时受阻";
      pushHostMilestone(milestones, seenKeys, {
        id: `trace-export-blocked-${event.timestamp}-${index}`,
        kind: "export_blocked",
        timestamp: event.timestamp,
        summary: `${prefix}：${preview ?? "等待修复后继续导出。"}`,
      });
      return;
    }

    if (event.event === "repair_started" || event.event === "validation_repair_started" || event.event === "repair_round_started") {
      sawRepair = true;
      const acceptedCount = typeof detail.accepted_count === "number" ? detail.accepted_count : undefined;
      const preview = compactProjectionText(typeof detail.preview === "string" ? detail.preview : undefined, 140);
      const summary = preview
        ? `进入修复轮：${preview}`
        : typeof acceptedCount === "number" && acceptedCount > 0
          ? `进入修复轮：系统正在补派 ${acceptedCount} 个 repair shards。`
          : "进入修复轮：正在修复缺口并准备重新导出。";
      pushHostMilestone(milestones, seenKeys, {
        id: `trace-repair-${event.timestamp}-${index}`,
        kind: "repair_started",
        timestamp: event.timestamp,
        summary,
      });
      return;
    }

    if (
      event.event === "repair_completed"
      || event.event === "validation_repair_completed"
      || event.event === "repair_round_completed"
    ) {
      const preview = compactProjectionText(typeof detail.preview === "string" ? detail.preview : undefined, 140);
      pushHostMilestone(milestones, seenKeys, {
        id: `trace-repair-completed-${event.timestamp}-${index}`,
        kind: "repair_completed",
        timestamp: event.timestamp,
        summary: `修复轮完成：${preview ?? "已完成补齐并返回主协调继续处理。"}`,
      });
      return;
    }

    if (
      event.event === "tool_call_started"
      && detail.phase === "host_export"
      && detail.tool === "export_spreadsheet"
    ) {
      const preview = compactProjectionText(typeof detail.preview === "string" ? detail.preview : undefined, 120) ?? "最终工作簿";
      pushHostMilestone(milestones, seenKeys, {
        id: `trace-export-started-${event.timestamp}-${index}`,
        kind: "export_started",
        timestamp: event.timestamp,
        summary: `${sawRepair ? "开始重试导出工作簿" : "开始导出工作簿"}：${preview}`,
      });
      return;
    }

    if (event.event === "host_export_completed") {
      const preview = compactProjectionText(typeof detail.preview === "string" ? detail.preview : undefined, 140);
      const artifactPath = extractPathFromText(preview, ["xlsx", "xls", "csv"]);
      pushHostMilestone(milestones, seenKeys, {
        id: `trace-export-succeeded-${event.timestamp}-${index}`,
        kind: "export_succeeded",
        timestamp: event.timestamp,
        artifactPath,
        summary: `${sawRepair ? "重试导出成功" : "导出成功"}：${preview ?? artifactPath ?? "最终工作簿"}`,
      });
    }
  });

  return milestones.sort((left, right) => left.timestamp - right.timestamp);
}

export function mergeLocalDialogHostMilestones(
  ...groups: Array<readonly LocalDialogHostMilestone[] | undefined>
): LocalDialogHostMilestone[] {
  const milestones: LocalDialogHostMilestone[] = [];
  const seenKeys = new Set<string>();
  groups.forEach((group) => {
    group?.forEach((milestone) => {
      pushHostMilestone(milestones, seenKeys, {
        ...milestone,
        artifactPath: milestone.artifactPath,
      });
    });
  });
  return milestones.sort((left, right) => left.timestamp - right.timestamp);
}

function deriveContinuationPhaseFromHostMilestones(
  hostMilestones: readonly LocalDialogHostMilestone[],
  fallback?: LocalDialogContinuationPhase,
): LocalDialogContinuationPhase | undefined {
  const latestHostMilestone = hostMilestones[hostMilestones.length - 1];
  if (!latestHostMilestone) return fallback;
  const hasRepairStarted = hostMilestones.some((milestone) => milestone.kind === "repair_started");
  if (latestHostMilestone.kind === "export_succeeded") {
    return "published";
  }
  if (latestHostMilestone.kind === "repair_started") {
    return "repairing";
  }
  if (
    latestHostMilestone.kind === "export_started"
    || latestHostMilestone.kind === "export_blocked"
    || latestHostMilestone.kind === "aggregation_started"
  ) {
    return hasRepairStarted ? "repairing" : "aggregating";
  }
  if (latestHostMilestone.kind === "repair_completed") {
    return hasRepairStarted ? "repairing" : "aggregating";
  }
  return fallback;
}

function detectContinuationPhase(params: {
  latestOrchestrationIndex: number;
  latestContinuationIndex: number;
  latestContinuationStep?: AgentStep;
  hostMilestones: readonly LocalDialogHostMilestone[];
}): LocalDialogContinuationPhase | undefined {
  if (params.latestOrchestrationIndex < 0) return undefined;
  if (params.latestContinuationIndex <= params.latestOrchestrationIndex) {
    return "waiting_children";
  }
  const hostDrivenPhase = deriveContinuationPhaseFromHostMilestones(params.hostMilestones);
  if (hostDrivenPhase) {
    return hostDrivenPhase;
  }
  const step = params.latestContinuationStep;
  const content = String(step?.content ?? "").trim();
  if (content) {
    if (REPAIR_CONTINUATION_PATTERNS.some((pattern) => pattern.test(content))) {
      return "repairing";
    }
    if (step?.type === "answer" && !step.streaming && PUBLISHED_CONTINUATION_PATTERNS.some((pattern) => pattern.test(content))) {
      return "published";
    }
  }
  return "aggregating";
}

function resolveLatestContinuationProjection(params: {
  latestContinuationStep?: AgentStep;
  hostMilestones: readonly LocalDialogHostMilestone[];
}): {
  latestContinuationTimestamp?: number;
  latestContinuationPreview?: string;
} {
  const latestStepTimestamp = params.latestContinuationStep?.timestamp;
  const latestStepPreview = getLiveContinuationPreview(params.latestContinuationStep);
  const latestHostMilestone = params.hostMilestones[params.hostMilestones.length - 1];
  if (!latestHostMilestone) {
    return {
      latestContinuationTimestamp: latestStepTimestamp,
      latestContinuationPreview: latestStepPreview,
    };
  }
  if (!latestStepTimestamp || latestHostMilestone.timestamp >= latestStepTimestamp) {
    return {
      latestContinuationTimestamp: latestHostMilestone.timestamp,
      latestContinuationPreview: latestHostMilestone.summary,
    };
  }
  return {
    latestContinuationTimestamp: latestStepTimestamp,
    latestContinuationPreview: latestStepPreview,
  };
}

export function getLocalDialogLiveContinuationState(
  steps: readonly AgentStep[] = [],
): LocalDialogLiveContinuationState {
  const latestOrchestrationIndex = Math.max(
    findLastStepIndex(steps, isOrchestrationAction),
    findLastStepIndex(steps, isSpawnStreamingStep),
  );
  const latestContinuationIndex = findLastStepIndex(steps, isLiveContinuationStep);
  const latestContinuationStep = latestContinuationIndex >= 0
    ? steps[latestContinuationIndex]
    : undefined;
  const hostMilestones = buildLocalDialogHostMilestones(steps, latestOrchestrationIndex);
  const latestContinuationProjection = resolveLatestContinuationProjection({
    latestContinuationStep,
    hostMilestones,
  });

  return {
    latestOrchestrationIndex,
    latestContinuationIndex,
    latestContinuationTimestamp: latestContinuationProjection.latestContinuationTimestamp,
    latestContinuationPreview: latestContinuationProjection.latestContinuationPreview,
    isContinuingAfterOrchestration: latestContinuationIndex > latestOrchestrationIndex,
    phase: detectContinuationPhase({
      latestOrchestrationIndex,
      latestContinuationIndex,
      latestContinuationStep,
      hostMilestones,
    }),
    hostMilestones,
  };
}

export function mergeLocalDialogLiveContinuationStateWithTraceEvents(
  state: LocalDialogLiveContinuationState,
  traceEvents: readonly DialogFlowTraceEvent[] = [],
): LocalDialogLiveContinuationState {
  const traceMilestones = buildLocalDialogHostMilestonesFromTraceEvents(traceEvents);
  if (traceMilestones.length === 0) return state;
  const mergedHostMilestones = mergeLocalDialogHostMilestones(state.hostMilestones, traceMilestones);
  const latestHostMilestone = mergedHostMilestones[mergedHostMilestones.length - 1];
  const latestTimestamp = state.latestContinuationTimestamp ?? 0;
  const useHostProjection = Boolean(latestHostMilestone && latestHostMilestone.timestamp >= latestTimestamp);
  const mergedPhase = deriveContinuationPhaseFromHostMilestones(mergedHostMilestones, state.phase);

  return {
    ...state,
    latestContinuationTimestamp: useHostProjection
      ? latestHostMilestone?.timestamp
      : state.latestContinuationTimestamp,
    latestContinuationPreview: useHostProjection
      ? latestHostMilestone?.summary
      : state.latestContinuationPreview,
    isContinuingAfterOrchestration: state.isContinuingAfterOrchestration || mergedHostMilestones.length > 0,
    phase: mergedPhase,
    hostMilestones: mergedHostMilestones,
  };
}

export function shouldHideLocalDialogStreamingAnswer(
  content: string | null | undefined,
): boolean {
  const normalized = content?.trim();
  if (!normalized) return false;
  if (INLINE_SUBTASK_PREFIX.test(normalized)) return true;
  const inlineSpawnSignalCount = INLINE_SPAWN_PAYLOAD_PATTERNS.filter((pattern) => pattern.test(normalized)).length;
  if (
    inlineSpawnSignalCount >= 2
    || (inlineSpawnSignalCount >= 1 && normalized.includes("{") && normalized.includes("}"))
  ) {
    return true;
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return false;

  let score = 0;
  if (PLANNING_HEADER_PATTERN.test(lines[0] ?? "")) {
    score += 3;
  }

  for (const pattern of PLANNING_MARKERS) {
    if (pattern.test(normalized)) score += 1;
  }

  const stepLineCount = lines.filter((line) =>
    /^(?:[-*]\s*)?(?:步骤\s*[0-9一二三四五六七八九十]+|Step\s*\d+|\d+\.)/.test(line)
  ).length;

  if (stepLineCount >= 2) {
    score += 2;
  }

  if (score >= 4) return true;
  return score >= 3 && normalized.length <= 1200;
}

export function shouldRenderLocalDialogStreamingAnswer(params: {
  content: string | null | undefined;
  streamingAnswerIndex: number;
  latestBlockingLiveIndex: number;
}): boolean {
  const normalized = params.content?.trim();
  if (!normalized) return false;
  return params.streamingAnswerIndex >= params.latestBlockingLiveIndex;
}

function isLikelyCollaborationSummary(content: string): boolean {
  const normalized = content.trim();
  if (normalized.length < 120) return false;

  let score = 0;
  for (const pattern of COLLABORATION_SUMMARY_MARKERS) {
    if (pattern.test(normalized)) score += 1;
  }

  const numberedSectionCount = (normalized.match(/(?:^|\n)\s*[一二三四五六七八九十]+、/g) ?? []).length;
  if (numberedSectionCount >= 3) score += 2;

  const checklistCount = (normalized.match(/(?:^|\n)\s*(?:主题|步骤|工具|依赖|输出|结论)[:：]/g) ?? []).length;
  if (checklistCount >= 3) score += 1;

  return score >= 4;
}

function isLikelyStructuredCoordinatorPayload(content: string | undefined): boolean {
  const normalized = String(content ?? "").trim();
  if (!normalized) return false;

  const parsed = parseStructuredPayload(normalized);
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return false;
    if (normalized.length >= 180) return true;
    return parsed.some((item) => Array.isArray(item) || (item && typeof item === "object"));
  }

  if (parsed && typeof parsed === "object") {
    const value = parsed as Record<string, unknown>;
    if (isPureOrchestrationObservation(normalized)) return true;
    if (Object.keys(value).some((key) => STRUCTURED_RESULT_KEYS.has(key))) return true;

    const nestedStructuredValueCount = Object.values(value)
      .filter((item) => Array.isArray(item) || (item && typeof item === "object"))
      .length;
    if (nestedStructuredValueCount >= 2) return true;

    if (normalized.length >= 220 && Object.keys(value).length >= 4) return true;
  }

  return normalized.length >= 240
    && (/^```(?:json)?/iu.test(normalized) || normalized.startsWith("{") || normalized.startsWith("["));
}

function isLowSignalCollaborationCoordinatorMessage(content: string | undefined): boolean {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 180) return false;
  return LOW_SIGNAL_COLLABORATION_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function shouldHideLocalDialogMessage(message: Pick<
  DialogMessage,
  "from" | "to" | "content" | "relatedRunId" | "expectReply" | "kind"
>, options?: {
  hasCollaborationGroups?: boolean;
}): boolean {
  if (message.from === "user") return false;
  if (message.expectReply) return false;
  if (message.kind === "approval_request" || message.kind === "clarification_request") return false;
  if (message.relatedRunId) return true;
  if (options?.hasCollaborationGroups) {
    if (/^spawned-/i.test(message.from)) return true;
    if (message.to && message.to !== "user") return true;
    if (
      (message.kind === "agent_result" || message.kind === "agent_message" || message.kind === "system_notice")
      && (
        isLikelyCollaborationSummary(message.content)
        || isLikelyStructuredCoordinatorPayload(message.content)
        || isLowSignalCollaborationCoordinatorMessage(message.content)
      )
    ) {
      return true;
    }
  }
  return TASK_RESULT_PREFIX.test(message.content);
}

export function shouldPreferLocalDialogContinuationSummary(params: {
  hasCollaborationGroups: boolean;
  continuationState?: LocalDialogLiveContinuationState;
}): boolean {
  if (!params.hasCollaborationGroups) return false;
  const state = params.continuationState;
  if (!state || state.latestOrchestrationIndex < 0) return false;
  return state.isContinuingAfterOrchestration;
}

export function getLocalDialogContinuationSummaryLabel(
  phase?: LocalDialogContinuationPhase,
): string {
  switch (phase) {
    case "repairing":
      return "修复并重试";
    case "published":
      return "整理最终交付";
    case "waiting_children":
      return "等待子任务完成";
    case "aggregating":
    default:
      return "汇总子任务结果";
  }
}

export function shouldHideLocalDialogLiveActor(params: {
  actorId: string;
  steps?: readonly AgentStep[];
  workerActorIds: ReadonlySet<string>;
  hasCollaborationGroups: boolean;
}): boolean {
  const { actorId, steps = [], workerActorIds, hasCollaborationGroups } = params;
  if (workerActorIds.has(actorId)) return true;
  if (!hasCollaborationGroups || steps.length === 0) return false;
  const continuationState = getLocalDialogLiveContinuationState(steps);
  if (continuationState.latestOrchestrationIndex < 0) return false;
  return !continuationState.isContinuingAfterOrchestration;
}
