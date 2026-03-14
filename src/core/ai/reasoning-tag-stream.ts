type ReasoningStreamMode = "visible" | "thinking";

export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

export interface CodeRegion {
  start: number;
  end: number;
}

export interface ReasoningTagChunk {
  visible: string;
  thinking: string;
}

const QUICK_REASONING_TAG_RE =
  /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|reasoning|final)\b/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking|reasoning)\b[^<>]*>/gi;
const STREAM_REASONING_TAG_RE =
  /<\s*(\/?)\s*(think(?:ing)?|thought|antthinking|reasoning|final)\b[^<>]*>/gi;
const PARTIAL_REASONING_TAG_PREFIXES = [
  "<think",
  "<thinking",
  "<thought",
  "<antthinking",
  "<reasoning",
  "<final",
  "</think",
  "</thinking",
  "</thought",
  "</antthinking",
  "</reasoning",
  "</final",
];

function createEmptyChunk(): ReasoningTagChunk {
  return { visible: "", thinking: "" };
}

function appendText(
  target: ReasoningTagChunk,
  mode: ReasoningStreamMode,
  text: string,
): void {
  if (!text) return;
  if (mode === "thinking") {
    target.thinking += text;
  } else {
    target.visible += text;
  }
}

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") return value;
  if (mode === "start") return value.trimStart();
  return value.trim();
}

function isPartialReasoningTagPrefix(value: string): boolean {
  const trimmed = value.trimStart().toLowerCase();
  if (!trimmed.startsWith("<")) return false;
  if (trimmed.includes(">")) return false;
  return PARTIAL_REASONING_TAG_PREFIXES.some((prefix) =>
    prefix.startsWith(trimmed),
  );
}

function getTrailingPartialTagLength(
  text: string,
  codeRegions: CodeRegion[],
): number {
  const lastOpen = text.lastIndexOf("<");
  if (lastOpen < 0 || isInsideCode(lastOpen, codeRegions)) {
    return 0;
  }
  const suffix = text.slice(lastOpen);
  return isPartialReasoningTagPrefix(suffix) ? suffix.length : 0;
}

function splitReasoningTextForStream(text: string): ReasoningTagChunk {
  if (!text) return createEmptyChunk();

  const codeRegions = findCodeRegions(text);
  const trailingPartialTagLength = getTrailingPartialTagLength(text, codeRegions);

  if (!QUICK_REASONING_TAG_RE.test(text)) {
    return {
      visible: trailingPartialTagLength
        ? text.slice(0, -trailingPartialTagLength)
        : text,
      thinking: "",
    };
  }

  const result = createEmptyChunk();
  let mode: ReasoningStreamMode = "visible";
  let lastIndex = 0;
  STREAM_REASONING_TAG_RE.lastIndex = 0;

  for (const match of text.matchAll(STREAM_REASONING_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    appendText(result, mode, text.slice(lastIndex, idx));

    const isClosing = match[1] === "/";
    const tagName = match[2].toLowerCase();
    if (mode === "visible") {
      mode = !isClosing && tagName !== "final" ? "thinking" : "visible";
    } else {
      mode = isClosing || tagName === "final" ? "visible" : "thinking";
    }
    lastIndex = idx + match[0].length;
  }

  appendText(result, mode, text.slice(lastIndex));

  if (trailingPartialTagLength > 0) {
    if (mode === "thinking") {
      result.thinking = result.thinking.slice(0, -trailingPartialTagLength);
    } else {
      result.visible = result.visible.slice(0, -trailingPartialTagLength);
    }
  }

  return result;
}

export function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?:\n|$)|$)/g;
  for (const match of text.matchAll(fencedRe)) {
    const start = (match.index ?? 0) + match[1].length;
    regions.push({ start, end: start + match[0].length - match[1].length });
  }

  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideFenced = regions.some((region) => start >= region.start && end <= region.end);
    if (!insideFenced) {
      regions.push({ start, end });
    }
  }

  regions.sort((left, right) => left.start - right.start);
  return regions;
}

export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((region) => pos >= region.start && pos < region.end);
}

