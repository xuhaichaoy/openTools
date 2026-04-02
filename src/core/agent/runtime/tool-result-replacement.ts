import { estimateTokens } from "@/core/ai/token-utils";

export const PERSISTED_TOOL_RESULT_TAG = "<persisted-output>";
export const PERSISTED_TOOL_RESULT_CLOSING_TAG = "</persisted-output>";

const CONTEXT_COMPACT_THRESHOLD = 0.75;
const TOTAL_TOOL_RESULT_CONTEXT_SHARE = 0.35;
const DEFAULT_PREVIEW_CHARS = 2_000;

export interface ToolResultReplacementRecord {
  kind: "tool-result";
  toolUseId: string;
  replacement: string;
}

export interface ToolResultReplacementState {
  seenIds: Set<string>;
  replacements: Map<string, string>;
}

export interface ToolResultReplacementSnapshot {
  seenToolUseIds: string[];
  replacements: ToolResultReplacementRecord[];
}

export interface ToolResultReplacementCandidate {
  toolUseId: string;
  toolName?: string;
  content: string;
}

type PersistedToolResult = {
  filepath: string;
  originalSize: number;
  preview: string;
  hasMore: boolean;
};

function joinPath(...parts: string[]): string {
  const normalized = parts
    .map((part, index) => {
      const value = String(part ?? "");
      if (index === 0) return value.replace(/[\\/]+$/g, "");
      return value.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter(Boolean);
  return normalized.join("/");
}

function sanitizeFileName(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "tool-result";
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const fsMod = await import("@tauri-apps/plugin-fs");
    if (typeof fsMod.mkdir === "function") {
      await fsMod.mkdir(path, { recursive: true });
      return;
    }
  } catch {
    // fall through
  }

  try {
    const fsMod = await import("node:fs/promises");
    await fsMod.mkdir(path, { recursive: true });
  } catch {
    // best effort
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const fsMod = await import("@tauri-apps/plugin-fs");
    if (typeof fsMod.readTextFile === "function") {
      return await fsMod.readTextFile(path);
    }
  } catch {
    // fall through
  }

  try {
    const fsMod = await import("node:fs/promises");
    return await fsMod.readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  try {
    const fsMod = await import("@tauri-apps/plugin-fs");
    if (typeof fsMod.writeTextFile === "function") {
      await fsMod.writeTextFile(path, content);
      return;
    }
  } catch {
    // fall through
  }

  try {
    const fsMod = await import("node:fs/promises");
    await fsMod.writeFile(path, content, "utf-8");
  } catch {
    // best effort
  }
}

function createPreview(content: string, maxChars = DEFAULT_PREVIEW_CHARS): {
  preview: string;
  hasMore: boolean;
} {
  const normalized = String(content ?? "");
  if (normalized.length <= maxChars) {
    return {
      preview: normalized,
      hasMore: false,
    };
  }
  return {
    preview: normalized.slice(0, maxChars).trimEnd(),
    hasMore: true,
  };
}

async function persistToolResultToFile(params: {
  persistDir?: string;
  toolUseId: string;
  content: string;
}): Promise<PersistedToolResult | null> {
  const persistDir = String(params.persistDir ?? "").trim();
  if (!persistDir) return null;

  await ensureDirectory(persistDir);
  const filepath = joinPath(persistDir, `${sanitizeFileName(params.toolUseId)}.txt`);
  const existing = await readText(filepath);
  if (existing === undefined) {
    await writeText(filepath, params.content);
  }

  const { preview, hasMore } = createPreview(params.content);
  return {
    filepath,
    originalSize: params.content.length,
    preview,
    hasMore,
  };
}

function buildReplacementMessage(result: PersistedToolResult): string {
  return [
    PERSISTED_TOOL_RESULT_TAG,
    `工具输出过长（${result.originalSize} chars），完整结果已保存到：${result.filepath}`,
    "",
    "预览：",
    result.preview,
    ...(result.hasMore ? ["..."] : []),
    PERSISTED_TOOL_RESULT_CLOSING_TAG,
  ].join("\n");
}

function toolBudgetLimit(contextLimit: number): number {
  const threshold = Math.max(
    512,
    Math.floor(contextLimit * CONTEXT_COMPACT_THRESHOLD),
  );
  return Math.max(
    192,
    Math.floor(threshold * TOTAL_TOOL_RESULT_CONTEXT_SHARE),
  );
}

function selectCandidatesToReplace(
  candidates: Array<{ toolUseId: string; content: string; tokenSize: number }>,
  limit: number,
): Array<{ toolUseId: string; content: string; tokenSize: number }> {
  const sorted = [...candidates].sort((left, right) => right.tokenSize - left.tokenSize);
  const selected: Array<{ toolUseId: string; content: string; tokenSize: number }> = [];
  let remaining = candidates.reduce((sum, candidate) => sum + candidate.tokenSize, 0);
  for (const candidate of sorted) {
    if (remaining <= limit) break;
    selected.push(candidate);
    remaining -= candidate.tokenSize;
  }
  return selected;
}

export function createToolResultReplacementState(
  snapshot?: ToolResultReplacementSnapshot,
): ToolResultReplacementState {
  const state: ToolResultReplacementState = {
    seenIds: new Set<string>(),
    replacements: new Map<string, string>(),
  };
  for (const id of snapshot?.seenToolUseIds ?? []) {
    const normalized = String(id ?? "").trim();
    if (normalized) state.seenIds.add(normalized);
  }
  for (const record of snapshot?.replacements ?? []) {
    if (record.kind !== "tool-result") continue;
    const toolUseId = String(record.toolUseId ?? "").trim();
    if (!toolUseId) continue;
    state.replacements.set(toolUseId, String(record.replacement ?? ""));
    state.seenIds.add(toolUseId);
  }
  return state;
}

export function snapshotToolResultReplacementState(
  state?: ToolResultReplacementState | null,
): ToolResultReplacementSnapshot | undefined {
  if (!state) return undefined;
  const seenToolUseIds = [...state.seenIds].filter(Boolean);
  const replacements = [...state.replacements.entries()]
    .map(([toolUseId, replacement]) => ({
      kind: "tool-result" as const,
      toolUseId,
      replacement,
    }));
  if (seenToolUseIds.length === 0 && replacements.length === 0) {
    return undefined;
  }
  return {
    seenToolUseIds,
    replacements,
  };
}

export async function replaceLargeToolResults(params: {
  candidates: ToolResultReplacementCandidate[];
  state?: ToolResultReplacementState;
  contextLimit: number;
  persistDir?: string;
}): Promise<{
  replacements: Map<string, string>;
  newlyReplaced: ToolResultReplacementRecord[];
}> {
  const state = params.state;
  if (!state || params.candidates.length === 0) {
    return {
      replacements: new Map<string, string>(),
      newlyReplaced: [],
    };
  }

  const replacementMap = new Map<string, string>();
  const fresh = params.candidates
    .map((candidate) => ({
      toolUseId: String(candidate.toolUseId ?? "").trim(),
      content: String(candidate.content ?? ""),
      tokenSize: estimateTokens(candidate.content),
    }))
    .filter((candidate) => candidate.toolUseId && candidate.content);

  for (const candidate of fresh) {
    const replacement = state.replacements.get(candidate.toolUseId);
    if (replacement !== undefined) {
      replacementMap.set(candidate.toolUseId, replacement);
    }
  }

  const unresolved = fresh.filter((candidate) => !state.replacements.has(candidate.toolUseId));
  if (unresolved.length === 0) {
    fresh.forEach((candidate) => state.seenIds.add(candidate.toolUseId));
    return {
      replacements: replacementMap,
      newlyReplaced: [],
    };
  }

  const limit = toolBudgetLimit(params.contextLimit);
  const totalTokens = unresolved.reduce((sum, candidate) => sum + candidate.tokenSize, 0);
  if (totalTokens <= limit) {
    unresolved.forEach((candidate) => state.seenIds.add(candidate.toolUseId));
    return {
      replacements: replacementMap,
      newlyReplaced: [],
    };
  }

  const selected = selectCandidatesToReplace(unresolved, limit);
  const selectedIds = new Set(selected.map((candidate) => candidate.toolUseId));
  unresolved
    .filter((candidate) => !selectedIds.has(candidate.toolUseId))
    .forEach((candidate) => state.seenIds.add(candidate.toolUseId));

  const persistedResults = await Promise.all(selected.map(async (candidate) => {
    const persisted = await persistToolResultToFile({
      persistDir: params.persistDir,
      toolUseId: candidate.toolUseId,
      content: candidate.content,
    });
    return [candidate, persisted] as const;
  }));

  const newlyReplaced: ToolResultReplacementRecord[] = [];
  for (const [candidate, persisted] of persistedResults) {
    state.seenIds.add(candidate.toolUseId);
    if (!persisted) continue;
    const replacement = buildReplacementMessage(persisted);
    state.replacements.set(candidate.toolUseId, replacement);
    replacementMap.set(candidate.toolUseId, replacement);
    newlyReplaced.push({
      kind: "tool-result",
      toolUseId: candidate.toolUseId,
      replacement,
    });
  }

  return {
    replacements: replacementMap,
    newlyReplaced,
  };
}
