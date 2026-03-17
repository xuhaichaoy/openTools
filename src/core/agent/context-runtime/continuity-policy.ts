import type {
  ContinuityDecision,
  DecideAgentSessionContinuityParams,
} from "./types";

function hasMeaningfulSessionContext(
  params: DecideAgentSessionContinuityParams,
): boolean {
  const session = params.currentSession;
  if (!session) return false;
  if (session.compaction?.summary?.trim()) return true;
  return session.tasks.length > 0;
}

export function decideAgentSessionContinuity(
  params: DecideAgentSessionContinuityParams,
): ContinuityDecision {
  if (params.forceNewSession) {
    return {
      strategy: "fork_session",
      reason: "force_new_session",
      carrySummary: false,
      carryRecentSteps: false,
      carryFiles: false,
      carryHandoff: false,
    };
  }

  const previousWorkspaceRoot = params.scope.previousWorkspaceRoot;
  const requestedWorkspaceRoot = params.scope.workspaceRoot;
  if (
    requestedWorkspaceRoot &&
    previousWorkspaceRoot &&
    requestedWorkspaceRoot !== previousWorkspaceRoot
  ) {
    const shouldFork = hasMeaningfulSessionContext(params);
    return {
      strategy: shouldFork ? "fork_session" : "soft_reset",
      reason: "workspace_switch",
      carrySummary: false,
      carryRecentSteps: false,
      carryFiles: false,
      carryHandoff: false,
    };
  }

  if (params.scope.explicitReset) {
    const shouldFork = hasMeaningfulSessionContext(params);
    return {
      strategy: shouldFork ? "fork_session" : "soft_reset",
      reason: "explicit_new_task",
      carrySummary: false,
      carryRecentSteps: false,
      carryFiles: false,
      carryHandoff: false,
    };
  }

  const hasCompactionSummary = !!params.currentSession?.compaction?.summary?.trim();
  const visibleTaskCount = params.currentSession?.tasks.length ?? 0;
  if (hasCompactionSummary && visibleTaskCount <= 1) {
    return {
      strategy: "inherit_summary_only",
      reason: "same_workspace",
      carrySummary: true,
      carryRecentSteps: false,
      carryFiles: true,
      carryHandoff: true,
    };
  }

  return {
    strategy: "inherit_full",
    reason: "same_workspace",
    carrySummary: true,
    carryRecentSteps: true,
    carryFiles: true,
    carryHandoff: true,
  };
}
