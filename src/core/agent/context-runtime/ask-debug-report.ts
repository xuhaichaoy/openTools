import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { buildAskSourceModeLabel } from "@/core/ai/ask-context-snapshot";
import { createLogger } from "@/core/logger";
import type { Conversation } from "@/core/ai/types";
import type { AskContextRuntimeDebugReport } from "./debug-types";
import { shouldEmitContextRuntimeDebugByFlags } from "./debug-report";

const logger = createLogger("AskContextRuntime");

export function buildAskContextRuntimeDebugReport(params: {
  conversation: Conversation;
  query: string;
  status: AskContextRuntimeDebugReport["execution"]["status"];
  durationMs: number;
  answer?: string | null;
  error?: string | null;
  sessionNoteSaved?: boolean;
  sessionNotePreview?: string;
  memoryAutoExtractionScheduled?: boolean;
}): AskContextRuntimeDebugReport {
  const messages = params.conversation.messages ?? [];
  const recalledMemoryCount = Math.max(
    ...messages.map((message) =>
      Math.max(
        message.appliedMemoryIds?.length ?? 0,
        message.appliedMemoryPreview?.length ?? 0,
      ),
    ),
    0,
  );

  return {
    generatedAt: Date.now(),
    conversationId: params.conversation.id,
    queryPreview: summarizeAISessionRuntimeText(params.query, 140) || undefined,
    workspaceRoot: params.conversation.workspaceRoot?.trim() || undefined,
    sourceModeLabel: buildAskSourceModeLabel(params.conversation.sourceHandoff),
    scope: {
      messageCount: messages.length,
      attachmentCount: messages.reduce(
        (count, message) => count + (message.attachmentPaths?.length ?? 0),
        0,
      ),
      imageCount: messages.reduce(
        (count, message) => count + (message.images?.length ?? 0),
        0,
      ),
      contextBlockCount: messages.reduce(
        (count, message) => count + (message.contextPrefix?.trim() ? 1 : 0),
        0,
      ),
      recalledMemoryCount,
    },
    ingest: {
      sessionNoteSaved: params.sessionNoteSaved === true,
      sessionNotePreview: params.sessionNotePreview,
      memoryAutoExtractionScheduled: params.memoryAutoExtractionScheduled === true,
    },
    execution: {
      status: params.status,
      durationMs: Math.max(0, Math.round(params.durationMs)),
      answerPreview: summarizeAISessionRuntimeText(params.answer || "", 180) || undefined,
      errorPreview: summarizeAISessionRuntimeText(params.error || "", 180) || undefined,
    },
  };
}

export function emitAskContextRuntimeDebugReport(
  report: AskContextRuntimeDebugReport,
): void {
  if (!shouldEmitContextRuntimeDebugByFlags({
    hasMemorySignals:
      report.ingest.sessionNoteSaved
      || report.scope.recalledMemoryCount > 0
      || report.ingest.memoryAutoExtractionScheduled,
  })) {
    return;
  }

  logger.debug("turn-debug-report", report);
}
