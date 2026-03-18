import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { ClusterMode, ClusterSessionStatus } from "@/core/agent/cluster/types";
import type { AICenterHandoff } from "@/store/app-store";

const MODE_LABELS: Record<NonNullable<AICenterHandoff["sourceMode"]>, string> = {
  ask: "Ask",
  agent: "Agent",
  cluster: "Cluster",
  dialog: "Dialog",
};

const CLUSTER_MODE_LABELS: Record<ClusterMode, string> = {
  parallel_split: "并行分治",
  multi_role: "多角色协作",
};

const STATUS_LABELS: Record<ClusterSessionStatus, string> = {
  idle: "空闲",
  planning: "规划中",
  awaiting_approval: "等待审批",
  dispatching: "分发中",
  running: "执行中",
  aggregating: "汇总中",
  done: "已完成",
  error: "执行失败",
};

export interface ClusterContextSnapshot {
  generatedAt: number;
  sessionId?: string;
  queryPreview?: string;
  modeLabel?: string;
  workspaceRoot?: string;
  sourceModeLabel?: string;
  sourceHandoffGoalPreview?: string;
  sourceHandoffSummary?: string;
  status: ClusterSessionStatus;
  statusLabel: string;
  imageCount: number;
  messageCount: number;
  planStepCount: number;
  instanceCount: number;
  runningInstanceCount: number;
  completedInstanceCount: number;
  errorInstanceCount: number;
  reportPreview?: string;
  lastSessionNotePreview?: string;
  lastRunStatus?: string;
  lastRunDurationMs?: number;
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

export function cloneClusterContextSnapshot(
  snapshot?: ClusterContextSnapshot | null,
): ClusterContextSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    memoryPreview: [...(snapshot.memoryPreview ?? [])],
    transcriptPreview: [...(snapshot.transcriptPreview ?? [])],
    contextLines: [...snapshot.contextLines],
  };
}

export function buildClusterSourceModeLabel(
  handoff?: AICenterHandoff | null,
): string | undefined {
  if (!handoff?.sourceMode) return undefined;
  return `${MODE_LABELS[handoff.sourceMode]} 模式`;
}

export function buildClusterSourceHandoffSummary(
  handoff?: AICenterHandoff | null,
): string | undefined {
  if (!handoff) return undefined;
  const parts: string[] = [];
  const modeLabel = buildClusterSourceModeLabel(handoff);
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

export function hasClusterContextSnapshotContent(
  snapshot?: ClusterContextSnapshot | null,
): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.modeLabel
    || snapshot.workspaceRoot
    || snapshot.sourceModeLabel
    || snapshot.status !== "idle"
    || snapshot.planStepCount > 0
    || snapshot.instanceCount > 0
    || snapshot.imageCount > 0
    || snapshot.messageCount > 0
    || snapshot.reportPreview
    || snapshot.lastSessionNotePreview
    || snapshot.lastRunStatus
    || snapshot.memoryRecallAttempted
    || snapshot.transcriptRecallAttempted
  );
}

function describeLastRunStatus(status?: string): string | null {
  switch (status) {
    case "success":
      return "最近一轮已完成";
    case "error":
      return "最近一轮失败";
    case "cancelled":
      return "最近一轮已中断";
    default:
      return null;
  }
}

