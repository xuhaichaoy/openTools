import { invoke } from "@tauri-apps/api/core";
import type { AIConfig } from "./types";
import { getServerUrl } from "@/store/server-store";

export type AISource = "own_key" | "team" | "platform";

export interface RouteOptions {
  messages: any[];
  config: AIConfig;
  conversationId: string;
  token?: string | null;
}

/**
 * 根据 AI 来源配置路由请求
 * - own_key: 直接使用用户配置的 API Key
 * - platform: 通过 mTools 服务器代理（消耗能量）
 * - team: 通过 mTools 服务器的团队代理（使用团队 Key）
 */
export async function routeAIRequest(options: RouteOptions) {
  const { messages, config, conversationId, token } = options;
  const source = config.source || "own_key";
  const baseUrl = getServerUrl();

  switch (source) {
    case "own_key":
      return invoke("ai_chat_stream", {
        messages,
        config,
        conversationId,
      });

    case "platform": {
      // base_url 设为 {serverUrl}/ai，Tauri 命令自动追加 /chat/completions
      // 服务端通过 Authorization header 验证身份并计费
      const platformConfig: AIConfig = {
        ...config,
        base_url: `${baseUrl}/ai`,
        api_key: token || "",
      };
      return invoke("ai_chat_stream", {
        messages,
        config: platformConfig,
        conversationId,
      });
    }

    case "team": {
      // base_url 设为 {serverUrl}/ai/team，Tauri 命令自动追加 /chat/completions
      // 服务端从 team_ai_configs 读取 Key 并转发
      const teamConfig: AIConfig = {
        ...config,
        base_url: `${baseUrl}/ai/team`,
        api_key: token || "",
      };
      return invoke("ai_chat_stream", {
        messages,
        config: teamConfig,
        conversationId,
      });
    }

    default:
      return invoke("ai_chat_stream", {
        messages,
        config,
        conversationId,
      });
  }
}