export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
  },
): string {
  if (!text) return text;
  if (!QUICK_REASONING_TAG_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";
  let cleaned = text;

  if (FINAL_TAG_RE.test(cleaned)) {
    FINAL_TAG_RE.lastIndex = 0;
    const finalMatches: Array<{
      start: number;
      length: number;
      inCode: boolean;
    }> = [];
    const preCodeRegions = findCodeRegions(cleaned);
    for (const match of cleaned.matchAll(FINAL_TAG_RE)) {
      const start = match.index ?? 0;
      finalMatches.push({
        start,
        length: match[0].length,
        inCode: isInsideCode(start, preCodeRegions),
      });
    }

    for (let index = finalMatches.length - 1; index >= 0; index -= 1) {
      const finalMatch = finalMatches[index];
      if (!finalMatch.inCode) {
        cleaned =
          cleaned.slice(0, finalMatch.start) +
          cleaned.slice(finalMatch.start + finalMatch.length);
      }
    }
  } else {
    FINAL_TAG_RE.lastIndex = 0;
  }

  const codeRegions = findCodeRegions(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClosing = match[1] === "/";

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (!inThinking) {
      result += cleaned.slice(lastIndex, idx);
      if (!isClosing) {
        inThinking = true;
      }
    } else if (isClosing) {
      inThinking = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inThinking || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  return applyTrim(result, trimMode);
}

function sanitizeVisibleChunk(text: string): string {
  if (!text) return "";
  const stripped = stripReasoningTagsFromText(text, {
    mode: "strict",
    trim: "none",
  });
  if (!stripped) return stripped;
  const codeRegions = findCodeRegions(stripped);
  const trailingPartialTagLength = getTrailingPartialTagLength(
    stripped,
    codeRegions,
  );
  return trailingPartialTagLength > 0
    ? stripped.slice(0, -trailingPartialTagLength)
    : stripped;
}

export class ReasoningTagStreamFilter {
  private rawText = "";
  private emittedVisibleLength = 0;
  private emittedThinkingLength = 0;

  process(chunk: string): ReasoningTagChunk {
    if (!chunk) return createEmptyChunk();

    this.rawText += chunk;
    const parsed = splitReasoningTextForStream(this.rawText);
    const nextVisible = parsed.visible.slice(this.emittedVisibleLength);
    const nextThinking = parsed.thinking.slice(this.emittedThinkingLength);

    this.emittedVisibleLength = parsed.visible.length;
    this.emittedThinkingLength = parsed.thinking.length;

    return {
      visible: nextVisible,
      thinking: nextThinking,
    };
  }

  flush(): ReasoningTagChunk {
    const parsed = splitReasoningTextForStream(this.rawText);
    const result = {
      visible: parsed.visible.slice(this.emittedVisibleLength),
      thinking: parsed.thinking.slice(this.emittedThinkingLength),
    };
    this.reset();
    return result;
  }

  reset(): void {
    this.rawText = "";
    this.emittedVisibleLength = 0;
    this.emittedThinkingLength = 0;
  }
}

export class AssistantReasoningStreamNormalizer {
  private sawExplicitThinking = false;
  private readonly inlineTagFilter = new ReasoningTagStreamFilter();

  processTextChunk(chunk: string): ReasoningTagChunk {
    if (!chunk) return createEmptyChunk();
    if (this.sawExplicitThinking) {
      return {
        visible: sanitizeVisibleChunk(chunk),
        thinking: "",
      };
    }
    return this.inlineTagFilter.process(chunk);
  }

  processThinkingChunk(chunk: string): ReasoningTagChunk {
    if (!chunk) return createEmptyChunk();
    this.sawExplicitThinking = true;
    this.inlineTagFilter.reset();
    return {
      visible: "",
      thinking: chunk,
    };
  }

  flush(): ReasoningTagChunk {
    const result = this.sawExplicitThinking
      ? createEmptyChunk()
      : this.inlineTagFilter.flush();
    this.reset();
    return result;
  }

  reset(): void {
    this.sawExplicitThinking = false;
    this.inlineTagFilter.reset();
  }
}
