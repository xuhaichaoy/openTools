import { isAIDebugFlagEnabled } from "@/core/ai/local-ai-debug-preferences";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { createLogger } from "@/core/logger";
import type { AgentPromptContextSnapshot } from "@/plugins/builtin/SmartAgent/core/prompt-context";
import type { AgentSession } from "@/store/agent-store";
import type { AgentContextRuntimeDebugReport } from "./debug-types";
import type { ContinuityDecision, TaskScopeSnapshot } from "./types";

const logger = createLogger("AgentContextRuntime");

function basename(path: string): string {
  return path.trim().replace(/\\/g, "/").split("/").pop() || path;
}

function uniqueLimited(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, Math.max(0, limit));
}

export function shouldEmitContextRuntimeDebugByFlags(params: {
  workspaceReset?: boolean;
  hasMemorySignals?: boolean;
  hasCompactionSignals?: boolean;
}): boolean {
  if (isAIDebugFlagEnabled("context_runtime")) {
    return true;
  }
  if (params.workspaceReset && isAIDebugFlagEnabled("workspace_switch")) {
    return true;
  }
  if (params.hasCompactionSignals && isAIDebugFlagEnabled("compaction")) {
    return true;
  }
  if (params.hasMemorySignals && isAIDebugFlagEnabled("memory_pipeline")) {
    return true;
  }
  return false;
}

export function buildAgentContextRuntimeDebugReport(params: {
  sessionId: string;
  taskId: string;
  query: string;
  scope: TaskScopeSnapshot;
  continuity: ContinuityDecision;
  workspaceRoot?: string;
  workspaceReset: boolean;
  promptContextSnapshot?: AgentPromptContextSnapshot | null;
  session?: AgentSession | null;
  status: AgentContextRuntimeDebugReport["execution"]["status"];
  durationMs: number;
  answer?: string | null;
  error?: string | null;
  sessionNoteSaved?: boolean;
  sessionNotePreview?: string;
  referencedPaths?: readonly string[];
  memoryAutoExtractionScheduled?: boolean;
}): AgentContextRuntimeDebugReport {
  const promptSnapshot = params.promptContextSnapshot;
  const session = params.session;

  return {
    generatedAt: Date.now(),
    sessionId: params.sessionId,
    taskId: params.taskId,
    queryPreview: summarizeAISessionRuntimeText(params.query, 160) || undefined,
    workspaceRoot: params.workspaceRoot?.trim() || undefined,
    continuityStrategy: params.continuity.strategy,
    continuityReason: params.continuity.reason,
    workspaceReset: params.workspaceReset,
    scope: {
      queryIntent: params.scope.queryIntent,
      attachmentCount: params.scope.attachmentPaths.length,
      imageCount: params.scope.imagePaths.length,
      handoffCount: params.scope.handoffPaths.length,
      pathHintCount: params.scope.pathHints.length,
      pathHintPreview: uniqueLimited(
        params.scope.pathHints.map((path) => basename(path)),
        6,
      ),
    },
    prompt: {
      runModeLabel: promptSnapshot?.runModeLabel,
      bootstrapFileCount: promptSnapshot?.bootstrapContextFileCount ?? 0,
      bootstrapFileNames: promptSnapshot?.bootstrapContextFileNames?.slice(0, 6) ?? [],
      historyContextMessageCount: promptSnapshot?.historyContextMessageCount ?? 0,
      knowledgeContextMessageCount: promptSnapshot?.knowledgeContextMessageCount ?? 0,
      memoryItemCount: promptSnapshot?.memoryItemCount ?? 0,
    },
    compaction: {
      compactedTaskCount: session?.compaction?.compactedTaskCount ?? 0,
      preservedIdentifiers: session?.compaction?.preservedIdentifiers?.slice(0, 8) ?? [],
      bootstrapRules: session?.compaction?.bootstrapReinjectionPreview?.slice(0, 3) ?? [],
    },
    ingest: {
      sessionNoteSaved: params.sessionNoteSaved === true,
      sessionNotePreview: params.sessionNotePreview,
      referencedPaths: uniqueLimited(
        (params.referencedPaths ?? []).map((path) => basename(path)),
        6,
      ),
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

function shouldEmitAgentContextRuntimeDebugReport(
  report: AgentContextRuntimeDebugReport,
): boolean {
  return shouldEmitContextRuntimeDebugByFlags({
    workspaceReset: report.workspaceReset,
    hasCompactionSignals:
      report.compaction.compactedTaskCount > 0
      || report.compaction.preservedIdentifiers.length > 0,
    hasMemorySignals:
      report.ingest.sessionNoteSaved
      || report.prompt.memoryItemCount > 0
      || report.ingest.memoryAutoExtractionScheduled,
  });
}

export function emitAgentContextRuntimeDebugReport(
  report: AgentContextRuntimeDebugReport,
): void {
  if (!shouldEmitAgentContextRuntimeDebugReport(report)) {
    return;
  }

  logger.debug("turn-debug-report", report);
}
