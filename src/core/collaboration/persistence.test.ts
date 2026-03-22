import { describe, expect, it } from "vitest";

import {
  cloneCollaborationSnapshot,
  cloneCollaborationSnapshotForPersistence,
  createEmptyCollaborationSnapshot,
} from "./persistence";

describe("collaboration persistence", () => {
  it("strips derived contract delegations from persisted snapshots", () => {
    const snapshot = createEmptyCollaborationSnapshot("local_dialog");
    snapshot.contractDelegations = [
      {
        delegationId: "delegation-1",
        targetActorId: "reviewer",
        label: "Reviewer",
        state: "running",
        runId: "run-1",
      },
    ];

    const runtimeClone = cloneCollaborationSnapshot(snapshot);
    const persistedClone = cloneCollaborationSnapshotForPersistence(snapshot);

    expect(runtimeClone.contractDelegations).toEqual([
      {
        delegationId: "delegation-1",
        targetActorId: "reviewer",
        label: "Reviewer",
        state: "running",
        runId: "run-1",
      },
    ]);
    expect(persistedClone.contractDelegations).toEqual([]);
    expect(snapshot.contractDelegations).toHaveLength(1);
  });
});
