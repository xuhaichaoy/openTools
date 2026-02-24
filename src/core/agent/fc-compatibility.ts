import type { AIConfig } from "@/core/ai/types";

/**
 * 构建 Function Calling 兼容性缓存 key。
 * 仅使用模型身份相关字段，避免引入敏感信息（如 api_key）。
 */
export function buildAgentFCCompatibilityKey(config: AIConfig): string {
  const source = (config.source || "own_key").trim().toLowerCase();
  const protocol = (config.protocol || "openai").trim().toLowerCase();
  const baseUrl = (config.base_url || "").trim().replace(/\/+$/, "").toLowerCase();
  const model = (config.model || "").trim().toLowerCase();
  const teamId = (config.team_id || "").trim().toLowerCase();
  const teamConfigId = (config.team_config_id || "").trim().toLowerCase();
  const ownKeyId = (config.active_own_key_id || "").trim().toLowerCase();

  return [source, protocol, baseUrl, model, teamId, teamConfigId, ownKeyId].join(
    "|",
  );
}
