import { isLikelyVisualAttachmentPath } from "@/core/ai/ai-center-handoff";
import type { ChannelOutgoingMessage } from "./types";

type ChannelOutgoingAttachment = NonNullable<ChannelOutgoingMessage["attachments"]>[number];

function normalizeFileUrl(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      return pathname.slice(1);
    }
    return pathname || value;
  } catch {
    return value;
  }
}

function normalizeMediaRef(value?: string | null): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return normalizeFileUrl(trimmed).replace(/\\/g, "/");
}

function uniqueOrdered(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeMediaRef(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function extractMediaFileName(value: string): string | undefined {
  try {
    if (/^[a-z]+:\/\//i.test(value)) {
      const pathname = decodeURIComponent(new URL(value).pathname || "");
      const normalized = pathname.replace(/\\/g, "/");
      return normalized.split("/").pop() || undefined;
    }
  } catch {
    // Fall through to path-like parsing.
  }
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").pop() || undefined;
}

function isLikelyVisualMediaRef(value: string): boolean {
  const sanitized = value.split("#")[0]?.split("?")[0] ?? value;
  return isLikelyVisualAttachmentPath(sanitized);
}

export function resolveOutgoingMediaUrls(
  params: Pick<ChannelOutgoingMessage, "mediaUrl" | "mediaUrls" | "images" | "attachments">,
): string[] | undefined {
  const urls = uniqueOrdered([
    ...(params.mediaUrls ?? []),
    params.mediaUrl,
    ...(params.images ?? []),
    ...((params.attachments ?? []).map((item) => item.path)),
  ]);
  return urls.length ? urls : undefined;
}

export function resolveChannelOutgoingMedia(
  params: Pick<ChannelOutgoingMessage, "mediaUrl" | "mediaUrls" | "images" | "attachments">,
): {
  mediaUrl?: string;
  mediaUrls?: string[];
  images?: string[];
  attachments?: ChannelOutgoingAttachment[];
} {
  const explicitImages = new Set((params.images ?? []).map((value) => normalizeMediaRef(value)).filter(Boolean));
  const explicitAttachments = new Map<string, ChannelOutgoingAttachment>();
  for (const item of params.attachments ?? []) {
    const path = normalizeMediaRef(item.path);
    if (!path) continue;
    explicitAttachments.set(path, {
      path,
      ...(item.fileName ? { fileName: item.fileName } : {}),
    });
  }

  const mediaUrls = resolveOutgoingMediaUrls(params);
  const images: string[] = [];
  const attachments = new Map<string, ChannelOutgoingAttachment>(explicitAttachments);

  for (const mediaUrl of mediaUrls ?? []) {
    if (explicitImages.has(mediaUrl)) {
      images.push(mediaUrl);
      continue;
    }
    const explicitAttachment = attachments.get(mediaUrl);
    if (explicitAttachment) {
      attachments.set(mediaUrl, explicitAttachment);
      continue;
    }
    if (isLikelyVisualMediaRef(mediaUrl)) {
      images.push(mediaUrl);
      continue;
    }
    attachments.set(mediaUrl, {
      path: mediaUrl,
      fileName: extractMediaFileName(mediaUrl),
    });
  }

  for (const image of explicitImages) {
    if (!images.includes(image) && !attachments.has(image)) {
      images.push(image);
    }
  }

  const attachmentList = [...attachments.values()];
  return {
    ...(mediaUrls?.length ? { mediaUrls, mediaUrl: mediaUrls[0] } : {}),
    ...(images.length ? { images } : {}),
    ...(attachmentList.length ? { attachments: attachmentList } : {}),
  };
}
