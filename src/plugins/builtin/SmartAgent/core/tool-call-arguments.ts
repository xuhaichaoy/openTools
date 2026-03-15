export interface ParsedToolCallArguments {
  params: Record<string, unknown>;
  parseError?: string;
}

interface LooseStringOptions {
  allowMissingColon?: boolean;
  allowPartial?: boolean;
}

function normalizeToolArgumentQuotes(raw: string): string {
  return raw
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'");
}

export function escapeRawControlCharsInJsonStrings(input: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      result += ch;
      inString = !inString;
      continue;
    }
    if (inString) {
      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }
    }
    result += ch;
  }

  return result;
}

export function decodeJsonLikeString(value: string): string {
  return value
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function buildLooseStringStartPattern(key: string, allowMissingColon = false): RegExp {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const colonPart = allowMissingColon ? ":?" : ":";
  return new RegExp(`["']?${escapedKey}["']?\\s*${colonPart}\\s*(["'])`);
}

export function extractLooseStringValue(
  input: string,
  key: string,
  options: LooseStringOptions = {},
): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const colonPart = options.allowMissingColon ? ":?" : ":";
  const regex = new RegExp(
    `["']?${escapedKey}["']?\\s*${colonPart}\\s*(["'])([\\s\\S]*?)\\1(?=\\s*(?:,|\\}|$))`,
  );
  const match = input.match(regex);
  if (!match) return null;
  return decodeJsonLikeString(match[2]);
}

export function extractTrailingLooseStringValue(
  input: string,
  key: string,
  options: LooseStringOptions = {},
): string | null {
  const regex = buildLooseStringStartPattern(key, options.allowMissingColon);
  const match = regex.exec(input);
  if (!match) return null;

  const quote = match[1];
  const start = match.index + match[0].length;
  let end = input.length - 1;

  while (end >= start && /\s/.test(input[end])) end--;
  if (end >= start && input[end] === "}") end--;
  while (end >= start && /\s/.test(input[end])) end--;
  if (end >= start && input[end] === ",") end--;
  while (end >= start && /\s/.test(input[end])) end--;

  if (end >= start && input[end] === quote) {
    return decodeJsonLikeString(input.slice(start, end));
  }

  if (!options.allowPartial) return null;
  return decodeJsonLikeString(input.slice(start));
}

export function recoverLooseToolArguments(input: string): Record<string, unknown> | null {
  const writePath = extractLooseStringValue(input, "path", { allowMissingColon: true });
  const writeContent = extractTrailingLooseStringValue(input, "content", {
    allowMissingColon: true,
  });
  if (writePath && writeContent !== null) {
    return { path: writePath, content: writeContent };
  }

  const command = extractLooseStringValue(input, "command", { allowMissingColon: true });
  const editPath = extractLooseStringValue(input, "path", { allowMissingColon: true });
  const newStr = extractTrailingLooseStringValue(input, "new_str", {
    allowMissingColon: true,
  });
  if (command === "create" && editPath && newStr !== null) {
    return { command, path: editPath, new_str: newStr };
  }

  return null;
}

export function parseToolCallArguments(rawArguments: string): ParsedToolCallArguments {
  const raw = (rawArguments || "").trim();
  if (!raw) return { params: {} };

  const tryParseObject = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };

  const direct = tryParseObject(raw);
  if (direct) return { params: direct };

  const normalizedQuotes = normalizeToolArgumentQuotes(raw);
  const normalized = tryParseObject(normalizedQuotes);
  if (normalized) return { params: normalized };

  const escapedControls = tryParseObject(escapeRawControlCharsInJsonStrings(normalizedQuotes));
  if (escapedControls) return { params: escapedControls };

  const recovered = recoverLooseToolArguments(normalizedQuotes);
  if (recovered) return { params: recovered };

  const snippet = raw.length > 400 ? `${raw.slice(0, 400)}...` : raw;
  return {
    params: {},
    parseError: `工具参数不是有效 JSON。请严格返回合法 JSON，并确保多行文本中的换行和双引号被正确转义。原始参数片段: ${snippet}`,
  };
}
