export const DEFAULT_AGENT_MAX_ITERATIONS = 25;
export const MIN_AGENT_MAX_ITERATIONS = 5;
export const MAX_AGENT_MAX_ITERATIONS = 50;

export function clampGlobalAgentMaxIterations(value?: number): number {
  return Math.max(
    MIN_AGENT_MAX_ITERATIONS,
    Math.min(MAX_AGENT_MAX_ITERATIONS, Math.floor(value ?? DEFAULT_AGENT_MAX_ITERATIONS)),
  );
}

export function resolveActorEffectiveMaxIterations(params: {
  actorMaxIterations: number;
  actorHasExplicitMaxIterations: boolean;
  globalConfiguredMaxIterations?: number;
  runOverrideMaxIterations?: number;
}): number {
  const globalMaxIterations = clampGlobalAgentMaxIterations(params.globalConfiguredMaxIterations);
  const requestedMaxIterations = params.runOverrideMaxIterations
    ?? (params.actorHasExplicitMaxIterations
      ? params.actorMaxIterations
      : Math.max(params.actorMaxIterations, globalMaxIterations));

  return Math.max(1, Math.min(requestedMaxIterations, globalMaxIterations));
}
