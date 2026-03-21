import { describe, expect, it } from "vitest";
import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import { buildCollaborationChildSession } from "./child-session";

describe("child-session", () => {
  it("marks active child sessions as running while the delegated turn is still executing", () => {
    const record: SpawnedTaskRecord = {
      runId: "run-1",
      spawnerActorId: "coordinator",
      targetActorId: "reviewer",
      dispatchSource: "manual",
      parentRunId: "parent-1",
      roleBoundary: "reviewer",
      task: "请独立审查本次改动并指出回归风险",
      label: "代码评审",
      status: "running",
      spawnedAt: 100,
      mode: "session",
      expectsCompletionMessage: true,
      cleanup: "keep",
      sessionOpen: true,
      lastActiveAt: 150,
      result: "发现两个边界条件风险",
    };

    const session = buildCollaborationChildSession(record);

    expect(session).toEqual({
      id: "run-1",
      runId: "run-1",
      parentRunId: "parent-1",
      ownerActorId: "coordinator",
      targetActorId: "reviewer",
      label: "代码评审",
      roleBoundary: "reviewer",
      mode: "session",
      status: "running",
      focusable: true,
      resumable: true,
      announceToParent: true,
      lastResultSummary: "发现两个边界条件风险",
      lastError: undefined,
      startedAt: 100,
      updatedAt: 150,
      endedAt: undefined,
    });
  });

  it("marks completed but still-open child sessions as waiting for resume", () => {
    const record: SpawnedTaskRecord = {
      runId: "run-2",
      spawnerActorId: "coordinator",
      targetActorId: "reviewer",
      dispatchSource: "manual",
      roleBoundary: "reviewer",
      task: "请继续审查剩余边界条件",
      label: "继续评审",
      status: "completed",
      spawnedAt: 200,
      completedAt: 260,
      mode: "session",
      expectsCompletionMessage: true,
      cleanup: "keep",
      sessionOpen: true,
      lastActiveAt: 260,
      result: "已完成第一轮审查",
    };

    const session = buildCollaborationChildSession(record);

    expect(session.status).toBe("waiting");
    expect(session.resumable).toBe(true);
    expect(session.focusable).toBe(true);
    expect(session.lastResultSummary).toBe("已完成第一轮审查");
  });
});
