import type { AICenterHandoff } from "@/store/app-store";
import type { AgentSession } from "@/store/agent-store";
import { decideAgentSessionContinuity } from "./continuity-policy";
import { resolveTaskScopeSnapshot } from "./scope-resolver";
import type { AgentExecutionContextPlan } from "./types";

export async function buildAgentExecutionContextPlan(params: {
  query: string;
  currentSession?: AgentSession | null;
  explicitWorkspaceRoot?: string;
  attachmentPaths?: readonly string[];
  images?: readonly string[];
  sourceHandoff?: AICenterHandoff | null;
  forceNewSession?: boolean;
}): Promise<AgentExecutionContextPlan> {
  let scope = await resolveTaskScopeSnapshot({
    query: params.query,
    previousWorkspaceRoot: params.currentSession?.workspaceRoot,
    explicitWorkspaceRoot: params.explicitWorkspaceRoot,
    attachmentPaths: params.attachmentPaths,
    images: params.images,
    sourceHandoff: params.sourceHandoff,
  });
  const lockedWorkspaceRoot = params.currentSession?.workspaceLocked
    ? params.currentSession.workspaceRoot?.trim()
    : undefined;
  if (lockedWorkspaceRoot) {
    const hasExternalWorkspaceSignal =
      !!params.explicitWorkspaceRoot?.trim()
      || !!scope.attachmentPaths.length
      || !!scope.imagePaths.length
      || !!scope.handoffPaths.length
      || !!scope.queryPathHints.length;
    if (!hasExternalWorkspaceSignal) {
      scope = {
        ...scope,
        workspaceRoot: lockedWorkspaceRoot,
        workspaceSource: "locked_previous",
      };
    }
  }
  const continuity = decideAgentSessionContinuity({
    scope,
    forceNewSession: params.forceNewSession,
    currentSession: params.currentSession,
  });

  const shouldInheritWorkspaceRoot =
    continuity.strategy === "inherit_full"
    || continuity.strategy === "inherit_summary_only"
    || continuity.strategy === "inherit_recent_only";
  const effectiveWorkspaceRoot =
    scope.workspaceRoot
    ?? (shouldInheritWorkspaceRoot
      ? params.currentSession?.workspaceRoot
      : undefined);
  const previousWorkspaceRoot = params.currentSession?.workspaceRoot;
  const workspaceRootToPersist =
    effectiveWorkspaceRoot && effectiveWorkspaceRoot !== previousWorkspaceRoot
      ? effectiveWorkspaceRoot
      : undefined;
  const promptSourceHandoff = continuity.carryHandoff
    ? (params.sourceHandoff ?? params.currentSession?.sourceHandoff)
    : (params.sourceHandoff ?? undefined);

  return {
    scope,
    continuity,
    effectiveWorkspaceRoot,
    workspaceRootToPersist,
    promptSourceHandoff,
    shouldResetInheritedContext: continuity.strategy === "soft_reset",
  };
}
