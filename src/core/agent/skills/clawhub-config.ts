import { getTauriStore } from "@/core/storage";
import { handleError, ErrorLevel } from "@/core/errors";

const STORE_FILENAME = "skill-marketplace.json";
const CLAWHUB_PERSONAL_CONFIG_KEY = "clawhub_personal_config";

export interface ClawHubPersonalConfig {
  siteUrl: string;
  registryUrl: string;
  token: string;
  updatedAt: number;
}

export const DEFAULT_CLAWHUB_SITE_URL = "https://clawhub.ai";
export const DEFAULT_CLAWHUB_REGISTRY_URL = "https://clawhub.ai";

export function normalizeClawHubSiteUrl(_value?: string | null): string {
  return DEFAULT_CLAWHUB_SITE_URL;
}

export function normalizeClawHubRegistryUrl(_value?: string | null): string {
  return DEFAULT_CLAWHUB_REGISTRY_URL;
}

export function createDefaultClawHubPersonalConfig(): ClawHubPersonalConfig {
  return {
    siteUrl: DEFAULT_CLAWHUB_SITE_URL,
    registryUrl: DEFAULT_CLAWHUB_REGISTRY_URL,
    token: "",
    updatedAt: Date.now(),
  };
}

export async function loadClawHubPersonalConfig(): Promise<ClawHubPersonalConfig> {
  try {
    const store = await getTauriStore(STORE_FILENAME);
    const raw = await store.get<string>(CLAWHUB_PERSONAL_CONFIG_KEY);
    if (!raw) return createDefaultClawHubPersonalConfig();
    const parsed = JSON.parse(raw) as Partial<ClawHubPersonalConfig>;
    return {
      siteUrl: normalizeClawHubSiteUrl(parsed.siteUrl),
      registryUrl: normalizeClawHubRegistryUrl(parsed.registryUrl),
      token: typeof parsed.token === "string" ? parsed.token : "",
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch (error) {
    handleError(error, {
      context: "加载 ClawHub 个人配置",
      level: ErrorLevel.Warning,
      silent: true,
    });
    return createDefaultClawHubPersonalConfig();
  }
}

export async function saveClawHubPersonalConfig(
  config: Omit<ClawHubPersonalConfig, "updatedAt">,
): Promise<ClawHubPersonalConfig> {
  const next: ClawHubPersonalConfig = {
    siteUrl: DEFAULT_CLAWHUB_SITE_URL,
    registryUrl: DEFAULT_CLAWHUB_REGISTRY_URL,
    token: config.token,
    updatedAt: Date.now(),
  };
  try {
    const store = await getTauriStore(STORE_FILENAME);
    await store.set(CLAWHUB_PERSONAL_CONFIG_KEY, JSON.stringify(next));
    await store.save();
  } catch (error) {
    handleError(error, {
      context: "保存 ClawHub 个人配置",
      level: ErrorLevel.Warning,
      silent: true,
    });
  }
  return next;
}
