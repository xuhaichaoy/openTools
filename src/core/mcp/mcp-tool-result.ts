import { invoke } from "@tauri-apps/api/core";

type JsonRecord = Record<string, unknown>;

export interface McpToolResultMaterializeOptions {
  saveImage?: (base64: string, mimeType: string) => Promise<string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeMimeType(value: unknown): string | undefined {
  const mimeType = readString(value);
  return mimeType ? mimeType.toLowerCase() : undefined;
}

function extFromMimeType(mimeType?: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/svg+xml":
      return "svg";
    case "image/heic":
      return "heic";
    default:
      return "png";
  }
}

function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:([A-Za-z0-9/+.-]+\/[A-Za-z0-9.+-]+)?;base64,(.+)$/i);
  return match?.[2]?.trim() || trimmed;
}

async function defaultSaveImage(base64: string, mimeType: string): Promise<string> {
  const fileName = `mcp_tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extFromMimeType(mimeType)}`;
  return invoke<string>("ai_save_chat_image", {
    imageData: stripDataUrlPrefix(base64),
    fileName,
  });
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function getContentBlocks(result: unknown): unknown[] | null {
  if (Array.isArray(result)) return result;
  if (isRecord(result) && Array.isArray(result.content)) {
    return result.content;
  }
  return null;
}

function isDirectMediaRef(candidate: string): boolean {
  return (
    candidate.startsWith("/")
    || candidate.startsWith("file://")
    || /^[A-Za-z]:[\\/]/.test(candidate)
    || /^https?:\/\//i.test(candidate)
  );
}

function isPotentialMediaRef(candidate: string, mimeType?: string): boolean {
  if (!candidate) return false;
  if (isDirectMediaRef(candidate)) return true;
  if (mimeType?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|pdf|mp4|mov|mp3|wav|txt|csv|json)$/i.test(candidate);
}

function formatMediaDirective(ref: string): string {
  return /\s/.test(ref) ? `MEDIA:\`${ref}\`` : `MEDIA:${ref}`;
}

function cleanExtractedMediaRef(value: string): string {
  return value
    .trim()
    .replace(/^[`"'(<[]+/, "")
    .replace(/[`"')>\].,;!?]+$/, "");
}

function extractMediaRefsFromText(text: string): string[] {
  const refs = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const savedMatch = line.match(
      /\b(?:saved|wrote|written|captured|exported|generated|output)\b.*?\b(?:to|at)\b\s+((?:file:\/\/|\/|[A-Za-z]:[\\/])[^\s`"'<>]+?\.(?:png|jpe?g|gif|webp|bmp|svg|pdf))/i,
    );
    if (savedMatch?.[1]) {
      refs.add(cleanExtractedMediaRef(savedMatch[1]));
      continue;
    }

    const standaloneMatch = line.match(
      /^((?:file:\/\/|\/|[A-Za-z]:[\\/])[^\s`"'<>]+?\.(?:png|jpe?g|gif|webp|bmp|svg|pdf))$/i,
    );
    if (standaloneMatch?.[1]) {
      refs.add(cleanExtractedMediaRef(standaloneMatch[1]));
    }
  }

  return [...refs];
}

function getResourcePayload(block: JsonRecord): JsonRecord | undefined {
  return isRecord(block.resource) ? block.resource : undefined;
}

function getResourceRef(block: JsonRecord): string | undefined {
  const resource = getResourcePayload(block);
  return readString(
    block.uri,
    block.url,
    block.path,
    resource?.uri,
    resource?.url,
    resource?.path,
  );
}

function getResourceText(block: JsonRecord): string | undefined {
  const resource = getResourcePayload(block);
  return readString(block.text, resource?.text);
}

function getResourceBlob(block: JsonRecord): string | undefined {
  const resource = getResourcePayload(block);
  return readString(block.blob, resource?.blob, block.data, resource?.data);
}

function getResourceMimeType(block: JsonRecord): string | undefined {
  const resource = getResourcePayload(block);
  return normalizeMimeType(block.mimeType ?? block.mime_type ?? resource?.mimeType ?? resource?.mime_type);
}

async function appendImageDirective(
  parts: string[],
  seenMedia: Set<string>,
  base64: string,
  mimeType: string,
  options: McpToolResultMaterializeOptions,
): Promise<boolean> {
  const saveImage = options.saveImage ?? defaultSaveImage;
  const savedPath = await saveImage(stripDataUrlPrefix(base64), mimeType);
  if (!savedPath) return false;
  if (seenMedia.has(savedPath)) return true;
  seenMedia.add(savedPath);
  parts.push(formatMediaDirective(savedPath));
  return true;
}

function appendMediaRef(
  parts: string[],
  seenMedia: Set<string>,
  ref?: string,
): boolean {
  const normalized = ref?.trim();
  if (!normalized || seenMedia.has(normalized)) return false;
  seenMedia.add(normalized);
  parts.push(formatMediaDirective(normalized));
  return true;
}

async function materializeContentBlock(
  block: unknown,
  parts: string[],
  seenMedia: Set<string>,
  options: McpToolResultMaterializeOptions,
): Promise<void> {
  if (typeof block === "string") {
    if (block.trim()) parts.push(block);
    return;
  }

  if (!isRecord(block)) {
    const fallback = safeStringify(block).trim();
    if (fallback) parts.push(fallback);
    return;
  }

  const type = readString(block.type)?.toLowerCase();
  const text = readString(block.text);
  if (text && type !== "image" && type !== "resource_link") {
    parts.push(text);
    for (const mediaRef of extractMediaRefsFromText(text)) {
      appendMediaRef(parts, seenMedia, mediaRef);
    }
  }

  const imageMimeType = normalizeMimeType(block.mimeType ?? block.mime_type);
  const imageData = readString(block.data);
  const imageUrl = readString(block.url, block.uri, block.path);
  if (type === "image") {
    if (imageData && await appendImageDirective(parts, seenMedia, imageData, imageMimeType ?? "image/png", options)) {
      return;
    }
    if (imageUrl && isPotentialMediaRef(imageUrl, imageMimeType)) {
      appendMediaRef(parts, seenMedia, imageUrl);
      return;
    }
  }

  const resourceText = getResourceText(block);
  if (resourceText && resourceText !== text) {
    parts.push(resourceText);
    for (const mediaRef of extractMediaRefsFromText(resourceText)) {
      appendMediaRef(parts, seenMedia, mediaRef);
    }
  }

  const resourceMimeType = getResourceMimeType(block);
  const resourceBlob = getResourceBlob(block);
  if (resourceBlob && resourceMimeType?.startsWith("image/")) {
    if (await appendImageDirective(parts, seenMedia, resourceBlob, resourceMimeType, options)) {
      return;
    }
  }

  const resourceRef = getResourceRef(block) ?? imageUrl;
  if (resourceRef && isPotentialMediaRef(resourceRef, resourceMimeType ?? imageMimeType)) {
    appendMediaRef(parts, seenMedia, resourceRef);
    return;
  }

  if (!text && !resourceText) {
    const fallback = safeStringify(block).trim();
    if (fallback) parts.push(fallback);
  }
}

export async function materializeMcpToolResult(
  result: unknown,
  options: McpToolResultMaterializeOptions = {},
): Promise<string> {
  const blocks = getContentBlocks(result);
  if (!blocks) {
    return safeStringify(result);
  }

  const parts: string[] = [];
  const seenMedia = new Set<string>();

  for (const block of blocks) {
    await materializeContentBlock(block, parts, seenMedia, options);
  }

  const output = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return output || safeStringify(result);
}
