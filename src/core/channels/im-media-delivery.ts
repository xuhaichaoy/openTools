import { isLikelyVisualAttachmentPath } from "@/core/ai/ai-center-handoff";
import { resolveChannelOutgoingMedia } from "./channel-outbound-media";

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\n\r]+)\)/g;
const FILE_URL_PATTERN = /file:\/\/[^\s"'`<>]+/gi;
const REMOTE_IMAGE_URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi;

export function shouldExplicitlyDeliverMediaToIM(text?: string | null): boolean {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) return false;

  const directPatterns = [
    /发给我/u,
    /给我发/u,
    /传给我/u,
    /回传给我/u,
    /把.{0,20}(图|图片|截图|文件|原图|附件).{0,12}(发|传|给).{0,6}我/u,
    /直接.{0,12}(发|传).{0,6}我/u,
    /send (it|them|that|this)?\s*to me/i,
    /attach (it|them|that|this)?/i,
    /upload (it|them|that|this)?/i,
  ];
  if (directPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const shortImperativePatterns = [
    /^(发|传)$/,
    /^(发|传)我$/,
    /^(发|传)来$/,
    /^(给我|给我看)$/,
  ];
  return shortImperativePatterns.some((pattern) => pattern.test(normalized));
}

const SHAREABLE_IM_PATH_PATTERNS = [
  /(?:^|\/)downloads(?:\/|$)/i,
  /(?:^|\/)desktop(?:\/|$)/i,
  /(?:^|\/)documents(?:\/|$)/i,
  /^\/tmp(?:\/|$)/i,
  /^\/var\/folders(?:\/|$)/i,
] as const;

const ABSOLUTE_FILE_PATH_PATTERN = /(\/[^"'`\n\r<>]+?\.[A-Za-z0-9]{1,12}|[A-Za-z]:\\[^"'`\n\r<>]+?\.[A-Za-z0-9]{1,12})/g;

function normalizePath(path?: string | null): string {
  const normalized = String(path ?? "").trim().replace(/\\/g, "/");
  return normalized.replace(/^\/{2,}(?=(Users|tmp|var|Volumes|home)\b)/, "/");
}

function normalizeFileUrl(value?: string | null): string {
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

function stripTrailingPathPunctuation(path: string): string {
  return path.replace(/[),\]}:;!?。，“”"'`]+$/g, "");
}

function isShareableIMPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  return SHAREABLE_IM_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isHttpMediaUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

function isLikelyRemoteImageUrl(path: string): boolean {
  if (!isHttpMediaUrl(path)) return false;
  const sanitized = path.split("#")[0]?.split("?")[0] ?? path;
  return isLikelyVisualAttachmentPath(sanitized);
}

function extractAbsoluteFilePaths(text?: string | null): string[] {
  const source = String(text ?? "");
  if (!source.trim()) return [];

  const matches = [...source.matchAll(ABSOLUTE_FILE_PATH_PATTERN)]
    .map((match) => stripTrailingPathPunctuation(match[1] || match[0] || ""))
    .map((path) => normalizePath(path))
    .filter(Boolean);

  return [...new Set(matches)];
}

function extractMarkdownImageRefs(text?: string | null): string[] {
  const source = String(text ?? "");
  if (!source.trim()) return [];

  const refs = [...source.matchAll(MARKDOWN_IMAGE_PATTERN)]
    .map((match) => normalizeFileUrl(stripTrailingPathPunctuation(match[2] || "")))
    .filter(Boolean);

  return [...new Set(refs)];
}

function extractFileUrls(text?: string | null): string[] {
  const source = String(text ?? "");
  if (!source.trim()) return [];

  const matches = [...(source.match(FILE_URL_PATTERN) ?? [])]
    .map((match) => normalizeFileUrl(stripTrailingPathPunctuation(match)))
    .filter(Boolean);

  return [...new Set(matches)];
}

function extractRemoteImageUrls(text?: string | null): string[] {
  const source = String(text ?? "");
  if (!source.trim()) return [];

  const matches = [...(source.match(REMOTE_IMAGE_URL_PATTERN) ?? [])]
    .map((match) => stripTrailingPathPunctuation(match))
    .filter(isLikelyRemoteImageUrl);

  return [...new Set(matches)];
}

export function deriveShareableIMMediaFromText(text?: string | null): {
  mediaUrl?: string;
  mediaUrls?: string[];
  images?: string[];
  attachments?: Array<{ path: string; fileName?: string }>;
} {
  const candidates = [
    ...extractMarkdownImageRefs(text),
    ...extractFileUrls(text),
    ...extractAbsoluteFilePaths(text),
    ...extractRemoteImageUrls(text),
  ].filter((candidate, index, list) => {
    if (list.indexOf(candidate) !== index) return false;
    return isHttpMediaUrl(candidate) || isShareableIMPath(candidate);
  });
  if (!candidates.length) return {};
  return resolveChannelOutgoingMedia({ mediaUrls: candidates });
}

export function sanitizeIMReplyTextForMedia(text?: string | null): string {
  const lines = String(text ?? "")
    .replace(MARKDOWN_IMAGE_PATTERN, (_match, altText: string) => {
      const label = String(altText ?? "").trim();
      return label ? `[图片: ${label}]` : "[图片]";
    })
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  const filtered = lines.filter((line) => {
    const normalized = line.trim();
    if (!normalized) return true;
    if (/^\[图片(?:: [^\]]+)?\]$/.test(normalized)) {
      return false;
    }
    return !(
    /当前渠道不能|无法直接发送|不能直接把|只能把本机|回到本机打开|打开图片所在文件夹|不支持(直接)?发送(图片|文件|附件)/u.test(line)
    );
  });

  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
