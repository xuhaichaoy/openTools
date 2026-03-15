import type { AIConfig } from "./types";

const LOCAL_AI_CONFIG_OVERRIDES_KEY = "mtools-ai-local-config-overrides";

export type AILocalConfigOverrideKey =
  | "enable_advanced_tools"
  | "enable_native_tools";

export type AILocalConfigOverrides = Partial<
  Pick<AIConfig, AILocalConfigOverrideKey>
>;

const LOCAL_OVERRIDE_KEYS: AILocalConfigOverrideKey[] = [
  "enable_advanced_tools",
  "enable_native_tools",
];

export function loadAILocalConfigOverrides(): AILocalConfigOverrides {
  if (typeof localStorage === "undefined") {
    return {};
  }

  try {
    const raw = localStorage.getItem(LOCAL_AI_CONFIG_OVERRIDES_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const overrides: AILocalConfigOverrides = {};
    for (const key of LOCAL_OVERRIDE_KEYS) {
      if (typeof parsed[key] === "boolean") {
        overrides[key] = parsed[key] as AIConfig[typeof key];
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

export function saveAILocalConfigOverrides(
  partial: AILocalConfigOverrides,
): AILocalConfigOverrides {
  const next = {
    ...loadAILocalConfigOverrides(),
    ...partial,
  };

  if (typeof localStorage === "undefined") {
    return next;
  }

  try {
    localStorage.setItem(LOCAL_AI_CONFIG_OVERRIDES_KEY, JSON.stringify(next));
  } catch {
    // ignore local persistence failures
  }

  return next;
}

export function applyAILocalConfigOverrides(config: AIConfig): AIConfig {
  const overrides = loadAILocalConfigOverrides();
  if (Object.keys(overrides).length === 0) {
    return config;
  }

  return {
    ...config,
    ...overrides,
  };
}
