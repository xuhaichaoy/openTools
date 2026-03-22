import {
  buildAICenterHandoffScopedFileRefs,
  normalizeAICenterHandoff,
  pickVisualAttachmentPaths,
} from "@/core/ai/ai-center-handoff";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import type {
  CollaborationChildSession,
  CollaborationContractDelegation,
} from "@/core/collaboration/types";
import type { AICenterHandoff } from "@/store/app-store";
import { getSpawnedTaskRoleBoundaryMeta } from "./spawned-task-role-boundary";
import type { TodoItem } from "./middlewares";
import type {
  DialogArtifactRecord,
  DialogMessage,
  SpawnedTaskRecord,
} from "./types";

export interface SpawnedTaskTranscriptActor {
  roleName: string;
  sessionHistory: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
}

export interface SpawnedTaskTranscriptEntry {
  id: string;
  content: string;
  timestamp: number;
  label: string;
  kindLabel?: string;
  source: "history" | "dialog";
}

export type SpawnedTaskCheckpointStage =
  | "planning"
  | "execution"
  | "verification"
  | "blocked"
  | "completed";

export interface SpawnedTaskCheckpoint {
  stage: SpawnedTaskCheckpointStage;
  stageLabel: string;
  summary: string;
  nextStep?: string;
  activeTodoCount: number;
  activeTodos: string[];
  relatedArtifactPaths: string[];
  updatedAt: number;
}

type SpawnedTaskProjectedChildSession = Pick<
  CollaborationChildSession,
  "label" | "statusSummary" | "nextStepHint"
>;

type SpawnedTaskProjectedDelegation = Pick<
  CollaborationContractDelegation,
  "label" | "statusSummary" | "nextStepHint"
>;

function uniqueStrings(values: readonly string[], limit = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function pickFirstMeaningfulString(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) return normalized;
  }
  return undefined;
}

function getDialogKindLabel(kind?: DialogMessage["kind"]): string | undefined {
  switch (kind) {
    case "approval_request":
      return "审批请求";
    case "approval_response":
      return "审批回复";
    case "clarification_request":
      return "澄清请求";
    case "clarification_response":
      return "澄清回复";
    case "agent_result":
      return "结果回传";
    case "system_notice":
      return "系统提示";
    default:
      return undefined;
  }
}

