import { describe, expect, it } from "vitest";

import type { AIConfig } from "@/core/ai/types";

import {
  applyAICenterModelScope,
  buildAICenterModelScope,
  matchesAICenterModelScope,
} from "./ai-center-model-scope";

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

describe("ai-center-model-scope", () => {
  it("captures the current model scope from config", () => {
    expect(buildAICenterModelScope(BASE_CONFIG)).toEqual({
      source: "own_key",
      model: "gpt-4o",
      protocol: "openai",
      activeOwnKeyId: "own-1",
    });
  });

  it("applies a team scope even when current config is own_key", () => {
    const next = applyAICenterModelScope(BASE_CONFIG, {
      source: "team",
      model: "claude-sonnet-4",
      protocol: "anthropic",
      teamId: "team-1",
      teamConfigId: "cfg-1",
    });

    expect(next).toMatchObject({
      source: "team",
      model: "claude-sonnet-4",
      protocol: "anthropic",
      team_id: "team-1",
      team_config_id: "cfg-1",
      active_own_key_id: undefined,
    });
  });

  it("applies an own_key scope even when current config is team", () => {
    const next = applyAICenterModelScope(
      {
        ...BASE_CONFIG,
        source: "team",
        model: "team-model",
        protocol: "anthropic",
        team_id: "team-1",
        team_config_id: "cfg-1",
        active_own_key_id: undefined,
      },
      {
        source: "own_key",
        model: "gpt-4.1",
        protocol: "openai",
        activeOwnKeyId: "own-2",
      },
    );

    expect(next).toMatchObject({
      source: "own_key",
      model: "gpt-4.1",
      protocol: "openai",
      active_own_key_id: "own-2",
      team_id: undefined,
      team_config_id: undefined,
    });
  });

  it("treats a different source as a scope mismatch", () => {
    const scope = {
      source: "team" as const,
      model: "claude-sonnet-4",
      protocol: "anthropic" as const,
      teamId: "team-1",
      teamConfigId: "cfg-1",
    };

    expect(matchesAICenterModelScope(BASE_CONFIG, scope)).toBe(false);
    expect(matchesAICenterModelScope(applyAICenterModelScope(BASE_CONFIG, scope), scope)).toBe(true);
  });
});
