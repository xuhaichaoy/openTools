import { describe, expect, it } from "vitest";

import {
  modelSupportsImageInput,
  resolveModelCapabilities,
} from "./model-capabilities";

describe("model capabilities", () => {
  it("matches OpenClaw for ModelStudio family", () => {
    expect(modelSupportsImageInput("qwen3.5-plus", "openai")).toBe(true);
    expect(modelSupportsImageInput("qwen3-max-2026-01-23", "openai")).toBe(
      false,
    );
    expect(modelSupportsImageInput("MiniMax-M2.5", "openai")).toBe(false);
    expect(modelSupportsImageInput("MiniMax M2.5", "openai")).toBe(false);
    expect(modelSupportsImageInput("glm-5", "openai")).toBe(false);
    expect(modelSupportsImageInput("kimi-k2.5", "openai")).toBe(true);
  });

  it("marks explicit OpenClaw matches as openclaw sourced", () => {
    expect(resolveModelCapabilities("qwen3.5-plus", "openai")).toEqual({
      supportsImageInput: true,
      source: "openclaw",
    });
  });

  it("falls back for generic multimodal models outside OpenClaw table", () => {
    expect(resolveModelCapabilities("gpt-4o", "openai")).toEqual({
      supportsImageInput: true,
      source: "fallback",
    });
  });

  it("normalizes space separated model names", () => {
    expect(resolveModelCapabilities("MiniMax VL 01", "anthropic")).toEqual({
      supportsImageInput: true,
      source: "openclaw",
    });
  });
});
