import {
  decodeJsonLikeString,
  extractLooseStringValue,
  extractTrailingLooseStringValue,
  parseToolCallArguments,
} from "./tool-call-arguments";

export interface PartialToolJSONPreview {
  path: string;
  content: string;
  query: string;
  url: string;
  command: string;
  targetAgent: string;
  task: string;
  label: string;
  thought: string;
  thoughtNumber?: number;
  totalThoughts?: number;
}

function inferPathExtension(path: string): string {
  const normalized = path.trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 ? normalized.slice(dotIndex + 1) : "";
}

const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function pickString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractLooseJsonStringField(
  source: string,
  fieldNames: string[],
  trailing = false,
): string {
  for (const fieldName of fieldNames) {
    const value = trailing
      ? extractTrailingLooseStringValue(source, fieldName, {
          allowMissingColon: true,
          allowPartial: true,
        })
      : extractLooseStringValue(source, fieldName, {
          allowMissingColon: true,
        });
    if (value !== null) return value;
  }

  return "";
}

function extractLooseJsonNumberField(
  source: string,
  fieldNames: string[],
): number | undefined {
  for (const fieldName of fieldNames) {
    const escapedKey = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(`["']?${escapedKey}["']?\\s*:?[ \\t\\r\\n]*(-?\\d+)`));
    if (!match?.[1]) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function decodeJsonLikeStringDeep(value: string, maxPasses = 4): string {
  let current = String(value || "");
  for (let index = 0; index < maxPasses; index += 1) {
    const decoded = decodeJsonLikeString(current);
    if (decoded === current) break;
    current = decoded;
  }
  return current;
}

function normalizePreviewText(value: string): string {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function normalizeArtifactLineContinuations(value: string): string {
  return String(value || "")
    .replace(/\\[ \t]*(?:\r\n|\r|\n)[ \t]*/g, "\n")
    .replace(/>\s*\\\s*</g, ">\n<")
    .replace(/\{\s*\\\s*/g, "{\n")
    .replace(/;\s*\\\s*/g, ";\n")
    .replace(/\}\s*\\\s*/g, "}\n")
    .trim();
}

function hasDenseHtmlStructure(source: string): boolean {
  return source.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;

    if (/<style\b[^>]*>[\s\S]*<\/style>/i.test(trimmed) || /<script\b[^>]*>[\s\S]*<\/script>/i.test(trimmed)) {
      return true;
    }

    const tags = trimmed.match(/<\/?[a-zA-Z][^>]*>/g) ?? [];
    if (tags.length >= 3) return true;

    return /<\/?[a-zA-Z][^>]*>\s*<\/?[a-zA-Z][^>]*>/.test(trimmed);
  });
}

function pushPreviewLine(lines: string[], value: string, indent: number): void {
  const normalized = value.trim();
  if (!normalized) return;
  lines.push(`${"  ".repeat(Math.max(0, indent))}${normalized}`);
}

function formatCssPreview(source: string): string {
  const lines: string[] = [];
  let buffer = "";
  let indent = 0;
  let inString = false;
  let stringQuote = "";
  let inComment = false;

  const flushBuffer = () => {
    const normalized = buffer.replace(/\s+/g, " ").trim();
    if (normalized) {
      pushPreviewLine(lines, normalized, indent);
    }
    buffer = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (inComment) {
      buffer += char;
      if (char === "*" && next === "/") {
        buffer += "/";
        index += 1;
        inComment = false;
        flushBuffer();
      }
      continue;
    }

    if (inString) {
      buffer += char;
      if (char === "\\" && next) {
        buffer += next;
        index += 1;
        continue;
      }
      if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (char === "/" && next === "*") {
      flushBuffer();
      buffer = "/*";
      inComment = true;
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'") {
      buffer += char;
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === "{") {
      const selector = buffer.replace(/\s+/g, " ").trim();
      pushPreviewLine(lines, selector ? `${selector} {` : "{", indent);
      buffer = "";
      indent += 1;
      continue;
    }

    if (char === "}") {
      flushBuffer();
      indent = Math.max(0, indent - 1);
      pushPreviewLine(lines, "}", indent);
      continue;
    }

    if (char === ";") {
      buffer += ";";
      flushBuffer();
      continue;
    }

    if (char === "\n" || char === "\r") {
      if (buffer && !/\s$/.test(buffer)) {
        buffer += " ";
      }
      continue;
    }

    buffer += char;
  }

  flushBuffer();

  return lines.join("\n").trim();
}

function formatScriptPreview(source: string): string {
  const withBreaks = source
    .replace(/;\s*/g, ";\n")
    .replace(/\{\s*/g, "{\n")
    .replace(/\}\s*/g, "}\n")
    .replace(/\n{3,}/g, "\n\n");
  return normalizePreviewText(withBreaks);
}

function formatHtmlPreview(source: string): string {
  const tokens = source.match(/<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/g) ?? [source];
  const lines: string[] = [];
  const openStack: string[] = [];
  let indent = 0;

  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;

    if (/^<!DOCTYPE/i.test(token) || /^<!--/.test(token)) {
      pushPreviewLine(lines, token, indent);
      continue;
    }

    const closingMatch = token.match(/^<\/([a-zA-Z0-9:-]+)/);
    if (closingMatch) {
      indent = Math.max(0, indent - 1);
      pushPreviewLine(lines, token, indent);
      if (openStack[openStack.length - 1] === closingMatch[1].toLowerCase()) {
        openStack.pop();
      }
      continue;
    }

    const openingMatch = token.match(/^<([a-zA-Z0-9:-]+)/);
    if (openingMatch) {
      const tagName = openingMatch[1].toLowerCase();
      const selfClosing = token.endsWith("/>") || HTML_VOID_TAGS.has(tagName);
      pushPreviewLine(lines, token, indent);
      if (!selfClosing) {
        openStack.push(tagName);
        indent += 1;
      }
      continue;
    }

    const parentTag = openStack[openStack.length - 1];
    if (parentTag === "style") {
      const formattedCss = formatCssPreview(token);
      for (const line of formattedCss.split("\n")) {
        pushPreviewLine(lines, line, indent);
      }
      continue;
    }

    if (parentTag === "script") {
      const formattedScript = formatScriptPreview(token);
      for (const line of formattedScript.split("\n")) {
        pushPreviewLine(lines, line, indent);
      }
      continue;
    }

    pushPreviewLine(lines, token.replace(/\s+/g, " "), indent);
  }

  return lines.join("\n").trim();
}

