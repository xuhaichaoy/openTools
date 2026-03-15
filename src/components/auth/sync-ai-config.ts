import type { AIConfig } from "@/core/ai/types";

export type AIConfigWithVersion = AIConfig & { _syncVersion?: number };

export function mergeCloudAIConfig(
  localConfig: AIConfigWithVersion,
  cloudConfig: Record<string, any>,
  version: number,
): AIConfigWithVersion {
  const cloudSource = cloudConfig.source ?? localConfig.source;
  const cloudTeamId =
    typeof cloudConfig.team_id === "string" ? cloudConfig.team_id : undefined;
  const cloudTeamConfigId =
    typeof cloudConfig.team_config_id === "string"
      ? cloudConfig.team_config_id
      : undefined;
  const cloudProtocol =
    cloudConfig.protocol === "openai" || cloudConfig.protocol === "anthropic"
      ? cloudConfig.protocol
      : undefined;
  const cloudActiveOwnKeyId =
    typeof cloudConfig.active_own_key_id === "string"
      ? cloudConfig.active_own_key_id
      : undefined;

  const merged: AIConfigWithVersion = {
    ...localConfig,
    model: cloudConfig.model ?? localConfig.model,
    temperature: cloudConfig.temperature ?? localConfig.temperature,
    max_tokens: cloudConfig.max_tokens ?? localConfig.max_tokens,
    system_prompt: cloudConfig.system_prompt ?? localConfig.system_prompt,
    // 高级工具 / 原生工具属于本机权限偏好，不参与跨设备覆盖。
    enable_rag_auto_search:
      cloudConfig.enable_rag_auto_search ?? localConfig.enable_rag_auto_search,
    enable_long_term_memory:
      cloudConfig.enable_long_term_memory ?? localConfig.enable_long_term_memory,
    enable_memory_auto_recall:
      cloudConfig.enable_memory_auto_recall ??
      localConfig.enable_memory_auto_recall,
    enable_memory_auto_save:
      cloudConfig.enable_memory_auto_save ?? localConfig.enable_memory_auto_save,
    enable_memory_sync:
      cloudConfig.enable_memory_sync ?? localConfig.enable_memory_sync,
    source: cloudSource,
    team_id: cloudSource === "team" ? cloudTeamId ?? localConfig.team_id : undefined,
    team_config_id:
      cloudSource === "team"
        ? cloudTeamConfigId ?? localConfig.team_config_id
        : undefined,
    protocol: cloudProtocol ?? localConfig.protocol,
    active_own_key_id: cloudActiveOwnKeyId ?? localConfig.active_own_key_id,
    _syncVersion: version,
  };

  // 防御：云端 source=team 但没有 team_id 时，不切到无效 team source。
  if (merged.source === "team" && !merged.team_id) {
    merged.source = localConfig.team_id ? "team" : (localConfig.source ?? "own_key");
    merged.team_id = localConfig.team_id;
    merged.team_config_id = localConfig.team_config_id;
  }

  return merged;
}
