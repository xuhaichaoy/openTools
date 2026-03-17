import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { saveSessionMemoryNote } from "@/core/ai/memory-store";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { AgentPromptContextSnapshot } from "@/plugins/builtin/SmartAgent/core/prompt-context";
import type { AgentSession } from "@/store/agent-store";
import {
  buildAgentContextRuntimeDebugReport,
  emitAgentContextRuntimeDebugReport,
} from "./debug-report";
import type { AgentContextRuntimeDebugReport } from "./debug-types";
import {
  collectContextPathHints,
  normalizeContextPath,
  uniqueContextPaths,
} from "./scope-resolver";
import type { ContinuityDecision, TaskScopeSnapshot } from "./types";

function basename(path: string): string {
  const normalized = normalizeContextPath(path);
  return normalized.split("/").pop() || normalized;
}

function formatDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${seconds}s`;
}

function collectReferencedPaths(steps: readonly AgentStep[]): string[] {
  return uniqueContextPaths(
    steps.flatMap((step) => [
      ...collectContextPathHints(step.toolInput),
      ...collectContextPathHints(step.toolOutput),
    ]),
  );
}

function buildAgentTurnSessionNote(params: {
  query: string;
  status: AgentContextRuntimeDebugReport["execution"]["status"];
  answer?: string | null;
  error?: string | null;
  workspaceRoot?: string;
  workspaceReset: boolean;
  referencedPaths: readonly string[];
  durationMs: number;
}): string | null {
  const query = summarizeAISessionRuntimeText(params.query, 84);
  const answer = summarizeAISessionRuntimeText(params.answer || "", 120);
  const error = summarizeAISessionRuntimeText(params.error || "", 120);
  const files = params.referencedPaths.slice(0, 4).map((path) => basename(path));
  const duration = formatDuration(params.durationMs);

  const parts: string[] = [];
  if (query) {
    parts.push(`任务：${query}`);
  }
  switch (params.status) {
    case "success":
      if (answer) {
        parts.push(`结果：${answer}`);
      }
      break;
    case "cancelled":
      parts.push(`状态：已中断${answer ? `，${answer}` : ""}`);
      break;
    case "error":
      parts.push(`状态：失败${error ? `，${error}` : ""}`);
      break;
  }
  if (params.workspaceReset) {
    parts.push(`上下文：已按${params.workspaceRoot ? "新工作区" : "新任务"}重置继承`);
  }
  if (files.length > 0) {
    parts.push(`涉及文件：${files.join("、")}`);
  }
  if (duration) {
    parts.push(`耗时：${duration}`);
  }

  const note = parts.join("；").trim();
  return note.length >= 12 ? note : null;
}

export interface AgentTurnContextIngestResult {
  sessionNoteSaved: boolean;
  sessionNotePreview?: string;
  referencedPaths: string[];
  debugReport: AgentContextRuntimeDebugReport;
}

export async function persistAgentTurnContextIngest(params: {
  sessionId: string;
  taskId: string;
  query: string;
  steps: readonly AgentStep[];
  status: AgentContextRuntimeDebugReport["execution"]["status"];
  durationMs: number;
  answer?: string | null;
  error?: string | null;
  workspaceRoot?: string;
  workspaceReset: boolean;
  scope: TaskScopeSnapshot;
  continuity: ContinuityDecision;
  promptContextSnapshot?: AgentPromptContextSnapshot | null;
  session?: AgentSession | null;
  memoryAutoExtractionScheduled?: boolean;
}): Promise<AgentTurnContextIngestResult> {
  const referencedPaths = collectReferencedPaths(params.steps);
  const sessionNote = buildAgentTurnSessionNote({
    query: params.query,
    status: params.status,
    answer: params.answer,
    error: params.error,
    workspaceRoot: params.workspaceRoot,
    workspaceReset: params.workspaceReset,
    referencedPaths,
    durationMs: params.durationMs,
  });

  let sessionNoteSaved = false;
  let sessionNotePreview: string | undefined;

  if (sessionNote) {
    const saved = await saveSessionMemoryNote(sessionNote, {
      conversationId: params.sessionId,
      workspaceId: params.workspaceRoot,
      source: "system",
    }).catch(() => null);
    sessionNoteSaved = !!saved;
    sessionNotePreview = saved?.content || summarizeAISessionRuntimeText(sessionNote, 160) || undefined;
  }

  const debugReport = buildAgentContextRuntimeDebugReport({
    sessionId: params.sessionId,
    taskId: params.taskId,
    query: params.query,
    scope: params.scope,
    continuity: params.continuity,
    workspaceRoot: params.workspaceRoot,
    workspaceReset: params.workspaceReset,
    promptContextSnapshot: params.promptContextSnapshot,
    session: params.session,
    status: params.status,
    durationMs: params.durationMs,
    answer: params.answer,
    error: params.error,
    sessionNoteSaved,
    sessionNotePreview,
    referencedPaths,
    memoryAutoExtractionScheduled: params.memoryAutoExtractionScheduled,
  });

  emitAgentContextRuntimeDebugReport(debugReport);

  return {
    sessionNoteSaved,
    sessionNotePreview,
    referencedPaths,
    debugReport,
  };
}
