import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIConfig } from "./types";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  getAuthState: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/core/api/client", () => ({
  api: {
    get: mocks.apiGet,
  },
}));

vi.mock("@/store/server-store", () => ({
  getServerUrl: () => "http://127.0.0.1:3000",
}));

vi.mock("@/store/auth-store", () => ({
  useAuthStore: {
    getState: mocks.getAuthState,
  },
}));

import { clearTeamModelCache, resolveRoutedConfig, resolveTeamModelConfig } from "./router";
import { withRoutedAIConfig } from "./router";

describe("resolveTeamModelConfig", () => {
  beforeEach(() => {
    clearTeamModelCache();
    mocks.apiGet.mockReset();
    mocks.getAuthState.mockReset();
    mocks.login.mockReset();
    mocks.logout.mockReset();
    mocks.fetch.mockReset();
    globalThis.fetch = mocks.fetch as typeof fetch;
    mocks.getAuthState.mockReturnValue({
      token: "token",
      refreshToken: "refresh-token",
      login: mocks.login,
      logout: mocks.logout,
    });
  });

  it("should reuse auth store token when caller omits token", async () => {
    mocks.apiGet.mockResolvedValueOnce({
      models: [
        {
          config_id: "cfg-minimax",
          model_name: "MiniMax-M2.5",
          protocol: "anthropic",
        },
      ],
    });
    mocks.getAuthState.mockReturnValueOnce({
      token: "session-token",
      refreshToken: "refresh-token",
      login: mocks.login,
      logout: mocks.logout,
    });

    const config: AIConfig = {
      base_url: "http://127.0.0.1:3000/v1/ai/team",
      api_key: "",
      model: "MiniMax-M2.5",
      temperature: 0.7,
      max_tokens: null,
      enable_advanced_tools: true,
      system_prompt: "",
      enable_rag_auto_search: true,
      enable_native_tools: true,
      enable_long_term_memory: true,
      enable_memory_auto_recall: true,
      enable_memory_auto_save: true,
      enable_memory_sync: true,
      source: "team",
      team_id: "team-1",
      protocol: "openai",
    };

    const routed = await resolveRoutedConfig(config);

    expect(routed.api_key).toBe("session-token");
    expect(routed.base_url).toBe("http://127.0.0.1:3000/v1/ai/team");
    expect(routed.protocol).toBe("anthropic");
    expect(routed.team_config_id).toBe("cfg-minimax");
  });

  it("should resolve MiniMax team model to anthropic protocol", () => {
    const config: AIConfig = {
      base_url: "http://127.0.0.1:3000/v1/ai/team",
      api_key: "token",
      model: "MiniMax-M2.5",
      temperature: 0.7,
      max_tokens: null,
      enable_advanced_tools: true,
      system_prompt: "",
      enable_rag_auto_search: true,
      enable_native_tools: true,
      enable_long_term_memory: true,
      enable_memory_auto_recall: true,
      enable_memory_auto_save: true,
      enable_memory_sync: true,
      source: "team",
      team_id: "team-1",
      protocol: "openai",
    };

    const resolved = resolveTeamModelConfig(config, [
      {
        config_id: "cfg-minimax",
        model_name: "MiniMax-M2.5",
        protocol: "anthropic",
      },
    ]);

    expect(resolved.team_config_id).toBe("cfg-minimax");
    expect(resolved.model).toBe("MiniMax-M2.5");
    expect(resolved.protocol).toBe("anthropic");
  });

  it("should prefer explicit model override over stale team_config_id", () => {
    const config: AIConfig = {
      base_url: "http://127.0.0.1:3000/v1/ai/team",
      api_key: "token",
      model: "MiniMax-M2.5",
      temperature: 0.7,
      max_tokens: null,
      enable_advanced_tools: true,
      system_prompt: "",
      enable_rag_auto_search: true,
      enable_native_tools: true,
      enable_long_term_memory: true,
      enable_memory_auto_recall: true,
      enable_memory_auto_save: true,
      enable_memory_sync: true,
      source: "team",
      team_id: "team-1",
      team_config_id: "cfg-openai",
      protocol: "openai",
    };

    const resolved = resolveTeamModelConfig(config, [
      {
        config_id: "cfg-openai",
        model_name: "gpt-4o",
        protocol: "openai",
      },
      {
        config_id: "cfg-minimax",
        model_name: "MiniMax-M2.5",
        protocol: "anthropic",
      },
    ]);

    expect(resolved.team_config_id).toBe("cfg-minimax");
    expect(resolved.model).toBe("MiniMax-M2.5");
    expect(resolved.protocol).toBe("anthropic");
  });

  it("retries managed AI requests after refreshing auth token", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "refreshed-token",
        refresh_token: "refreshed-refresh-token",
        user: { id: "user-1" },
      }),
    });

    const config: AIConfig = {
      base_url: "https://api.openai.com/v1",
      api_key: "",
      model: "gpt-5.4",
      temperature: 0.7,
      max_tokens: null,
      enable_advanced_tools: true,
      system_prompt: "",
      enable_rag_auto_search: true,
      enable_native_tools: true,
      enable_long_term_memory: true,
      enable_memory_auto_recall: true,
      enable_memory_auto_save: true,
      enable_memory_sync: true,
      source: "platform",
      protocol: "openai",
    };

    const runner = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('API 错误 (HTTP 401): {"code":"UNAUTHORIZED","message":"Invalid token"}'),
      )
      .mockResolvedValueOnce("ok");

    const result = await withRoutedAIConfig(config, runner);

    expect(result).toBe("ok");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]?.[0]?.api_key).toBe("token");
    expect(runner.mock.calls[1]?.[0]?.api_key).toBe("refreshed-token");
    expect(mocks.login).toHaveBeenCalledWith(
      { id: "user-1" },
      "refreshed-token",
      "refreshed-refresh-token",
    );
  });

  it("reuses a newer auth-store token before issuing another refresh", async () => {
    const authState = {
      token: "stale-token",
      refreshToken: "refresh-token",
      login: mocks.login,
      logout: mocks.logout,
    };
    mocks.getAuthState.mockImplementation(() => authState);

    const config: AIConfig = {
      base_url: "https://api.openai.com/v1",
      api_key: "",
      model: "gpt-5.4",
      temperature: 0.7,
      max_tokens: null,
      enable_advanced_tools: true,
      system_prompt: "",
      enable_rag_auto_search: true,
      enable_native_tools: true,
      enable_long_term_memory: true,
      enable_memory_auto_recall: true,
      enable_memory_auto_save: true,
      enable_memory_sync: true,
      source: "platform",
      protocol: "openai",
    };

    const runner = vi.fn(async (routed: AIConfig) => {
      if (routed.api_key === "stale-token") {
        authState.token = "fresh-token-from-store";
        throw new Error('API 错误 (HTTP 401): {"code":"UNAUTHORIZED","message":"Invalid token"}');
      }
      return "ok";
    });

    const result = await withRoutedAIConfig(config, runner);

    expect(result).toBe("ok");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[0]?.api_key).toBe("fresh-token-from-store");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent managed-auth refresh requests", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "shared-refreshed-token",
        refresh_token: "shared-refresh-token",
        user: { id: "user-1" },
      }),
    });

    const config: AIConfig = {
      base_url: "https://api.openai.com/v1",
      api_key: "",
      model: "gpt-5.4",
      temperature: 0.7,
      max_tokens: null,
      enable_advanced_tools: true,
      system_prompt: "",
      enable_rag_auto_search: true,
      enable_native_tools: true,
      enable_long_term_memory: true,
      enable_memory_auto_recall: true,
      enable_memory_auto_save: true,
      enable_memory_sync: true,
      source: "platform",
      protocol: "openai",
    };

    const runnerA = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('API 错误 (HTTP 401): {"code":"UNAUTHORIZED","message":"Invalid token"}'),
      )
      .mockResolvedValueOnce("ok-a");
    const runnerB = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('API 错误 (HTTP 401): {"code":"UNAUTHORIZED","message":"Invalid token"}'),
      )
      .mockResolvedValueOnce("ok-b");

    const [resultA, resultB] = await Promise.all([
      withRoutedAIConfig(config, runnerA),
      withRoutedAIConfig(config, runnerB),
    ]);

    expect(resultA).toBe("ok-a");
    expect(resultB).toBe("ok-b");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
