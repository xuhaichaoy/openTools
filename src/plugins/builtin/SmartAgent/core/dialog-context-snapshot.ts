import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { formatAICenterModeLabel } from "@/core/ai/ai-center-mode-meta";
import type {
  DialogArtifactRecord,
  DialogContextSummary,
  DialogRoomCompactionState,
  PendingInteraction,
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import type { AICenterHandoff } from "@/store/app-store";

export interface DialogContextSnapshot {
  generatedAt: number;
  sessionId?: string;
  workspaceRoot?: string;
  sourceModeLabel?: string;
  sourceHandoffGoalPreview?: string;
  sourceHandoffSummary?: string;
  dialogHistoryCount: number;
  summarizedMessageCount: number;
  uploadCount: number;
  artifactCount: number;
  spawnedTaskCount: number;
  openSessionCount: number;
  actorCount: number;
  runningActorCount: number;
  pendingInteractionCount: number;
  pendingApprovalCount: number;
  queuedFollowUpCount: number;
  focusedSessionRunId?: string;
  focusedSessionLabel?: string;
  summaryPreview?: string;
  roomCompactionUpdatedAt?: number;
  roomCompactionMessageCount: number;
  roomCompactionTaskCount: number;
  roomCompactionArtifactCount: number;
  roomCompactionSummaryPreview?: string;
  roomCompactionPreservedIdentifiers: string[];
  roomCompactionTriggerReasons: string[];
  roomCompactionMemoryConfirmedCount: number;
  roomCompactionMemoryQueuedCount: number;
  memoryRecallAttempted: boolean;
  memoryHitCount: number;
  memoryPreview: string[];
  transcriptRecallAttempted: boolean;
  transcriptRecallHitCount: number;
  transcriptPreview: string[];
  contextLines: string[];
}

function compactText(text: string, maxLength: number): string | undefined {
  return summarizeAISessionRuntimeText(text, maxLength) || undefined;
}

export function cloneDialogContextSnapshot(
  snapshot?: DialogContextSnapshot | null,
): DialogContextSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    roomCompactionPreservedIdentifiers: [...(snapshot.roomCompactionPreservedIdentifiers ?? [])],
    roomCompactionTriggerReasons: [...(snapshot.roomCompactionTriggerReasons ?? [])],
    memoryPreview: [...(snapshot.memoryPreview ?? [])],
    transcriptPreview: [...(snapshot.transcriptPreview ?? [])],
    contextLines: [...snapshot.contextLines],
  };
}

export function buildDialogSourceModeLabel(
  handoff?: AICenterHandoff | null,
): string | undefined {
  if (!handoff?.sourceMode) return undefined;
  return `${formatAICenterModeLabel(handoff.sourceMode)} 模式`;
}

export function buildDialogSourceHandoffSummary(
  handoff?: AICenterHandoff | null,
): string | undefined {
  if (!handoff) return undefined;
  const parts: string[] = [];
  const modeLabel = buildDialogSourceModeLabel(handoff);
  if (modeLabel) parts.push(`来源：${modeLabel}`);
  if (handoff.intent) parts.push(`意图：${handoff.intent}`);
  if (handoff.goal) {
    const goal = compactText(handoff.goal, 120);
    if (goal) parts.push(`目标：${goal}`);
  }
  if (handoff.summary) {
    const summary = compactText(handoff.summary, 140);
    if (summary) parts.push(`摘要：${summary}`);
  }
  return parts.join("；") || undefined;
}

export function hasDialogContextSnapshotContent(
  snapshot?: DialogContextSnapshot | null,
): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.workspaceRoot
    || snapshot.sourceModeLabel
    || snapshot.dialogHistoryCount > 0
    || snapshot.summarizedMessageCount > 0
    || snapshot.uploadCount > 0
    || snapshot.artifactCount > 0
    || snapshot.openSessionCount > 0
    || snapshot.focusedSessionLabel
    || snapshot.pendingInteractionCount > 0
    || snapshot.queuedFollowUpCount > 0
    || snapshot.runningActorCount > 0
    || snapshot.roomCompactionMessageCount > 0
    || snapshot.memoryRecallAttempted
    || snapshot.transcriptRecallAttempted,
  );
}

