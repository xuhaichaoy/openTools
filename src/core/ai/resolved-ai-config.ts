import { DEFAULT_AI_MODEL } from "@/core/constants";
import type { AICenterModelScope } from "@/core/ai/ai-center-model-scope";
import { applyAICenterModelScope } from "@/core/ai/ai-center-model-scope";
import type { AIConfig, OwnKeyModelConfig } from "@/core/ai/types";

export interface AIGlobalConfig
  extends Pick<
    AIConfig,
    | "enable_advanced_tools"
    | "enable_native_tools"
    | "enable_rag_auto_search"
    | "enable_long_term_memory"
    | "enable_memory_auto_recall"
    | "enable_memory_auto_save"
    | "enable_memory_sync"
    | "system_prompt"
    | "agent_runtime_mode"
    | "agent_max_concurrency"
    | "agent_retry_max"
    | "agent_retry_backoff_ms"
    | "agent_max_iterations"
  > {}

export interface AISourceSelection
  extends Pick<
    AIConfig,
    | "source"
    | "base_url"
    | "api_key"
    | "model"
    | "temperature"
    | "max_tokens"
    | "team_id"
    | "team_config_id"
    | "protocol"
    | "active_own_key_id"
  > {}

export type ResolvedAIConfig = AIConfig;

export const DEFAULT_PLATFORM_MODEL = DEFAULT_AI_MODEL;
export const DEFAULT_PLATFORM_PROTOCOL: NonNullable<AIConfig["protocol"]> =
  "openai";

export function extractAIGlobalConfig(config: AIConfig): AIGlobalConfig {
  const {
    enable_advanced_tools,
    enable_native_tools,
    enable_rag_auto_search,
    enable_long_term_memory,
    enable_memory_auto_recall,
    enable_memory_auto_save,
    enable_memory_sync,
    system_prompt,
    agent_runtime_mode,
    agent_max_concurrency,
    agent_retry_max,
    agent_retry_backoff_ms,
    agent_max_iterations,
  } = config;

  return {
    enable_advanced_tools,
    enable_native_tools,
    enable_rag_auto_search,
    enable_long_term_memory,
    enable_memory_auto_recall,
    enable_memory_auto_save,
    enable_memory_sync,
    system_prompt,
    agent_runtime_mode,
    agent_max_concurrency,
    agent_retry_max,
    agent_retry_backoff_ms,
    agent_max_iterations,
  };
}

export function extractAISourceSelection(config: AIConfig): AISourceSelection {
  const {
    source,
    base_url,
    api_key,
    model,
    temperature,
    max_tokens,
    team_id,
    team_config_id,
    protocol,
    active_own_key_id,
  } = config;

  return {
    source,
    base_url,
    api_key,
    model,
    temperature,
    max_tokens,
    team_id,
    team_config_id,
    protocol,
    active_own_key_id,
  };
}

function findOwnKey(
  ownKeys: readonly OwnKeyModelConfig[],
  id?: string,
): OwnKeyModelConfig | null {
  if (!id) return null;
  return ownKeys.find((item) => item.id === id) ?? null;
}

function resolveOwnKeyRuntimeConfig(params: {
  baseConfig: AIConfig;
  ownKeys: readonly OwnKeyModelConfig[];
  scope?: AICenterModelScope | null;
}): ResolvedAIConfig {
  const { baseConfig, ownKeys, scope } = params;
  const scopeOwnKeyId = scope?.source === "own_key" ? scope.activeOwnKeyId : undefined;
  const fallbackOwnKeyId = baseConfig.active_own_key_id;
  const activeKey =
    findOwnKey(ownKeys, scopeOwnKeyId)
    ?? findOwnKey(ownKeys, fallbackOwnKeyId)
    ?? ownKeys[0]
    ?? null;

  const resolved: ResolvedAIConfig = {
    ...baseConfig,
    source: "own_key",
    team_id: undefined,
    team_config_id: undefined,
    active_own_key_id: activeKey?.id ?? scopeOwnKeyId ?? fallbackOwnKeyId,
  };

  if (!activeKey) {
    return {
      ...resolved,
      protocol: scope?.protocol ?? baseConfig.protocol ?? "openai",
      model: scope?.model ?? baseConfig.model,
    };
  }

  return {
    ...resolved,
    base_url: activeKey.base_url,
    api_key: activeKey.api_key,
    temperature: activeKey.temperature,
    max_tokens: activeKey.max_tokens,
    protocol: scope?.protocol ?? activeKey.protocol,
    model: scope?.model || activeKey.model,
  };
}

function resolveTeamRuntimeConfig(
  baseConfig: AIConfig,
  scopedConfig: AIConfig,
): ResolvedAIConfig {
  return {
    ...baseConfig,
    ...scopedConfig,
    source: "team",
    active_own_key_id: undefined,
    team_id: scopedConfig.team_id ?? baseConfig.team_id,
    team_config_id: scopedConfig.team_config_id ?? baseConfig.team_config_id,
    protocol: scopedConfig.protocol ?? baseConfig.protocol ?? "openai",
    model: scopedConfig.model || baseConfig.model,
  };
}

function resolvePlatformRuntimeConfig(
  baseConfig: AIConfig,
  scopedConfig: AIConfig,
): ResolvedAIConfig {
  return {
    ...baseConfig,
    ...scopedConfig,
    source: "platform",
    team_id: undefined,
    team_config_id: undefined,
    active_own_key_id: undefined,
    protocol: DEFAULT_PLATFORM_PROTOCOL,
    model: DEFAULT_PLATFORM_MODEL,
  };
}

export function resolveAIConfig(params: {
  baseConfig: AIConfig;
  ownKeys?: readonly OwnKeyModelConfig[];
  scope?: AICenterModelScope | null;
}): ResolvedAIConfig {
  const { baseConfig, ownKeys = [], scope } = params;
  const scopedConfig = scope ? applyAICenterModelScope(baseConfig, scope) : baseConfig;
  const source = scopedConfig.source ?? baseConfig.source ?? "own_key";

  switch (source) {
    case "team":
      return resolveTeamRuntimeConfig(baseConfig, scopedConfig);
    case "platform":
      return resolvePlatformRuntimeConfig(baseConfig, scopedConfig);
    default:
      return resolveOwnKeyRuntimeConfig({ baseConfig, ownKeys, scope });
  }
}
