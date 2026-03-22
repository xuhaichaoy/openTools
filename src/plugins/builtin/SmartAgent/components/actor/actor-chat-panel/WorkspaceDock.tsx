import React, { useEffect, useMemo, useState } from "react";
import {
  Brain,
  FileDown,
  FolderOpen,
  ListChecks,
  Network,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { buildSpawnedTaskCheckpoint, type SpawnedTaskCheckpoint } from "@/core/agent/actor/spawned-task-checkpoint";
import type { TodoItem } from "@/core/agent/actor/middlewares";
import type { ClusterPlan } from "@/core/agent/cluster/types";
import type {
  DialogArtifactRecord,
  DialogContextSummary,
  DialogMessage,
  DialogRoomCompactionState,
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import type { DialogDispatchPlanBundle } from "@/core/agent/actor/dialog-dispatch-plan";
import type {
  CollaborationChildSession,
  CollaborationContractDelegation,
} from "@/core/collaboration/types";
import type { DialogContextBreakdown } from "@/core/ai/dialog-context-breakdown";
import {
  buildDialogContextNarrative,
  hasDialogContextSnapshotContent,
  type DialogContextSnapshot,
} from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";
import type { ActorSnapshot } from "@/store/actor-system-store";

function basename(path: unknown): string {
  const s = String(path ?? "");
  return s.split("/").pop() || s;
}

export type DialogArtifact = DialogArtifactRecord & {
  actorName: string;
};

type ArtifactAvailability = "ready" | "missing" | "unknown";

export type WorkspacePanel = "todos" | "artifacts" | "uploads" | "subtasks" | "context" | "plan" | null;

function formatShortTime(timestamp?: number): string {
  if (!timestamp) return "刚刚";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTokenCount(tokens?: number): string {
  if (!tokens || tokens <= 0) return "0";
  if (tokens >= 10000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}

function formatRatioAsPercent(ratio?: number): string {
  if (!ratio || ratio <= 0) return "0%";
  return `${Math.round(ratio * 100)}%`;
}

function compactLongText(text: string | undefined, maxLength = 260): string {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

type ContextOverviewCard = {
  label: string;
  value: string;
  detail: string;
  toneClassName?: string;
};

function buildContextOverviewCards(
  snapshot: DialogContextSnapshot | null,
): ContextOverviewCard[] {
  if (!snapshot) {
    return [
      {
        label: "主入口",
        value: "主 Agent",
        detail: "新输入默认先交给主 Agent，再决定是否继续派工。",
        toneClassName: "text-[var(--color-accent)]",
      },
      {
        label: "待处理交互",
        value: "0",
        detail: "当前没有待回复或待确认交互。",
      },
      {
        label: "后台线程",
        value: "0",
        detail: "当前没有保留中的后台线程。",
      },
      {
        label: "记忆回补",
        value: "0",
        detail: "如果命中长期记忆或轨迹回补，会在这里说明。",
      },
    ];
  }

  const recalledCount = snapshot.memoryHitCount + snapshot.transcriptRecallHitCount;
  const focusedValue = snapshot.focusedSessionLabel ? "聚焦线程" : "主 Agent";
  const focusedDetail = snapshot.focusedSessionLabel
    ? `新输入会优先接到 ${snapshot.focusedSessionLabel}`
    : "新输入默认仍先交给主 Agent 处理";
  const interactionDetail = snapshot.pendingInteractionCount > 0
    ? snapshot.pendingApprovalCount > 0
      ? `其中 ${snapshot.pendingApprovalCount} 条需要确认，会优先阻塞新的自由输入`
      : "当前优先处理待回复交互，再接新的自由输入"
    : "当前没有待回复或待确认交互";
  const sessionDetail = snapshot.openSessionCount > 0
    ? `${snapshot.openSessionCount} 个后台线程仍可复用，但默认不要求你先看子线程`
    : "当前没有保留中的后台线程";
  const recallDetail = recalledCount > 0
    ? `本轮会自动回补 ${recalledCount} 条长期记忆/历史轨迹`
    : snapshot.memoryRecallAttempted || snapshot.transcriptRecallAttempted
      ? "系统已经检索过记忆与轨迹，但本轮没有额外命中"
      : "如果命中长期记忆或轨迹回补，会在这里说明";

  return [
    {
      label: "主入口",
      value: focusedValue,
      detail: focusedDetail,
      toneClassName: "text-[var(--color-accent)]",
    },
    {
      label: "待处理交互",
      value: String(snapshot.pendingInteractionCount),
      detail: interactionDetail,
      toneClassName: snapshot.pendingInteractionCount > 0 ? "text-amber-700" : "text-[var(--color-text)]",
    },
    {
      label: "后台线程",
      value: String(snapshot.openSessionCount),
      detail: sessionDetail,
      toneClassName: snapshot.openSessionCount > 0 ? "text-sky-700" : "text-[var(--color-text)]",
    },
    {
      label: "记忆回补",
      value: String(recalledCount),
      detail: recallDetail,
      toneClassName: recalledCount > 0 ? "text-emerald-700" : "text-[var(--color-text)]",
    },
  ];
}

function buildContinuationItems(
  snapshot: DialogContextSnapshot | null,
): string[] {
  if (!snapshot) {
    return ["当前会沿用最近房间消息、主 Agent 的当前任务，以及共享工作集继续执行。"];
  }

  const items = [
    snapshot.workspaceRoot ? `工作区会继续锁定在 ${snapshot.workspaceRoot}` : "",
    snapshot.focusedSessionLabel
      ? `新输入默认会优先接到聚焦中的线程 ${snapshot.focusedSessionLabel}`
      : snapshot.openSessionCount > 0
        ? `当前还有 ${snapshot.openSessionCount} 个后台线程可继续复用，但默认仍先发给主 Agent`
        : "当前默认仍由主 Agent 接住新输入，再决定是否继续派工",
    snapshot.pendingInteractionCount > 0
      ? `还有 ${snapshot.pendingInteractionCount} 条待回复/待确认交互，会优先于新的自由输入`
      : "",
    snapshot.queuedFollowUpCount > 0
      ? `已有 ${snapshot.queuedFollowUpCount} 条排队消息，房间空闲后会继续发送`
      : "",
    snapshot.memoryHitCount > 0
      ? `本轮还会带入 ${snapshot.memoryHitCount} 条长期记忆命中`
      : snapshot.memoryRecallAttempted
        ? "本轮已经检索过长期记忆，但没有额外命中"
        : "",
    snapshot.transcriptRecallHitCount > 0
      ? `还会回补 ${snapshot.transcriptRecallHitCount} 条历史轨迹线索`
      : snapshot.transcriptRecallAttempted
        ? "已经检索过会话轨迹，但没有额外命中"
        : "",
  ].filter(Boolean);

  return items.length > 0
    ? items
    : ["当前会沿用最近房间消息、主 Agent 的当前任务，以及共享工作集继续执行。"];
}

function buildMemoryCarryItems(
  snapshot: DialogContextSnapshot | null,
): string[] {
  if (!snapshot) {
    return ["如果本轮命中长期记忆、会话轨迹或跨模式接力上下文，会在这里说明自动回补了什么。"];
  }

  const items = [
    snapshot.sourceHandoffSummary
      ? `当前还带着跨模式接力上下文：${snapshot.sourceHandoffSummary}`
      : "",
    snapshot.memoryHitCount > 0
      ? `长期记忆会回补 ${snapshot.memoryHitCount} 条${snapshot.memoryPreview.length > 0 ? `：${snapshot.memoryPreview.join("；")}` : ""}`
      : snapshot.memoryRecallAttempted
        ? "长期记忆已经检索过，但本轮没有额外命中"
        : "",
    snapshot.transcriptRecallHitCount > 0
      ? `会话轨迹会回补 ${snapshot.transcriptRecallHitCount} 条${snapshot.transcriptPreview.length > 0 ? `：${snapshot.transcriptPreview.join("；")}` : ""}`
      : snapshot.transcriptRecallAttempted
        ? "会话轨迹已经检索过，但本轮没有额外命中"
        : "",
    snapshot.roomCompactionMemoryConfirmedCount > 0 || snapshot.roomCompactionMemoryQueuedCount > 0
      ? `房间压缩产物已沉淀为记忆：确认 ${snapshot.roomCompactionMemoryConfirmedCount} 条，候选 ${snapshot.roomCompactionMemoryQueuedCount} 条`
      : "",
  ].filter(Boolean);

  return items.length > 0
    ? items
    : ["当前没有额外的记忆或轨迹回补，但系统会继续在后续轮次自动检索。"];
}

function buildCompactionItems(
  snapshot: DialogContextSnapshot | null,
  dialogRoomCompaction: DialogRoomCompactionState | null,
): string[] {
  if (!dialogRoomCompaction && !snapshot?.roomCompactionMessageCount) {
    return [
      "当前还没有触发房间级压缩；如果上下文继续变重，系统会把较早消息、子任务和产物整理成可续跑摘要。",
    ];
  }

  const messageCount = snapshot?.roomCompactionMessageCount ?? dialogRoomCompaction?.compactedMessageCount ?? 0;
  const taskCount = snapshot?.roomCompactionTaskCount ?? dialogRoomCompaction?.compactedSpawnedTaskCount ?? 0;
  const artifactCount = snapshot?.roomCompactionArtifactCount ?? dialogRoomCompaction?.compactedArtifactCount ?? 0;
  const reasons = snapshot?.roomCompactionTriggerReasons ?? dialogRoomCompaction?.triggerReasons ?? [];
  const identifiers = snapshot?.roomCompactionPreservedIdentifiers ?? dialogRoomCompaction?.preservedIdentifiers ?? [];
  const memoryConfirmed = snapshot?.roomCompactionMemoryConfirmedCount ?? dialogRoomCompaction?.memoryConfirmedCount ?? 0;
  const memoryQueued = snapshot?.roomCompactionMemoryQueuedCount ?? dialogRoomCompaction?.memoryQueuedCount ?? 0;
  const summaryPreview = snapshot?.roomCompactionSummaryPreview ?? compactLongText(dialogRoomCompaction?.summary, 180);

  return [
    `较早的 ${messageCount} 条消息、${taskCount} 条子任务线索、${artifactCount} 条产物线索已经压缩为结构化续跑摘要`,
    reasons.length > 0 ? `本次压缩主要是因为：${reasons.join("；")}` : "",
    summaryPreview ? `后续续跑会优先参考：${summaryPreview}` : "",
    identifiers.length > 0 ? `压缩后仍保留的关键线索：${identifiers.slice(0, 6).join("、")}` : "",
    memoryConfirmed > 0 || memoryQueued > 0
      ? `压缩内容已沉淀为记忆：确认 ${memoryConfirmed} 条，候选 ${memoryQueued} 条`
      : "",
  ].filter(Boolean);
}

function getChildSessionStatusMeta(
  status: CollaborationChildSession["status"] | SpawnedTaskRecord["status"] | undefined,
): {
  label: string;
  className: string;
} {
  switch (status) {
    case "running":
      return {
        label: "运行中",
        className: "bg-emerald-500/10 text-emerald-700",
      };
    case "waiting":
      return {
        label: "已暂停",
        className: "bg-blue-500/10 text-blue-700",
      };
    case "completed":
      return {
        label: "已完成",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
      };
    case "failed":
    case "error":
      return {
        label: "失败",
        className: "bg-red-500/10 text-red-700",
      };
    case "aborted":
      return {
        label: "已中止",
        className: "bg-amber-500/10 text-amber-700",
      };
    default:
      return {
        label: "待启动",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
      };
  }
}

function getContractDelegationStatusMeta(
  status: CollaborationContractDelegation["state"] | undefined,
): {
  label: string;
  className: string;
} {
  switch (status) {
    case "running":
      return {
        label: "运行中",
        className: "bg-emerald-500/10 text-emerald-700",
      };
    case "waiting":
      return {
        label: "待继续",
        className: "bg-blue-500/10 text-blue-700",
      };
    case "completed":
      return {
        label: "已完成",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
      };
    case "failed":
      return {
        label: "失败",
        className: "bg-red-500/10 text-red-700",
      };
    case "stale":
      return {
        label: "已过期",
        className: "bg-amber-500/10 text-amber-700",
      };
    default:
      return {
        label: "待派工",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
      };
  }
}

function getContextStatusMeta(status: DialogContextBreakdown["actors"][number]["status"]): {
  badge: string;
  bar: string;
  text: string;
} {
  switch (status) {
    case "tight":
      return {
        badge: "bg-red-500/10 text-red-600",
        bar: "bg-red-500",
        text: "预算偏紧",
      };
    case "busy":
      return {
        badge: "bg-amber-500/10 text-amber-700",
        bar: "bg-amber-500",
        text: "预算偏忙",
      };
    default:
      return {
        badge: "bg-emerald-500/10 text-emerald-700",
        bar: "bg-emerald-500",
        text: "预算宽松",
      };
  }
}

function getArtifactSourceMeta(source: DialogArtifactRecord["source"]): {
  label: string;
  className: string;
  missingHint: string;
} {
  switch (source) {
    case "approval":
      return {
        label: "审批预览",
        className: "bg-amber-500/10 text-amber-700",
        missingHint: "这是审批阶段的候选产物，确认写入后才会真正落盘。",
      };
    case "tool_write":
      return {
        label: "工具写入",
        className: "bg-emerald-500/10 text-emerald-700",
        missingHint: "运行记录显示它曾被写入，但当前没有检测到磁盘文件。",
      };
    case "tool_edit":
      return {
        label: "工具编辑",
        className: "bg-sky-500/10 text-sky-700",
        missingHint: "运行记录显示它曾被编辑，但当前没有检测到磁盘文件。",
      };
    case "upload":
      return {
        label: "用户上传",
        className: "bg-violet-500/10 text-violet-700",
        missingHint: "这份上传文件当前已不在原路径，可能已被移动或删除。",
      };
    default:
      return {
        label: "消息引用",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
        missingHint: "当前没有检测到该路径对应的文件。",
      };
  }
}

function ArtifactPathActions({ filePath, available }: { filePath: string; available: boolean }) {
  const fileName = basename(filePath);

  if (!available) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => {
          void invoke("open_file_location", { filePath });
        }}
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
      >
        <FolderOpen className="w-3 h-3" />
        打开位置
      </button>
      <button
        onClick={async () => {
          try {
            const { save } = await import("@tauri-apps/plugin-dialog");
            const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
            const dest = await save({ defaultPath: fileName });
            if (dest) {
              const data = await readFile(filePath);
              await writeFile(dest, data);
            }
          } catch (err) {
            if (err && typeof err === "object" && "message" in err && /cancel/i.test(String((err as Error).message))) return;
            console.warn("[ActorChatPanel] File save failed:", err);
          }
        }}
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-accent)]/10 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 transition-colors"
      >
        <FileDown className="w-3 h-3" />
        下载
      </button>
    </div>
  );
}

export function DialogWorkspaceDock({
  panel,
  onPanelChange,
  actors,
  actorTodos,
  dialogHistory,
  artifacts,
  sessionUploads,
  spawnedTasks,
  childSessions,
  contractDelegations,
  selectedRunId,
  onSelectRunId,
  onSteerSession,
  onCloseSession,
  onKillSession,
  onContinueTaskWithAgent,
  draftPlan,
  draftInsight,
  contextBreakdown,
  contextSnapshot,
  dialogRoomCompaction,
  dialogContextSummary,
  requirePlanApproval,
  onTogglePlanApproval,
  lastPlanReview,
  graphAvailable,
  onOpenGraph,
}: {
  panel: WorkspacePanel;
  onPanelChange: (panel: WorkspacePanel) => void;
  actors: ActorSnapshot[];
  actorTodos: Record<string, TodoItem[]>;
  dialogHistory: DialogMessage[];
  artifacts: DialogArtifact[];
  sessionUploads: SessionUploadRecord[];
  spawnedTasks: SpawnedTaskRecord[];
  childSessions: CollaborationChildSession[];
  contractDelegations: CollaborationContractDelegation[];
  selectedRunId: string | null;
  onSelectRunId: (runId: string) => void;
  onSteerSession: (runId: string) => void;
  onCloseSession: (runId: string) => void;
  onKillSession: (runId: string) => void;
  onContinueTaskWithAgent: (runId: string) => void;
  draftPlan: ClusterPlan | null;
  draftInsight: DialogDispatchPlanBundle["insight"] | null;
  contextBreakdown: DialogContextBreakdown;
  contextSnapshot: DialogContextSnapshot | null;
  dialogRoomCompaction: DialogRoomCompactionState | null;
  dialogContextSummary: DialogContextSummary | null;
  requirePlanApproval: boolean;
  onTogglePlanApproval: (value: boolean) => void;
  lastPlanReview: {
    status: "approved" | "rejected";
    timestamp: number;
    plan?: ClusterPlan;
    source: "human" | "auto_review" | "policy";
    risk?: "safe" | "low" | "medium" | "high" | "unknown";
    reason?: string;
  } | null;
  graphAvailable: boolean;
  onOpenGraph: (() => void) | null;
}) {
  const [showFullEarlySummary, setShowFullEarlySummary] = useState(false);
  const [showFullRoomCompaction, setShowFullRoomCompaction] = useState(false);
  const actorById = useMemo(() => {
    const map = new Map<string, ActorSnapshot>();
    actors.forEach((actor) => map.set(actor.id, actor));
    return map;
  }, [actors]);
  const actorNameById = useMemo(() => {
    const map = new Map<string, string>();
    actors.forEach((actor) => map.set(actor.id, actor.roleName));
    return map;
  }, [actors]);

  const sortedTasks = useMemo(() => {
    return [...spawnedTasks].sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return b.spawnedAt - a.spawnedAt;
    });
  }, [spawnedTasks]);
  const taskCheckpointByRunId = useMemo(() => {
    const map = new Map<string, SpawnedTaskCheckpoint>();
    for (const task of sortedTasks) {
      const checkpoint = buildSpawnedTaskCheckpoint({
        task,
        targetActor: actorById.get(task.targetActorId),
        actorTodos: actorTodos[task.targetActorId] ?? [],
        dialogHistory,
        artifacts,
        actorNameById,
      });
      if (checkpoint) {
        map.set(task.runId, checkpoint);
      }
    }
    return map;
  }, [sortedTasks, actorById, actorTodos, dialogHistory, artifacts, actorNameById]);
  const taskByRunId = useMemo(() => {
    const map = new Map<string, SpawnedTaskRecord>();
    sortedTasks.forEach((task) => map.set(task.runId, task));
    return map;
  }, [sortedTasks]);
  const childSessionByRunId = useMemo(() => {
    const map = new Map<string, CollaborationChildSession>();
    childSessions.forEach((session) => map.set(session.runId, session));
    return map;
  }, [childSessions]);
  const compactThreadRows = useMemo(() => {
    if (contractDelegations.length > 0) {
      return contractDelegations
        .map((delegation) => {
          const task = delegation.runId ? taskByRunId.get(delegation.runId) ?? null : null;
          const childSession = delegation.runId ? childSessionByRunId.get(delegation.runId) ?? null : null;
          const checkpoint = delegation.runId ? taskCheckpointByRunId.get(delegation.runId) ?? null : null;
          const targetActorId = task?.targetActorId ?? childSession?.targetActorId ?? delegation.targetActorId;
          const targetName = actorById.get(targetActorId)?.roleName ?? targetActorId;
          const summary = delegation.statusSummary
            || checkpoint?.summary
            || childSession?.lastResultSummary
            || task?.label
            || task?.task
            || `${delegation.label} 尚未派发`;
          const updatedAt = delegation.updatedAt
            ?? childSession?.updatedAt
            ?? task?.lastActiveAt
            ?? task?.completedAt
            ?? task?.spawnedAt
            ?? 0;
          return {
            id: delegation.delegationId,
            runId: delegation.runId ?? null,
            targetName,
            label: delegation.label,
            summary,
            nextStepHint: delegation.nextStepHint
              || childSession?.nextStepHint
              || checkpoint?.nextStep
              || null,
            updatedAt,
            statusMeta: getContractDelegationStatusMeta(delegation.state),
            task,
            childSession,
            delegation,
          };
        })
        .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    return sortedTasks.map((task) => {
      const childSession = childSessionByRunId.get(task.runId) ?? null;
      const checkpoint = taskCheckpointByRunId.get(task.runId) ?? null;
      return {
        id: task.runId,
        runId: task.runId,
        targetName: actorById.get(task.targetActorId)?.roleName ?? task.targetActorId,
        label: task.label ?? task.task,
        summary: checkpoint?.summary || childSession?.lastResultSummary || task.task,
        nextStepHint: childSession?.nextStepHint || checkpoint?.nextStep || null,
        updatedAt: childSession?.updatedAt ?? task.lastActiveAt ?? task.completedAt ?? task.spawnedAt,
        statusMeta: getChildSessionStatusMeta(childSession?.status ?? task.status),
        task,
        childSession,
        delegation: null,
      };
    });
  }, [actorById, childSessionByRunId, contractDelegations, sortedTasks, taskByRunId, taskCheckpointByRunId]);
  const contextNarrative = useMemo(
    () => buildDialogContextNarrative(contextSnapshot),
    [contextSnapshot],
  );
  const continuationItems = useMemo(
    () => buildContinuationItems(contextSnapshot),
    [contextSnapshot],
  );
  const contextOverviewCards = useMemo(
    () => buildContextOverviewCards(contextSnapshot),
    [contextSnapshot],
  );
  const memoryCarryItems = useMemo(
    () => buildMemoryCarryItems(contextSnapshot),
    [contextSnapshot],
  );
  const compactionItems = useMemo(
    () => buildCompactionItems(contextSnapshot, dialogRoomCompaction),
    [contextSnapshot, dialogRoomCompaction],
  );
  const earlySummaryPreview = useMemo(
    () => compactLongText(dialogContextSummary?.summary, 320),
    [dialogContextSummary],
  );
  const roomCompactionPreview = useMemo(
    () => compactLongText(dialogRoomCompaction?.summary, 360),
    [dialogRoomCompaction],
  );

  const [artifactAvailabilityByPath, setArtifactAvailabilityByPath] = useState<Record<string, ArtifactAvailability>>({});

  useEffect(() => {
    setShowFullEarlySummary(false);
    setShowFullRoomCompaction(false);
  }, [panel, dialogContextSummary?.updatedAt, dialogRoomCompaction?.updatedAt]);

  useEffect(() => {
    if (panel !== "artifacts") return;
    if (artifacts.length === 0) {
      setArtifactAvailabilityByPath({});
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const { exists } = await import("@tauri-apps/plugin-fs");
        const entries = await Promise.all(
          artifacts.map(async (artifact) => [
            artifact.path,
            (await exists(artifact.path)) ? "ready" : "missing",
          ] as const),
        );
        if (!cancelled) {
          setArtifactAvailabilityByPath(Object.fromEntries(entries));
        }
      } catch (error) {
        console.warn("[ActorChatPanel] Failed to verify artifact existence:", error);
        if (!cancelled) {
          setArtifactAvailabilityByPath(
            Object.fromEntries(artifacts.map((artifact) => [artifact.path, "unknown" as ArtifactAvailability])),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [panel, artifacts]);

  const activeTodoCount = useMemo(
    () =>
      Object.values(actorTodos).reduce(
        (sum, todos) =>
          sum + todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length,
        0,
      ),
    [actorTodos],
  );

  const totalTodoCount = useMemo(
    () => Object.values(actorTodos).reduce((sum, todos) => sum + todos.length, 0),
    [actorTodos],
  );

  const openSessionCount = useMemo(
    () => sortedTasks.filter((task) => task.mode === "session" && task.sessionOpen).length,
    [sortedTasks],
  );

  const workspaceTabs: Array<{
    id: Exclude<WorkspacePanel, null>;
    label: string;
    icon: LucideIcon;
    count: number;
    description: string;
  }> = [
    {
      id: "todos",
      label: "待办",
      icon: ListChecks,
      count: activeTodoCount || totalTodoCount,
      description: activeTodoCount > 0 ? `${activeTodoCount} 个活跃待办` : "查看全部 Agent 待办",
    },
    {
      id: "artifacts",
      label: "产物",
      icon: FileDown,
      count: artifacts.length,
      description: artifacts.length > 0 ? "浏览本轮生成的文件产物" : "当前还没有生成文件产物",
    },
    {
      id: "uploads",
      label: "上传",
      icon: FolderOpen,
      count: sessionUploads.length,
      description: sessionUploads.length > 0 ? "查看会话上传与上下文附件" : "当前会话没有登记上传项",
    },
    {
      id: "subtasks",
      label: "子任务",
      icon: Network,
      count: sortedTasks.length,
      description: openSessionCount > 0 ? `${openSessionCount} 个后台线程仍在保留` : "查看已派发子任务与后台线程",
    },
    {
      id: "context",
      label: "上下文",
      icon: Brain,
      count: contextBreakdown.totalSharedTokens + contextBreakdown.totalRuntimeTokens,
      description: "查看续跑上下文、房间压缩保留和记忆回补，再下钻到成本估算",
    },
    {
      id: "plan",
      label: "计划",
      icon: ShieldCheck,
      count: draftPlan?.steps.length ?? 0,
      description: requirePlanApproval ? "发送前会先审批执行计划" : "当前发送将直接进入执行",
    },
  ];

  const activePanelMeta = panel
    ? workspaceTabs.find((tab) => tab.id === panel) ?? null
    : null;
  const ActivePanelIcon = activePanelMeta?.icon ?? ListChecks;
  const defaultPanel = useMemo<Exclude<WorkspacePanel, null>>(() => {
    if (activeTodoCount > 0 || totalTodoCount > 0) return "todos";
    if (sortedTasks.length > 0) return "subtasks";
    if (contextBreakdown.totalSharedTokens > 0 || contextBreakdown.totalRuntimeTokens > 0) return "context";
    if (artifacts.length > 0) return "artifacts";
    if (sessionUploads.length > 0) return "uploads";
    return "plan";
  }, [
    activeTodoCount,
    totalTodoCount,
    sortedTasks.length,
    contextBreakdown.totalRuntimeTokens,
    contextBreakdown.totalSharedTokens,
    artifacts.length,
    sessionUploads.length,
  ]);
  const currentPanelLabel = activePanelMeta ? `工作台 · ${activePanelMeta.label}` : "工作台";

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] ${
            requirePlanApproval
              ? "border-amber-500/25 bg-amber-500/10 text-amber-700"
              : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 text-[var(--color-text-secondary)]"
          }`}
        >
          {requirePlanApproval ? "发送前审批" : "直接发送"}
        </span>
        {graphAvailable && onOpenGraph && (
          <button
            onClick={onOpenGraph}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-fuchsia-500/30 hover:text-fuchsia-600 transition-colors"
            title="查看当前房间的角色关系、消息流和子任务派发"
          >
            <Network className="w-3 h-3" />
            协作图
          </button>
        )}
        <button
          onClick={() => onPanelChange(panel ? null : defaultPanel)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
            panel
              ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
              : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/25 hover:text-[var(--color-text)]"
          }`}
          title="打开会话工作台"
        >
          <ListChecks className="w-3 h-3" />
          {panel ? currentPanelLabel : "工作台"}
        </button>
      </div>

      {panel && activePanelMeta && (
        <>
          <div className="absolute inset-0 z-20 bg-black/20" onClick={() => onPanelChange(null)} />
          <div className="absolute inset-3 z-30 flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl md:inset-y-3 md:right-3 md:left-auto md:w-[min(760px,calc(100%-1rem))]">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-3.5 py-2.5 backdrop-blur-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-2xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
                    <ActivePanelIcon className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-[13px] font-medium text-[var(--color-text)]">{activePanelMeta.label}</span>
                  <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                    {formatTokenCount(activePanelMeta.count)}
                  </span>
                </div>
                <div className="mt-1 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
                  {activePanelMeta.description}
                </div>
              </div>
              <button
                onClick={() => onPanelChange(null)}
                className="rounded-xl p-1.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
              <div className="flex flex-wrap gap-1.5">
                {workspaceTabs.map((tab) => {
                  const active = panel === tab.id;
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => onPanelChange(tab.id)}
                      className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] transition-all ${
                        active
                          ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/10 text-[var(--color-text)] shadow-sm"
                          : "border-[var(--color-border)] bg-[var(--color-bg)]/75 text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/25 hover:text-[var(--color-text)]"
                      }`}
                      title={tab.description}
                    >
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          active ? "bg-[var(--color-accent)]/12 text-[var(--color-accent)]" : "bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)]"
                        }`}
                      >
                        <Icon className="w-3 h-3" />
                      </span>
                      <span>{tab.label}</span>
                      {tab.count > 0 && (
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[9px] ${
                            active
                              ? "bg-[var(--color-bg)] text-[var(--color-text-secondary)]"
                              : "bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)]"
                          }`}
                        >
                          {formatTokenCount(tab.count)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-[var(--color-bg-secondary)]/35">
              {panel === "todos" && (
                <div className="p-3 space-y-2.5">
                  {actors.map((actor) => {
                    const todos = actorTodos[actor.id] ?? [];
                    const activeTodos = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
                    return (
                      <div key={actor.id} className="rounded-xl border border-[var(--color-border)]/80 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[12px] font-medium text-[var(--color-text)]">{actor.roleName}</div>
                          <div className="text-[10px] text-[var(--color-text-tertiary)]">
                            活跃 {activeTodos.length} / 全部 {todos.length}
                          </div>
                        </div>
                        {todos.length === 0 ? (
                          <div className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">当前没有待办。</div>
                        ) : (
                          <div className="mt-2 grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
                            {todos
                              .slice()
                              .sort((a, b) => b.updatedAt - a.updatedAt)
                              .map((todo) => (
                                <div key={todo.id} className="rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/70 px-2.5 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[11px] font-medium text-[var(--color-text)]">{todo.title}</span>
                                    <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">{todo.priority}</span>
                                  </div>
                                  <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
                                    <span>{todo.status}</span>
                                    <span>更新于 {formatShortTime(todo.updatedAt)}</span>
                                  </div>
                                  {todo.notes && (
                                    <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{todo.notes}</div>
                                  )}
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {panel === "artifacts" && (
                <div className="p-3 space-y-2.5">
                  {artifacts.length === 0 ? (
                    <div className="text-[12px] text-[var(--color-text-tertiary)]">当前还没有检测到文件产物。</div>
                  ) : (
                    artifacts.map((artifact) => (
                      <div key={artifact.id} className="rounded-xl border border-[var(--color-border)]/80 p-2.5">
                        {(() => {
                          const sourceMeta = getArtifactSourceMeta(artifact.source);
                          const availability = artifactAvailabilityByPath[artifact.path] ?? "unknown";
                          const availabilityLabel = availability === "ready"
                            ? "已落盘"
                            : availability === "missing"
                              ? (artifact.source === "approval" ? "未落盘" : "文件缺失")
                              : "未验证";
                          const availabilityClass = availability === "ready"
                            ? "bg-emerald-500/10 text-emerald-700"
                            : availability === "missing"
                              ? "bg-amber-500/10 text-amber-700"
                              : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]";

                          return (
                            <>
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="text-[12px] font-medium text-[var(--color-text)]">{artifact.fileName}</div>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${sourceMeta.className}`}>
                                  {sourceMeta.label}
                                </span>
                                {artifact.relatedRunId && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600">
                                    子会话产物
                                  </span>
                                )}
                                {artifact.toolName && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
                                    {artifact.toolName}
                                  </span>
                                )}
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${availabilityClass}`}>
                                  {availabilityLabel}
                                </span>
                                <span className="text-[10px] text-[var(--color-text-tertiary)]">
                                  {artifact.actorName} · {formatShortTime(artifact.timestamp)}
                                </span>
                              </div>
                              <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                                {artifact.summary}
                              </div>
                              <div className="mt-1 text-[10px] text-[var(--color-text-tertiary)] break-all">
                                {artifact.path}
                              </div>
                              {availability === "missing" && (
                                <div className="mt-2 rounded-lg border border-amber-500/15 bg-amber-500/5 px-2.5 py-2 text-[10px] leading-relaxed text-amber-800">
                                  {sourceMeta.missingHint}
                                </div>
                              )}
                              {(artifact.preview || artifact.fullContent) && (
                                <div className="mt-2 rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/60 px-3 py-2">
                                  <div className="text-[10px] text-[var(--color-text-tertiary)]">
                                    {artifact.language ? `${artifact.language} 预览` : "内容预览"}
                                  </div>
                                  <pre className="mt-1 max-h-[180px] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                                    {artifact.preview || artifact.fullContent}
                                  </pre>
                                </div>
                              )}
                              <div className="mt-2">
                                <ArtifactPathActions filePath={artifact.path} available={availability === "ready"} />
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    ))
                  )}
                </div>
              )}

              {panel === "uploads" && (
                <div className="p-3 space-y-2.5">
                  {sessionUploads.length === 0 ? (
                    <div className="text-[12px] text-[var(--color-text-tertiary)]">当前会话没有登记上传项。</div>
                  ) : (
                    sessionUploads.map((upload) => (
                      <div key={upload.id} className="rounded-xl border border-[var(--color-border)]/80 p-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-[12px] font-medium text-[var(--color-text)]">{upload.name}</div>
                          <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                            {upload.type}
                          </span>
                          {upload.multimodalEligible && (
                            <span className="rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700">
                              视觉可读
                            </span>
                          )}
                          {upload.parsed && (
                            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700">
                              已解析
                            </span>
                          )}
                          <span className="text-[10px] text-[var(--color-text-tertiary)]">
                            {formatShortTime(upload.addedAt)}
                          </span>
                        </div>
                        {upload.path && (
                          <div className="mt-1 break-all text-[10px] text-[var(--color-text-tertiary)]">
                            {upload.path}
                          </div>
                        )}
                        {upload.excerpt && (
                          <div className="mt-2 rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/60 px-3 py-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-wrap break-words">
                            {upload.excerpt}
                            {upload.truncated ? "..." : ""}
                          </div>
                        )}
                        {upload.path && (
                          <div className="mt-2">
                            <ArtifactPathActions filePath={upload.path} available />
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}

              {panel === "subtasks" && (
                <div className="p-3 space-y-2.5">
                  {compactThreadRows.length === 0 ? (
                    <div className="text-[12px] text-[var(--color-text-tertiary)]">当前还没有派发子任务。</div>
                  ) : (
                    <div className="space-y-2">
                      {compactThreadRows.map((row) => {
                        const isSelected = Boolean(row.runId && row.runId === selectedRunId);
                        const canSteer = Boolean(row.runId && row.childSession?.mode === "session" && row.childSession.resumable);
                        const canClose = Boolean(row.runId && row.task?.mode === "session" && row.task.sessionOpen && row.childSession?.resumable);
                        const canKill = Boolean(row.runId && row.task?.mode === "session" && row.task.sessionOpen);
                        const note = row.delegation?.state === "available"
                          ? "这是已批准的建议委派。是否真的派工，由主 Agent 自主决定。"
                          : row.delegation?.state === "stale"
                            ? "这条建议委派关联的是旧线程或失效目标，当前只保留摘要。"
                            : row.childSession?.status === "waiting"
                              ? "后台线程已保留，主 Agent 后续可以继续复用这段上下文。"
                              : row.childSession?.status === "completed"
                                ? "该线程已结束，当前保留的是结果摘要。"
                                : row.childSession?.lastError
                                  ? row.childSession.lastError
                                  : null;
                        const detail = row.nextStepHint ?? note;

                        return (
                          <div
                            key={row.id}
                            className={`rounded-xl border px-3 py-2.5 ${
                              isSelected
                                ? "border-[var(--color-accent)]/30 bg-[var(--color-accent)]/8"
                                : "border-[var(--color-border)]/80 bg-[var(--color-bg)]"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                if (row.runId) onSelectRunId(row.runId);
                              }}
                              className="flex w-full items-start gap-2 text-left"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
                                    {row.label}
                                  </div>
                                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${row.statusMeta.className}`}>
                                    {row.statusMeta.label}
                                  </span>
                                  {row.task?.mode === "session" && (
                                    <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-700">
                                      子会话
                                    </span>
                                  )}
                                  {row.childSession?.focusable && (
                                    <span className="shrink-0 rounded-full bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-700">
                                      已保留
                                    </span>
                                  )}
                                  {row.task?.roleBoundary && (
                                    <span className="shrink-0 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-700">
                                      {row.task.roleBoundary}
                                    </span>
                                  )}
                                  <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
                                    {row.targetName}
                                  </span>
                                  {row.updatedAt > 0 && (
                                    <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
                                      {formatShortTime(row.updatedAt)}
                                    </span>
                                  )}
                                </div>
                                <div
                                  className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]"
                                  title={row.summary}
                                >
                                  {row.summary}
                                </div>
                              </div>
                            </button>

                            {detail && (
                              <div className="mt-2 text-[10px] leading-relaxed text-[var(--color-text-tertiary)]">
                                {detail}
                              </div>
                            )}

                            {row.runId && (
                              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                {canSteer && (
                                  <button
                                    onClick={() => onSteerSession(row.runId!)}
                                    className="rounded-full border border-sky-500/25 bg-sky-500/8 px-3 py-1 text-[10px] text-sky-700 transition-colors hover:bg-sky-500/12"
                                  >
                                    补充指令
                                  </button>
                                )}
                                <button
                                  onClick={() => onContinueTaskWithAgent(row.runId!)}
                                  className="rounded-full bg-[var(--color-accent)]/10 px-3 py-1 text-[10px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/15"
                                >
                                  转到 Agent 继续
                                </button>
                                {canClose && (
                                  <button
                                    onClick={() => onCloseSession(row.runId!)}
                                    className="rounded-full border border-amber-500/25 bg-amber-500/8 px-3 py-1 text-[10px] text-amber-700 transition-colors hover:bg-amber-500/12"
                                  >
                                    结束保留
                                  </button>
                                )}
                                {canKill && (
                                  <button
                                    onClick={() => onKillSession(row.runId!)}
                                    className="rounded-full border border-red-500/25 bg-red-500/8 px-3 py-1 text-[10px] text-red-700 transition-colors hover:bg-red-500/12"
                                  >
                                    立即中止
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {panel === "context" && (
                <div className="p-3 space-y-2.5">
                  <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)] px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                      这页在说明什么
                    </div>
                    <div className="mt-2 text-[12px] leading-6 text-[var(--color-text)]">
                      {contextNarrative}
                    </div>
                  </div>

                  <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)] px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                      执行概览
                    </div>
                    <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                      {contextOverviewCards.map((card) => (
                        <div
                          key={card.label}
                          className="rounded-xl border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/65 px-3 py-2.5"
                        >
                          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                            {card.label}
                          </div>
                          <div className={`mt-1 text-[18px] font-semibold ${card.toneClassName ?? "text-[var(--color-text)]"}`}>
                            {card.value}
                          </div>
                          <div className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                            {card.detail}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-2.5 md:grid-cols-2">
                    <div className="rounded-xl border border-sky-500/15 bg-sky-500/5 px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.12em] text-sky-700">本轮会沿用什么</div>
                      <div className="mt-2 space-y-1.5">
                        {continuationItems.map((item) => (
                          <div key={item} className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/5 px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.12em] text-emerald-700">系统如何接住复杂房间</div>
                      <div className="mt-2 space-y-1.5">
                        {compactionItems.map((item) => (
                          <div key={item} className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-violet-500/15 bg-violet-500/5 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-violet-700">记忆如何回补</div>
                    <div className="mt-2 space-y-1.5">
                      {memoryCarryItems.map((item) => (
                        <div key={item} className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>

                  {dialogContextSummary && (
                    <div className="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[10px] uppercase tracking-[0.12em] text-cyan-700">早期协作摘要</div>
                        <span className="rounded-full border border-cyan-500/20 bg-white/70 px-1.5 py-0.5 text-[10px] text-cyan-700">
                          已整理 {dialogContextSummary.summarizedMessageCount} 条消息
                        </span>
                        <span className="text-[10px] text-[var(--color-text-tertiary)]">
                          更新于 {formatShortTime(dialogContextSummary.updatedAt)}
                        </span>
                      </div>
                      <div className="mt-2 text-[11px] leading-6 text-[var(--color-text-secondary)]">
                        {showFullEarlySummary ? dialogContextSummary.summary : earlySummaryPreview}
                      </div>
                      {dialogContextSummary.summary.length > earlySummaryPreview.length && (
                        <button
                          onClick={() => setShowFullEarlySummary((value) => !value)}
                          className="mt-2 rounded-full border border-cyan-500/20 bg-white/75 px-3 py-1 text-[10px] text-cyan-700 transition-colors hover:bg-white"
                        >
                          {showFullEarlySummary ? "收起详情" : "展开详情"}
                        </button>
                      )}
                    </div>
                  )}

                  {dialogRoomCompaction && (
                    <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/5 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[10px] uppercase tracking-[0.12em] text-emerald-700">房间压缩保留</div>
                        <span className="rounded-full border border-emerald-500/20 bg-white/70 px-1.5 py-0.5 text-[10px] text-emerald-700">
                          消息 {dialogRoomCompaction.compactedMessageCount}
                        </span>
                        <span className="rounded-full border border-emerald-500/20 bg-white/70 px-1.5 py-0.5 text-[10px] text-emerald-700">
                          子任务 {dialogRoomCompaction.compactedSpawnedTaskCount}
                        </span>
                        <span className="rounded-full border border-emerald-500/20 bg-white/70 px-1.5 py-0.5 text-[10px] text-emerald-700">
                          产物 {dialogRoomCompaction.compactedArtifactCount}
                        </span>
                        <span className="text-[10px] text-[var(--color-text-tertiary)]">
                          更新于 {formatShortTime(dialogRoomCompaction.updatedAt)}
                        </span>
                      </div>
                      {dialogRoomCompaction.triggerReasons?.length ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {dialogRoomCompaction.triggerReasons.map((reason) => (
                            <span
                              key={reason}
                              className="rounded-full border border-emerald-500/15 bg-white/70 px-2 py-0.5 text-[10px] text-emerald-700"
                            >
                              {reason}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-2 text-[11px] leading-6 text-[var(--color-text-secondary)]">
                        {showFullRoomCompaction ? dialogRoomCompaction.summary : roomCompactionPreview}
                      </div>
                      {dialogRoomCompaction.summary.length > roomCompactionPreview.length && (
                        <button
                          onClick={() => setShowFullRoomCompaction((value) => !value)}
                          className="mt-2 rounded-full border border-emerald-500/20 bg-white/75 px-3 py-1 text-[10px] text-emerald-700 transition-colors hover:bg-white"
                        >
                          {showFullRoomCompaction ? "收起详情" : "展开详情"}
                        </button>
                      )}
                      {(dialogRoomCompaction.preservedIdentifiers.length > 0
                        || (dialogRoomCompaction.memoryConfirmedCount ?? 0) > 0
                        || (dialogRoomCompaction.memoryQueuedCount ?? 0) > 0) && (
                        <div className="mt-3 space-y-2">
                          {dialogRoomCompaction.preservedIdentifiers.length > 0 && (
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.12em] text-emerald-700">保留线索</div>
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {dialogRoomCompaction.preservedIdentifiers.map((item) => (
                                  <span
                                    key={item}
                                    className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                                  >
                                    {item}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {((dialogRoomCompaction.memoryConfirmedCount ?? 0) > 0
                            || (dialogRoomCompaction.memoryQueuedCount ?? 0) > 0) && (
                            <div className="rounded-lg border border-emerald-500/10 bg-white/70 px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">
                              已沉淀记忆：确认 {dialogRoomCompaction.memoryConfirmedCount ?? 0} 条，候选 {dialogRoomCompaction.memoryQueuedCount ?? 0} 条
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)] px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                      续跑细项清单
                    </div>
                    <div className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                      下面这部分是系统实际会带着继续执行的清单，用来解释“会沿用什么”，不是调试日志。
                    </div>
                  </div>

                  {hasDialogContextSnapshotContent(contextSnapshot) && (
                    <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)] px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                          续跑细项清单
                        </div>
                        {contextSnapshot?.generatedAt && (
                          <span className="text-[10px] text-[var(--color-text-tertiary)]">
                            更新于 {formatShortTime(contextSnapshot.generatedAt)}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {contextSnapshot?.contextLines.map((line, index) => (
                          <div
                            key={`${index}-${line}`}
                            className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]"
                          >
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)] px-3 py-3">
                    <div className="mb-2 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                      成本观察（调试）
                    </div>
                    <div className="mb-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                      这一段主要给调试和预算判断使用，所以放在最后，避免整个上下文页看起来像纯 token 诊断面板。
                    </div>
                    <div className="grid gap-2 md:grid-cols-3">
                      <div className="rounded-lg bg-[var(--color-bg-secondary)]/70 px-3 py-2">
                        <div className="text-[10px] text-[var(--color-text-tertiary)]">共享工作集</div>
                        <div className="mt-1 text-[18px] font-semibold text-[var(--color-text)]">
                          ~{formatTokenCount(contextBreakdown.totalSharedTokens)}
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                          房间消息、上传、产物、子任务与计划草案的总估算
                        </div>
                      </div>
                      <div className="rounded-lg bg-[var(--color-bg-secondary)]/70 px-3 py-2">
                        <div className="text-[10px] text-[var(--color-text-tertiary)]">运行现场</div>
                        <div className="mt-1 text-[18px] font-semibold text-[var(--color-text)]">
                          ~{formatTokenCount(contextBreakdown.totalRuntimeTokens)}
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                          正在执行的 query 与近期步骤轨迹估算
                        </div>
                      </div>
                      <div className="rounded-lg bg-[var(--color-bg-secondary)]/70 px-3 py-2">
                        <div className="text-[10px] text-[var(--color-text-tertiary)]">附件与会话</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
                          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5">
                            文件 {contextBreakdown.attachmentCount}
                          </span>
                          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5">
                            图片 {contextBreakdown.imageCount}
                          </span>
                          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5">
                            开放子会话 {contextBreakdown.openSessionCount}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                          这些元素越多，后续协作越容易变重
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] leading-relaxed text-[var(--color-text-tertiary)]">
                      这里展示的是前端侧的粗略 token 估算，便于判断“哪里在变重”。不包含 provider framing、系统保留字段和服务端额外压缩。
                    </div>
                  </div>

                  {contextBreakdown.warnings.length > 0 && (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-[0.12em] text-amber-700">上下文提醒</div>
                      <div className="mt-2 space-y-1.5">
                        {contextBreakdown.warnings.map((warning) => (
                          <div key={warning} className="text-[11px] leading-relaxed text-amber-800">
                            {warning}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)] px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-medium text-[var(--color-text)]">共享工作集拆解</div>
                      <div className="text-[10px] text-[var(--color-text-tertiary)]">
                        合计 ~{formatTokenCount(contextBreakdown.totalSharedTokens)}
                      </div>
                    </div>
                    <div className="mt-2 space-y-2">
                      {contextBreakdown.sharedSections.length === 0 ? (
                        <div className="text-[11px] text-[var(--color-text-tertiary)]">当前还没有足够的共享上下文线索。</div>
                      ) : (
                        contextBreakdown.sharedSections.map((section) => {
                          const share = contextBreakdown.totalSharedTokens > 0
                            ? section.tokens / contextBreakdown.totalSharedTokens
                            : 0;
                          return (
                            <div key={section.id} className="rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/60 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-medium text-[var(--color-text)]">{section.label}</span>
                                <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                                  ~{formatTokenCount(section.tokens)}
                                </span>
                                {section.itemCount > 0 && (
                                  <span className="text-[10px] text-[var(--color-text-tertiary)]">
                                    {section.itemCount} 项
                                  </span>
                                )}
                                <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">
                                  {formatRatioAsPercent(share)}
                                </span>
                              </div>
                              <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                                {section.description}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-bg)] px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-medium text-[var(--color-text)]">Agent 估算上下文与运行现场</div>
                      <div className="text-[10px] text-[var(--color-text-tertiary)]">
                        总估算 = 共享工作集 + 专属记忆 + 运行现场
                      </div>
                    </div>
                    <div className="mt-2 space-y-2">
                      {contextBreakdown.actors.length === 0 ? (
                        <div className="text-[11px] text-[var(--color-text-tertiary)]">当前还没有 Agent。</div>
                      ) : (
                        contextBreakdown.actors.map((actor) => {
                          const statusMeta = getContextStatusMeta(actor.status);
                          return (
                            <div key={actor.actorId || actor.roleName} className="rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/60 px-3 py-2.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="text-[12px] font-medium text-[var(--color-text)]">{actor.roleName}</div>
                                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${statusMeta.badge}`}>
                                  {statusMeta.text}
                                </span>
                                <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                                  {actor.modelLabel}
                                </span>
                                {actor.thinkingLevel && actor.thinkingLevel !== "adaptive" && (
                                  <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                                    思考 {actor.thinkingLevel}
                                  </span>
                                )}
                                {actor.workspaceLabel && (
                                  <span className="max-w-[160px] truncate rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]" title={actor.workspaceLabel}>
                                    {actor.workspaceLabel}
                                  </span>
                                )}
                              </div>
                              <div className="mt-2">
                                <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-tertiary)]">
                                  <span>预计总上下文占用</span>
                                  <span>
                                    ~{formatTokenCount(actor.estimatedTotalTokens)} / {formatTokenCount(actor.budgetTokens)} · {formatRatioAsPercent(actor.estimatedTotalRatio)}
                                  </span>
                                </div>
                                <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--color-bg)]">
                                  <div
                                    className={`h-full rounded-full ${statusMeta.bar}`}
                                    style={{ width: `${Math.min(actor.estimatedTotalRatio * 100, 100)}%` }}
                                  />
                                </div>
                              </div>
                              <div className="mt-2 grid gap-2 md:grid-cols-4">
                                <div className="rounded-lg bg-[var(--color-bg)] px-2.5 py-2">
                                  <div className="text-[10px] text-[var(--color-text-tertiary)]">共享工作集</div>
                                  <div className="mt-1 text-[12px] text-[var(--color-text)]">~{formatTokenCount(actor.sharedTokens)}</div>
                                </div>
                                <div className="rounded-lg bg-[var(--color-bg)] px-2.5 py-2">
                                  <div className="text-[10px] text-[var(--color-text-tertiary)]">历史记忆</div>
                                  <div className="mt-1 text-[12px] text-[var(--color-text)]">~{formatTokenCount(actor.memoryTokens)}</div>
                                </div>
                                <div className="rounded-lg bg-[var(--color-bg)] px-2.5 py-2">
                                  <div className="text-[10px] text-[var(--color-text-tertiary)]">角色附加提示</div>
                                  <div className="mt-1 text-[12px] text-[var(--color-text)]">~{formatTokenCount(actor.promptTokens)}</div>
                                </div>
                                <div className="rounded-lg bg-[var(--color-bg)] px-2.5 py-2">
                                  <div className="text-[10px] text-[var(--color-text-tertiary)]">运行现场</div>
                                  <div className="mt-1 text-[12px] text-[var(--color-text)]">~{formatTokenCount(actor.runtimeTokens)}</div>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              )}

              {panel === "plan" && (
                <div className="p-3 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-[12px] text-[var(--color-text)]">
                      <input
                        type="checkbox"
                        checked={requirePlanApproval}
                        onChange={(e) => onTogglePlanApproval(e.target.checked)}
                        className="rounded"
                      />
                      发送前先审批执行计划
                    </label>
                    {lastPlanReview && (
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                        lastPlanReview.status === "approved"
                          ? "bg-emerald-500/10 text-emerald-600"
                          : "bg-red-500/10 text-red-600"
                      }`}>
                        最近一次{lastPlanReview.status === "approved"
                          ? (lastPlanReview.source === "human" ? "人工批准" : "自动通过")
                          : (lastPlanReview.source === "policy" ? "策略拦截" : "已拒绝")} · {formatShortTime(lastPlanReview.timestamp)}
                      </span>
                    )}
                  </div>
                  {draftPlan ? (
                    <div className="space-y-2">
                      {draftInsight?.autoModeLabel && (
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-700">
                            自动识别 {draftInsight.autoModeLabel}
                          </span>
                          {draftInsight.focusLabel && (
                            <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-sky-700">
                              {draftInsight.focusLabel}
                            </span>
                          )}
                          {draftInsight.reasons[0] && (
                            <span
                              className="truncate text-[10px] text-[var(--color-text-tertiary)]"
                              title={draftInsight.reasons.join(" · ")}
                            >
                              {draftInsight.reasons[0]}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="text-[11px] text-[var(--color-text-secondary)]">
                        当前输入会生成以下 dispatch plan 预览。
                      </div>
                      {draftPlan.steps.map((step) => (
                        <div key={step.id} className="rounded-xl border border-[var(--color-border)]/80 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-[var(--color-text)]">{step.role}</span>
                            <span className="text-[10px] text-[var(--color-text-tertiary)]">{step.id}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{step.task}</div>
                          {step.dependencies.length > 0 && (
                            <div className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">
                              依赖: {step.dependencies.join(", ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[12px] text-[var(--color-text-tertiary)]">
                      输入一条新任务后，这里会显示即将发送给 dialog runtime 的执行计划预览。
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