function collectRelevantTodos(
  task: SpawnedTaskRecord,
  actorTodos?: readonly TodoItem[],
): TodoItem[] {
  if (!actorTodos?.length) return [];
  const taskStart = task.spawnedAt - 1000;
  return actorTodos
    .filter((todo) => todo.updatedAt >= taskStart)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function collectRelevantArtifacts(
  task: SpawnedTaskRecord,
  artifacts?: readonly DialogArtifactRecord[],
): DialogArtifactRecord[] {
  if (!artifacts?.length) return [];
  const taskEnd = task.completedAt ?? Number.POSITIVE_INFINITY;
  return artifacts
    .filter((artifact) => {
      if (artifact.relatedRunId === task.runId) return true;
      if (artifact.actorId !== task.targetActorId) return false;
      return artifact.timestamp >= task.spawnedAt - 1000 && artifact.timestamp <= taskEnd;
    })
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function collectSpawnedTaskTranscriptEntries(params: {
  task: SpawnedTaskRecord | null;
  targetActor?: SpawnedTaskTranscriptActor | null;
  actorNameById?: ReadonlyMap<string, string>;
  dialogHistory?: readonly DialogMessage[];
}): SpawnedTaskTranscriptEntry[] {
  const { task, targetActor, actorNameById, dialogHistory } = params;
  if (!task || !targetActor) return [];

  const start = typeof task.sessionHistoryStartIndex === "number"
    ? Math.max(0, task.sessionHistoryStartIndex)
    : 0;
  const end = task.mode === "session" && task.sessionOpen
    ? undefined
    : typeof task.sessionHistoryEndIndex === "number"
      ? Math.max(start, task.sessionHistoryEndIndex)
      : undefined;
  const historySlice = typeof task.sessionHistoryStartIndex === "number"
    ? targetActor.sessionHistory.slice(start, end)
    : targetActor.sessionHistory.filter((entry) => {
        const completedAt = task.completedAt ?? Number.POSITIVE_INFINITY;
        return entry.timestamp >= task.spawnedAt - 1000 && entry.timestamp <= completedAt;
      });

  const dialogEntries: SpawnedTaskTranscriptEntry[] = (dialogHistory ?? [])
    .filter((message) => message.relatedRunId === task.runId)
    .map((message) => {
      const fromLabel = message.from === "user"
        ? "你"
        : (actorNameById?.get(message.from) ?? message.from);
      const toLabel = message.to
        ? (message.to === "user" ? "你" : (actorNameById?.get(message.to) ?? message.to))
        : undefined;
      const directionLabel = toLabel ? `${fromLabel} → ${toLabel}` : fromLabel;
      return {
        id: `dialog-${message.id}`,
        content: message._briefContent ?? message.content,
        timestamp: message.timestamp,
        label: directionLabel,
        kindLabel: getDialogKindLabel(message.kind),
        source: "dialog",
      };
    });

  const dedupedHistoryEntries: SpawnedTaskTranscriptEntry[] = historySlice
    .filter((entry) => !dialogEntries.some((message) =>
      message.content.trim() === entry.content.trim()
      && Math.abs(message.timestamp - entry.timestamp) <= 1500,
    ))
    .map((entry, index) => ({
      id: `history-${entry.timestamp}-${index}`,
      content: entry.content,
      timestamp: entry.timestamp,
      label: entry.role === "user"
        ? (task.mode === "session" ? "子会话输入" : "任务输入")
        : targetActor.roleName,
      source: "history" as const,
    }));

  return [...dedupedHistoryEntries, ...dialogEntries].sort((a, b) => a.timestamp - b.timestamp);
}

function inferCheckpointStage(params: {
  task: SpawnedTaskRecord;
  activeTodos: readonly string[];
  relatedArtifactPaths: readonly string[];
  summaryText: string;
}): SpawnedTaskCheckpointStage {
  const { task, activeTodos, relatedArtifactPaths, summaryText } = params;
  const hintText = `${task.task}\n${summaryText}\n${activeTodos.join("\n")}`.toLowerCase();

  if (task.status === "error" || task.status === "aborted") return "blocked";
  if (!task.sessionOpen && task.status === "completed") return "completed";
  if (
    /测试|验证|lint|build|review|回归|test|verify/i.test(hintText)
    && (activeTodos.length > 0 || relatedArtifactPaths.length > 0 || task.status === "completed")
  ) {
    return "verification";
  }
  if (activeTodos.length > 0 || relatedArtifactPaths.length > 0 || task.status === "running") {
    return "execution";
  }
  return "planning";
}

function getCheckpointStageLabel(stage: SpawnedTaskCheckpointStage): string {
  switch (stage) {
    case "blocked":
      return "已阻塞";
    case "completed":
      return "已收束";
    case "verification":
      return "验证中";
    case "execution":
      return "执行中";
    case "planning":
    default:
      return "待拆解";
  }
}

export function buildSpawnedTaskCheckpoint(params: {
  task: SpawnedTaskRecord | null;
  targetActor?: SpawnedTaskTranscriptActor | null;
  actorTodos?: readonly TodoItem[];
  dialogHistory?: readonly DialogMessage[];
  artifacts?: readonly DialogArtifactRecord[];
  actorNameById?: ReadonlyMap<string, string>;
}): SpawnedTaskCheckpoint | null {
  const { task, targetActor, actorTodos, dialogHistory, artifacts, actorNameById } = params;
  if (!task) return null;

  const transcript = collectSpawnedTaskTranscriptEntries({
    task,
    targetActor,
    actorNameById,
    dialogHistory,
  });
  const relevantTodos = collectRelevantTodos(task, actorTodos);
  const activeTodos = relevantTodos
    .filter((todo) => todo.status === "pending" || todo.status === "in_progress")
    .map((todo) => summarizeAISessionRuntimeText(todo.title, 80) || todo.title);
  const relevantArtifacts = collectRelevantArtifacts(task, artifacts);
  const relatedArtifactPaths = uniqueStrings(relevantArtifacts.map((artifact) => artifact.path), 6);

  const latestTranscript = [...transcript]
    .reverse()
    .find((entry) => entry.content.trim().length > 0);
  const summarySource = task.error?.trim()
    ? `子任务异常：${task.error.trim()}`
    : task.result?.trim()
      ? task.result.trim()
      : latestTranscript?.content.trim()
        ? latestTranscript.content.trim()
        : task.task.trim();
  const summary = summarizeAISessionRuntimeText(summarySource, 180)
    || summarizeAISessionRuntimeText(task.task, 180)
    || "等待继续推进";

  const nextStep = summarizeAISessionRuntimeText(
    activeTodos[0]
      || (task.status === "error" || task.status === "aborted"
        ? "先根据当前错误补充上下文或重新规划执行路径"
        : task.mode === "session" && task.sessionOpen
          ? "继续在该子会话里补充上下文，推动下一步执行"
          : undefined),
    120,
  );

  const stage = inferCheckpointStage({
    task,
    activeTodos,
    relatedArtifactPaths,
    summaryText: summary,
  });
  const updatedAt = Math.max(
    task.lastActiveAt ?? 0,
    task.completedAt ?? 0,
    latestTranscript?.timestamp ?? 0,
    relevantTodos[0]?.updatedAt ?? 0,
    relevantArtifacts[0]?.timestamp ?? 0,
    task.spawnedAt,
  );

  return {
    stage,
    stageLabel: getCheckpointStageLabel(stage),
    summary,
    ...(nextStep ? { nextStep } : {}),
    activeTodoCount: activeTodos.length,
    activeTodos: uniqueStrings(activeTodos, 3),
    relatedArtifactPaths,
    updatedAt,
  };
}

export function buildDialogSpawnedTaskHandoff(params: {
  task: SpawnedTaskRecord | null;
  targetActor?: SpawnedTaskTranscriptActor | null;
  actorTodos?: readonly TodoItem[];
  dialogHistory?: readonly DialogMessage[];
  artifacts?: readonly DialogArtifactRecord[];
  actorNameById?: ReadonlyMap<string, string>;
  projectedChildSession?: SpawnedTaskProjectedChildSession;
  projectedDelegation?: SpawnedTaskProjectedDelegation;
  sourceSessionId?: string;
}): AICenterHandoff | null {
  const {
    task,
    targetActor,
    actorTodos,
    dialogHistory,
    artifacts,
    actorNameById,
    projectedChildSession,
    projectedDelegation,
    sourceSessionId,
  } = params;
  if (!task) return null;

  const checkpoint = buildSpawnedTaskCheckpoint({
    task,
    targetActor,
    actorTodos,
    dialogHistory,
    artifacts,
    actorNameById,
  });
  const transcript = collectSpawnedTaskTranscriptEntries({
    task,
    targetActor,
    actorNameById,
    dialogHistory,
  });
  const transcriptLines = transcript
    .slice(-8)
    .map((entry) => `- [${entry.label}${entry.kindLabel ? ` · ${entry.kindLabel}` : ""}] ${summarizeAISessionRuntimeText(entry.content, 180) || entry.content}`);
  const relatedArtifacts = collectRelevantArtifacts(task, artifacts);
  const artifactPaths = uniqueStrings([
    ...(task.images ?? []),
    ...relatedArtifacts.map((artifact) => artifact.path),
    ...(dialogHistory ?? [])
      .filter((message) => message.relatedRunId === task.runId)
      .flatMap((message) => message.images || []),
  ], 12);
  const visualAttachmentPaths = pickVisualAttachmentPaths(artifactPaths, 8) ?? [];
  const actorName = actorNameById?.get(task.targetActorId) ?? targetActor?.roleName ?? task.targetActorId;
  const roleBoundaryMeta = getSpawnedTaskRoleBoundaryMeta(task.roleBoundary);
  const handoffLabel = pickFirstMeaningfulString(
    projectedChildSession?.label,
    projectedDelegation?.label,
    task.label,
    task.task,
  ) ?? "未命名子任务";
  const statusSummary = pickFirstMeaningfulString(
    projectedChildSession?.statusSummary,
    projectedDelegation?.statusSummary,
    checkpoint?.summary,
  );
  const nextStepHint = pickFirstMeaningfulString(
    projectedChildSession?.nextStepHint,
    projectedDelegation?.nextStepHint,
    checkpoint?.nextStep,
  );

  const intro = [
    `请接力继续推进 Dialog 子任务：${summarizeAISessionRuntimeText(handoffLabel, 80) || "未命名子任务"}`,
    "",
    `原始任务：${task.task}`,
    `当前职责：${roleBoundaryMeta.label}`,
    checkpoint ? `当前阶段：${checkpoint.stageLabel}` : "",
    statusSummary ? `当前进展：${statusSummary}` : "",
    nextStepHint ? `建议下一步：${nextStepHint}` : "",
    transcriptLines.length > 0 ? `最近子会话记录：\n${transcriptLines.join("\n")}` : "",
  ].filter(Boolean).join("\n");

  const inferredCoding = inferCodingExecutionProfile({
    query: intro,
    attachmentPaths: artifactPaths,
  });

  return normalizeAICenterHandoff({
    query: intro,
    title: `${actorName} 子任务接力`,
    goal: nextStepHint
      || summarizeAISessionRuntimeText(handoffLabel, 100)
      || "继续推进当前子任务",
    intent: inferredCoding.profile.codingMode ? "coding" : "delivery",
    keyPoints: uniqueStrings([
      `职责边界：${roleBoundaryMeta.label}`,
      checkpoint ? `当前阶段：${checkpoint.stageLabel}` : "",
      statusSummary ? `当前概况：${statusSummary}` : "",
      checkpoint?.activeTodoCount ? `${checkpoint.activeTodoCount} 个活跃待办` : "",
      visualAttachmentPaths.length ? `${visualAttachmentPaths.length} 张视觉参考图` : "",
      checkpoint?.relatedArtifactPaths.length ? `${checkpoint.relatedArtifactPaths.length} 个相关文件` : "",
      task.mode === "session" && task.sessionOpen ? "原始子会话仍可继续交互" : "",
    ].filter(Boolean)),
    nextSteps: uniqueStrings([
      nextStepHint || "",
      checkpoint?.activeTodoCount ? "先检查活跃待办，再继续实施或验证" : "",
      visualAttachmentPaths.length ? "先查看已带入的视觉参考图，再继续实现或分析" : "",
      checkpoint?.relatedArtifactPaths.length ? "先阅读相关文件与最近产物，再决定下一步改动" : "",
    ].filter(Boolean)),
    contextSections: [
      visualAttachmentPaths.length
        ? { title: "视觉参考", items: [`已带入 ${visualAttachmentPaths.length} 张当前相关图片`] }
        : null,
      checkpoint?.activeTodos.length
        ? { title: "活跃待办", items: checkpoint.activeTodos }
        : null,
      transcriptLines.length
        ? { title: "最近子会话记录", items: transcriptLines }
        : null,
    ].filter((section): section is { title: string; items: string[] } => Boolean(section)),
    attachmentPaths: artifactPaths,
    ...(visualAttachmentPaths.length ? { visualAttachmentPaths } : {}),
    files: buildAICenterHandoffScopedFileRefs({
      attachmentPaths: artifactPaths,
      visualAttachmentPaths,
      visualReason: "Dialog 子任务视觉参考图",
      attachmentReason: "Dialog 子任务相关文件",
    }),
    sourceMode: "dialog",
    ...(sourceSessionId ? { sourceSessionId } : {}),
    sourceLabel: `Dialog 子任务 · ${actorName} · ${roleBoundaryMeta.shortLabel}`,
    summary: checkpoint
      ? `从 Dialog 子任务接力 · ${roleBoundaryMeta.label} · ${checkpoint.stageLabel}${statusSummary ? ` · ${summarizeAISessionRuntimeText(statusSummary, 36)}` : ""}${checkpoint.activeTodoCount ? ` · ${checkpoint.activeTodoCount} 个活跃待办` : ""}`
      : "从 Dialog 子任务接力",
  });
}
