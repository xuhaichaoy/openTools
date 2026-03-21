import type { AICenterMode } from "@/store/app-store";
import { useAppStore } from "@/store/app-store";
import { useAIStore } from "@/store/ai-store";
import { resolveAIConfig, type ResolvedAIConfig } from "./resolved-ai-config";

export function getResolvedAIConfigForMode(
  mode: AICenterMode = "ask",
): ResolvedAIConfig {
  const aiState = useAIStore.getState();
  const appState = useAppStore.getState();
  return resolveAIConfig({
    baseConfig: aiState.config,
    ownKeys: aiState.ownKeys,
    scope: appState.aiCenterModelScopes[mode],
  });
}
