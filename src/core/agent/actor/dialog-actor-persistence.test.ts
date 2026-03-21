import { describe, expect, it } from "vitest";
import { resolvePersistedDialogActorMaxIterations } from "./dialog-actor-persistence";

describe("dialog-actor-persistence", () => {
  it("preserves an explicitly persisted maxIterations value", () => {
    expect(resolvePersistedDialogActorMaxIterations({
      roleName: "Lead",
      maxIterations: 72,
    }, 1)).toBe(72);
  });

  it("migrates a legacy single Coordinator dialog room to the higher lead budget", () => {
    expect(resolvePersistedDialogActorMaxIterations({
      roleName: "Coordinator",
    }, 1)).toBe(40);
  });

  it("does not force a higher budget onto multi-actor legacy rooms", () => {
    expect(resolvePersistedDialogActorMaxIterations({
      roleName: "Coordinator",
    }, 2)).toBeUndefined();
  });
});
