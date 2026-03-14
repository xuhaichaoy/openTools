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

function fallbackSupportsImageInput(model: string, protocol: AIProtocol): boolean {
  if (protocol === "anthropic") {
    return model.includes("claude") || model.includes("minimax-vl");
  }

  return model.includes("gpt-4")
    || model.includes("gpt-4o")
    || model.includes("gpt-4.1")
    || model.includes("claude")
    || model.includes("gemini")
    || model.includes("kimi")
    || model.includes("qwen-vl")
    || model.includes("qwen2-vl")
    || model.includes("qwen2.5-vl")
    || model.includes("glm-4v")
    || model.includes("glm-4.1v")
    || model.includes("minimax-vl");
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
    return {
      supportsImageInput: explicitRule.supportsImageInput,
      source: explicitRule.source,
    };
  }

  return {
    supportsImageInput: fallbackSupportsImageInput(
      normalizedModel,
      normalizedProtocol,
    ),
    source: "fallback",
  };
}

export function modelSupportsImageInput(
  model: string,
  protocol?: string,
): boolean {
  return resolveModelCapabilities(model, protocol).supportsImageInput;
}
