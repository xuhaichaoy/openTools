import type { ChannelConfig, ChannelType } from "./types";

export const CHANNEL_STORAGE_KEY = "mtools_im_channels";

export interface SavedChannelEntry {
  config: ChannelConfig;
}

function canUseLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function isChannelType(value: unknown): value is ChannelType {
  return value === "dingtalk" || value === "feishu";
}

export function normalizeChannelConfig(input: unknown): ChannelConfig | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<ChannelConfig> & { platformConfig?: unknown };
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name || !isChannelType(raw.type)) {
    return null;
  }

  const platformConfig = raw.platformConfig && typeof raw.platformConfig === "object"
    ? { ...(raw.platformConfig as Record<string, unknown>) }
    : {};

  return {
    id,
    type: raw.type,
    name,
    enabled: raw.enabled !== false,
    autoConnect: raw.autoConnect !== false,
    platformConfig,
  };
}

function normalizeSavedChannelEntry(input: unknown): SavedChannelEntry | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { config?: unknown };
  const config = normalizeChannelConfig(raw.config ?? input);
  if (!config) return null;
  return { config };
}

export function loadSavedChannels(): SavedChannelEntry[] {
  if (!canUseLocalStorage()) return [];
  try {
    const raw = localStorage.getItem(CHANNEL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeSavedChannelEntry(item))
      .filter((item): item is SavedChannelEntry => item !== null);
  } catch {
    return [];
  }
}

export function saveSavedChannels(channels: SavedChannelEntry[]): void {
  if (!canUseLocalStorage()) return;
  const normalized = channels
    .map((item) => normalizeSavedChannelEntry(item))
    .filter((item): item is SavedChannelEntry => item !== null);
  localStorage.setItem(CHANNEL_STORAGE_KEY, JSON.stringify(normalized));
}
