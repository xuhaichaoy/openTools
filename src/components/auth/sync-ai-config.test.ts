import { describe, expect, it } from "vitest";
import { mergeCloudAIConfig } from "./sync-ai-config";

describe("mergeCloudAIConfig", () => {
  it("should not switch to invalid team source when team_id is missing", () => {
    const local = {
      base_url: "https://api.openai.com/v1",
      api_key: "local-key",
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
      source: "own_key" as const,
      active_own_key_id: "key-1",
    };

    const cloud = {
      source: "team",
      model: "claude-3-5-sonnet",
      team_config_id: "cfg-1",
    };

    const merged = mergeCloudAIConfig(local, cloud, 100);

    expect(merged.source).toBe("own_key");
    expect(merged.team_id).toBeUndefined();
    expect(merged.team_config_id).toBeUndefined();
    expect(merged.model).toBe("claude-3-5-sonnet");
    expect((merged as any)._syncVersion).toBe(100);
  });

  it("should keep local-only tool toggles while merging shared fields", () => {
    const local = {
      base_url: "https://api.openai.com/v1",
      api_key: "local-key",
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: null,
      enable_advanced_tools: false,
      system_prompt: "",
      enable_rag_auto_search: true,
      enable_native_tools: false,
      enable_long_term_memory: true,
      enable_memory_auto_recall: true,
      enable_memory_auto_save: true,
      enable_memory_sync: true,
      source: "own_key" as const,
      protocol: "openai" as const,
      active_own_key_id: "key-local",
    };

    const cloud = {
      source: "team",
      team_id: "team-1",
      team_config_id: "cfg-2",
      protocol: "anthropic",
      active_own_key_id: "key-cloud",
      enable_advanced_tools: true,
      enable_native_tools: true,
      enable_memory_auto_recall: false,
    };

    const merged = mergeCloudAIConfig(local, cloud, 101);

    expect(merged.source).toBe("team");
    expect(merged.team_id).toBe("team-1");
    expect(merged.team_config_id).toBe("cfg-2");
    expect(merged.protocol).toBe("anthropic");
    expect(merged.active_own_key_id).toBe("key-cloud");
    expect(merged.enable_advanced_tools).toBe(false);
    expect(merged.enable_native_tools).toBe(false);
    expect(merged.enable_memory_auto_recall).toBe(false);
    expect((merged as any)._syncVersion).toBe(101);
  });
});
