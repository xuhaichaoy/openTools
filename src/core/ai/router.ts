import { invoke } from "@tauri-apps/api/core";
import type { AIConfig } from "./types";
import { getServerUrl } from "@/store/server-store";
import { useAuthStore } from "@/store/auth-store";

export type AISource = "own_key" | "team" | "platform";

export interface RouteOptions {
  messages: any[];
  config: AIConfig;
  conversationId: string;
  token?: string | null;
  extraTools?: any[];
}

/**
 * 根据 AI 来源，对 config 的 base_url / api_key 做路由修正。
 * - own_key: 原样返回
 * - platform: base_url → {serverUrl}/ai，api_key → 用户 auth token
 * - team: base_url → {serverUrl}/ai/team，api_key → 用户 auth token
 *
 * 所有需要调用 Rust AI 命令的地方都应先用此函数处理 config。
 */
export function applyRouting(config: AIConfig, token?: string | null): AIConfig {
  const source = config.source || "own_key";
  const baseUrl = getServerUrl();

  switch (source) {
    case "platform": {
      const routed = { ...config, base_url: `${baseUrl}/v1/ai`, api_key: token || "" };
      console.log("[AI Router] platform →", routed.base_url, "model=", config.model);
      return routed;
    }
    case "team": {
      const routed = { ...config, base_url: `${baseUrl}/v1/ai/team`, api_key: token || "" };
      console.log("[AI Router] team →", routed.base_url, "model=", config.model, "team_id=", config.team_id, "serverUrl=", baseUrl);
      return routed;
    }
    default:
      return config;
  }
}

/**
 * 快捷版 applyRouting —— 自动从 authStore 取 token
 */
export function getRoutedConfig(config: AIConfig): AIConfig {
  const { token } = useAuthStore.getState();
  return applyRouting(config, token);
}

/**
 * 根据 AI 来源配置路由请求
 * - own_key: 直接使用用户配置的 API Key
 * - platform: 通过 51ToolBox 服务器代理（消耗能量）
 * - team: 通过 51ToolBox 服务器的团队代理（使用团队 Key）
 */
export async function routeAIRequest(options: RouteOptions) {
  const { messages, config, conversationId, token, extraTools } = options;
  const routed = applyRouting(config, token);

  return invoke("ai_chat_stream", {
    messages,
    config: routed,
    conversationId,
    extraTools: extraTools?.length ? extraTools : null,
  });
}
