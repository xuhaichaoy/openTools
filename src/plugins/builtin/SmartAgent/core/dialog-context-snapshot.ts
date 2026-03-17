import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type {
  DialogArtifactRecord,
  DialogContextSummary,
  PendingInteraction,
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import type { AICenterHandoff } from "@/store/app-store";

const MODE_LABELS: Record<NonNullable<AICenterHandoff["sourceMode"]>, string> = {
  ask: "Ask",
  agent: "Agent",
  cluster: "Cluster",
  dialog: "Dialog",
};

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
    contextLines: [...snapshot.contextLines],
  };
}

export function buildDialogSourceModeLabel(
  handoff?: AICenterHandoff | null,
): string | undefined {
  if (!handoff?.sourceMode) return undefined;
  return `${MODE_LABELS[handoff.sourceMode]} 模式`;
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
    || snapshot.runningActorCount > 0,
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

  return lines;
}

export function buildDialogContextSnapshot(params: {
  sessionId?: string;
  workspaceRoot?: string;
  sourceHandoff?: AICenterHandoff | null;
  dialogContextSummary?: DialogContextSummary | null;
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
    contextLines: [],
  };

  snapshot.contextLines = buildDialogContextReport(snapshot);
  return snapshot;
}
