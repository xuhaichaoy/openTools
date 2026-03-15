export type StreamChunkMergeMode =
  | "empty"
  | "delta"
  | "snapshot"
  | "duplicate"
  | "overlap"
  | "reset";

export interface StreamChunkMergeResult {
  mode: StreamChunkMergeMode;
  full: string;
  delta: string;
}

function longestSuffixPrefixOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let size = max; size > 0; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

function looksLikeRestartPrefix(previous: string, incoming: string): boolean {
  if (!previous || !incoming) return false;
  if (!previous.startsWith(incoming)) return false;
  return previous.length >= 24 && incoming.length >= 12;
}

export function mergeStreamChunk(
  previous: string,
  incoming: string,
): StreamChunkMergeResult {
  if (!incoming) {
    return {
      mode: "empty",
      full: previous,
      delta: "",
    };
  }

  if (!previous) {
    return {
      mode: "delta",
      full: incoming,
      delta: incoming,
    };
  }

  if (incoming === previous) {
    return {
      mode: "duplicate",
      full: previous,
      delta: "",
    };
  }

  if (incoming.startsWith(previous)) {
    return {
      mode: "snapshot",
      full: incoming,
      delta: incoming.slice(previous.length),
    };
  }

  if (looksLikeRestartPrefix(previous, incoming)) {
    return {
      mode: "reset",
      full: incoming,
      delta: "",
    };
  }

  if (previous.endsWith(incoming)) {
    return {
      mode: "duplicate",
      full: previous,
      delta: "",
    };
  }

  const overlap = longestSuffixPrefixOverlap(previous, incoming);
  if (overlap > 0) {
    return {
      mode: "overlap",
      full: previous + incoming.slice(overlap),
      delta: incoming.slice(overlap),
    };
  }

  return {
    mode: "delta",
    full: previous + incoming,
    delta: incoming,
  };
}
