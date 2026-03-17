import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { buildClusterSourceModeLabel } from "@/plugins/builtin/SmartAgent/core/cluster-context-snapshot";
import { createLogger } from "@/core/logger";
import type { ClusterSession } from "@/store/cluster-store";
import type { ClusterContextRuntimeDebugReport } from "./debug-types";
import { shouldEmitContextRuntimeDebugByFlags } from "./debug-report";

const logger = createLogger("ClusterContextRuntime");

export function buildClusterContextRuntimeDebugReport(params: {
  session: ClusterSession;
  status: ClusterContextRuntimeDebugReport["execution"]["status"];
  durationMs: number;
  answer?: string | null;
  error?: string | null;
  sessionNoteSaved?: boolean;
  sessionNotePreview?: string;
}): ClusterContextRuntimeDebugReport {
  return {
    generatedAt: Date.now(),
    sessionId: params.session.id,
    queryPreview: summarizeAISessionRuntimeText(params.session.query, 140) || undefined,
    modeLabel: params.session.contextSnapshot?.modeLabel,
    workspaceRoot: params.session.workspaceRoot?.trim() || undefined,
    sourceModeLabel: buildClusterSourceModeLabel(params.session.sourceHandoff),
    planStepCount:
      params.session.plan?.steps.length
      ?? params.session.contextSnapshot?.planStepCount
      ?? 0,
    instanceCount: params.session.instances.length,
    runningInstanceCount: params.session.instances.filter((instance) =>
      instance.status === "running" || instance.status === "reviewing",
    ).length,
    completedInstanceCount: params.session.instances.filter((instance) =>
      instance.status === "done",
    ).length,
    errorInstanceCount: params.session.instances.filter((instance) =>
      instance.status === "error",
    ).length,
    ingest: {
      sessionNoteSaved: params.sessionNoteSaved === true,
      sessionNotePreview: params.sessionNotePreview,
    },
    execution: {
      status: params.status,
      durationMs: Math.max(0, Math.round(params.durationMs)),
      answerPreview: summarizeAISessionRuntimeText(params.answer || "", 180) || undefined,
      errorPreview: summarizeAISessionRuntimeText(params.error || "", 180) || undefined,
    },
  };
}

export function emitClusterContextRuntimeDebugReport(
  report: ClusterContextRuntimeDebugReport,
): void {
  if (!shouldEmitContextRuntimeDebugByFlags({
    hasMemorySignals: report.ingest.sessionNoteSaved,
  })) {
    return;
  }

  logger.debug("turn-debug-report", report);
}
