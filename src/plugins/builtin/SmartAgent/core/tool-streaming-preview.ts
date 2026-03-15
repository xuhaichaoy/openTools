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
}

function inferPathExtension(path: string): string {
  const normalized = path.trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 ? normalized.slice(dotIndex + 1) : "";
}

function pickString(value: unknown): string {
  return typeof value === "string" ? value : "";
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
  };
}

export function decodePartialToolContent(content: string): string {
  return decodeJsonLikeString(String(content || ""))
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
    const markers = ["<!DOCTYPE", "<!doctype", "<html", "<body", "<div", "<main", "<section"];
    const positions = markers
      .map((marker) => decoded.indexOf(marker))
      .filter((position) => position >= 0);
    if (positions.length > 0) {
      return decoded.slice(Math.min(...positions)).trim();
    }
  }

  return decoded;
}
