import { describe, expect, it } from "vitest";
import type { DialogExecutionPlan } from "./types";
import type { ExecutionContract } from "@/core/collaboration/types";
import {
  buildExecutionContractFromLegacyDialogExecutionPlan,
  buildLegacyDialogExecutionPlanFromContract,
  cloneLegacyDialogExecutionPlan,
} from "./dialog-execution-plan-compat";

function createContract(): ExecutionContract {
  return {
    contractId: "contract-1",
    surface: "local_dialog",
    executionStrategy: "coordinator",
    executionPolicy: {
      accessMode: "auto",
      approvalMode: "normal",
    },
    summary: "Coordinator 协调 Specialist",
    coordinatorActorId: "coordinator",
    inputHash: "input-hash",
    actorRosterHash: "roster-hash",
    initialRecipientActorIds: ["coordinator"],
    participantActorIds: ["coordinator", "specialist"],
    allowedMessagePairs: [
      { fromActorId: "coordinator", toActorId: "specialist" },
      { fromActorId: "specialist", toActorId: "coordinator" },
    ],
    allowedSpawnPairs: [
      { fromActorId: "coordinator", toActorId: "specialist" },
    ],
    plannedDelegations: [
      {
        id: "delegation-1",
        targetActorId: "specialist",
        task: "补充验证结论",
        label: "验证支援",
        roleBoundary: "validator",
      },
    ],
    approvedAt: 123,
    state: "active",
  };
}

describe("dialog-execution-plan-compat", () => {
  it("builds a legacy dialog plan view from the active contract and runtime state", () => {
    const plan = buildLegacyDialogExecutionPlanFromContract(createContract(), {
      runtimeState: {
        activatedAt: 456,
        sourceMessageId: "msg-1",
      },
      hasActor: (actorId) => actorId !== "ghost",
    });

    expect(plan).toMatchObject({
      id: "contract-1",
      routingMode: "coordinator",
      state: "active",
      activatedAt: 456,
      sourceMessageId: "msg-1",
      coordinatorActorId: "coordinator",
      plannedSpawns: [
        expect.objectContaining({
          id: "delegation-1",
          targetActorId: "specialist",
          roleBoundary: "validator",
        }),
      ],
    });
    expect(cloneLegacyDialogExecutionPlan(plan)).toEqual(plan);
  });

  it("converts a legacy dialog plan into a contract plus runtime state", () => {
    const legacyPlan: DialogExecutionPlan = {
      id: "legacy-plan-1",
      routingMode: "smart",
      summary: "恢复旧版 plan",
      approvedAt: 99,
      initialRecipientActorIds: ["coordinator", "coordinator"],
      participantActorIds: ["coordinator", "specialist", "specialist"],
      coordinatorActorId: "ghost",
      allowedMessagePairs: [
        { fromActorId: "coordinator", toActorId: "specialist" },
        { fromActorId: "", toActorId: "ghost" },
      ],
      allowedSpawnPairs: [
        { fromActorId: "coordinator", toActorId: "specialist" },
      ],
      plannedSpawns: [
        {
          id: "spawn-1",
          targetActorId: "specialist",
          task: "  补充验证  ",
        },
        {
          id: "spawn-2",
          targetActorId: "",
          task: "",
        },
      ],
      state: "active",
      activatedAt: 1234,
      sourceMessageId: "  msg-restore-1  ",
    };

    const result = buildExecutionContractFromLegacyDialogExecutionPlan({
      surface: "local_dialog",
      plan: legacyPlan,
      hasActor: (actorId) => actorId !== "ghost",
    });

    expect(result.runtimeState).toEqual({
      activatedAt: 1234,
      sourceMessageId: "msg-restore-1",
    });
    expect(result.contract).toMatchObject({
      contractId: "legacy-plan-1",
      surface: "local_dialog",
      executionStrategy: "smart",
      summary: "恢复旧版 plan",
      state: "active",
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator", "specialist"],
      coordinatorActorId: undefined,
      plannedDelegations: [
        expect.objectContaining({
          id: "spawn-1",
          targetActorId: "specialist",
          task: "补充验证",
        }),
      ],
    });
  });
});
