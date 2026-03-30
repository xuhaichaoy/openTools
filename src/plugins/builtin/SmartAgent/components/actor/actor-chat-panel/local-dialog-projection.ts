import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { DialogMessage } from "@/core/agent/actor/types";
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
const LOW_SIGNAL_CONTINUATION_TOOL_NAMES = new Set([
  "sequential_thinking",
]);
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

export interface LocalDialogLiveContinuationState {
  latestOrchestrationIndex: number;
  latestContinuationIndex: number;
  latestContinuationTimestamp?: number;
  latestContinuationPreview?: string;
  isContinuingAfterOrchestration: boolean;
  phase?: LocalDialogContinuationPhase;
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

function parseStructuredObject(content: string | undefined): Record<string, unknown> | null {
  const normalized = String(content ?? "").trim();
  if (!normalized || (!normalized.startsWith("{") && !normalized.startsWith("["))) {
    return null;
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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

function detectContinuationPhase(params: {
  latestOrchestrationIndex: number;
  latestContinuationIndex: number;
  latestContinuationStep?: AgentStep;
}): LocalDialogContinuationPhase | undefined {
  if (params.latestOrchestrationIndex < 0) return undefined;
  if (params.latestContinuationIndex <= params.latestOrchestrationIndex) {
    return "waiting_children";
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

  return {
    latestOrchestrationIndex,
    latestContinuationIndex,
    latestContinuationTimestamp: latestContinuationStep?.timestamp,
    latestContinuationPreview: getLiveContinuationPreview(latestContinuationStep),
    isContinuingAfterOrchestration: latestContinuationIndex > latestOrchestrationIndex,
    phase: detectContinuationPhase({
      latestOrchestrationIndex,
      latestContinuationIndex,
      latestContinuationStep,
    }),
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
  if (options?.hasCollaborationGroups && message.kind === "agent_result" && isLikelyCollaborationSummary(message.content)) {
    return true;
  }
  return TASK_RESULT_PREFIX.test(message.content);
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
