import type { AIConfig } from "@/core/ai/types";

export interface AICenterModelScope {
  source: AIConfig["source"];
  model?: string;
  protocol?: AIConfig["protocol"];
  activeOwnKeyId?: string;
  teamId?: string;
  teamConfigId?: string;
}

function normalizeSource(source?: AIConfig["source"]): NonNullable<AIConfig["source"]> {
  return source || "own_key";
}

export function getAICenterModelScopeSource(
  scope?: AICenterModelScope | null,
): NonNullable<AIConfig["source"]> | null {
  if (!scope) return null;
  return normalizeSource(scope.source);
}

export function buildAICenterModelScope(config: AIConfig): AICenterModelScope {
  const source = normalizeSource(config.source);
  return {
    source,
    model: config.model,
    protocol: config.protocol,
    ...(source === "own_key" && config.active_own_key_id
      ? { activeOwnKeyId: config.active_own_key_id }
      : {}),
    ...(source === "team" && config.team_id
      ? {
          teamId: config.team_id,
          ...(config.team_config_id ? { teamConfigId: config.team_config_id } : {}),
        }
      : {}),
  };
}

export function isAICenterModelScopeCompatible(
  config: AIConfig,
  scope?: AICenterModelScope | null,
): boolean {
  if (!scope) return false;
  return normalizeSource(config.source) === getAICenterModelScopeSource(scope);
}

export function matchesAICenterModelScope(
  config: AIConfig,
  scope?: AICenterModelScope | null,
): boolean {
  if (!isAICenterModelScopeCompatible(config, scope)) return false;

  const source = normalizeSource(config.source);
  if ((config.model || "") !== (scope?.model || "")) return false;
  if ((config.protocol || "openai") !== (scope?.protocol || "openai")) return false;

  if (source === "own_key") {
    return (config.active_own_key_id || "") === (scope?.activeOwnKeyId || "");
  }

  if (source === "team") {
    return (config.team_id || "") === (scope?.teamId || "")
      && (config.team_config_id || "") === (scope?.teamConfigId || "");
  }

  return true;
}

export function applyAICenterModelScope(
  config: AIConfig,
  scope?: AICenterModelScope | null,
): AIConfig {
  if (!scope) return config;

  const source = getAICenterModelScopeSource(scope);
  if (!source) return config;
  return {
    ...config,
    source,
    ...(scope.model ? { model: scope.model } : {}),
    ...(scope.protocol ? { protocol: scope.protocol } : {}),
    active_own_key_id: source === "own_key" ? scope.activeOwnKeyId : undefined,
    ...(source === "team"
      ? {
          ...(scope.teamId ? { team_id: scope.teamId } : {}),
          ...(scope.teamConfigId ? { team_config_id: scope.teamConfigId } : {}),
        }
      : { team_id: undefined, team_config_id: undefined }),
  };
}
