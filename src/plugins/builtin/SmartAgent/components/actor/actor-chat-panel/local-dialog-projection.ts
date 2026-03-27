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

  const latestAction = [...steps].reverse().find((step) => step.type === "action");
  if (latestAction?.toolName === "spawn_task" || latestAction?.toolName === "wait_for_spawned_tasks") {
    return true;
  }

  const latestToolStreaming = [...steps].reverse().find((step) => step.type === "tool_streaming");
  if (latestToolStreaming && buildToolStreamingPreview(latestToolStreaming.content).kind === "spawn") {
    return true;
  }

  return false;
}
