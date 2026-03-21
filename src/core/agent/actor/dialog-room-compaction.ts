import {
  ingestAutomaticMemorySignals,
  saveSessionMemoryNote,
} from "@/core/ai/memory-store";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { buildDialogWorkingSetSnapshot } from "@/core/ai/ai-working-set";
import type { DialogContextBreakdown } from "@/core/ai/dialog-context-breakdown";
import { buildSpawnedTaskCheckpoint } from "./spawned-task-checkpoint";
import type { TodoItem } from "./middlewares";
import type {
  DialogArtifactRecord,
  DialogMessage,
  DialogRoomCompactionState,
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "./types";

const DEFAULT_KEEP_RECENT_MESSAGES = 12;
const MAX_COMPACTION_SUMMARY_CHARS = 2200;
const MIN_COMPACTION_REFRESH_INTERVAL_MS = 30_000;
const MAX_CONTINUITY_CHECKPOINTS = 4;

type ActorSessionHistoryEntry = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

function clip(value: string | undefined, maxLength = 140): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const summarized = summarizeAISessionRuntimeText(normalized, maxLength);
  return summarized || normalized.slice(0, maxLength);
}

function basename(path: string): string {
  const normalized = String(path ?? "").trim();
  return normalized.split("/").pop() || normalized;
}

function dedupeStrings(values: readonly string[], limit = 8): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function trimSummary(summary: string): string {
  if (summary.length <= MAX_COMPACTION_SUMMARY_CHARS) return summary;
  return `${summary.slice(0, MAX_COMPACTION_SUMMARY_CHARS - 24).trimEnd()}\n...（房间压缩摘要已截断）`;
}

function getSpawnedTaskUpdatedAt(task: SpawnedTaskRecord): number {
  return task.lastActiveAt ?? task.completedAt ?? task.sessionClosedAt ?? task.spawnedAt;
}

function buildCurrentWorkingSetLines(params: {
  dialogHistory: readonly DialogMessage[];
  artifacts: readonly DialogArtifactRecord[];
  sessionUploads: readonly SessionUploadRecord[];
  spawnedTasks: readonly SpawnedTaskRecord[];
  actorNameById?: ReadonlyMap<string, string>;
}): string[] {
  const workingSet = buildDialogWorkingSetSnapshot({
    artifacts: params.artifacts.map((artifact) => ({
      path: artifact.path,
      fileName: artifact.fileName,
      actorName: params.actorNameById?.get(artifact.actorId) ?? artifact.actorId,
    })),
    sessionUploads: params.sessionUploads,
    spawnedTasks: params.spawnedTasks,
    actorNameById: params.actorNameById,
    extraAttachmentPaths: params.dialogHistory.flatMap((message) => message.images ?? []),
    maxArtifacts: 4,
    maxSpawnedTasks: 4,
    maxAttachmentPaths: 12,
  });

  return [
    workingSet.summary ? `- ${workingSet.summary}` : "",
    ...workingSet.artifactSummaryLines.slice(0, 3),
    workingSet.uploadSummaryLine ? `- ${workingSet.uploadSummaryLine}` : "",
    workingSet.visualSummaryLine ? `- ${workingSet.visualSummaryLine}` : "",
  ].filter(Boolean);
}

function buildCurrentCheckpointLines(params: {
  spawnedTasks: readonly SpawnedTaskRecord[];
  actorNameById?: ReadonlyMap<string, string>;
  actorSessionHistoryById?: ReadonlyMap<string, ActorSessionHistoryEntry[]>;
  actorTodosById?: Readonly<Record<string, TodoItem[]>>;
  dialogHistory: readonly DialogMessage[];
  artifacts: readonly DialogArtifactRecord[];
}): string[] {
  const candidateTasks = [...params.spawnedTasks]
    .filter((task) =>
      task.status === "pending"
      || task.status === "running"
      || (task.mode === "session" && task.sessionOpen),
    )
    .sort((left, right) => getSpawnedTaskUpdatedAt(right) - getSpawnedTaskUpdatedAt(left))
    .slice(0, MAX_CONTINUITY_CHECKPOINTS);

  return candidateTasks.map((task) => {
    const actorName = params.actorNameById?.get(task.targetActorId) ?? task.targetActorId;
    const checkpoint = buildSpawnedTaskCheckpoint({
      task,
      targetActor: {
        roleName: actorName,
        sessionHistory: params.actorSessionHistoryById?.get(task.targetActorId) ?? [],
      },
      actorTodos: params.actorTodosById?.[task.targetActorId] ?? [],
      dialogHistory: params.dialogHistory,
      artifacts: params.artifacts,
      actorNameById: params.actorNameById,
    });
    if (!checkpoint) {
      const taskPreview = clip(task.label || task.task, 96);
      return `- ${actorName}：${taskPreview || "继续执行当前子线程"}`;
    }
    const summary = clip(checkpoint.summary, 110);
    const nextStep = clip(checkpoint.nextStep, 72);
    return `- ${actorName} · ${checkpoint.stageLabel}${summary ? ` · ${summary}` : ""}${nextStep ? ` · 下一步：${nextStep}` : ""}`;
  });
}

