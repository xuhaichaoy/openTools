import type { PluginFeature, PluginInstance } from "./types";

export type PlatformTag = "darwin" | "win" | "linux";

export function getCurrentPlatformTag(): PlatformTag {
  if (typeof navigator === "undefined") return "linux";
  if (navigator.platform.startsWith("Mac")) return "darwin";
  if (navigator.platform.startsWith("Win")) return "win";
  return "linux";
}

export function normalizePlatformTag(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "mac" || lower === "macos" || lower === "osx")
    return "darwin";
  if (lower === "windows" || lower === "win32") return "win";
  return lower;
}

export function isFeatureSupportedOnCurrentPlatform(
  feature: PluginFeature,
): boolean {
  const platforms = feature.platform;
  if (!platforms || platforms.length === 0) return true;
  const current = getCurrentPlatformTag();
  return platforms.some((platform) => normalizePlatformTag(platform) === current);
}

export function getPrimarySupportedFeature(
  plugin: Pick<PluginInstance, "manifest"> | null | undefined,
): PluginFeature | null {
  if (!plugin) return null;
  return (
    plugin.manifest.features.find((feature) =>
      isFeatureSupportedOnCurrentPlatform(feature),
    ) || null
  );
}
