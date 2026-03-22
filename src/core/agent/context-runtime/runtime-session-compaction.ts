import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { DialogRoomCompactionState } from "@/core/agent/actor/types";

export interface RuntimeSessionCompactionPreview {
  roomCompactionSummaryPreview?: string;
  roomCompactionUpdatedAt?: number;
  roomCompactionMessageCount?: number;
  roomCompactionTaskCount?: number;
  roomCompactionArtifactCount?: number;
  roomCompactionPreservedIdentifiers?: string[];
}

function normalizeCompactionCount(value?: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeCompactionIdentifiers(values?: readonly string[] | null): string[] | undefined {
  const normalized = (values ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 6);
  return normalized.length > 0 ? normalized : undefined;
}

export function buildRuntimeSessionCompactionPreview(
  state?: DialogRoomCompactionState | null,
): RuntimeSessionCompactionPreview {
  if (!state) {
    return {
      roomCompactionSummaryPreview: undefined,
      roomCompactionUpdatedAt: undefined,
      roomCompactionMessageCount: undefined,
      roomCompactionTaskCount: undefined,
      roomCompactionArtifactCount: undefined,
      roomCompactionPreservedIdentifiers: undefined,
    };
  }

  return {
    roomCompactionSummaryPreview: summarizeAISessionRuntimeText(state.summary, 180) || undefined,
    roomCompactionUpdatedAt: typeof state.updatedAt === "number" ? state.updatedAt : undefined,
    roomCompactionMessageCount: normalizeCompactionCount(state.compactedMessageCount),
    roomCompactionTaskCount: normalizeCompactionCount(state.compactedSpawnedTaskCount),
    roomCompactionArtifactCount: normalizeCompactionCount(state.compactedArtifactCount),
    roomCompactionPreservedIdentifiers: normalizeCompactionIdentifiers(state.preservedIdentifiers),
  };
}

export function hasRuntimeSessionCompactionPreview(
  preview?: RuntimeSessionCompactionPreview | null,
): boolean {
  return Boolean(
    preview?.roomCompactionSummaryPreview
    || (preview?.roomCompactionMessageCount ?? 0) > 0
    || (preview?.roomCompactionTaskCount ?? 0) > 0
    || (preview?.roomCompactionArtifactCount ?? 0) > 0,
  );
}

export function buildRuntimeSessionCompactionHint(
  preview?: RuntimeSessionCompactionPreview | null,
): string | null {
  if (!hasRuntimeSessionCompactionPreview(preview)) {
    return null;
  }
  if ((preview?.roomCompactionMessageCount ?? 0) > 0) {
    return `已整理 ${preview?.roomCompactionMessageCount ?? 0} 条上下文`;
  }
  if ((preview?.roomCompactionTaskCount ?? 0) > 0) {
    return `已整理 ${preview?.roomCompactionTaskCount ?? 0} 条线程`;
  }
  if ((preview?.roomCompactionArtifactCount ?? 0) > 0) {
    return `已整理 ${preview?.roomCompactionArtifactCount ?? 0} 条产物`;
  }
  return "已整理上下文";
}
