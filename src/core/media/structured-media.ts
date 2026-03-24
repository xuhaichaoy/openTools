import { splitStructuredIMMediaReply } from "@/core/channels/im-media-delivery";
import { resolveChannelOutgoingMedia } from "@/core/channels/channel-outbound-media";

export type StructuredMediaAttachment = {
  path: string;
  fileName?: string;
};

export type StructuredMediaReply = {
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  images?: string[];
  attachments?: StructuredMediaAttachment[];
};

const LOOSE_MEDIA_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff",
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "zip", "7z", "rar",
]);
const FENCED_BLOCK_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?=\n|$)|$)/g;
const QUOTED_MEDIA_RE = /(["'`])((?:https?:\/\/|file:\/\/|\/)[^"'`\n]+\.[A-Za-z0-9]{2,10}(?:[?#][^"'`\n]*)?)\1/g;
const BARE_MEDIA_RE = /(?:^|[\s(（\[【:：])((?:https?:\/\/|file:\/\/|\/)[^\s<>"'`)\]】]+?\.[A-Za-z0-9]{2,10}(?:[?#][^\s<>"'`)\\\]】]*)?)/g;

function normalizePathLike(value?: string | null): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (!/^file:\/\//i.test(trimmed)) {
    return trimmed.replace(/\\/g, "/");
  }

  try {
    const url = new URL(trimmed);
    const pathname = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      return pathname.slice(1).replace(/\\/g, "/");
    }
    return (pathname || trimmed).replace(/\\/g, "/");
  } catch {
    return trimmed.replace(/\\/g, "/");
  }
}

function parseFenceSpans(input: string): Array<{ start: number; end: number }> {
  return [...input.matchAll(FENCED_BLOCK_RE)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function isInsideFence(
  spans: Array<{ start: number; end: number }>,
  offset: number,
): boolean {
  return spans.some((span) => offset >= span.start && offset < span.end);
}

function isLooseMediaRef(value: string): boolean {
  const normalized = normalizePathLike(value)
    .replace(/[),.;!?，。；：]+$/g, "")
    .split("#")[0]
    ?.split("?")[0]
    ?.toLowerCase() ?? "";
  if (!normalized) return false;
  const fileName = normalized.split("/").pop() || normalized;
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  return Boolean(ext && LOOSE_MEDIA_EXTENSIONS.has(ext));
}

function extractLooseMediaRefs(text?: string | null): StructuredMediaReply {
  const raw = String(text ?? "").trimEnd();
  if (!raw.trim()) return { text: "" };

  const fenceSpans = raw.includes("```") || raw.includes("~~~")
    ? parseFenceSpans(raw)
    : [];
  const refs: string[] = [];
  const pushRef = (value?: string | null) => {
    const normalized = normalizePathLike(value).replace(/[),.;!?，。；：]+$/g, "");
    if (!normalized || !isLooseMediaRef(normalized)) return;
    refs.push(normalized);
  };

  for (const match of raw.matchAll(QUOTED_MEDIA_RE)) {
    const offset = match.index ?? 0;
    if (fenceSpans.length && isInsideFence(fenceSpans, offset)) continue;
    pushRef(match[2]);
  }

  for (const match of raw.matchAll(BARE_MEDIA_RE)) {
    const offset = match.index ?? 0;
    if (fenceSpans.length && isInsideFence(fenceSpans, offset)) continue;
    pushRef(match[1]);
  }

  const outgoingMedia = resolveChannelOutgoingMedia({ mediaUrls: refs });
  return {
    text: raw.trim(),
    ...(outgoingMedia.mediaUrl ? { mediaUrl: outgoingMedia.mediaUrl } : {}),
    ...(outgoingMedia.mediaUrls?.length ? { mediaUrls: outgoingMedia.mediaUrls } : {}),
    ...(outgoingMedia.images?.length ? { images: outgoingMedia.images } : {}),
    ...(outgoingMedia.attachments?.length ? { attachments: outgoingMedia.attachments } : {}),
  };
}

function uniqueImages(values: Array<string | undefined>): string[] | undefined {
  const merged = [...new Set(
    values
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  )];
  return merged.length > 0 ? merged : undefined;
}

function uniqueAttachments(
  values: Array<StructuredMediaAttachment | undefined>,
): StructuredMediaAttachment[] | undefined {
  const merged = new Map<string, StructuredMediaAttachment>();
  for (const value of values) {
    const path = String(value?.path ?? "").trim();
    if (!path) continue;
    merged.set(path, {
      path,
      ...(value?.fileName ? { fileName: value.fileName } : {}),
    });
  }
  const attachments = [...merged.values()];
  return attachments.length > 0 ? attachments : undefined;
}

export function splitStructuredMediaReply(text?: string | null): StructuredMediaReply {
  return splitStructuredIMMediaReply(text);
}

export function mergeStructuredMedia(params: {
  text?: string | null;
  images?: string[];
  attachments?: StructuredMediaAttachment[];
}): StructuredMediaReply {
  const parsed = splitStructuredMediaReply(params.text);
  const loose = extractLooseMediaRefs(parsed.text);
  const images = uniqueImages([
    ...(params.images ?? []),
    ...(parsed.images ?? []),
    ...(loose.images ?? []),
  ]);
  const attachments = uniqueAttachments([
    ...(params.attachments ?? []),
    ...(parsed.attachments ?? []),
    ...(loose.attachments ?? []),
  ]);

  return {
    text: parsed.text,
    ...(parsed.mediaUrl ? { mediaUrl: parsed.mediaUrl } : {}),
    ...(parsed.mediaUrls?.length ? { mediaUrls: parsed.mediaUrls } : {}),
    ...(images?.length ? { images } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}