export function buildDialogContextNarrative(
  snapshot?: DialogContextSnapshot | null,
): string {
  if (!snapshot) {
    return "当前会基于房间最近上下文继续协作。";
  }

  const parts: string[] = [];
  if (snapshot.workspaceRoot) {
    parts.push(`当前会优先沿用工作区 ${snapshot.workspaceRoot}`);
  }
  if (snapshot.sourceModeLabel) {
    parts.push(
      `已带入来自 ${snapshot.sourceModeLabel} 的接力上下文${snapshot.sourceHandoffGoalPreview ? `，目标是“${snapshot.sourceHandoffGoalPreview}”` : ""}`,
    );
  }
  if (snapshot.summarizedMessageCount > 0) {
    parts.push(`更早的 ${snapshot.summarizedMessageCount} 条房间消息已整理为摘要，避免重复注入整段旧历史`);
  } else if (snapshot.dialogHistoryCount > 0) {
    parts.push("当前会继续沿用房间最近的协作消息");
  }
  if (snapshot.roomCompactionMessageCount > 0) {
    parts.push(
      `房间较早的 ${snapshot.roomCompactionMessageCount} 条消息已压缩为结构化摘要，并保留了 ${snapshot.roomCompactionTaskCount} 条子任务线索与 ${snapshot.roomCompactionArtifactCount} 条产物线索`,
    );
  }
  if (snapshot.focusedSessionLabel) {
    parts.push(`新输入会优先继续聚焦中的子会话 ${snapshot.focusedSessionLabel}`);
  }
  if (snapshot.pendingInteractionCount > 0) {
    parts.push(`还有 ${snapshot.pendingInteractionCount} 条待处理交互需要回复`);
  }
  if (snapshot.queuedFollowUpCount > 0) {
    parts.push(`${snapshot.queuedFollowUpCount} 条排队消息会在交互处理后继续`);
  }
  if (snapshot.runningActorCount > 0) {
    parts.push(`${snapshot.runningActorCount} 个 Agent 仍在运行`);
  }
  if (snapshot.memoryHitCount > 0) {
    parts.push(`最近房间内命中了 ${snapshot.memoryHitCount} 条长期记忆`);
  } else if (snapshot.memoryRecallAttempted) {
    parts.push("最近房间内检索过长期记忆，但本轮没有命中");
  }
  if (snapshot.transcriptRecallHitCount > 0) {
    parts.push(`最近房间内回补了 ${snapshot.transcriptRecallHitCount} 条会话轨迹`);
  } else if (snapshot.transcriptRecallAttempted) {
    parts.push("最近房间内检索过会话轨迹，但本轮没有命中");
  }

  if (parts.length === 0) {
    return "当前会基于房间最近上下文继续协作。";
  }

  return `${parts.join("；")}。`;
}

