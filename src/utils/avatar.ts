import { getServerUrl } from "@/store/server-store";

/**
 * Resolves an avatar_url to a fully displayable URL.
 * Handles: data: URIs, absolute https:// URLs, relative server paths (/uploads/...).
 */
export function resolveAvatarUrl(avatarUrl: string | undefined | null): string {
  if (!avatarUrl) return "";
  if (avatarUrl.startsWith("data:") || avatarUrl.startsWith("http://") || avatarUrl.startsWith("https://")) {
    return avatarUrl;
  }
  if (avatarUrl.startsWith("/")) {
    return `${getServerUrl()}${avatarUrl}`;
  }
  return avatarUrl;
}
