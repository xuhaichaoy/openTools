import { describe, expect, it } from "vitest";
import type {
  DialogExecutionPlan,
  DialogMessage,
  PendingInteraction,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import type { CollaborationActorRosterEntry, ExecutionContract, ExecutionContractDraft } from "./types";
import {
  buildActorRosterHash,
  buildInputHash,
  cloneExecutionContract,
  sealExecutionContract,
} from "./execution-contract";
import { CollaborationSessionController } from "./session-controller";

class FakeSystem {
  public readonly sent: Array<{ kind: string; target?: string; content: string }> = [];
  public dialogPlan: DialogExecutionPlan | null = null;
  public activeContract: ExecutionContract | null = null;
  public pendingInteractions: PendingInteraction[] = [];
  public spawnedTasks: SpawnedTaskRecord[] = [];
  public dialogMessages: DialogMessage[] = [];
  public focusedRunId: string | null = null;

  getPendingUserInteractions(): PendingInteraction[] {
    return [...this.pendingInteractions];
  }

  getSpawnedTasksSnapshot(): SpawnedTaskRecord[] {
    return [...this.spawnedTasks];
  }

  getFocusedSpawnedSessionRunId(): string | null {
    return this.focusedRunId;
  }

  focusSpawnedSession(runId: string | null): void {
    this.focusedRunId = runId;
  }

  getActiveExecutionContract(): ExecutionContract | null {
    return this.activeContract ? cloneExecutionContract(this.activeContract) : null;
  }

  getDialogExecutionPlan(): DialogExecutionPlan | null {
    return this.dialogPlan ? { ...this.dialogPlan } : null;
  }

  getDialogMessagesSnapshot(): DialogMessage[] {
    return this.dialogMessages.map((message) => ({ ...message }));
  }

  armExecutionContract(contract: ExecutionContract): void {
    this.activeContract = cloneExecutionContract({
      ...contract,
      state: "sealed",
    });
  }

  restoreExecutionContract(contract: ExecutionContract): void {
    this.activeContract = cloneExecutionContract(contract);
  }

  clearExecutionContract(): void {
    this.activeContract = null;
  }

  armDialogExecutionPlan(plan: DialogExecutionPlan): void {
    this.dialogPlan = { ...plan };
  }

  restoreDialogExecutionPlan(plan: DialogExecutionPlan): void {
    this.dialogPlan = { ...plan };
  }

  clearDialogExecutionPlan(): void {
    this.dialogPlan = null;
  }

  send(from: string, to: string, content: string): DialogMessage {
    this.sent.push({ kind: "send", target: to, content });
    const message: DialogMessage = {
      id: `msg-${this.sent.length}`,
      from,
      to,
      content,
      timestamp: Date.now(),
      priority: "normal",
      kind: "user_input",
    };
    this.dialogMessages.push(message);
    return message;
  }

  broadcast(from: string, content: string): DialogMessage {
    this.sent.push({ kind: "broadcast", content });
    const message: DialogMessage = {
      id: `msg-${this.sent.length}`,
      from,
      content,
      timestamp: Date.now(),
      priority: "normal",
      kind: "user_input",
    };
    this.dialogMessages.push(message);
    return message;
  }

  broadcastAndResolve(from: string, content: string): DialogMessage {
    this.sent.push({ kind: "broadcastAndResolve", content });
    const message: DialogMessage = {
      id: `msg-${this.sent.length}`,
      from,
      content,
      timestamp: Date.now(),
      priority: "normal",
      kind: "user_input",
    };
    this.dialogMessages.push(message);
    return message;
  }

  replyToMessage(messageId: string, content: string): DialogMessage {
    this.sent.push({ kind: "reply", target: messageId, content });
    const message: DialogMessage = {
      id: `msg-${this.sent.length}`,
      from: "user",
      to: "reviewer",
      content,
      timestamp: Date.now(),
      priority: "normal",
      replyTo: messageId,
      kind: "clarification_response",
    };
    this.dialogMessages.push(message);
    this.pendingInteractions = [];
    return message;
  }

  sendUserMessageToSpawnedSession(runId: string, content: string): DialogMessage {
    this.sent.push({ kind: "steer", target: runId, content });
    const message: DialogMessage = {
      id: `msg-${this.sent.length}`,
      from: "user",
      to: "reviewer",
      content,
      timestamp: Date.now(),
      priority: "normal",
      kind: "user_input",
      relatedRunId: runId,
    };
    this.dialogMessages.push(message);
    return message;
  }
}

const ROSTER: CollaborationActorRosterEntry[] = [
  { actorId: "coordinator", roleName: "Coordinator", capabilities: ["coordinator"] },
  { actorId: "reviewer", roleName: "Reviewer", capabilities: ["code_review"] },
];

function createDraft(): ExecutionContractDraft {
  const input = { content: "请 review 这次改动" };
  return {
    draftId: "draft-1",
    surface: "local_dialog",
    executionStrategy: "direct",
    summary: "定向发送给 reviewer",
    createdAt: 1,
    input,
    actorRoster: ROSTER,
    inputHash: buildInputHash(input),
    actorRosterHash: buildActorRosterHash(ROSTER),
    initialRecipientActorIds: ["reviewer"],
    participantActorIds: ["coordinator", "reviewer"],
    allowedMessagePairs: [{ fromActorId: "coordinator", toActorId: "reviewer" }],
    allowedSpawnPairs: [],
    plannedDelegations: [],
  };
}

describe("session-controller", () => {
  it("round-trips snapshot state and preserves queued follow-ups", () => {
    const system = new FakeSystem();
    system.spawnedTasks = [{
      runId: "run-1",
      spawnerActorId: "coordinator",
      targetActorId: "reviewer",
      dispatchSource: "manual",
      task: "审查改动",
      label: "代码评审",
      status: "running",
      spawnedAt: 100,
      mode: "session",
      expectsCompletionMessage: true,
      cleanup: "keep",
      sessionOpen: true,
      lastActiveAt: 120,
    }];

    const controller = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => ROSTER,
    });
    controller.applyExecutionContract(sealExecutionContract(createDraft(), {
      contractId: "contract-1",
      approvedAt: 2,
      state: "sealed",
    }));
    controller.syncFromSystem();
    controller.setFocusedChildSession("run-1");
    controller.enqueueFollowUp({ content: "等 reviewer 回复后继续" }, "queue");

    const snapshot = controller.snapshot();
    const restored = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => ROSTER,
    });
    restored.restore(snapshot);

    expect(restored.snapshot()).toMatchObject({
      ...snapshot,
      updatedAt: expect.any(Number),
    });
    expect(system.focusedRunId).toBe("run-1");
  });

  it("dispatches queued follow-ups with the sealed contract instead of rerouting", () => {
    const system = new FakeSystem();
    const controller = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => ROSTER,
    });
    const contract = sealExecutionContract(createDraft(), {
      contractId: "contract-2",
      approvedAt: 3,
      state: "sealed",
    });

    const followUpId = controller.enqueueFollowUp({
      content: "请继续看 reviewer 给出的风险点",
      contract,
    }, "queue");
    const result = controller.runQueuedFollowUp(followUpId);

    expect(result.disposition).toBe("dispatched");
    expect(system.sent).toEqual([{
      kind: "send",
      target: "reviewer",
      content: "请继续看 reviewer 给出的风险点",
    }]);
    expect(controller.snapshot().queuedFollowUps).toHaveLength(0);
  });

  it("prefers the runtime execution contract interface over the legacy dialog plan bridge", () => {
    const system = new FakeSystem();
    const controller = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => ROSTER,
    });
    const contract = sealExecutionContract(createDraft(), {
      contractId: "contract-runtime-only",
      approvedAt: 9,
      state: "active",
    });

    controller.applyExecutionContract(contract);

    expect(system.activeContract?.contractId).toBe("contract-runtime-only");
    expect(system.dialogPlan).toBeNull();
    expect(controller.snapshot().activeContract?.contractId).toBe("contract-runtime-only");
  });

  it("marks queued follow-up as needing reapproval when roster changes", () => {
    const system = new FakeSystem();
    const controller = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => ROSTER,
    });
    const contract = sealExecutionContract(createDraft(), {
      contractId: "contract-3",
      approvedAt: 4,
      state: "sealed",
    });
    const followUpId = controller.enqueueFollowUp({
      content: "重新执行 review",
      contract,
    }, "queue");

    const changedController = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => [
        ...ROSTER,
        { actorId: "validator", roleName: "Validator", capabilities: ["testing"] },
      ],
    });
    changedController.restore(controller.snapshot());

    expect(() => changedController.runQueuedFollowUp(followUpId)).toThrow(/needs reapproval/i);
    expect(changedController.snapshot().queuedFollowUps[0]?.contractStatus).toBe("needs_reapproval");
  });

  it("projects contract delegations from the active contract and spawned task graph", () => {
    const system = new FakeSystem();
    const controller = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => ROSTER,
    });
    const contract = sealExecutionContract({
      ...createDraft(),
      executionStrategy: "coordinator",
      plannedDelegations: [
        {
          id: "delegation-running",
          targetActorId: "reviewer",
          label: "代码评审",
          task: "继续审查改动",
        },
        {
          id: "delegation-available",
          targetActorId: "coordinator",
          label: "主线程汇总",
          task: "等待主 Agent 自主决定",
        },
      ],
      allowedSpawnPairs: [{ fromActorId: "coordinator", toActorId: "reviewer" }],
    }, {
      contractId: "contract-projection",
      approvedAt: 6,
      state: "active",
    });

    system.activeContract = contract;
    system.spawnedTasks = [{
      runId: "run-delegation-1",
      spawnerActorId: "coordinator",
      targetActorId: "reviewer",
      contractId: "contract-projection",
      plannedDelegationId: "delegation-running",
      dispatchSource: "contract_suggestion",
      task: "继续审查改动",
      label: "代码评审",
      status: "completed",
      spawnedAt: 100,
      completedAt: 160,
      mode: "session",
      expectsCompletionMessage: true,
      cleanup: "keep",
      sessionOpen: true,
      lastActiveAt: 160,
    }];

    const snapshot = controller.syncFromSystem();

    expect(snapshot.contractDelegations).toEqual([
      {
        delegationId: "delegation-running",
        targetActorId: "reviewer",
        label: "代码评审",
        state: "waiting",
        runId: "run-delegation-1",
      },
      {
        delegationId: "delegation-available",
        targetActorId: "coordinator",
        label: "主线程汇总",
        state: "available",
      },
    ]);
  });

  it("clears focused child session when the live spawned session is closed", () => {
    const system = new FakeSystem();
    system.spawnedTasks = [{
      runId: "run-session-1",
      spawnerActorId: "coordinator",
      targetActorId: "reviewer",
      dispatchSource: "manual",
      task: "继续 review",
      label: "Review Session",
      status: "running",
      spawnedAt: 100,
      mode: "session",
      expectsCompletionMessage: true,
      cleanup: "keep",
      sessionOpen: true,
      lastActiveAt: 120,
    }];

    const controller = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => ROSTER,
    });

    controller.setFocusedChildSession("run-session-1");
    expect(controller.snapshot().focusedChildSessionId).toBe("run-session-1");

    system.spawnedTasks = [{
      ...system.spawnedTasks[0],
      sessionOpen: false,
      status: "completed",
      completedAt: 180,
    }];
    system.focusedRunId = null;

    const snapshot = controller.syncFromSystem();

    expect(snapshot.focusedChildSessionId).toBeNull();
    expect(snapshot.presentationState.focusedChildSessionId).toBeNull();
  });

  it("does not route to a focused child session when dispatch explicitly clears child focus", () => {
    const system = new FakeSystem();
    system.spawnedTasks = [{
      runId: "run-session-1",
      spawnerActorId: "coordinator",
      targetActorId: "reviewer",
      dispatchSource: "manual",
      task: "继续 review",
      label: "Review Session",
      status: "running",
      spawnedAt: 100,
      mode: "session",
      expectsCompletionMessage: true,
      cleanup: "keep",
      sessionOpen: true,
      lastActiveAt: 120,
    }];

    const controller = new CollaborationSessionController(system, {
      surface: "local_dialog",
      actorRosterProvider: () => ROSTER,
    });

    controller.setFocusedChildSession("run-session-1");
    controller.dispatchUserInput({ content: "继续看这次 review" }, {
      focusedChildSessionId: null,
      allowQueue: false,
    });

    expect(system.sent[0]).toMatchObject({
      kind: "broadcastAndResolve",
      content: "继续看这次 review",
    });
  });
});
