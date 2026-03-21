import { describe, expect, it, vi } from "vitest";

import type {
  DialogArtifactRecord,
  DialogMessage,
  DialogRoomCompactionState,
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "./types";

const hoisted = vi.hoisted(() => ({
  persistDialogRoomCompactionArtifacts: vi.fn(async ({
    state,
  }: {
    state: DialogRoomCompactionState;
  }) => ({
    ...state,
    memoryFlushNoteId: "note-1",
    memoryConfirmedCount: 2,
    memoryQueuedCount: 1,
  })),
  getActorTodoList: vi.fn(() => []),
}));

vi.mock("./dialog-room-compaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dialog-room-compaction")>();
  return {
    ...actual,
    persistDialogRoomCompactionArtifacts: hoisted.persistDialogRoomCompactionArtifacts,
  };
});

vi.mock("./middlewares", () => ({
  getActorTodoList: hoisted.getActorTodoList,
}));

import {
  CONTEXT_PRESSURE_TRIGGER,
  ensureDialogRoomCompaction,
  isDialogContextPressureError,
  recoverDialogRoomCompactionFromContextPressure,
} from "./dialog-context-pressure";

function createMessage(
  id: string,
  from: string,
  content: string,
  timestamp: number,
): DialogMessage {
  return {
    id,
    from,
    content,
    timestamp,
    priority: "normal",
  };
}

function createSystemFixture() {
  let dialogRoomCompaction: DialogRoomCompactionState | null = null;
  const dialogHistory: DialogMessage[] = Array.from({ length: 15 }, (_, index) =>
    createMessage(
      `m-${index + 1}`,
      index % 2 === 0 ? "user" : "builder",
      index % 2 === 0
        ? `请继续推进首页重构任务，补充第 ${index + 1} 条约束。`
        : `Builder 已同步第 ${index + 1} 条执行结论，并继续整理补丁。`,
      index + 1,
    ));
  const artifacts: DialogArtifactRecord[] = [
    {
      id: "artifact-1",
      actorId: "builder",
      path: "/repo/src/main.tsx",
      fileName: "main.tsx",
      directory: "/repo/src",
      source: "tool_write",
      summary: "更新首页主入口",
      timestamp: 4,
    },
  ];
  const sessionUploads: SessionUploadRecord[] = [
    {
      id: "upload-1",
      type: "image",
      name: "design.png",
      path: "/repo/assets/design.png",
      size: 1,
      addedAt: 5,
    },
  ];
  const spawnedTasks: SpawnedTaskRecord[] = [
    {
      runId: "run-1",
      spawnerActorId: "coordinator",
      targetActorId: "reviewer",
      dispatchSource: "contract_suggestion",
      plannedDelegationId: "delegation-1",
      contractId: "contract-1",
      task: "检查首页交互回归",
      label: "回归检查",
      status: "running",
      spawnedAt: 8,
      lastActiveAt: 14,
      mode: "session",
      expectsCompletionMessage: true,
      cleanup: "keep",
      sessionOpen: true,
      roleBoundary: "reviewer",
    },
  ];
  const actors = [
    {
      id: "coordinator",
      role: { name: "Coordinator" },
      modelOverride: "gpt-5",
      workspace: "/repo",
      contextTokens: 8000,
      thinkingLevel: "adaptive" as const,
      getSystemPromptOverride: () => "负责协调与综合",
      getSessionHistory: () => [
        { role: "user" as const, content: "继续完成首页重构", timestamp: 1 },
        { role: "assistant" as const, content: "正在拆分任务与整理工作集", timestamp: 2 },
      ],
      currentTask: {
        query: "继续完成首页重构",
        status: "running",
        steps: [
          { type: "observation", content: "正在汇总当前房间线索" },
          { type: "observation", content: "准备决定是否继续派工" },
        ],
      },
    },
    {
      id: "reviewer",
      role: { name: "Reviewer" },
      modelOverride: "gpt-5-mini",
      workspace: "/repo",
      contextTokens: 6000,
      thinkingLevel: "low" as const,
      getSystemPromptOverride: () => undefined,
      getSessionHistory: () => [
        { role: "assistant" as const, content: "我会先做一轮首页回归检查。", timestamp: 13 },
      ],
      currentTask: {
        query: "检查首页交互回归",
        status: "running",
        steps: [{ type: "observation", content: "正在检查 Hero 和 CTA" }],
      },
    },
  ];

  const system = {
    sessionId: "dialog-1",
    getAll: () => actors,
    getCoordinatorId: () => "coordinator",
    getDialogHistory: () => dialogHistory,
    getArtifactRecordsSnapshot: () => artifacts,
    getSessionUploadsSnapshot: () => sessionUploads,
    getSpawnedTasksSnapshot: () => spawnedTasks,
    getDialogRoomCompaction: () => dialogRoomCompaction,
    setDialogRoomCompaction: (state: DialogRoomCompactionState | null) => {
      dialogRoomCompaction = state;
    },
  };

  return {
    system,
    getDialogRoomCompaction: () => dialogRoomCompaction,
  };
}

describe("dialog-context-pressure", () => {
  it("recognizes provider context pressure errors", () => {
    expect(isDialogContextPressureError(new Error("maximum context length exceeded"))).toBe(true);
    expect(isDialogContextPressureError(new Error("Request too large for this model"))).toBe(true);
    expect(isDialogContextPressureError(new Error("network timeout"))).toBe(false);
  });

  it("builds and persists a room compaction when dialog runtime hits context pressure", async () => {
    const fixture = createSystemFixture();

    const recovered = await recoverDialogRoomCompactionFromContextPressure(fixture.system as never);

    expect(recovered).not.toBeNull();
    expect(recovered?.triggerReasons).toContain(CONTEXT_PRESSURE_TRIGGER);
    expect(recovered?.summary).toContain("后续续跑应优先沿用的当前工作集");
    expect(recovered?.memoryFlushNoteId).toBe("note-1");
    expect(recovered?.memoryConfirmedCount).toBe(2);
    expect(hoisted.persistDialogRoomCompactionArtifacts).toHaveBeenCalledTimes(1);
    expect(fixture.getDialogRoomCompaction()).toEqual(recovered);
  });

  it("skips proactive refresh when the current compaction is still fresh enough", async () => {
    const fixture = createSystemFixture();
    const first = await ensureDialogRoomCompaction(fixture.system as never, { force: true });
    expect(first?.changed).toBe(true);

    hoisted.persistDialogRoomCompactionArtifacts.mockClear();
    const second = await ensureDialogRoomCompaction(fixture.system as never);

    expect(second).toBeNull();
    expect(hoisted.persistDialogRoomCompactionArtifacts).not.toHaveBeenCalled();
  });

  it("reuses the current compaction if the same summary already includes the pressure trigger", async () => {
    const fixture = createSystemFixture();
    const first = await recoverDialogRoomCompactionFromContextPressure(fixture.system as never);
    hoisted.persistDialogRoomCompactionArtifacts.mockClear();

    const second = await recoverDialogRoomCompactionFromContextPressure(fixture.system as never);

    expect(second).toEqual(first);
    expect(hoisted.persistDialogRoomCompactionArtifacts).not.toHaveBeenCalled();
  });
});