export function buildDialogContextReport(
  snapshot: DialogContextSnapshot,
): string[] {
  const lines: string[] = [];

  if (snapshot.workspaceRoot) {
    lines.push(`当前工作区：${snapshot.workspaceRoot}`);
  }
  if (snapshot.sourceHandoffSummary) {
    lines.push(`跨模式来源：${snapshot.sourceHandoffSummary}`);
  }
  if (snapshot.summarizedMessageCount > 0) {
    lines.push(`早期上下文：已整理 ${snapshot.summarizedMessageCount} 条房间消息摘要`);
  } else if (snapshot.dialogHistoryCount > 0) {
    lines.push(`近期协作：当前保留 ${snapshot.dialogHistoryCount} 条房间消息线索`);
  }
  if (snapshot.focusedSessionLabel) {
    lines.push(`输入落点：新消息会优先发往聚焦中的子会话 ${snapshot.focusedSessionLabel}`);
  }
  if (snapshot.pendingInteractionCount > 0) {
    lines.push(
      `待处理交互：${snapshot.pendingInteractionCount} 条${snapshot.pendingApprovalCount > 0 ? `，其中 ${snapshot.pendingApprovalCount} 条为审批` : ""}`,
    );
  }
  if (snapshot.queuedFollowUpCount > 0) {
    lines.push(`排队消息：${snapshot.queuedFollowUpCount} 条会在房间空闲后继续发送`);
  }
  if (snapshot.openSessionCount > 0) {
    lines.push(`开放子会话：当前保留 ${snapshot.openSessionCount} 个可继续的子会话`);
  }
  if (snapshot.runningActorCount > 0 || snapshot.actorCount > 0) {
    lines.push(`房间 Agent：${snapshot.actorCount} 个参与者，${snapshot.runningActorCount} 个正在运行`);
  }
  if (snapshot.uploadCount > 0 || snapshot.artifactCount > 0 || snapshot.spawnedTaskCount > 0) {
    lines.push(
      `共享工作集：上传 ${snapshot.uploadCount} 项，产物 ${snapshot.artifactCount} 项，子任务 ${snapshot.spawnedTaskCount} 项`,
    );
  }
  if (snapshot.summaryPreview) {
    lines.push(`摘要提示：${snapshot.summaryPreview}`);
  }
  if (snapshot.roomCompactionMessageCount > 0) {
    lines.push(
      `房间压缩：已整理 ${snapshot.roomCompactionMessageCount} 条消息、${snapshot.roomCompactionTaskCount} 条子任务线索、${snapshot.roomCompactionArtifactCount} 条产物线索`,
    );
  }
  if (snapshot.roomCompactionTriggerReasons.length > 0) {
    lines.push(`压缩原因：${snapshot.roomCompactionTriggerReasons.join("；")}`);
  }
  if (snapshot.roomCompactionSummaryPreview) {
    lines.push(`压缩摘要：${snapshot.roomCompactionSummaryPreview}`);
  }
  if (snapshot.roomCompactionPreservedIdentifiers.length > 0) {
    lines.push(`保留线索：${snapshot.roomCompactionPreservedIdentifiers.join("；")}`);
  }
  if (snapshot.roomCompactionMemoryConfirmedCount > 0 || snapshot.roomCompactionMemoryQueuedCount > 0) {
    lines.push(
      `压缩记忆沉淀：确认 ${snapshot.roomCompactionMemoryConfirmedCount} 条，候选 ${snapshot.roomCompactionMemoryQueuedCount} 条`,
    );
  }
  if (snapshot.memoryHitCount > 0) {
    lines.push(`长期记忆：命中 ${snapshot.memoryHitCount} 条`);
  } else if (snapshot.memoryRecallAttempted) {
    lines.push("长期记忆：已检索，本轮未命中");
  }
  if (snapshot.memoryPreview.length > 0) {
    lines.push(`记忆命中预览：${snapshot.memoryPreview.join("；")}`);
  }
  if (snapshot.transcriptRecallHitCount > 0) {
    lines.push(`会话轨迹回补：${snapshot.transcriptRecallHitCount} 条`);
  } else if (snapshot.transcriptRecallAttempted) {
    lines.push("会话轨迹回补：已检索，本轮未命中");
  }
  if (snapshot.transcriptPreview.length > 0) {
    lines.push(`轨迹命中预览：${snapshot.transcriptPreview.join("；")}`);
  }

  return lines;
}

