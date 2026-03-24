import { describe, expect, it } from "vitest";
import {
  buildDialogRoomCompactionFromContinuityState,
  resolveRecoveredDialogRoomCompaction,
} from "./recovery";

describe("session-control-plane recovery", () => {
  it("rebuilds dialog room compaction state from continuity truth", () => {
    const state = buildDialogRoomCompactionFromContinuityState({
      source: "local_dialog",
      updatedAt: 300,
      roomCompactionSummary: "已确认首页继续沿用暖色调 Hero，并保留 Reviewer 的回归检查结论。",
      roomCompactionUpdatedAt: 280,
      roomCompactionMessageCount: 18,
      roomCompactionTaskCount: 2,
      roomCompactionArtifactCount: 1,
      roomCompactionPreservedIdentifiers: ["src/App.tsx", "design.png"],
      roomCompactionTriggerReasons: ["房间历史已明显拉长"],
      roomCompactionMemoryFlushNoteId: "note-1",
      roomCompactionMemoryConfirmedCount: 2,
      roomCompactionMemoryQueuedCount: 1,
    });

    expect(state).toEqual({
      summary: "已确认首页继续沿用暖色调 Hero，并保留 Reviewer 的回归检查结论。",
      compactedMessageCount: 18,
      compactedSpawnedTaskCount: 2,
      compactedArtifactCount: 1,
      preservedIdentifiers: ["src/App.tsx", "design.png"],
      triggerReasons: ["房间历史已明显拉长"],
      memoryFlushNoteId: "note-1",
      memoryConfirmedCount: 2,
      memoryQueuedCount: 1,
      updatedAt: 280,
    });
  });

  it("prefers newer control-plane compaction truth over older persisted data", () => {
    const resolved = resolveRecoveredDialogRoomCompaction({
      persisted: {
        summary: "旧摘要",
        compactedMessageCount: 12,
        compactedSpawnedTaskCount: 1,
        compactedArtifactCount: 0,
        preservedIdentifiers: ["old.ts"],
        updatedAt: 100,
      },
      continuity: {
        source: "im_conversation",
        updatedAt: 220,
        roomCompactionSummary: "新摘要",
        roomCompactionUpdatedAt: 200,
        roomCompactionMessageCount: 20,
        roomCompactionTaskCount: 3,
        roomCompactionArtifactCount: 1,
        roomCompactionPreservedIdentifiers: ["new.ts"],
      },
    });

    expect(resolved).toMatchObject({
      summary: "新摘要",
      compactedMessageCount: 20,
      compactedSpawnedTaskCount: 3,
      compactedArtifactCount: 1,
      preservedIdentifiers: ["new.ts"],
      updatedAt: 200,
    });
  });
});
