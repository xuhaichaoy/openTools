import type {
  ContinuityDecision,
  DecideAgentSessionContinuityParams,
} from "./types";
import { normalizeContextPath } from "./scope-resolver";

function hasMeaningfulSessionContext(
  params: DecideAgentSessionContinuityParams,
): boolean {
  const session = params.currentSession;
  if (!session) return false;
  if (session.compaction?.summary?.trim()) return true;
  return session.tasks.length > 0;
}

function hasExplicitContextSignals(
  params: DecideAgentSessionContinuityParams,
): boolean {
  return params.scope.attachmentPaths.length > 0
    || params.scope.imagePaths.length > 0
    || params.scope.handoffPaths.length > 0
    || (params.scope.queryPathHints?.length ?? 0) > 0;
}

function isPathWithinWorkspace(
  path: string,
  workspaceRoot?: string,
): boolean {
  const normalizedPath = normalizeContextPath(path);
  const normalizedWorkspace = normalizeContextPath(workspaceRoot || "");
  if (!normalizedPath || !normalizedWorkspace) return false;
  return normalizedPath === normalizedWorkspace
    || normalizedPath.startsWith(`${normalizedWorkspace}/`);
}

function arePathsRelated(pathA: string, pathB: string): boolean {
  const left = normalizeContextPath(pathA);
  const right = normalizeContextPath(pathB);
  if (!left || !right) return false;
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

function hasWorkspacePathFocusShift(
  params: DecideAgentSessionContinuityParams,
): boolean {
  const session = params.currentSession;
  const workspaceRoot =
    params.scope.workspaceRoot
    ?? params.scope.previousWorkspaceRoot
    ?? session?.workspaceRoot;
  if (!workspaceRoot) return false;

  const nextPaths = params.scope.pathHints.filter((path) =>
    isPathWithinWorkspace(path, workspaceRoot),
  );
  const previousPaths = (session?.lastActivePaths ?? []).filter((path) =>
    isPathWithinWorkspace(path, workspaceRoot),
  );
  if (nextPaths.length === 0 || previousPaths.length === 0) return false;

  return !nextPaths.some((nextPath) =>
    previousPaths.some((previousPath) =>
      arePathsRelated(nextPath, previousPath),
    ),
  );
}

function shouldTreatAsQueryTopicSwitch(
  params: DecideAgentSessionContinuityParams,
): boolean {
  const previousIntent = params.currentSession?.lastTaskIntent;
  const nextIntent = params.scope.queryIntent;
  if (!previousIntent || previousIntent === nextIntent) return false;
  if (params.scope.explicitReset) return false;
  if (hasExplicitContextSignals(params)) return false;

  if (previousIntent === "coding" && nextIntent !== "coding") {
    return true;
  }
  if (previousIntent !== "general" && nextIntent === "general") {
    return true;
  }
  if (nextIntent === "coding" && previousIntent !== "coding") {
    return true;
  }
  return false;
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

  if (shouldTreatAsQueryTopicSwitch(params)) {
    const shouldFork = hasMeaningfulSessionContext(params);
    return {
      strategy: shouldFork ? "fork_session" : "soft_reset",
      reason: "query_topic_switch",
      carrySummary: false,
      carryRecentSteps: false,
      carryFiles: false,
      carryHandoff: false,
    };
  }

  if (
    hasExplicitContextSignals(params)
    && hasWorkspacePathFocusShift(params)
  ) {
    return {
      strategy: "inherit_summary_only",
      reason: "path_focus_shift",
      carrySummary: true,
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
