import { invoke } from "@tauri-apps/api/core";
import type { AIConfig } from "./types";
import { api } from "@/core/api/client";
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

interface TeamModelInfo {
  config_id: string;
  model_name: string;
  protocol?: string;
}

const TEAM_MODEL_CACHE_TTL_MS = 30_000;
const teamModelCache = new Map<
  string,
  { expiresAt: number; models: TeamModelInfo[] }
>();
const teamModelRequests = new Map<string, Promise<TeamModelInfo[]>>();

function normalizeProtocol(protocol?: string): "openai" | "anthropic" {
  return String(protocol || "").trim().toLowerCase() === "anthropic"
    ? "anthropic"
    : "openai";
}

function normalizeTeamModel(model: unknown): TeamModelInfo | null {
  if (!model || typeof model !== "object") return null;
  const item = model as Record<string, unknown>;
  const configId = String(item.config_id ?? "").trim();
  const modelName = String(item.model_name ?? "").trim();
  if (!configId || !modelName) return null;
  return {
    config_id: configId,
    model_name: modelName,
    protocol: String(item.protocol ?? "").trim(),
  };
}

async function loadTeamModels(teamId: string): Promise<TeamModelInfo[]> {
  const normalizedTeamId = teamId.trim();
  if (!normalizedTeamId) return [];

  const cached = teamModelCache.get(normalizedTeamId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  const inflight = teamModelRequests.get(normalizedTeamId);
  if (inflight) return inflight;

  const request = api
    .get<{ models?: unknown[] }>(`/teams/${normalizedTeamId}/ai-models`)
    .then((res) => {
      const models = Array.isArray(res.models)
        ? res.models
            .map((model) => normalizeTeamModel(model))
            .filter((model): model is TeamModelInfo => !!model)
        : [];
      teamModelCache.set(normalizedTeamId, {
        expiresAt: Date.now() + TEAM_MODEL_CACHE_TTL_MS,
        models,
      });
      return models;
    })
    .finally(() => {
      teamModelRequests.delete(normalizedTeamId);
    });

  teamModelRequests.set(normalizedTeamId, request);
  return request;
}

export function resolveTeamModelConfig(
  config: AIConfig,
  teamModels: TeamModelInfo[],
): AIConfig {
  if (config.source !== "team" || !config.team_id || teamModels.length === 0) {
    return config;
  }

  const requestedModel = String(config.model || "").trim();
  const requestedConfigId = String(config.team_config_id || "").trim();
  const selectedById = requestedConfigId
    ? teamModels.find((model) => model.config_id === requestedConfigId)
    : undefined;
  const selectedByModel = requestedModel
    ? teamModels.find((model) => model.model_name === requestedModel)
    : undefined;

  // Let an explicit model override win when it disagrees with a stale team_config_id.
  const selected =
    (selectedByModel &&
      (!selectedById || selectedById.model_name !== requestedModel)
      ? selectedByModel
      : selectedById) ||
    selectedByModel ||
    selectedById ||
    teamModels[0];

  if (!selected) return config;

  const nextProtocol = normalizeProtocol(selected.protocol);
  if (
    config.team_config_id === selected.config_id &&
    config.model === selected.model_name &&
    normalizeProtocol(config.protocol) === nextProtocol
  ) {
    return config;
  }

  return {
    ...config,
    team_config_id: selected.config_id,
    model: selected.model_name,
    protocol: nextProtocol,
  };
}

export async function resolveRoutedConfig(
  config: AIConfig,
  token?: string | null,
): Promise<AIConfig> {
  const resolvedToken =
    token !== undefined ? token : useAuthStore.getState().token;
  let resolved = config;

  if (config.source === "team" && config.team_id) {
    try {
      const teamModels = await loadTeamModels(config.team_id);
      resolved = resolveTeamModelConfig(config, teamModels);
    } catch (error) {
      console.warn("[AI Router] failed to resolve team model metadata:", error);
    }
  }

  return applyRouting(resolved, resolvedToken);
}

export function primeTeamModelCache(teamId: string, models: TeamModelInfo[]): void {
  const normalizedTeamId = teamId.trim();
  if (!normalizedTeamId) return;
  teamModelCache.set(normalizedTeamId, {
    expiresAt: Date.now() + TEAM_MODEL_CACHE_TTL_MS,
    models: models.map((model) => ({
      config_id: model.config_id,
      model_name: model.model_name,
      protocol: model.protocol,
    })),
  });
}

export function clearTeamModelCache(): void {
  teamModelCache.clear();
  teamModelRequests.clear();
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
      return { ...config, base_url: `${baseUrl}/v1/ai`, api_key: token || "" };
    }
    case "team": {
      return { ...config, base_url: `${baseUrl}/v1/ai/team`, api_key: token || "" };
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
  const routed = await resolveRoutedConfig(config, token);

  return invoke("ai_chat_stream", {
    messages,
    config: routed,
    conversationId,
    extraTools: extraTools?.length ? extraTools : null,
  });
}
