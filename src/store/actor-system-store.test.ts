import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadSessionFromDisk = vi.fn();
const mockSaveSessionToDisk = vi.fn(async () => undefined);
const mockGetLatestActiveSessionId = vi.fn(async () => null);

vi.mock("@/core/agent/actor/actor-transcript", () => ({
  appendDialogMessageSync: vi.fn(),
  appendSpawnEventSync: vi.fn(),
  appendAnnounceEventSync: vi.fn(),
  updateTranscriptActors: vi.fn(async () => undefined),
  archiveSession: vi.fn(async () => undefined),
  deleteTranscriptSession: vi.fn(async () => undefined),
  clearSessionCache: vi.fn(),
}));

vi.mock("@/core/channels", () => ({
  getChannelManager: () => ({
    connectToActorSystem: vi.fn(),
    listenForCallbacks: vi.fn(async () => undefined),
    register: vi.fn(async () => undefined),
  }),
  loadSavedChannels: () => [],
}));

vi.mock("@/core/task-center", () => ({
  getTaskQueue: () => ({
    setExecutor: vi.fn(),
  }),
  createActorSystemExecutor: vi.fn(() => vi.fn()),
}));

vi.mock("@/core/agent/actor/session-persistence", () => ({
  getLatestActiveSessionId: (...args: unknown[]) => mockGetLatestActiveSessionId(...args),
  loadSession: (...args: unknown[]) => mockLoadSessionFromDisk(...args),
  saveSession: (...args: unknown[]) => mockSaveSessionToDisk(...args),
}));

