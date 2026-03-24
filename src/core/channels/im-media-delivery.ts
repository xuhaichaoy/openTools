import { resolveChannelOutgoingMedia } from "./channel-outbound-media";

const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,12}$/;
const FENCED_BLOCK_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?=\n|$)|$)/g;

function normalizePath(path?: string | null): string {
  const normalized = String(path ?? "").trim().replace(/\\/g, "/");
  return normalized.replace(/^\/{2,}(?=(Users|tmp|var|Volumes|home)\b)/, "/");
}

function normalizeMediaSource(value?: string | null): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (!/^file:\/\//i.test(trimmed)) {
    return normalizePath(trimmed);
  }

  try {
    const url = new URL(trimmed);
    const pathname = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      return normalizePath(pathname.slice(1));
    }
    return normalizePath(pathname || trimmed);
  } catch {
    return normalizePath(trimmed);
  }
}

function cleanCandidate(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^[`"'[{(]+/, "")
    .replace(/[`"'\\})\],:;!?。，“”]+$/, "");
}

function unwrapQuoted(value: string): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last) return undefined;
  if (first !== `"` && first !== "'" && first !== "`") return undefined;
  return trimmed.slice(1, -1).trim();
}

function isLikelyLocalPath(candidate: string): boolean {
  return (
    candidate.startsWith("/")
    || candidate.startsWith("file://")
    || WINDOWS_DRIVE_RE.test(candidate)
    || candidate.startsWith("\\\\")
  );
}

function isValidMediaRef(
  candidate: string,
  opts?: { allowSpaces?: boolean; allowBareFilename?: boolean },
): boolean {
  if (!candidate || candidate.length > 4096) {
    return false;
  }
  if (!opts?.allowSpaces && /\s/.test(candidate)) {
    return false;
  }
  if (/^https?:\/\//i.test(candidate)) {
    return true;
  }
  if (isLikelyLocalPath(candidate)) {
    return true;
  }
  if (opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT_RE.test(candidate)) {
    return true;
  }
  return false;
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

export function splitStructuredIMMediaReply(text?: string | null): {
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  images?: string[];
  attachments?: Array<{ path: string; fileName?: string }>;
} {
  const trimmedRaw = String(text ?? "").trimEnd();
  if (!trimmedRaw.trim()) {
    return { text: "" };
  }

  const hasFenceMarkers = trimmedRaw.includes("```") || trimmedRaw.includes("~~~");
  const fenceSpans = hasFenceMarkers ? parseFenceSpans(trimmedRaw) : [];
  const lines = trimmedRaw.split("\n");
  const mediaRefs: string[] = [];
  const keptLines: string[] = [];

  let lineOffset = 0;
  for (const line of lines) {
    if (hasFenceMarkers && isInsideFence(fenceSpans, lineOffset)) {
      keptLines.push(line);
      lineOffset += line.length + 1;
      continue;
    }

    const trimmedStart = line.trimStart();
    if (!trimmedStart.startsWith("MEDIA:")) {
      keptLines.push(line);
      lineOffset += line.length + 1;
      continue;
    }

    const matches = [...line.matchAll(MEDIA_TOKEN_RE)];
    if (!matches.length) {
      keptLines.push(line);
      lineOffset += line.length + 1;
      continue;
    }

    const pieces: string[] = [];
    let cursor = 0;

    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(line.slice(cursor, start));

      const payload = String(match[1] ?? "");
      const unwrapped = unwrapQuoted(payload);
      const payloadValue = (unwrapped ?? payload).trim();
      const parts = unwrapped ? [unwrapped] : payload.split(/\s+/).filter(Boolean);
      const invalidParts: string[] = [];
      const mediaCountBeforeMatch = mediaRefs.length;

      for (const part of parts) {
        const candidate = normalizeMediaSource(cleanCandidate(part));
        if (isValidMediaRef(candidate, unwrapped ? { allowSpaces: true } : undefined)) {
          mediaRefs.push(candidate);
        } else if (part.trim()) {
          invalidParts.push(part.trim());
        }
      }

      if (mediaRefs.length === mediaCountBeforeMatch && payloadValue) {
        const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
        if (isValidMediaRef(fallback, { allowSpaces: true, allowBareFilename: true })) {
          mediaRefs.push(fallback);
          invalidParts.length = 0;
        }
      }

      if (invalidParts.length) {
        pieces.push(invalidParts.join(" "));
      }
      cursor = start + match[0].length;
    }

    pieces.push(line.slice(cursor));
    const cleanedLine = pieces
      .join("")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    if (cleanedLine) {
      keptLines.push(cleanedLine);
    }
    lineOffset += line.length + 1;
  }

  const cleanedText = keptLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const outgoingMedia = resolveChannelOutgoingMedia({ mediaUrls: mediaRefs });
  return {
    text: cleanedText,
    ...(outgoingMedia.mediaUrl ? { mediaUrl: outgoingMedia.mediaUrl } : {}),
    ...(outgoingMedia.mediaUrls?.length ? { mediaUrls: outgoingMedia.mediaUrls } : {}),
    ...(outgoingMedia.images?.length ? { images: outgoingMedia.images } : {}),
    ...(outgoingMedia.attachments?.length ? { attachments: outgoingMedia.attachments } : {}),
  };
}
