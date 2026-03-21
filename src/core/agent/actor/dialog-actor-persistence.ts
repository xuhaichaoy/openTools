import type { AgentCapabilities } from "./types";
import { clampGlobalAgentMaxIterations } from "./iteration-budget";

export interface PersistedDialogActorConfigLike {
  roleName: string;
  maxIterations?: number;
  capabilities?: AgentCapabilities;
}

export function isLegacySingleDefaultDialogLead(
  config: PersistedDialogActorConfigLike,
  actorCount: number,
): boolean {
  if (actorCount !== 1) return false;
  if (config.roleName === "Lead" || config.roleName === "Coordinator") return true;
  const tags = config.capabilities?.tags ?? [];
  return tags.includes("coordinator") && tags.includes("code_analysis") && tags.includes("code_write");
}

export function resolvePersistedDialogActorMaxIterations(
  config: PersistedDialogActorConfigLike,
  actorCount: number,
): number | undefined {
  if (typeof config.maxIterations === "number" && Number.isFinite(config.maxIterations)) {
    return clampGlobalAgentMaxIterations(config.maxIterations);
  }
  if (isLegacySingleDefaultDialogLead(config, actorCount)) {
    return 40;
  }
  return undefined;
}