function buildDialogRoomCompactionMemorySource(
  state: DialogRoomCompactionState,
): string {
  const lines = [
    "以下是 Dialog 房间压缩后的结构化续跑摘要，用于提取稳定的项目上下文、子线程连续性与用户长期要求。",
    `压缩规模：${state.compactedMessageCount} 条消息，${state.compactedSpawnedTaskCount} 条子任务线索，${state.compactedArtifactCount} 条产物线索。`,
    state.triggerReasons?.length ? `触发原因：${state.triggerReasons.join("；")}` : "",
    state.preservedIdentifiers.length > 0 ? `关键线索：${state.preservedIdentifiers.join("、")}` : "",
    state.summary,
  ].filter(Boolean);
  return lines.join("\n\n");
}

export function cloneDialogRoomCompaction(
  state?: DialogRoomCompactionState | null,
): DialogRoomCompactionState | null {
  if (!state) return null;
  return {
    ...state,
    preservedIdentifiers: [...state.preservedIdentifiers],
    triggerReasons: state.triggerReasons ? [...state.triggerReasons] : undefined,
  };
}

export function buildDialogRoomCompactionState(params: {
  dialogHistory: readonly DialogMessage[];
  artifacts: readonly DialogArtifactRecord[];
  sessionUploads: readonly SessionUploadRecord[];
  spawnedTasks: readonly SpawnedTaskRecord[];
  actorNameById?: ReadonlyMap<string, string>;
  actorSessionHistoryById?: ReadonlyMap<string, ActorSessionHistoryEntry[]>;
  actorTodosById?: Readonly<Record<string, TodoItem[]>>;
  keepRecentMessages?: number;
  triggerReasons?: string[];
  updatedAt?: number;
}): DialogRoomCompactionState | null {
  const keepRecentMessages = Math.max(4, params.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES);
  if (params.dialogHistory.length <= keepRecentMessages) return null;

  const recentMessages = params.dialogHistory.slice(-keepRecentMessages);
  const olderMessages = params.dialogHistory.slice(0, -keepRecentMessages);
  if (olderMessages.length === 0) return null;

  const compactionCutoffAt = recentMessages[0]?.timestamp
    ?? olderMessages[olderMessages.length - 1]?.timestamp
    ?? Date.now();
  const olderArtifacts = params.artifacts.filter((artifact) => artifact.timestamp <= compactionCutoffAt);
  const olderUploads = params.sessionUploads.filter((upload) => upload.addedAt <= compactionCutoffAt);
  const olderSpawnedTasks = params.spawnedTasks.filter((task) => {
    return getSpawnedTaskUpdatedAt(task) <= compactionCutoffAt;
  });

  const actorNameById = params.actorNameById;
  const earlyUserRequests = [...olderMessages]
    .reverse()
    .filter((message) => message.from === "user")
    .slice(0, 5)
    .map((message) => clip(message._briefContent || message.content, 120))
    .filter(Boolean)
    .reverse();

  const earlyResults = [...olderMessages]
    .reverse()
    .filter((message) => message.from !== "user")
    .slice(0, 5)
    .map((message) => {
      const actorName = actorNameById?.get(message.from) ?? message.from;
      const content = clip(message._briefContent || message.content, 120);
      return content ? `${actorName}：${content}` : "";
    })
    .filter(Boolean)
    .reverse();

  const workingSet = buildDialogWorkingSetSnapshot({
    artifacts: olderArtifacts.map((artifact) => ({
      path: artifact.path,
      fileName: artifact.fileName,
      actorName: actorNameById?.get(artifact.actorId) ?? artifact.actorId,
    })),
    sessionUploads: olderUploads,
    spawnedTasks: olderSpawnedTasks,
    actorNameById,
    extraAttachmentPaths: olderMessages.flatMap((message) => message.images ?? []),
    maxArtifacts: 6,
    maxSpawnedTasks: 6,
    maxAttachmentPaths: 16,
  });
  const currentWorkingSetLines = buildCurrentWorkingSetLines({
    dialogHistory: recentMessages,
    artifacts: params.artifacts,
    sessionUploads: params.sessionUploads,
    spawnedTasks: params.spawnedTasks,
    actorNameById,
  });
  const currentCheckpointLines = buildCurrentCheckpointLines({
    spawnedTasks: params.spawnedTasks,
    actorNameById,
    actorSessionHistoryById: params.actorSessionHistoryById,
    actorTodosById: params.actorTodosById,
    dialogHistory: params.dialogHistory,
    artifacts: params.artifacts,
  });

  const sections = [
    earlyUserRequests.length > 0
      ? `早期用户诉求：\n${earlyUserRequests.map((line) => `- ${line}`).join("\n")}`
      : "",
    earlyResults.length > 0
      ? `已形成的房间结论：\n${earlyResults.map((line) => `- ${line}`).join("\n")}`
      : "",
    workingSet.spawnedTaskSummaryLines.length > 0
      ? `已压缩的较早子任务线索：\n${workingSet.spawnedTaskSummaryLines.join("\n")}`
      : "",
    workingSet.artifactSummaryLines.length > 0
      ? `已保留的较早产物线索：\n${workingSet.artifactSummaryLines.join("\n")}`
      : "",
    currentWorkingSetLines.length > 0
      ? `后续续跑应优先沿用的当前工作集：\n${currentWorkingSetLines.join("\n")}`
      : "",
    currentCheckpointLines.length > 0
      ? `当前仍需延续的子线程检查点：\n${currentCheckpointLines.join("\n")}`
      : "",
    workingSet.uploadSummaryLine ? `附件与工作集：\n- ${workingSet.uploadSummaryLine}` : "",
    workingSet.visualSummaryLine ? `视觉参考：\n- ${workingSet.visualSummaryLine}` : "",
  ].filter(Boolean);

  if (sections.length === 0) return null;

  const preservedIdentifiers = dedupeStrings([
    ...workingSet.attachmentPaths.map((path) => basename(path)),
    ...olderSpawnedTasks.map((task) => task.label || actorNameById?.get(task.targetActorId) || task.targetActorId),
    ...olderArtifacts.map((artifact) => artifact.fileName),
    ...olderUploads.map((upload) => upload.name),
  ]);

  return {
    summary: trimSummary(sections.join("\n\n")),
    compactedMessageCount: olderMessages.length,
    compactedSpawnedTaskCount: olderSpawnedTasks.length,
    compactedArtifactCount: olderArtifacts.length,
    preservedIdentifiers,
    triggerReasons: params.triggerReasons?.length ? [...params.triggerReasons] : undefined,
    memoryConfirmedCount: 0,
    memoryQueuedCount: 0,
    updatedAt: params.updatedAt ?? Date.now(),
  };
}

