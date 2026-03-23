import type { AICenterMode } from "@/store/app-store";
import { normalizeAIProductMode } from "@/core/ai/ai-mode-types";
import { useAppStore } from "@/store/app-store";
import { useAIStore } from "@/store/ai-store";
import { resolveAIConfig, type ResolvedAIConfig } from "./resolved-ai-config";

export function getResolvedAIConfigForMode(
  mode: AICenterMode = "explore",
): ResolvedAIConfig {
  const aiState = useAIStore.getState();
  const appState = useAppStore.getState();
  const normalizedMode = normalizeAIProductMode(mode);
  return resolveAIConfig({
    baseConfig: aiState.config,
    ownKeys: aiState.ownKeys,
    scope: appState.aiCenterModelScopes[normalizedMode],
  });
}
