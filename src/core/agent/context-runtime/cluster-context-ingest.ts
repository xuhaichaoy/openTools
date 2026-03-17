import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { saveSessionMemoryNote } from "@/core/ai/memory-store";
import type { ClusterSession } from "@/store/cluster-store";
import {
  buildClusterContextRuntimeDebugReport,
  emitClusterContextRuntimeDebugReport,
} from "./cluster-debug-report";
import type { ClusterContextRuntimeDebugReport } from "./debug-types";

function formatDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return `${Math.max(1, Math.round(durationMs / 1000))}s`;
}

function buildClusterTurnSessionNote(params: {
  session: ClusterSession;
  status: ClusterContextRuntimeDebugReport["execution"]["status"];
  answer?: string | null;
  error?: string | null;
  durationMs: number;
}): string | null {
  const query = summarizeAISessionRuntimeText(params.session.query, 88);
  const answer = summarizeAISessionRuntimeText(params.answer || "", 120);
  const error = summarizeAISessionRuntimeText(params.error || "", 120);

  const parts: string[] = [];
  if (query) {
    parts.push(`Cluster 任务：${query}`);
  }
  if (params.session.contextSnapshot?.modeLabel) {
    parts.push(`模式：${params.session.contextSnapshot.modeLabel}`);
  }
  switch (params.status) {
    case "success":
      if (answer) {
        parts.push(`结果：${answer}`);
      }
      break;
    case "cancelled":
      parts.push("状态：已中断");
      break;
    case "error":
      parts.push(`状态：失败${error ? `，${error}` : ""}`);
      break;
  }
  if (params.session.instances.length > 0) {
    parts.push(`实例：${params.session.instances.length} 个`);
  }
  const duration = formatDuration(params.durationMs);
  if (duration) {
    parts.push(`耗时：${duration}`);
  }

  const note = parts.join("；").trim();
  return note.length >= 12 ? note : null;
}

export interface ClusterTurnContextIngestResult {
  sessionNoteSaved: boolean;
  sessionNotePreview?: string;
  debugReport: ClusterContextRuntimeDebugReport;
}

export async function persistClusterTurnContextIngest(params: {
  session: ClusterSession;
  status: ClusterContextRuntimeDebugReport["execution"]["status"];
  durationMs: number;
  answer?: string | null;
  error?: string | null;
}): Promise<ClusterTurnContextIngestResult> {
  const sessionNote = buildClusterTurnSessionNote({
    session: params.session,
    status: params.status,
    answer: params.answer,
    error: params.error,
    durationMs: params.durationMs,
  });

  let sessionNoteSaved = false;
  let sessionNotePreview: string | undefined;

  if (sessionNote) {
    const saved = await saveSessionMemoryNote(sessionNote, {
      conversationId: params.session.id,
      workspaceId: params.session.workspaceRoot,
      source: "system",
    }).catch(() => null);
    sessionNoteSaved = !!saved;
    sessionNotePreview = saved?.content
      || summarizeAISessionRuntimeText(sessionNote, 160)
      || undefined;
  }

  const debugReport = buildClusterContextRuntimeDebugReport({
    session: params.session,
    status: params.status,
    durationMs: params.durationMs,
    answer: params.answer,
    error: params.error,
    sessionNoteSaved,
    sessionNotePreview,
  });

  emitClusterContextRuntimeDebugReport(debugReport);

  return {
    sessionNoteSaved,
    sessionNotePreview,
    debugReport,
  };
}
