import type { DialogRoomCompactionState } from "@/core/agent/actor/types";
import type { SessionControlPlaneContinuityState } from "./types";

function cloneDialogRoomCompactionState(
  state: DialogRoomCompactionState,
): DialogRoomCompactionState {
  return {
    ...state,
    preservedIdentifiers: [...state.preservedIdentifiers],
    ...(state.triggerReasons ? { triggerReasons: [...state.triggerReasons] } : {}),
  };
}

export function buildDialogRoomCompactionFromContinuityState(
  continuity?: SessionControlPlaneContinuityState | null,
): DialogRoomCompactionState | null {
  const summary = continuity?.roomCompactionSummary?.trim();
  if (!summary) return null;
  return {
    summary,
    compactedMessageCount: continuity?.roomCompactionMessageCount ?? 0,
    compactedSpawnedTaskCount: continuity?.roomCompactionTaskCount ?? 0,
    compactedArtifactCount: continuity?.roomCompactionArtifactCount ?? 0,
    preservedIdentifiers: [...(continuity?.roomCompactionPreservedIdentifiers ?? [])],
    ...(continuity?.roomCompactionTriggerReasons?.length
      ? { triggerReasons: [...continuity.roomCompactionTriggerReasons] }
      : {}),
    ...(continuity?.roomCompactionMemoryFlushNoteId
      ? { memoryFlushNoteId: continuity.roomCompactionMemoryFlushNoteId }
      : {}),
    ...(typeof continuity?.roomCompactionMemoryConfirmedCount === "number"
      ? { memoryConfirmedCount: continuity.roomCompactionMemoryConfirmedCount }
      : {}),
    ...(typeof continuity?.roomCompactionMemoryQueuedCount === "number"
      ? { memoryQueuedCount: continuity.roomCompactionMemoryQueuedCount }
      : {}),
    updatedAt: continuity?.roomCompactionUpdatedAt ?? continuity?.updatedAt ?? Date.now(),
  };
}

export function resolveRecoveredDialogRoomCompaction(params: {
  persisted?: DialogRoomCompactionState | null;
  continuity?: SessionControlPlaneContinuityState | null;
}): DialogRoomCompactionState | null {
  const persisted = params.persisted ? cloneDialogRoomCompactionState(params.persisted) : null;
  const recovered = buildDialogRoomCompactionFromContinuityState(params.continuity);
  if (!persisted) return recovered;
  if (!recovered) return persisted;
  return (recovered.updatedAt ?? 0) >= (persisted.updatedAt ?? 0)
    ? recovered
    : persisted;
}
