import { describe, expect, it } from "vitest";

import type { AIConfig, OwnKeyModelConfig } from "@/core/ai/types";

import {
  DEFAULT_PLATFORM_MODEL,
  DEFAULT_PLATFORM_PROTOCOL,
  resolveAIConfig,
} from "./resolved-ai-config";

const BASE_CONFIG: AIConfig = {
  base_url: "https://api.example.com/v1",
  api_key: "sk-demo",
  model: "gpt-4o",
  temperature: 0.7,
  max_tokens: null,
  enable_advanced_tools: false,
  system_prompt: "",
  enable_rag_auto_search: true,
  enable_native_tools: true,
  enable_long_term_memory: true,
  enable_memory_auto_recall: true,
  enable_memory_auto_save: true,
  enable_memory_sync: true,
  source: "own_key",
  protocol: "openai",
  active_own_key_id: "own-1",
};

const OWN_KEYS: OwnKeyModelConfig[] = [
  {
    id: "own-1",
    name: "OpenAI Default",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    api_key: "sk-openai",
    model: "gpt-4o",
    temperature: 0.7,
    max_tokens: 4096,
  },
  {
    id: "own-2",
    name: "Anthropic Work",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    api_key: "sk-anthropic",
    model: "claude-sonnet-4",
    temperature: 0.2,
    max_tokens: 8192,
  },
];

describe("resolved-ai-config", () => {
  it("resolves own_key mode preference from the selected local key", () => {
    const resolved = resolveAIConfig({
      baseConfig: BASE_CONFIG,
      ownKeys: OWN_KEYS,
      scope: {
        source: "own_key",
        activeOwnKeyId: "own-2",
        model: "claude-custom",
        protocol: "anthropic",
      },
    });

    expect(resolved).toMatchObject({
      source: "own_key",
      active_own_key_id: "own-2",
      base_url: "https://api.anthropic.com",
      api_key: "sk-anthropic",
      model: "claude-custom",
      protocol: "anthropic",
      temperature: 0.2,
      max_tokens: 8192,
    });
  });

  it("falls back to the first available own key when the stored preference no longer exists", () => {
    const resolved = resolveAIConfig({
      baseConfig: {
        ...BASE_CONFIG,
        active_own_key_id: "missing-key",
      },
      ownKeys: OWN_KEYS,
      scope: {
        source: "own_key",
        activeOwnKeyId: "deleted-key",
      },
    });

    expect(resolved).toMatchObject({
      source: "own_key",
      active_own_key_id: "own-1",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-openai",
      model: "gpt-4o",
      protocol: "openai",
    });
  });

  it("does not inherit stale client-side model metadata in platform mode", () => {
    const resolved = resolveAIConfig({
      baseConfig: {
        ...BASE_CONFIG,
        source: "platform",
        model: "claude-sonnet-4",
        protocol: "anthropic",
        team_id: "team-1",
        team_config_id: "cfg-1",
        active_own_key_id: "own-2",
      },
      ownKeys: OWN_KEYS,
    });

    expect(resolved).toMatchObject({
      source: "platform",
      model: DEFAULT_PLATFORM_MODEL,
      protocol: DEFAULT_PLATFORM_PROTOCOL,
      team_id: undefined,
      team_config_id: undefined,
      active_own_key_id: undefined,
    });
  });
});