import { clearAllRuntimeSessions } from "@/core/agent/context-runtime/runtime-state";
import { useSessionControlPlaneStore } from "@/store/session-control-plane-store";
import { useActorSystemStore } from "./actor-system-store";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe("actor-system-store restore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLoadSessionFromDisk.mockReset();
    mockSaveSessionToDisk.mockClear();
    mockGetLatestActiveSessionId.mockReset();
    useActorSystemStore.getState().destroyAll();
    clearAllRuntimeSessions();
    useSessionControlPlaneStore.getState().clear();
    localStorage.clear();
  });

  afterEach(() => {
    useActorSystemStore.getState().destroyAll();
    clearAllRuntimeSessions();
    useSessionControlPlaneStore.getState().clear();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recovers local dialog room compaction from session control plane when persisted snapshot omitted it", async () => {
    const runtimeSessionId = "dialog-session-restore";
    const session = useSessionControlPlaneStore.getState().upsertSession({
      identity: {
        productMode: "dialog",
        surface: "local_dialog",
        sessionKey: runtimeSessionId,
        sessionKind: "collaboration_room",
        scope: "workspace",
        runtimeSessionId,
      },
      title: "Dialog 工作台",
      summary: "继续沿用之前房间压缩后的摘要",
      status: "running",
      createdAt: 100,
      updatedAt: 200,
      lastActiveAt: 200,
    });
    useSessionControlPlaneStore.getState().patchSessionContinuityState(session?.id ?? "", {
      source: "local_dialog",
      updatedAt: 220,
      roomCompactionSummary: "已整理较早的房间协作上下文，后续只需接着当前任务继续。",
      roomCompactionSummaryPreview: "已整理较早的房间协作上下文",
      roomCompactionUpdatedAt: 210,
      roomCompactionMessageCount: 16,
      roomCompactionTaskCount: 2,
      roomCompactionArtifactCount: 1,
      roomCompactionPreservedIdentifiers: ["src/App.tsx", "notes.md"],
    });

    localStorage.setItem("dialog_session_pointer", runtimeSessionId);
    mockLoadSessionFromDisk.mockResolvedValue({
      sessionId: runtimeSessionId,
      createdAt: 100,
      updatedAt: 200,
      entries: [],
      actorConfigs: [],
      snapshot: {
        version: 9,
        sessionId: runtimeSessionId,
        dialogHistory: [],
        actorConfigs: [
          {
            id: "agent-lead-restore",
            roleName: "Lead",
            maxIterations: 40,
          },
        ],
        dialogRoomCompaction: null,
        savedAt: 1710000000000,
      },
    });

    useActorSystemStore.getState().init();
    await flushMicrotasks();
    await flushMicrotasks();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    const state = useActorSystemStore.getState();

    expect(state.dialogRoomCompaction).toMatchObject({
      summary: "已整理较早的房间协作上下文，后续只需接着当前任务继续。",
      compactedMessageCount: 16,
      compactedSpawnedTaskCount: 2,
      compactedArtifactCount: 1,
      preservedIdentifiers: ["src/App.tsx", "notes.md"],
      updatedAt: 210,
    });
    expect(state._system?.getDialogRoomCompaction()).toMatchObject({
      summary: "已整理较早的房间协作上下文，后续只需接着当前任务继续。",
      compactedMessageCount: 16,
      compactedSpawnedTaskCount: 2,
      compactedArtifactCount: 1,
      preservedIdentifiers: ["src/App.tsx", "notes.md"],
      updatedAt: 210,
    });
  });

  it("restores persisted dialog execution mode as plan mode", async () => {
    const runtimeSessionId = "dialog-session-plan-mode";
    localStorage.setItem("dialog_session_pointer", runtimeSessionId);
    mockLoadSessionFromDisk.mockResolvedValue({
      sessionId: runtimeSessionId,
      createdAt: 100,
      updatedAt: 200,
      entries: [],
      actorConfigs: [],
      snapshot: {
        version: 10,
        sessionId: runtimeSessionId,
        dialogHistory: [],
        actorConfigs: [
          {
            id: "agent-lead-plan",
            roleName: "Lead",
            maxIterations: 40,
            executionPolicy: {
              accessMode: "auto",
              approvalMode: "permissive",
            },
          },
        ],
        dialogExecutionMode: "plan",
        savedAt: 1710000000000,
      },
    });

    useActorSystemStore.getState().init();
    await flushMicrotasks();
    await flushMicrotasks();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    const state = useActorSystemStore.getState();

    expect(state.dialogExecutionMode).toBe("plan");
    expect(state._system?.getDialogExecutionMode()).toBe("plan");
    expect(state.actors[0]?.normalizedExecutionPolicy).toEqual({
      accessMode: "read_only",
      approvalMode: "strict",
    });
  });

  it("restores persisted dialog subagent mode flag", async () => {
    const runtimeSessionId = "dialog-session-subagent-mode";
    localStorage.setItem("dialog_session_pointer", runtimeSessionId);
    mockLoadSessionFromDisk.mockResolvedValue({
      sessionId: runtimeSessionId,
      createdAt: 100,
      updatedAt: 200,
      entries: [],
      actorConfigs: [],
      snapshot: {
        version: 11,
        sessionId: runtimeSessionId,
        dialogHistory: [],
        actorConfigs: [
          {
            id: "agent-lead-subagent",
            roleName: "Lead",
            maxIterations: 40,
          },
        ],
        dialogSubagentEnabled: true,
        savedAt: 1710000000000,
      },
    });

    useActorSystemStore.getState().init();
    await flushMicrotasks();
    await flushMicrotasks();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    const state = useActorSystemStore.getState();

    expect(state.dialogSubagentEnabled).toBe(true);
    expect(state._system?.getDialogSubagentEnabled()).toBe(true);
  });

  it("restores persisted dialog flow trace events", async () => {
    const runtimeSessionId = "dialog-session-flow-trace";
    localStorage.setItem("dialog_session_pointer", runtimeSessionId);
    mockLoadSessionFromDisk.mockResolvedValue({
      sessionId: runtimeSessionId,
      createdAt: 100,
      updatedAt: 200,
      entries: [],
      actorConfigs: [],
      snapshot: {
        version: 12,
        sessionId: runtimeSessionId,
        dialogHistory: [],
        dialogFlowEvents: [
          {
            event: "repair_round_started",
            actorId: "agent-lead-flow",
            timestamp: 1200,
            detail: {
              accepted_count: 1,
              preview: "结果清单补派（第2组修复）",
            },
          },
          {
            event: "host_export_completed",
            actorId: "agent-lead-flow",
            timestamp: 1500,
            detail: {
              phase: "host_export",
              preview: "/Users/demo/Downloads/final-courses.xlsx",
            },
          },
        ],
        actorConfigs: [
          {
            id: "agent-lead-flow",
            roleName: "Lead",
            maxIterations: 40,
          },
        ],
        savedAt: 1710000000000,
      },
    });

    useActorSystemStore.getState().init();
    await flushMicrotasks();
    await flushMicrotasks();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    const state = useActorSystemStore.getState();

    expect(state.dialogFlowEvents).toHaveLength(2);
    expect(state.dialogFlowEvents[0]).toMatchObject({
      event: "repair_round_started",
      actorId: "agent-lead-flow",
    });
    expect(state._system?.getDialogFlowEventsSnapshot()).toHaveLength(2);
  });
});
