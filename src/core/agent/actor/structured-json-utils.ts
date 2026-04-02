function extractBalancedJsonSubstring(value: string): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;

  const startIndexes: number[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "{" || char === "[") {
      startIndexes.push(index);
      if (startIndexes.length >= 8) break;
    }
  }

  const matchesClosingPair = (open: string, close: string) => (
    (open === "{" && close === "}")
    || (open === "[" && close === "]")
  );

  for (const startIndex of startIndexes) {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < normalized.length; index += 1) {
      const char = normalized[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const open = stack.pop();
        if (!open || !matchesClosingPair(open, char)) {
          break;
        }
        if (stack.length === 0) {
          return normalized.slice(startIndex, index + 1);
        }
      }
    }
  }

  return undefined;
}

export function extractStructuredJsonCandidate(value: string | undefined): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;

  const blockMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (blockMatch?.[1]?.trim()) {
    const fenced = blockMatch[1].trim();
    if (
      (fenced.startsWith("{") && fenced.endsWith("}"))
      || (fenced.startsWith("[") && fenced.endsWith("]"))
    ) {
      return fenced;
    }
    return extractBalancedJsonSubstring(fenced);
  }

  if (
    (normalized.startsWith("{") && normalized.endsWith("}"))
    || (normalized.startsWith("[") && normalized.endsWith("]"))
  ) {
    return normalized;
  }

  return extractBalancedJsonSubstring(normalized);
}

export function tryParseStructuredPayload(value: string | undefined): unknown {
  const candidate = extractStructuredJsonCandidate(value);
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
