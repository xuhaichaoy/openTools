import type { AgentCapabilities } from "./types";
import { clampGlobalAgentMaxIterations } from "./iteration-budget";
import {
  DEFAULT_DIALOG_MAIN_BUDGET_SECONDS,
  DEFAULT_DIALOG_MAIN_IDLE_LEASE_SECONDS,
} from "./timeout-policy";

export interface PersistedDialogActorConfigLike {
  roleName: string;
  maxIterations?: number;
  capabilities?: AgentCapabilities;
  timeoutSeconds?: number;
  idleLeaseSeconds?: number;
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

export function resolvePersistedDialogActorBudgetSeconds(
  config: PersistedDialogActorConfigLike,
  actorCount: number,
  sessionVersion?: number,
): number | undefined {
  if (typeof config.timeoutSeconds === "number" && Number.isFinite(config.timeoutSeconds)) {
    if (
      (sessionVersion ?? 0) < 10
      && isLegacySingleDefaultDialogLead(config, actorCount)
      && config.timeoutSeconds <= DEFAULT_DIALOG_MAIN_IDLE_LEASE_SECONDS
    ) {
      return DEFAULT_DIALOG_MAIN_BUDGET_SECONDS;
    }
    return config.timeoutSeconds;
  }
  if (isLegacySingleDefaultDialogLead(config, actorCount)) {
    return DEFAULT_DIALOG_MAIN_BUDGET_SECONDS;
  }
  return undefined;
}

export function resolvePersistedDialogActorIdleLeaseSeconds(
  config: PersistedDialogActorConfigLike,
  actorCount: number,
): number | undefined {
  if (typeof config.idleLeaseSeconds === "number" && Number.isFinite(config.idleLeaseSeconds)) {
    return config.idleLeaseSeconds;
  }
  if (isLegacySingleDefaultDialogLead(config, actorCount)) {
    return DEFAULT_DIALOG_MAIN_IDLE_LEASE_SECONDS;
  }
  return undefined;
}
