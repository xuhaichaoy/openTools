import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIConfig } from "./types";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  getAuthState: vi.fn(() => ({ token: "token" })),
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

describe("resolveTeamModelConfig", () => {
  beforeEach(() => {
    clearTeamModelCache();
    mocks.apiGet.mockReset();
    mocks.getAuthState.mockReset();
    mocks.getAuthState.mockReturnValue({ token: "token" });
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
    mocks.getAuthState.mockReturnValueOnce({ token: "session-token" });

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
});