export function buildDialogRoomCompactionContextMessages(
  state?: DialogRoomCompactionState | null,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!state?.summary.trim()) return [];

  const safeguardParts = [
    state.preservedIdentifiers.length > 0 ? `关键线索 ${state.preservedIdentifiers.length} 项` : "",
    typeof state.memoryConfirmedCount === "number" && state.memoryConfirmedCount > 0
      ? `记忆沉淀 ${state.memoryConfirmedCount} 条`
      : "",
  ].filter(Boolean);

  return [
    {
      role: "user",
      content:
        "以下是当前 Dialog 房间中较早协作内容整理后的结构化历史摘要，请把它视为已经确认并可继续复用的房间上下文：\n"
        + state.summary,
    },
    {
      role: "assistant",
      content:
        `已接收房间压缩摘要${safeguardParts.length > 0 ? `，并保留了${safeguardParts.join("、")}` : ""}。后续仅需结合最近未压缩消息、当前工作集、仍开放的子线程检查点和最新指令继续执行。`,
    },
  ];
}

export function computeDialogRoomCompactionTriggerReasons(params: {
  breakdown: DialogContextBreakdown;
  dialogHistoryCount: number;
  keepRecentMessages?: number;
}): string[] {
  const keepRecentMessages = Math.max(4, params.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES);
  const reasons: string[] = [];

  if (params.breakdown.totalSharedTokens >= 4000) {
    reasons.push("共享工作集偏大");
  }
  if (params.breakdown.actors.some((actor) => actor.estimatedTotalRatio >= 1.05)) {
    reasons.push("至少一个 Agent 的预算占用接近或超过上限");
  }
  if (params.breakdown.openSessionCount >= 3) {
    reasons.push("开放子会话数量偏多");
  }
  if (params.breakdown.imageCount >= 4) {
    reasons.push("视觉输入累计较多");
  }
  if (params.dialogHistoryCount >= keepRecentMessages + 10) {
    reasons.push("房间历史已明显拉长");
  }

  return dedupeStrings(reasons, 6);
}

