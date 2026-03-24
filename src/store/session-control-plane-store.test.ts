import { beforeEach, describe, expect, it } from "vitest";
import { useSessionControlPlaneStore } from "./session-control-plane-store";

describe("session-control-plane-store", () => {
  beforeEach(() => {
    useSessionControlPlaneStore.getState().clear();
  });

  it("patches runtime and continuity state onto an existing session", () => {
    const session = useSessionControlPlaneStore.getState().upsertSession({
      identity: {
        productMode: "dialog",
        surface: "local_dialog",
        sessionKey: "dialog-1",
        sessionKind: "collaboration_room",
        runtimeSessionId: "dialog-1",
      },
      title: "Dialog 房间",
      summary: "继续首页实现",
      status: "running",
      createdAt: 100,
      updatedAt: 100,
      lastActiveAt: 100,
    });

    expect(session).not.toBeNull();

    useSessionControlPlaneStore.getState().patchSessionRuntimeState(session?.id ?? "", {
      mode: "dialog",
      active: true,
      status: "awaiting_reply",
      waitingStage: "user_reply",
      query: "继续首页实现",
      displayLabel: "Dialog 房间",
      displayDetail: "本机协作",
      workspaceRoot: "/repo",
      startedAt: 100,
      updatedAt: 120,
    });

    useSessionControlPlaneStore.getState().patchSessionContinuityState(session?.id ?? "", {
      source: "local_dialog",
      updatedAt: 130,
      executionStrategy: "coordinator",
      contractState: "active",
      pendingInteractionCount: 2,
      queuedFollowUpCount: 1,
      childSessionCount: 3,
      openChildSessionCount: 2,
      roomCompactionSummaryPreview: "已整理较早上下文",
      roomCompactionMessageCount: 24,
      roomCompactionTaskCount: 2,
      roomCompactionArtifactCount: 1,
      roomCompactionPreservedIdentifiers: ["src/App.tsx", "README.md"],
    });

    const stored = useSessionControlPlaneStore.getState().getSession(session?.id ?? "");
    const foundByRuntimeSessionId = useSessionControlPlaneStore
      .getState()
      .findSessionByRuntimeSessionId("dialog-1");
    expect(stored).toMatchObject({
      status: "awaiting_reply",
      runtimeState: {
        active: true,
        mode: "dialog",
        waitingStage: "user_reply",
        workspaceRoot: "/repo",
      },
      continuityState: {
        source: "local_dialog",
        executionStrategy: "coordinator",
        contractState: "active",
        pendingInteractionCount: 2,
        queuedFollowUpCount: 1,
        childSessionCount: 3,
        openChildSessionCount: 2,
        roomCompactionMessageCount: 24,
        roomCompactionTaskCount: 2,
        roomCompactionArtifactCount: 1,
        roomCompactionPreservedIdentifiers: ["src/App.tsx", "README.md"],
      },
    });
    expect(foundByRuntimeSessionId?.id).toBe(session?.id);
  });
});