export function formatArtifactPreviewBody(path: string, body: string): string {
  const rawNormalized = normalizePreviewText(body);
  const normalized = normalizeArtifactLineContinuations(rawNormalized);
  if (!normalized) return "";

  const ext = inferPathExtension(path);
  const looksLikeHtml = /<!doctype html>|<html\b|<head\b|<body\b|<style\b|<div\b/i.test(normalized);
  const looksLikeCss = /^[^{}]+\{.+\}$/.test(normalized);
  const hasLineContinuationMarkers = /\\[ \t]*(?:\r\n|\r|\n)/.test(rawNormalized);
  const hasCompressedHtmlLines = looksLikeHtml && hasDenseHtmlStructure(normalized);
  const maxLineLength = normalized
    .split("\n")
    .reduce((max, line) => Math.max(max, line.length), 0);

  if (
    normalized.includes("\n")
    && !hasLineContinuationMarkers
    && maxLineLength < 180
    && !hasCompressedHtmlLines
  ) {
    return normalized;
  }

  if (ext === "json" || normalized.startsWith("{") || normalized.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(normalized), null, 2);
    } catch {
      // keep raw preview below
    }
  }

  if (ext === "html" || ext === "htm" || looksLikeHtml) {
    return formatHtmlPreview(normalized);
  }

  if (ext === "css" || ext === "scss" || ext === "less" || looksLikeCss) {
    return formatCssPreview(normalized);
  }

  if (ext === "js" || ext === "jsx" || ext === "ts" || ext === "tsx") {
    return formatScriptPreview(normalized);
  }

  return normalized;
}

export function parsePartialToolJSON(jsonStr: string): PartialToolJSONPreview {
  const parsed = parseToolCallArguments(jsonStr).params;

  return {
    path: pickString(parsed.path) || pickString(parsed.filePath) || extractLooseJsonStringField(jsonStr, ["path", "filePath"]),
    content:
      pickString(parsed.content)
      || pickString(parsed.newText)
      || pickString(parsed.patch)
      || pickString(parsed.oldText)
      || pickString(parsed.new_str)
      || extractLooseJsonStringField(jsonStr, ["content", "newText", "patch", "oldText", "new_str"], true),
    query: pickString(parsed.query) || extractLooseJsonStringField(jsonStr, ["query"]),
    url: pickString(parsed.url) || extractLooseJsonStringField(jsonStr, ["url"]),
    command: pickString(parsed.command) || pickString(parsed.cmd) || extractLooseJsonStringField(jsonStr, ["command", "cmd"]),
    targetAgent:
      pickString(parsed.target_agent)
      || pickString(parsed.targetAgent)
      || extractLooseJsonStringField(jsonStr, ["target_agent", "targetAgent"]),
    task: pickString(parsed.task) || extractLooseJsonStringField(jsonStr, ["task"], true),
    label: pickString(parsed.label) || extractLooseJsonStringField(jsonStr, ["label"]),
    thought: pickString(parsed.thought) || extractLooseJsonStringField(jsonStr, ["thought"], true),
    thoughtNumber:
      pickNumber(parsed.thought_number)
      ?? pickNumber(parsed.thoughtNumber)
      ?? extractLooseJsonNumberField(jsonStr, ["thought_number", "thoughtNumber"]),
    totalThoughts:
      pickNumber(parsed.total_thoughts)
      ?? pickNumber(parsed.totalThoughts)
      ?? extractLooseJsonNumberField(jsonStr, ["total_thoughts", "totalThoughts"]),
  };
}

export function decodePartialToolContent(content: string): string {
  return decodeJsonLikeStringDeep(String(content || ""))
    .replace(/\\\r\n/g, "\n")
    .replace(/\\\n/g, "\n")
    .replace(/\\\r/g, "\n")
    .replace(/\\\t/g, "\t")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

export function hasArtifactPayloadKey(content: string): boolean {
  return /["']?(content|newText|oldText|patch)["']?\s*:?[ \t\r\n]*"/.test(content);
}

export function recoverArtifactBodyFromRaw(content: string, path: string): string {
  const decoded = decodePartialToolContent(content);
  if (!decoded) return "";

  const ext = inferPathExtension(path);
  if (ext === "html" || ext === "htm") {
    const startMarkers = ["<!DOCTYPE", "<!doctype", "<html", "<body", "<div", "<main", "<section"];
    const positions = startMarkers
      .map((marker) => decoded.indexOf(marker))
      .filter((position) => position >= 0);
    if (positions.length > 0) {
      const start = Math.min(...positions);
      const tail = decoded.slice(start);
      const endMarkers = ["</html>", "</body>", "</main>", "</section>", "</div>"];
      const end = endMarkers
        .map((marker) => {
          const index = tail.lastIndexOf(marker);
          return index >= 0 ? index + marker.length : -1;
        })
        .filter((position) => position >= 0)
        .sort((left, right) => right - left)[0];
      return (end ? tail.slice(0, end) : tail).trim();
    }
  }

  return decoded;
}
