export type AIProtocol = "openai" | "anthropic";

interface ModelCapabilityRule {
  pattern: string;
  protocols?: AIProtocol[];
  supportsImageInput: boolean;
  source: "openclaw" | "fallback";
}

export interface ModelCapabilities {
  supportsImageInput: boolean;
  source: "openclaw" | "fallback";
}

const OPENCLAW_MODEL_CAPABILITY_RULES: ReadonlyArray<ModelCapabilityRule> = [
  { pattern: "qwen3.5-plus", protocols: ["openai"], supportsImageInput: true, source: "openclaw" },
  { pattern: "qwen3-max", protocols: ["openai"], supportsImageInput: false, source: "openclaw" },
  { pattern: "qwen3-coder-next", protocols: ["openai"], supportsImageInput: false, source: "openclaw" },
  { pattern: "qwen3-coder-plus", protocols: ["openai"], supportsImageInput: false, source: "openclaw" },
  { pattern: "minimax-vl-01", protocols: ["anthropic"], supportsImageInput: true, source: "openclaw" },
  { pattern: "minimax-vl", supportsImageInput: true, source: "openclaw" },
  { pattern: "minimax-m2.5-highspeed", supportsImageInput: false, source: "openclaw" },
  { pattern: "minimax-m2.5", supportsImageInput: false, source: "openclaw" },
  { pattern: "minimax-2.5", supportsImageInput: false, source: "openclaw" },
  { pattern: "glm-5", protocols: ["openai"], supportsImageInput: false, source: "openclaw" },
  { pattern: "glm-4.7", protocols: ["openai"], supportsImageInput: false, source: "openclaw" },
  { pattern: "kimi-k2.5", protocols: ["openai"], supportsImageInput: true, source: "openclaw" },
];

const TEXT_ONLY_HINTS = [
  "embedding",
  "rerank",
  "re-rank",
  "transcribe",
  "transcription",
  "whisper",
  "tts",
  "speech",
  "asr",
  "coder",
];

const OPENAI_VISION_HINTS = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.7",
  "gpt-5",
  "claude",
  "gemini",
  "kimi",
  "qwen-vl",
  "qwen2-vl",
  "qwen2.5-vl",
  "qwen3.5-plus",
  "glm-4v",
  "glm-4.1v",
  "minimax-vl",
  "vision",
];

const ANTHROPIC_VISION_HINTS = [
  "claude",
  "minimax-vl",
];

function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeProtocol(protocol?: string): AIProtocol {
  return String(protocol || "").trim().toLowerCase() === "anthropic"
    ? "anthropic"
    : "openai";
}

function matchesRule(
  rule: ModelCapabilityRule,
  model: string,
  protocol: AIProtocol,
): boolean {
  if (rule.protocols && !rule.protocols.includes(protocol)) return false;
  return model.includes(rule.pattern);
}

function matchesAnyPattern(model: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => model.includes(pattern));
}

function fallbackSupportsImageInput(model: string, protocol: AIProtocol): boolean {
  if (matchesAnyPattern(model, TEXT_ONLY_HINTS)) return false;

  return protocol === "anthropic"
    ? matchesAnyPattern(model, ANTHROPIC_VISION_HINTS)
    : matchesAnyPattern(model, OPENAI_VISION_HINTS);
}

export function resolveModelCapabilities(
  model: string,
  protocol?: string,
): ModelCapabilities {
  const normalizedModel = normalizeModel(model);
  const normalizedProtocol = normalizeProtocol(protocol);

  const explicitRule = OPENCLAW_MODEL_CAPABILITY_RULES.find((rule) =>
    matchesRule(rule, normalizedModel, normalizedProtocol),
  );
  if (explicitRule) {
    console.log(
      `[ModelCapabilities] model="${model}" normalized="${normalizedModel}" protocol="${normalizedProtocol}" → EXPLICIT rule pattern="${explicitRule.pattern}" supportsImage=${explicitRule.supportsImageInput}`,
    );
    return {
      supportsImageInput: explicitRule.supportsImageInput,
      source: explicitRule.source,
    };
  }

  const fallbackResult = fallbackSupportsImageInput(
    normalizedModel,
    normalizedProtocol,
  );
  const matchedHint = normalizedProtocol === "anthropic"
    ? ANTHROPIC_VISION_HINTS.find((h) => normalizedModel.includes(h))
    : OPENAI_VISION_HINTS.find((h) => normalizedModel.includes(h));
  const matchedTextOnly = TEXT_ONLY_HINTS.find((h) => normalizedModel.includes(h));
  console.log(
    `[ModelCapabilities] model="${model}" normalized="${normalizedModel}" protocol="${normalizedProtocol}" → FALLBACK supportsImage=${fallbackResult} matchedHint=${matchedHint ?? "none"} matchedTextOnly=${matchedTextOnly ?? "none"}`,
  );

  return {
    supportsImageInput: fallbackResult,
    source: "fallback",
  };
}

export function modelSupportsImageInput(
  model: string,
  protocol?: string,
): boolean {
  return resolveModelCapabilities(model, protocol).supportsImageInput;
}
