import type {
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import { pickVisualAttachmentPaths } from "@/core/ai/ai-center-handoff";

export interface DialogWorkingSetArtifactEntry {
  path: string;
  fileName: string;
  actorName?: string;
}

export interface DialogWorkingSetSnapshot {
  attachmentPaths: string[];
  visualAttachmentPaths: string[];
  artifactSummaryLines: string[];
  spawnedTaskSummaryLines: string[];
  uploadSummaryLine?: string;
  visualSummaryLine?: string;
  summary: string;
  openSessionCount: number;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function dirname(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/") || "/";
}

export function buildDialogWorkingSetSnapshot(params: {
  artifacts: readonly DialogWorkingSetArtifactEntry[];
  sessionUploads: readonly SessionUploadRecord[];
  spawnedTasks: readonly SpawnedTaskRecord[];
  actorNameById?: ReadonlyMap<string, string>;
  extraAttachmentPaths?: readonly string[];
  maxArtifacts?: number;
  maxSpawnedTasks?: number;
  maxAttachmentPaths?: number;
}): DialogWorkingSetSnapshot {
  const {
    artifacts,
    sessionUploads,
    spawnedTasks,
    actorNameById,
    extraAttachmentPaths,
    maxArtifacts = 6,
    maxSpawnedTasks = 6,
    maxAttachmentPaths = 16,
  } = params;

  const attachmentPaths = Array.from(
    new Set(
      [
        ...artifacts.map((artifact) => artifact.path),
        ...sessionUploads.map((upload) => upload.path),
        ...(extraAttachmentPaths ?? []),
      ].filter((path): path is string => typeof path === "string" && path.trim().length > 0),
    ),
  ).slice(0, maxAttachmentPaths);
  const visualAttachmentPaths = pickVisualAttachmentPaths(
    attachmentPaths,
    Math.min(maxAttachmentPaths, 12),
  ) ?? [];

  const artifactSummaryLines = artifacts
    .slice(0, maxArtifacts)
    .map((artifact) => `- ${artifact.fileName} (${artifact.actorName || "未知来源"}) · ${dirname(artifact.path) || "/"}`);

  const spawnedTaskSummaryLines = [...spawnedTasks]
    .sort((a, b) => {
      const aTime = a.lastActiveAt ?? a.completedAt ?? a.spawnedAt;
      const bTime = b.lastActiveAt ?? b.completedAt ?? b.spawnedAt;
      return bTime - aTime;
    })
    .slice(0, maxSpawnedTasks)
    .map((task) => {
      const actorName = actorNameById?.get(task.targetActorId) ?? task.targetActorId;
      const statusLabel = task.mode === "session" && task.sessionOpen
        ? "开放子会话"
        : task.status === "running"
          ? "运行中"
          : task.status === "completed"
            ? "已完成"
            : task.status === "aborted"
              ? "已中止"
              : "失败";
      const label = (task.label || task.task || "").trim();
      const preview = label.length > 80 ? `${label.slice(0, 80)}...` : label || basename(actorName);
      return `- [${statusLabel}] ${actorName}: ${preview}`;
    });

  const uploadSummaryLine = sessionUploads.length > 0
    ? `当前房间登记了 ${sessionUploads.length} 份上传/上下文附件：${sessionUploads
      .slice(0, 5)
      .map((upload) => upload.name)
      .join("、")}。`
    : undefined;
  const visualSummaryLine = visualAttachmentPaths.length > 0
    ? `当前工作集附带 ${visualAttachmentPaths.length} 张视觉参考图：${visualAttachmentPaths
      .slice(0, 4)
      .map((path) => basename(path))
      .join("、")}。`
    : undefined;

  const openSessionCount = spawnedTasks.filter(
    (task) => task.mode === "session" && task.sessionOpen,
  ).length;

  const summaryParts = [
    "Dialog 协作上下文",
    attachmentPaths.length > 0 ? `附带 ${attachmentPaths.length} 个文件/图片` : "",
    visualAttachmentPaths.length > 0 ? `${visualAttachmentPaths.length} 张视觉参考图` : "",
    artifacts.length > 0 ? `${Math.min(artifacts.length, maxArtifacts)} 个产物线索` : "",
    openSessionCount > 0 ? `${openSessionCount} 个开放子会话` : "",
  ].filter(Boolean);

  return {
    attachmentPaths,
    visualAttachmentPaths,
    artifactSummaryLines,
    spawnedTaskSummaryLines,
    uploadSummaryLine,
    visualSummaryLine,
    summary: summaryParts.join("，"),
    openSessionCount,
  };
}