export function buildClusterContextNarrative(
  snapshot?: ClusterContextSnapshot | null,
): string {
  if (!snapshot) {
    return "当前 Cluster 会基于本轮任务独立规划和执行。";
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
  if (snapshot.modeLabel) {
    parts.push(`本轮使用 ${snapshot.modeLabel} 策略执行`);
  }
  if (snapshot.planStepCount > 0) {
    parts.push(`当前任务已拆成 ${snapshot.planStepCount} 个计划步骤`);
  }
  if (snapshot.status === "awaiting_approval") {
    parts.push("执行前还在等待人工审批");
  } else if (snapshot.runningInstanceCount > 0) {
    parts.push(`${snapshot.runningInstanceCount} 个 Agent 正在运行`);
  } else if (snapshot.status === "done") {
    parts.push("当前 Cluster 已完成汇总，可继续接力到 Agent 或 Dialog");
  } else if (snapshot.status === "error") {
    parts.push("上一次 Cluster 任务已失败，可基于当前上下文继续排查");
  }
  if (snapshot.reportPreview) {
    parts.push("最终结果摘要已保留在当前会话里");
  }
  if (snapshot.lastRunStatus) {
    parts.push(
      `${describeLastRunStatus(snapshot.lastRunStatus) || "最近一轮已更新"}${snapshot.lastRunDurationMs ? `（约 ${Math.max(1, Math.round(snapshot.lastRunDurationMs / 1000))} 秒）` : ""}`,
    );
  }
  if (snapshot.lastSessionNotePreview) {
    parts.push("最近一次执行已经沉淀为会话笔记");
  }
  if (snapshot.memoryHitCount > 0) {
    parts.push(`最近子任务命中了 ${snapshot.memoryHitCount} 条长期记忆`);
  } else if (snapshot.memoryRecallAttempted) {
    parts.push("最近子任务检索过长期记忆，但本轮没有命中");
  }
  if (snapshot.transcriptRecallHitCount > 0) {
    parts.push(`最近子任务回补了 ${snapshot.transcriptRecallHitCount} 条会话轨迹`);
  } else if (snapshot.transcriptRecallAttempted) {
    parts.push("最近子任务检索过会话轨迹，但本轮没有命中");
  }

  if (parts.length === 0) {
    return "当前 Cluster 会基于本轮任务独立规划和执行。";
  }

  return `${parts.join("；")}。`;
}

export function buildClusterContextReport(
  snapshot: ClusterContextSnapshot,
): string[] {
  const lines: string[] = [];

  if (snapshot.workspaceRoot) {
    lines.push(`当前工作区：${snapshot.workspaceRoot}`);
  }
  if (snapshot.sourceHandoffSummary) {
    lines.push(`跨模式来源：${snapshot.sourceHandoffSummary}`);
  }
  if (snapshot.modeLabel) {
    lines.push(`执行模式：${snapshot.modeLabel}`);
  }
  lines.push(`运行状态：${snapshot.statusLabel}`);

  if (snapshot.planStepCount > 0) {
    lines.push(`任务规划：当前已拆成 ${snapshot.planStepCount} 个步骤`);
  }
  if (snapshot.instanceCount > 0) {
    lines.push(
      `执行实例：共 ${snapshot.instanceCount} 个 Agent，运行中 ${snapshot.runningInstanceCount}，完成 ${snapshot.completedInstanceCount}，失败 ${snapshot.errorInstanceCount}`,
    );
  }
  if (snapshot.imageCount > 0 || snapshot.messageCount > 0) {
    lines.push(`带入材料：图片 ${snapshot.imageCount} 张，消息轨迹 ${snapshot.messageCount} 条`);
  }
  if (snapshot.reportPreview) {
    lines.push(`结果摘要：${snapshot.reportPreview}`);
  }
  if (snapshot.lastRunStatus) {
    lines.push(
      `最近运行：${describeLastRunStatus(snapshot.lastRunStatus) || snapshot.lastRunStatus}${snapshot.lastRunDurationMs ? ` / ${Math.max(1, Math.round(snapshot.lastRunDurationMs / 1000))}s` : ""}`,
    );
  }
  if (snapshot.lastSessionNotePreview) {
    lines.push(`最近会话笔记：${snapshot.lastSessionNotePreview}`);
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

export function buildClusterContextSnapshot(params: {
  sessionId?: string;
  query?: string;
  mode?: ClusterMode;
  status: ClusterSessionStatus;
  workspaceRoot?: string;
  sourceHandoff?: AICenterHandoff | null;
  imageCount: number;
  messageCount: number;
  planStepCount: number;
  instanceCount: number;
  runningInstanceCount: number;
  completedInstanceCount: number;
  errorInstanceCount: number;
  finalAnswer?: string | null;
  lastSessionNotePreview?: string;
  lastRunStatus?: string;
  lastRunDurationMs?: number;
  memoryRecallAttempted?: boolean;
  memoryHitCount?: number;
  memoryPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  transcriptPreview?: string[];
}): ClusterContextSnapshot {
  const snapshot: ClusterContextSnapshot = {
    generatedAt: Date.now(),
    sessionId: params.sessionId?.trim() || undefined,
    queryPreview: params.query ? compactText(params.query, 120) : undefined,
    modeLabel: params.mode ? CLUSTER_MODE_LABELS[params.mode] : undefined,
    workspaceRoot: params.workspaceRoot?.trim() || undefined,
    sourceModeLabel: buildClusterSourceModeLabel(params.sourceHandoff),
    sourceHandoffGoalPreview: params.sourceHandoff?.goal
      ? compactText(params.sourceHandoff.goal, 72)
      : undefined,
    sourceHandoffSummary: buildClusterSourceHandoffSummary(params.sourceHandoff),
    status: params.status,
    statusLabel: STATUS_LABELS[params.status],
    imageCount: Math.max(0, params.imageCount),
    messageCount: Math.max(0, params.messageCount),
    planStepCount: Math.max(0, params.planStepCount),
    instanceCount: Math.max(0, params.instanceCount),
    runningInstanceCount: Math.max(0, params.runningInstanceCount),
    completedInstanceCount: Math.max(0, params.completedInstanceCount),
    errorInstanceCount: Math.max(0, params.errorInstanceCount),
    reportPreview: params.finalAnswer ? compactText(params.finalAnswer, 160) : undefined,
    lastSessionNotePreview: params.lastSessionNotePreview
      ? compactText(params.lastSessionNotePreview, 140)
      : undefined,
    lastRunStatus: params.lastRunStatus?.trim() || undefined,
    lastRunDurationMs:
      typeof params.lastRunDurationMs === "number"
        ? Math.max(0, params.lastRunDurationMs)
        : undefined,
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

  snapshot.contextLines = buildClusterContextReport(snapshot);
  return snapshot;
}