export function buildDialogContextSnapshot(params: {
  sessionId?: string;
  workspaceRoot?: string;
  sourceHandoff?: AICenterHandoff | null;
  dialogContextSummary?: DialogContextSummary | null;
  dialogRoomCompaction?: DialogRoomCompactionState | null;
  dialogHistoryCount: number;
  sessionUploads?: readonly SessionUploadRecord[];
  artifacts?: readonly DialogArtifactRecord[];
  spawnedTasks?: readonly SpawnedTaskRecord[];
  actorCount: number;
  runningActorCount: number;
  pendingUserInteractions?: readonly PendingInteraction[];
  queuedFollowUpCount: number;
  focusedSessionRunId?: string | null;
  focusedSessionLabel?: string | null;
  memoryRecallAttempted?: boolean;
  memoryHitCount?: number;
  memoryPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  transcriptPreview?: string[];
}): DialogContextSnapshot {
  const pendingUserInteractions = params.pendingUserInteractions ?? [];
  const pendingApprovalCount = pendingUserInteractions.filter(
    (interaction) => interaction.status === "pending" && interaction.type === "approval",
  ).length;
  const snapshot: DialogContextSnapshot = {
    generatedAt: Date.now(),
    sessionId: params.sessionId?.trim() || undefined,
    workspaceRoot: params.workspaceRoot?.trim() || undefined,
    sourceModeLabel: buildDialogSourceModeLabel(params.sourceHandoff),
    sourceHandoffGoalPreview: params.sourceHandoff?.goal
      ? compactText(params.sourceHandoff.goal, 72)
      : undefined,
    sourceHandoffSummary: buildDialogSourceHandoffSummary(params.sourceHandoff),
    dialogHistoryCount: Math.max(0, params.dialogHistoryCount),
    summarizedMessageCount: Math.max(0, params.dialogContextSummary?.summarizedMessageCount ?? 0),
    uploadCount: Math.max(0, params.sessionUploads?.length ?? 0),
    artifactCount: Math.max(0, params.artifacts?.length ?? 0),
    spawnedTaskCount: Math.max(0, params.spawnedTasks?.length ?? 0),
    openSessionCount: Math.max(
      0,
      params.spawnedTasks?.filter((task) => task.mode === "session" && task.sessionOpen).length ?? 0,
    ),
    actorCount: Math.max(0, params.actorCount),
    runningActorCount: Math.max(0, params.runningActorCount),
    pendingInteractionCount: pendingUserInteractions.filter(
      (interaction) => interaction.status === "pending",
    ).length,
    pendingApprovalCount,
    queuedFollowUpCount: Math.max(0, params.queuedFollowUpCount),
    focusedSessionRunId: params.focusedSessionRunId?.trim() || undefined,
    focusedSessionLabel: params.focusedSessionLabel?.trim() || undefined,
    summaryPreview: params.dialogContextSummary?.summary
      ? compactText(params.dialogContextSummary.summary, 140)
      : undefined,
    roomCompactionUpdatedAt: params.dialogRoomCompaction?.updatedAt,
    roomCompactionMessageCount: Math.max(0, params.dialogRoomCompaction?.compactedMessageCount ?? 0),
    roomCompactionTaskCount: Math.max(0, params.dialogRoomCompaction?.compactedSpawnedTaskCount ?? 0),
    roomCompactionArtifactCount: Math.max(0, params.dialogRoomCompaction?.compactedArtifactCount ?? 0),
    roomCompactionSummaryPreview: params.dialogRoomCompaction?.summary
      ? compactText(params.dialogRoomCompaction.summary, 180)
      : undefined,
    roomCompactionPreservedIdentifiers: (params.dialogRoomCompaction?.preservedIdentifiers ?? [])
      .map((item) => compactText(item, 48))
      .filter((item): item is string => Boolean(item))
      .slice(0, 8),
    roomCompactionTriggerReasons: (params.dialogRoomCompaction?.triggerReasons ?? [])
      .map((item) => compactText(item, 60))
      .filter((item): item is string => Boolean(item))
      .slice(0, 4),
    roomCompactionMemoryConfirmedCount: Math.max(0, params.dialogRoomCompaction?.memoryConfirmedCount ?? 0),
    roomCompactionMemoryQueuedCount: Math.max(0, params.dialogRoomCompaction?.memoryQueuedCount ?? 0),
    memoryRecallAttempted: params.memoryRecallAttempted === true,
    memoryHitCount: Math.max(0, params.memoryHitCount ?? 0),
    memoryPreview: (params.memoryPreview ?? [])
      .map((item) => compactText(item, 72))
      .filter((item): item is string => Boolean(item))
      .slice(0, 4),
    transcriptRecallAttempted: params.transcriptRecallAttempted === true,
    transcriptRecallHitCount: Math.max(0, params.transcriptRecallHitCount ?? 0),
    transcriptPreview: (params.transcriptPreview ?? [])
      .map((item) => compactText(item, 88))
      .filter((item): item is string => Boolean(item))
      .slice(0, 4),
    contextLines: [],
  };

  snapshot.contextLines = buildDialogContextReport(snapshot);
  return snapshot;
}