export function shouldRefreshDialogRoomCompaction(params: {
  current?: DialogRoomCompactionState | null;
  triggerReasons: readonly string[];
  dialogHistoryCount: number;
  artifactsCount: number;
  spawnedTaskCount: number;
  keepRecentMessages?: number;
  now?: number;
}): boolean {
  if (params.triggerReasons.length === 0) return false;

  const keepRecentMessages = Math.max(4, params.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES);
  const olderMessageCount = Math.max(0, params.dialogHistoryCount - keepRecentMessages);
  const now = params.now ?? Date.now();
  const current = params.current;

  if (!current) {
    return olderMessageCount > 0;
  }
  if (now - current.updatedAt < MIN_COMPACTION_REFRESH_INTERVAL_MS) {
    return false;
  }
  if (olderMessageCount > current.compactedMessageCount + 6) {
    return true;
  }
  if (params.spawnedTaskCount > current.compactedSpawnedTaskCount + 2) {
    return true;
  }
  if (params.artifactsCount > current.compactedArtifactCount + 2) {
    return true;
  }
  const previousReasons = current.triggerReasons ?? [];
  if (params.triggerReasons.some((reason) => !previousReasons.includes(reason))) {
    return true;
  }
  return false;
}

export async function persistDialogRoomCompactionArtifacts(params: {
  state: DialogRoomCompactionState;
  conversationId: string;
  workspaceId?: string;
}): Promise<DialogRoomCompactionState> {
  const summary = params.state.summary.trim();
  if (!summary) {
    return cloneDialogRoomCompaction(params.state)!;
  }

  const preservedText = params.state.preservedIdentifiers.length > 0
    ? `关键线索：${params.state.preservedIdentifiers.join("、")}`
    : "";
  const flushText = [
    `Dialog 房间压缩摘要：${clip(summary, 200)}`,
    preservedText,
  ].filter(Boolean).join("；");

  const savedNote = flushText
    ? await saveSessionMemoryNote(flushText, {
        conversationId: params.conversationId,
        workspaceId: params.workspaceId,
        source: "system",
      }).catch(() => null)
    : null;

  const memorySource = [
    buildDialogRoomCompactionMemorySource(params.state),
    preservedText,
  ].filter(Boolean).join("\n\n");

  const memoryIngest = await ingestAutomaticMemorySignals(memorySource, {
    conversationId: params.conversationId,
    workspaceId: params.workspaceId,
    source: "system",
    sourceMode: "system",
    evidence: memorySource,
    autoConfirm: true,
    allowNonUserSourceAutoConfirm: true,
  }).catch(() => ({ confirmed: 0, queued: 0 }));

  return {
    ...cloneDialogRoomCompaction(params.state)!,
    memoryFlushNoteId: savedNote?.id,
    memoryConfirmedCount: memoryIngest.confirmed,
    memoryQueuedCount: memoryIngest.queued,
  };
}
