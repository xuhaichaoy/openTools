import { describe, expect, it } from "vitest";
import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import {
  buildCollaborationChildSession,
  buildCollaborationContractDelegations,
} from "./child-session";
import type { ExecutionContract } from "./types";

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
      statusSummary: "发现两个边界条件风险",
      nextStepHint: "等待子线程继续推进，只有被结果阻塞时再等待",
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
    expect(session.statusSummary).toBe("已完成第一轮审查");
    expect(session.nextStepHint).toBe("主 Agent 可按需继续复用该子会话，补充新的指令");
  });

  it("projects delegation summaries and next-step hints from the spawned task graph", () => {
    const contract: ExecutionContract = {
      contractId: "contract-1",
      surface: "local_dialog",
      executionStrategy: "coordinator",
      summary: "主 Agent 协调评审线程",
      inputHash: "input",
      actorRosterHash: "roster",
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator", "reviewer"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      plannedDelegations: [
        {
          id: "delegation-running",
          targetActorId: "reviewer",
          label: "代码评审",
          task: "继续审查改动",
        },
        {
          id: "delegation-available",
          targetActorId: "validator",
          label: "回归验证",
          task: "等待主 Agent 决定是否继续补充验证",
          createIfMissing: true,
        },
      ],
      approvedAt: 1,
      state: "active",
    };

    const delegations = buildCollaborationContractDelegations(contract, [
      {
        runId: "run-1",
        spawnerActorId: "coordinator",
        targetActorId: "reviewer",
        contractId: "contract-1",
        plannedDelegationId: "delegation-running",
        dispatchSource: "contract_suggestion",
        roleBoundary: "reviewer",
        task: "继续审查改动",
        label: "代码评审",
        status: "completed",
        spawnedAt: 100,
        completedAt: 150,
        mode: "session",
        expectsCompletionMessage: true,
        cleanup: "keep",
        sessionOpen: true,
        lastActiveAt: 150,
        result: "第一轮审查已完成，等待主 Agent 决定是否继续。",
      },
    ]);

    expect(delegations).toEqual([
      {
        delegationId: "delegation-running",
        targetActorId: "reviewer",
        label: "代码评审",
        state: "waiting",
        runId: "run-1",
        statusSummary: "第一轮审查已完成，等待主 Agent 决定是否继续。",
        nextStepHint: "主 Agent 可按需继续复用该子会话，补充新的指令",
        updatedAt: 150,
      },
      {
        delegationId: "delegation-available",
        targetActorId: "validator",
        label: "回归验证",
        state: "available",
        statusSummary: "等待主 Agent 决定是否继续补充验证",
        nextStepHint: "主 Agent 可按需创建或复用目标线程",
        updatedAt: undefined,
      },
    ]);
  });
});
