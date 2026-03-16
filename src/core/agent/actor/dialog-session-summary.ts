import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type {
  DialogArtifactRecord,
  DialogContextSummary,
  DialogMessage,
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "./types";

interface BuildDialogContextSummaryParams {
  dialogHistory: readonly DialogMessage[];
  artifacts?: readonly DialogArtifactRecord[];
  sessionUploads?: readonly SessionUploadRecord[];
  spawnedTasks?: readonly SpawnedTaskRecord[];
  actorNameById?: ReadonlyMap<string, string>;
  keepRecentMessages?: number;
}

function clip(text: string, max = 140): string {
  return summarizeAISessionRuntimeText(text, max) || text.slice(0, max);
}

export function buildDialogContextSummary({
  dialogHistory,
  artifacts = [],
  sessionUploads = [],
  spawnedTasks = [],
  actorNameById,
  keepRecentMessages = 12,
}: BuildDialogContextSummaryParams): DialogContextSummary | null {
  if (dialogHistory.length <= keepRecentMessages) {
    return null;
  }

  const olderMessages = dialogHistory.slice(0, -keepRecentMessages);
  if (olderMessages.length === 0) {
    return null;
  }

  const earlyUserRequests = [...olderMessages]
    .reverse()
    .filter((message) => message.from === "user")
    .slice(0, 4)
    .map((message) => clip(message._briefContent || message.content, 120))
    .filter(Boolean)
    .reverse();

  const earlyResults = [...olderMessages]
    .reverse()
    .filter((message) => message.from !== "user")
    .slice(0, 4)
    .map((message) => {
      const actorName = actorNameById?.get(message.from) ?? message.from;
      return `${actorName}：${clip(message._briefContent || message.content, 120)}`;
    })
    .filter(Boolean)
    .reverse();

  const artifactLines = artifacts
    .slice(-3)
    .map((artifact) => `${artifact.fileName}：${clip(artifact.summary, 80)}`);

  const uploadLines = sessionUploads
    .slice(-3)
    .map((upload) => upload.name)
    .filter(Boolean);

  const taskLines = spawnedTasks
    .slice(-4)
    .map((task) => {
      const actorName = actorNameById?.get(task.targetActorId) ?? task.targetActorId;
      return `${actorName} · ${clip(task.label || task.task, 80)} · ${task.status}`;
    });

  const sections = [
    earlyUserRequests.length > 0
      ? `早期用户诉求：\n${earlyUserRequests.map((line) => `- ${line}`).join("\n")}`
      : "",
    earlyResults.length > 0
      ? `已形成的房间结论：\n${earlyResults.map((line) => `- ${line}`).join("\n")}`
      : "",
    artifactLines.length > 0
      ? `已产生产物：\n${artifactLines.map((line) => `- ${line}`).join("\n")}`
      : "",
    taskLines.length > 0
      ? `较早的子任务进展：\n${taskLines.map((line) => `- ${line}`).join("\n")}`
      : "",
    uploadLines.length > 0
      ? `会话工作集：\n${uploadLines.map((line) => `- ${line}`).join("\n")}`
      : "",
  ].filter(Boolean);

  if (sections.length === 0) {
    return null;
  }

  const summary = sections.join("\n\n");
  return {
    summary: summary.length > 1600 ? `${summary.slice(0, 1580).trimEnd()}\n...` : summary,
    summarizedMessageCount: olderMessages.length,
    updatedAt: olderMessages[olderMessages.length - 1]?.timestamp ?? Date.now(),
  };
}
