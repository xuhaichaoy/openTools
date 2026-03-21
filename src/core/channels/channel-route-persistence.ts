import type { ChannelIncomingMessage } from "./types";

export const CHANNEL_ROUTE_STORAGE_KEY = "mtools_im_channel_routes_v1";

export interface PersistedConversationRoute {
  key: string;
  channelId: string;
  conversationId: string;
  conversationType?: ChannelIncomingMessage["conversationType"];
  targetUserId?: string;
  lastActiveAt: number;
  messageId?: string;
  replyWebhookUrl?: string;
  replyWebhookExpiresAt?: number;
  robotCode?: string;
}

function canUseLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeConversationType(
  value: unknown,
): ChannelIncomingMessage["conversationType"] | undefined {
  return value === "private" || value === "group" ? value : undefined;
}

function normalizePersistedConversationRoute(input: unknown): PersistedConversationRoute | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<PersistedConversationRoute>;
  const key = trimString(raw.key);
  const channelId = trimString(raw.channelId);
  const conversationId = trimString(raw.conversationId);
  const lastActiveAt = typeof raw.lastActiveAt === "number" && Number.isFinite(raw.lastActiveAt)
    ? raw.lastActiveAt
    : NaN;
  if (!key || !channelId || !conversationId || !Number.isFinite(lastActiveAt) || lastActiveAt <= 0) {
    return null;
  }

  return {
    key,
    channelId,
    conversationId,
    lastActiveAt,
    ...(normalizeConversationType(raw.conversationType)
      ? { conversationType: normalizeConversationType(raw.conversationType) }
      : {}),
    ...(trimString(raw.targetUserId) ? { targetUserId: trimString(raw.targetUserId) } : {}),
    ...(trimString(raw.messageId) ? { messageId: trimString(raw.messageId) } : {}),
    ...(trimString(raw.replyWebhookUrl) ? { replyWebhookUrl: trimString(raw.replyWebhookUrl) } : {}),
    ...(typeof raw.replyWebhookExpiresAt === "number" && Number.isFinite(raw.replyWebhookExpiresAt)
      ? { replyWebhookExpiresAt: raw.replyWebhookExpiresAt }
      : {}),
    ...(trimString(raw.robotCode) ? { robotCode: trimString(raw.robotCode) } : {}),
  };
}

export function loadPersistedConversationRoutes(): PersistedConversationRoute[] {
  if (!canUseLocalStorage()) return [];
  try {
    const raw = localStorage.getItem(CHANNEL_ROUTE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizePersistedConversationRoute(item))
      .filter((item): item is PersistedConversationRoute => item !== null);
  } catch {
    return [];
  }
}

export function savePersistedConversationRoutes(routes: PersistedConversationRoute[]): void {
  if (!canUseLocalStorage()) return;
  try {
    const normalized = routes
      .map((item) => normalizePersistedConversationRoute(item))
      .filter((item): item is PersistedConversationRoute => item !== null);
    localStorage.setItem(CHANNEL_ROUTE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore best-effort persistence failures.
  }
}

export function clearPersistedConversationRoutes(): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.removeItem(CHANNEL_ROUTE_STORAGE_KEY);
  } catch {
    // Ignore best-effort clear failures.
  }
}
