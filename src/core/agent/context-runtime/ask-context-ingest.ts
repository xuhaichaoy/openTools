import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { Conversation } from "@/core/ai/types";
import { saveSessionMemoryNote } from "@/core/ai/memory-store";
import {
  buildAskContextRuntimeDebugReport,
  emitAskContextRuntimeDebugReport,
} from "./ask-debug-report";
import type { AskContextRuntimeDebugReport } from "./debug-types";

function formatDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return `${Math.max(1, Math.round(durationMs / 1000))}s`;
}

function buildAskTurnSessionNote(params: {
  query: string;
  status: AskContextRuntimeDebugReport["execution"]["status"];
  answer?: string | null;
  error?: string | null;
  attachmentCount: number;
  imageCount: number;
  durationMs: number;
}): string | null {
  const query = summarizeAISessionRuntimeText(params.query, 84);
  const answer = summarizeAISessionRuntimeText(params.answer || "", 120);
  const error = summarizeAISessionRuntimeText(params.error || "", 120);

  const parts: string[] = [];
  if (query) {
    parts.push(`Ask 问题：${query}`);
  }
  switch (params.status) {
    case "success":
      if (answer) {
        parts.push(`回答：${answer}`);
      }
      break;
    case "cancelled":
      parts.push("状态：已中断");
      break;
    case "error":
      parts.push(`状态：失败${error ? `，${error}` : ""}`);
      break;
  }
  if (params.attachmentCount > 0 || params.imageCount > 0) {
    parts.push(
      `材料：附件 ${params.attachmentCount} 项，图片 ${params.imageCount} 张`,
    );
  }
  const duration = formatDuration(params.durationMs);
  if (duration) {
    parts.push(`耗时：${duration}`);
  }

  const note = parts.join("；").trim();
  return note.length >= 12 ? note : null;
}

export interface AskTurnContextIngestResult {
  sessionNoteSaved: boolean;
  sessionNotePreview?: string;
  debugReport: AskContextRuntimeDebugReport;
}

export async function persistAskTurnContextIngest(params: {
  conversation: Conversation;
  query: string;
  status: AskContextRuntimeDebugReport["execution"]["status"];
  durationMs: number;
  answer?: string | null;
  error?: string | null;
  attachmentCount?: number;
  imageCount?: number;
  memoryAutoExtractionScheduled?: boolean;
}): Promise<AskTurnContextIngestResult> {
  const sessionNote = buildAskTurnSessionNote({
    query: params.query,
    status: params.status,
    answer: params.answer,
    error: params.error,
    attachmentCount: Math.max(0, params.attachmentCount ?? 0),
    imageCount: Math.max(0, params.imageCount ?? 0),
    durationMs: params.durationMs,
  });

  let sessionNoteSaved = false;
  let sessionNotePreview: string | undefined;

  if (sessionNote) {
    const saved = await saveSessionMemoryNote(sessionNote, {
      conversationId: params.conversation.id,
      workspaceId: params.conversation.workspaceRoot,
      source: "system",
    }).catch(() => null);
    sessionNoteSaved = !!saved;
    sessionNotePreview = saved?.content
      || summarizeAISessionRuntimeText(sessionNote, 160)
      || undefined;
  }

  const debugReport = buildAskContextRuntimeDebugReport({
    conversation: params.conversation,
    query: params.query,
    status: params.status,
    durationMs: params.durationMs,
    answer: params.answer,
    error: params.error,
    sessionNoteSaved,
    sessionNotePreview,
    memoryAutoExtractionScheduled: params.memoryAutoExtractionScheduled,
  });

  emitAskContextRuntimeDebugReport(debugReport);

  return {
    sessionNoteSaved,
    sessionNotePreview,
    debugReport,
  };
}
