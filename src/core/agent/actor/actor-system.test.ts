import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ActorConfig, ExecutionPolicy, ToolPolicy } from "./types";
import type { ExecutionContract } from "@/core/collaboration/types";

vi.mock("./actor-transcript", () => ({
  appendDialogMessageSync: vi.fn(),
  appendSpawnEventSync: vi.fn(),
  appendAnnounceEventSync: vi.fn(),
  updateTranscriptActors: vi.fn(),
  archiveSession: vi.fn(),
  deleteTranscriptSession: vi.fn(),
  clearSessionCache: vi.fn(),
}));

vi.mock("./agent-actor", () => {
  class MockAgentActor {
    id: string;
    role: ActorConfig["role"];
    persistent: boolean;
    modelOverride?: string;
    capabilities?: ActorConfig["capabilities"];
    private _workspace?: string;
    private toolPolicy?: ToolPolicy;
    private executionPolicyValue?: ExecutionPolicy;
    private systemPromptOverride?: string;
    private _status = "idle";
    private inbox: unknown[] = [];
    lastAssignedQuery?: string;
    lastAssignedImages?: string[];
    lastMemoryRecallAttempted = false;
    lastMemoryRecallPreview: string[] = [];
    lastTranscriptRecallAttempted = false;
    lastTranscriptRecallHitCount = 0;
    lastTranscriptRecallPreview: string[] = [];

    constructor(config: ActorConfig) {
      this.id = config.id;
      this.role = config.role;
      this.persistent = config.persistent !== false;
      this.modelOverride = config.modelOverride;
      this.capabilities = config.capabilities;
      this._workspace = config.workspace;
      this.toolPolicy = config.toolPolicy;
      this.executionPolicyValue = config.executionPolicy;
      this.systemPromptOverride = config.systemPromptOverride;
    }

    on() {}

    receive(message: unknown) {
      this.inbox.push(message);
    }

    stop() {
      this._status = "stopped";
    }

    get status() {
      return this._status;
    }

    get pendingInboxCount() {
      return this.inbox.length;
    }

    get currentTask() {
      return undefined;
    }

    get allTasks() {
      return [];
    }

    get toolPolicyConfig() {
      if (!this.toolPolicy) return undefined;
      return {
        allow: this.toolPolicy.allow ? [...this.toolPolicy.allow] : undefined,
        deny: this.toolPolicy.deny ? [...this.toolPolicy.deny] : undefined,
      };
    }

    get workspace() {
      return this._workspace;
    }

    get executionPolicy() {
      if (!this.executionPolicyValue) return undefined;
      return { ...this.executionPolicyValue };
    }

    get timeoutSeconds() {
      return undefined;
    }

    get contextTokens() {
      return undefined;
    }

    get thinkingLevel() {
      return undefined;
    }

    get middlewareOverrides() {
      return undefined;
    }

    getSystemPromptOverride() {
      return this.systemPromptOverride;
    }

    getSessionHistory() {
      return [];
    }

    assignTask(query: string, images?: string[]) {
      this.lastAssignedQuery = query;
      this.lastAssignedImages = images;
      this._status = "running";
      return Promise.resolve({
        id: "task-1",
        query,
        status: "completed" as const,
        result: "ok",
        steps: [],
        startedAt: Date.now(),
        finishedAt: Date.now(),
      });
    }

    abort() {
      this._status = "idle";
    }
  }

  return {
    AgentActor: MockAgentActor,
    DIALOG_FULL_ROLE: {
      id: "dialog_agent",
      name: "Agent",
      systemPrompt: "dialog full role",
      capabilities: [],
      maxIterations: 20,
      temperature: 0.5,
    },
  };
});

vi.mock("./actor-cron", () => {
  class MockActorCron {
    constructor() {}

    cancelAll() {}
  }

  return {
    ActorCron: MockActorCron,
  };
});

vi.mock("./middlewares", () => ({
  clearSessionApprovals: vi.fn(),
  clearAllTodos: vi.fn(),
  resetTitleGeneration: vi.fn(),
  clearTelemetry: vi.fn(),
}));

vi.mock("./spawned-task-result-validator", () => ({
  buildSpawnTaskExecutionHint: vi.fn(() => ""),
  validateSpawnedTaskResult: vi.fn(() => ({
    ok: true,
    reason: "",
    warnings: [],
  })),
}));

let ActorSystem: typeof import("./actor-system").ActorSystem;

beforeAll(async () => {
  ({ ActorSystem } = await import("./actor-system"));
});

function buildActorConfig(
  id: string,
  name: string,
  overrides: Partial<ActorConfig> = {},
): ActorConfig {
  return {
    id,
    role: {
      id: `role-${id}`,
      name,
      systemPrompt: `${name} system prompt`,
      capabilities: [],
      maxIterations: 1,
      temperature: 0,
    },
    ...overrides,
  };
}

function buildExecutionContract(
  overrides: Partial<ExecutionContract> = {},
): ExecutionContract {
  return {
    contractId: overrides.contractId ?? "contract-1",
    surface: overrides.surface ?? "local_dialog",
    executionStrategy: overrides.executionStrategy ?? "coordinator",
    summary: overrides.summary ?? "Coordinator 协调 Specialist",
    coordinatorActorId: overrides.coordinatorActorId ?? "coordinator",
    inputHash: overrides.inputHash ?? "input-hash",
    actorRosterHash: overrides.actorRosterHash ?? "roster-hash",
    initialRecipientActorIds: overrides.initialRecipientActorIds ?? ["coordinator"],
    participantActorIds: overrides.participantActorIds ?? ["coordinator", "specialist"],
    allowedMessagePairs: overrides.allowedMessagePairs ?? [
      { fromActorId: "coordinator", toActorId: "specialist" },
      { fromActorId: "specialist", toActorId: "coordinator" },
    ],
    allowedSpawnPairs: overrides.allowedSpawnPairs ?? [
      { fromActorId: "coordinator", toActorId: "specialist" },
    ],
    plannedDelegations: overrides.plannedDelegations ?? [],
    approvedAt: overrides.approvedAt ?? 1,
    state: overrides.state ?? "sealed",
  };
}

describe("ActorSystem.broadcastAndResolve", () => {
  it("queues a new user message to the fallback coordinator when all actors are awaiting reply", () => {
    const system = new ActorSystem();
    const coordinator = system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist"));

    (coordinator as unknown as { _status: string })._status = "waiting";
    (specialist as unknown as { _status: string })._status = "waiting";

    void system.askUserInChat("coordinator", "请确认方案 A", { timeoutMs: 60_000 });
    void system.askUserInChat("specialist", "请确认方案 B", { timeoutMs: 60_000 });

    expect(system.getPendingUserInteractions()).toHaveLength(2);

    const msg = system.broadcastAndResolve("user", "继续做新的独立任务");

    expect(msg.content).toBe("继续做新的独立任务");
    expect(coordinator.pendingInboxCount).toBe(1);
    expect(specialist.pendingInboxCount).toBe(0);

    system.cancelPendingInteractionsForActor("coordinator");
    system.cancelPendingInteractionsForActor("specialist");
    system.killAll();
  });

  it("activates the approved contract without injecting a coordinator bootstrap", async () => {
    const system = new ActorSystem();
    const coordinator = system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      lastAssignedQuery?: string;
    };

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-bootstrap-free",
      approvedAt: Date.now(),
      plannedDelegations: [
        {
          id: "delegation-1",
          targetActorId: "specialist",
          task: "从验证视角补充实现风险与测试建议。",
          label: "验证支援",
        },
      ],
    }));

    const msg = system.broadcastAndResolve("user", "请继续完善这个实现");

    expect(msg.content).toBe("请继续完善这个实现");
    expect(coordinator.pendingInboxCount).toBe(1);
    expect(specialist.lastAssignedQuery).toBeUndefined();
  });

  it("exposes the active execution contract as the runtime source of truth", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    system.spawn(buildActorConfig("specialist", "Specialist"));

    system.armExecutionContract({
      contractId: "contract-1",
      surface: "local_dialog",
      executionStrategy: "coordinator",
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
          task: "补充测试建议",
          label: "验证支援",
        },
      ],
      approvedAt: 1,
      state: "sealed",
    });

    expect(system.getActiveExecutionContract()).toMatchObject({
      contractId: "contract-1",
      coordinatorActorId: "coordinator",
      plannedDelegations: [
        expect.objectContaining({
          id: "delegation-1",
          targetActorId: "specialist",
        }),
      ],
    });
    expect(system.getDialogExecutionPlan()).toMatchObject({
      id: "contract-1",
      coordinatorActorId: "coordinator",
      plannedSpawns: [
        expect.objectContaining({
          id: "delegation-1",
          targetActorId: "specialist",
        }),
      ],
    });
    expect(system.snapshot()).toMatchObject({
      executionContract: expect.objectContaining({
        contractId: "contract-1",
      }),
    });
  });

  it("uses legacy dialog plan APIs as contract-only compatibility wrappers", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    system.spawn(buildActorConfig("specialist", "Specialist"));

    system.restoreDialogExecutionPlan({
      id: "legacy-plan-restore",
      routingMode: "coordinator",
      summary: "恢复旧版 dialog plan",
      approvedAt: 1,
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator", "specialist"],
      coordinatorActorId: "coordinator",
      allowedMessagePairs: [
        { fromActorId: "coordinator", toActorId: "specialist" },
        { fromActorId: "specialist", toActorId: "coordinator" },
      ],
      allowedSpawnPairs: [
        { fromActorId: "coordinator", toActorId: "specialist" },
      ],
      plannedSpawns: [
        {
          id: "delegation-restore-1",
          targetActorId: "specialist",
          task: "恢复后补充验证",
        },
      ],
      state: "active",
      activatedAt: 123,
      sourceMessageId: "msg-restore-1",
    });

    expect(system.getActiveExecutionContract()).toMatchObject({
      contractId: "legacy-plan-restore",
      state: "active",
      plannedDelegations: [
        expect.objectContaining({
          id: "delegation-restore-1",
          targetActorId: "specialist",
        }),
      ],
    });
    expect(system.getDialogExecutionPlan()).toMatchObject({
      id: "legacy-plan-restore",
      state: "active",
      activatedAt: 123,
      sourceMessageId: "msg-restore-1",
      plannedSpawns: [
        expect.objectContaining({
          id: "delegation-restore-1",
          targetActorId: "specialist",
        }),
      ],
    });

    system.clearExecutionContract();

    expect(system.getActiveExecutionContract()).toBeNull();
    expect(system.getDialogExecutionPlan()).toBeNull();
  });
});

describe("ActorSystem.replyToMessage", () => {
  it("resumes a restored pending interaction from dialog history", async () => {
    const sourceSystem = new ActorSystem();
    sourceSystem.spawn(buildActorConfig("coordinator", "Coordinator"));

    void sourceSystem.askUserInChat("coordinator", "请确认是否继续执行", { timeoutMs: 60_000 });
    const pendingMessage = sourceSystem.getDialogHistory()[0];
    expect(pendingMessage?.interactionStatus).toBe("pending");

    const restoredHistory = sourceSystem.getDialogHistory().map((message) => ({ ...message }));
    sourceSystem.cancelPendingInteractionsForActor("coordinator");
    sourceSystem.killAll();

    const restoredSystem = new ActorSystem();
    restoredSystem.spawn(buildActorConfig("coordinator", "Coordinator"));
    restoredSystem.restoreDialogHistory(restoredHistory);

    const reply = restoredSystem.replyToMessage(pendingMessage!.id, "继续执行");

    expect(reply.replyTo).toBe(pendingMessage!.id);
    expect(reply.to).toBe("coordinator");
    expect(reply.interactionStatus).toBe("answered");
    expect(restoredSystem.getDialogHistory()[0]?.interactionStatus).toBe("answered");
  });
});

describe("ActorSystem.spawnTask", () => {
  it("passes inherited images to the spawned actor task", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      lastAssignedImages?: string[];
    };

    const record = system.spawnTask("coordinator", "specialist", "根据设计稿实现页面", {
      images: ["/tmp/design.png"],
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;
    expect(record.images).toEqual(["/tmp/design.png"]);
    expect(specialist.lastAssignedImages).toEqual(["/tmp/design.png"]);
  });

  it("wraps spawned work in a contract-style delegation prompt", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      lastAssignedQuery?: string;
    };

    const record = system.spawnTask("coordinator", "specialist", "修复 Dialog 房间里 Coordinator 仍然 25 步停止的问题", {
      label: "修复 25 步上限",
      context: "只检查 Dialog / Actor 运行时，不要顺手改普通 Agent 路径。",
      attachments: [
        "/repo/src/core/agent/actor/agent-actor.ts",
        "/repo/src/plugins/builtin/SmartAgent/components/actor/ActorChatPanel.tsx",
      ],
      roleBoundary: "executor",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;
    expect(specialist.lastAssignedQuery).toContain("## 任务目标");
    expect(specialist.lastAssignedQuery).toContain("## 任务焦点");
    expect(specialist.lastAssignedQuery).toContain("## 协作方式");
    expect(specialist.lastAssignedQuery).toContain("自行决定执行步骤");
    expect(specialist.lastAssignedQuery).toContain("## 本轮职责边界");
    expect(specialist.lastAssignedQuery).toContain("执行角色");
    expect(specialist.lastAssignedQuery).toContain("## 已知上下文");
    expect(specialist.lastAssignedQuery).toContain("只检查 Dialog / Actor 运行时");
    expect(specialist.lastAssignedQuery).toContain("## 工作集 / 附件文件");
    expect(specialist.lastAssignedQuery).toContain("/repo/src/core/agent/actor/agent-actor.ts");
    expect(specialist.lastAssignedQuery).toContain("## 交付要求");
  });

  it("can create a temporary child agent when the target does not exist", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-1",
      summary: "Coordinator 可创建临时子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask("coordinator", "Independent Reviewer", "独立审查这次 patch 的回归风险", {
      createIfMissing: true,
      createChildSpec: {
        description: "只负责独立审查 patch 的风险和边界条件",
        capabilities: ["code_review", "testing"],
      },
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId);
    expect(child?.role.name).toBe("Independent Reviewer");
    expect(child?.persistent).toBe(false);
    expect(record.roleBoundary).toBe("reviewer");
    expect(system.getActiveExecutionContract()?.participantActorIds).toContain(record.targetActorId);
    expect(system.getActiveExecutionContract()?.allowedSpawnPairs).toContainEqual({
      fromActorId: "coordinator",
      toActorId: record.targetActorId,
    });
    expect(system.getActiveExecutionContract()?.allowedMessagePairs).toContainEqual({
      fromActorId: record.targetActorId,
      toActorId: "coordinator",
    });
  });

  it("derives the legacy dialog plan view from the active contract graph", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract({
      contractId: "contract-dynamic-legacy-view",
      surface: "local_dialog",
      executionStrategy: "coordinator",
      summary: "Coordinator 可创建临时子 Agent",
      coordinatorActorId: "coordinator",
      inputHash: "input-hash",
      actorRosterHash: "roster-hash",
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      plannedDelegations: [],
      approvedAt: 1,
      state: "active",
    });

    const record = system.spawnTask("coordinator", "Independent Reviewer", "独立审查这次 patch 的回归风险", {
      createIfMissing: true,
      createChildSpec: {
        description: "只负责独立审查 patch 的风险和边界条件",
        capabilities: ["code_review", "testing"],
      },
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    expect(system.getActiveExecutionContract()?.participantActorIds).toContain(record.targetActorId);
    expect(system.getDialogExecutionPlan()?.participantActorIds).toContain(record.targetActorId);
    expect(system.snapshot().executionContract?.participantActorIds).toContain(record.targetActorId);
  });

  it("keeps the active contract graph in sync when participants are removed", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    system.spawn(buildActorConfig("specialist", "Specialist"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-remove-specialist",
      approvedAt: Date.now(),
      plannedDelegations: [
        {
          id: "delegation-remove-1",
          targetActorId: "specialist",
          task: "补充验证",
        },
      ],
    }));

    system.kill("specialist");

    expect(system.getActiveExecutionContract()).toMatchObject({
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      plannedDelegations: [],
    });
  });

  it("rejects nested child-agent creation so only the top-level coordinator can keep delegating", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-2",
      summary: "Coordinator -> Fixer -> Tester",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const fixer = system.spawnTask("coordinator", "Fixer", "先修复问题", {
      createIfMissing: true,
      createChildSpec: {
        description: "只负责实施修复",
        capabilities: ["code_write", "debugging"],
      },
      cleanup: "keep",
    });
    expect("error" in fixer).toBe(false);
    if ("error" in fixer) return;

    const tester = system.spawnTask(fixer.targetActorId, "Tester", "为修复结果补充回归验证", {
      createIfMissing: true,
      createChildSpec: {
        description: "只负责验证和回归检查",
        capabilities: ["testing"],
      },
      cleanup: "keep",
    });

    expect("error" in tester).toBe(true);
    if (!("error" in tester)) return;
    expect(tester.error).toContain("只允许顶层协调者创建子线程");

    expect(fixer.parentRunId).toBeUndefined();
    expect(fixer.rootRunId).toBe(fixer.runId);

    expect(system.getDescendantTasks("coordinator").map((task) => ({
      runId: task.runId,
      parentRunId: task.parentRunId,
      depth: task.depth,
    }))).toEqual([
      {
        runId: fixer.runId,
        parentRunId: undefined,
        depth: 1,
      },
    ]);

    expect(system.getDescendantTasks(fixer.targetActorId).map((task) => ({
      runId: task.runId,
      parentRunId: task.parentRunId,
      depth: task.depth,
    }))).toEqual([]);
  });

  it("can abort an open child session by runId and clear focus", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const reviewer = system.spawn(buildActorConfig("reviewer", "Reviewer")) as unknown as {
      assignTask: (query: string, images?: string[]) => Promise<unknown>;
      abort: ReturnType<typeof vi.fn>;
    };

    reviewer.abort = vi.fn();
    reviewer.assignTask = vi.fn(() => new Promise(() => undefined));

    const record = system.spawnTask("coordinator", "reviewer", "继续做实现审查", {
      mode: "session",
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    system.focusSpawnedSession(record.runId);
    system.abortSpawnedTask(record.runId, {
      error: "用户手动中止子会话",
    });

    const aborted = system.getSpawnedTask(record.runId);
    expect(reviewer.abort).toHaveBeenCalledTimes(1);
    expect(aborted?.status).toBe("aborted");
    expect(aborted?.sessionOpen).toBe(false);
    expect(aborted?.error).toBe("用户手动中止子会话");
    expect(system.getFocusedSpawnedSessionRunId()).toBeNull();
  });

  it("applies read-only defaults to reviewer-like temporary child agents", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-reviewer",
      summary: "Coordinator 可创建审查子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask("coordinator", "Independent Reviewer", "独立审查这次 patch", {
      createIfMissing: true,
      createChildSpec: {
        description: "只负责独立审查和边界风险分析",
        capabilities: ["code_review"],
      },
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId);
    expect(record.roleBoundary).toBe("reviewer");
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "write_file",
      "str_replace_edit",
      "json_edit",
      "delete_file",
      "run_shell_command",
      "persistent_shell",
    ]));
    expect(child?.getSystemPromptOverride()).toContain("你当前是独立审查子 Agent");
  });

  it("applies validation defaults while keeping shell access for validator-like child agents", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-validator",
      summary: "Coordinator 可创建验证子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask("coordinator", "QA Validator", "做回归验证", {
      createIfMissing: true,
      createChildSpec: {
        description: "只负责测试、验收和回归验证",
        capabilities: ["testing"],
      },
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId);
    expect(record.roleBoundary).toBe("validator");
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "write_file",
      "str_replace_edit",
      "json_edit",
      "delete_file",
    ]));
    expect(child?.toolPolicyConfig?.deny).not.toContain("run_shell_command");
    expect(child?.toolPolicyConfig?.deny).not.toContain("persistent_shell");
    expect(child?.getSystemPromptOverride()).toContain("你当前是验证子 Agent");
  });

  it("keeps parent restrictions and explicit child overrides when creating executor-like child agents", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator", {
      toolPolicy: {
        deny: ["web_search"],
      },
    }));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-executor",
      summary: "Coordinator 可创建执行子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask("coordinator", "Fixer", "修复这个问题", {
      createIfMissing: true,
      createChildSpec: {
        description: "只负责实现和修复",
        capabilities: ["code_write", "debugging"],
      },
      overrides: {
        toolPolicy: {
          deny: ["database_execute"],
        },
        systemPromptAppend: "优先输出最小改动方案。",
      },
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId);
    expect(record.roleBoundary).toBe("executor");
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "delete_file",
      "native_*",
      "ssh_*",
      "web_search",
      "database_execute",
    ]));
    expect(child?.getSystemPromptOverride()).toContain("你当前是执行子 Agent");
    expect(child?.getSystemPromptOverride()).toContain("优先输出最小改动方案。");
  });

  it("lets explicit roleBoundary override temporary child inference", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-explicit-boundary",
      summary: "Coordinator 显式指定子 Agent 边界",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask("coordinator", "Fixer", "先做验证回归", {
      createIfMissing: true,
      roleBoundary: "validator",
      createChildSpec: {
        description: "名字看起来像修复者，但这次只负责验证",
        capabilities: ["code_write", "debugging"],
      },
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId);
    expect(record.roleBoundary).toBe("validator");
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "write_file",
      "str_replace_edit",
      "json_edit",
      "delete_file",
    ]));
    expect(child?.toolPolicyConfig?.deny).not.toContain("run_shell_command");
    expect(child?.getSystemPromptOverride()).toContain("你当前是验证子 Agent");
  });

  it("inherits planned role boundaries when coordinator dispatches an approved support task", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      lastAssignedQuery?: string;
    };

    system.restoreExecutionContract(buildExecutionContract({
      contractId: "contract-boundary-sync",
      summary: "Coordinator 协调 Specialist 做验证",
      approvedAt: Date.now(),
      plannedDelegations: [
        {
          id: "delegation-1",
          targetActorId: "specialist",
          task: "从验证视角补充实现风险与测试建议。",
          label: "验证支援",
          context: "重点覆盖回归与复现路径。",
          roleBoundary: "validator",
        },
      ],
      state: "active",
    }));

    const record = system.spawnTask("coordinator", "specialist", "补充验证结论", {
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    expect(record.contractId).toBe("contract-boundary-sync");
    expect(record.plannedDelegationId).toBe("delegation-1");
    expect(record.dispatchSource).toBe("contract_suggestion");
    expect(record.roleBoundary).toBe("validator");
    expect(record.label).toBe("验证支援");
    expect(specialist.lastAssignedQuery).toContain("## 本轮职责边界");
    expect(specialist.lastAssignedQuery).toContain("你本轮是验证角色");
    expect(specialist.lastAssignedQuery).toContain("## 已知上下文");
    expect(specialist.lastAssignedQuery).toContain("重点覆盖回归与复现路径");
  });

  it("resolves target linkage from plannedDelegationId when coordinator spawns from the approved contract graph", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    system.spawn(buildActorConfig("specialist", "Specialist"));

    system.armExecutionContract({
      contractId: "contract-delegation-id",
      surface: "local_dialog",
      executionStrategy: "coordinator",
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
          id: "delegation-graph-1",
          targetActorId: "specialist",
          task: "从验证视角补充实现风险与测试建议。",
          label: "验证支援",
          roleBoundary: "validator",
        },
      ],
      approvedAt: 1,
      state: "active",
    });

    const record = system.spawnTask("coordinator", "", "补充验证结论", {
      plannedDelegationId: "delegation-graph-1",
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    expect(record.targetActorId).toBe("specialist");
    expect(record.contractId).toBe("contract-delegation-id");
    expect(record.plannedDelegationId).toBe("delegation-graph-1");
    expect(record.dispatchSource).toBe("contract_suggestion");
    expect(record.roleBoundary).toBe("validator");
  });
});

describe("ActorSystem.send", () => {
  it("does not deliver a bootstrap to the primary actor when direct user delivery activates the plan", async () => {
    const system = new ActorSystem();
    const reviewer = system.spawn(buildActorConfig("reviewer", "Reviewer"));
    const specialist = system.spawn(buildActorConfig("fixer", "Fixer")) as unknown as {
      lastAssignedQuery?: string;
    };

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-smart-1",
      executionStrategy: "smart",
      summary: "Reviewer 主接手并协调 Fixer",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["reviewer"],
      participantActorIds: ["reviewer", "fixer"],
      coordinatorActorId: "reviewer",
      allowedMessagePairs: [
        { fromActorId: "reviewer", toActorId: "fixer" },
        { fromActorId: "fixer", toActorId: "reviewer" },
      ],
      allowedSpawnPairs: [
        { fromActorId: "reviewer", toActorId: "fixer" },
      ],
      plannedDelegations: [
        {
          id: "delegation-1",
          targetActorId: "fixer",
          task: "给出最小修复方案与验证建议。",
          label: "修复支援",
        },
      ],
    }));

    system.send("user", "reviewer", "帮我 review 这次改动");

    expect(reviewer.pendingInboxCount).toBe(1);
    expect(specialist.lastAssignedQuery).toBeUndefined();
  });
});

describe("ActorSystem dialog recall metadata", () => {
  it("attaches shareable image and exported file artifacts to agent results", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator", {
      workspace: "/repo/project",
    }));

    system.recordArtifact({
      actorId: "coordinator",
      path: "/tmp/final-shot.png",
      source: "tool_write",
      toolName: "write_file",
      summary: "生成截图",
      timestamp: 1000,
    });
    system.recordArtifact({
      actorId: "coordinator",
      path: "/Users/demo/Downloads/report.xlsx",
      source: "tool_write",
      toolName: "write_file",
      summary: "导出报表",
      timestamp: 1001,
    });
    system.recordArtifact({
      actorId: "coordinator",
      path: "/repo/project/src/app.tsx",
      source: "tool_edit",
      toolName: "str_replace_edit",
      summary: "修改项目源码",
      timestamp: 1002,
    });

    const msg = system.publishResult("coordinator", "已生成截图和导出文件。");

    expect(msg?.images).toEqual(["/tmp/final-shot.png"]);
    expect(msg?.attachments).toEqual([
      { path: "/Users/demo/Downloads/report.xlsx", fileName: "report.xlsx" },
    ]);
  });

  it("does not echo uploaded files back as result media", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator", {
      workspace: "/repo/project",
    }));

    system.recordArtifact({
      actorId: "coordinator",
      path: "/tmp/user-upload.png",
      source: "upload",
      summary: "用户上传了图片：user-upload.png",
      timestamp: 1000,
    });

    const msg = system.publishResult("coordinator", "我已经看过你发来的图片。");

    expect(msg?.images).toBeUndefined();
    expect(msg?.attachments).toBeUndefined();
  });

  it("attaches recall metadata to agent result messages", () => {
    const system = new ActorSystem();
    const coordinator = system.spawn(buildActorConfig("coordinator", "Coordinator")) as unknown as {
      lastMemoryRecallAttempted: boolean;
      lastMemoryRecallPreview: string[];
      lastTranscriptRecallAttempted: boolean;
      lastTranscriptRecallHitCount: number;
      lastTranscriptRecallPreview: string[];
    };

    coordinator.lastMemoryRecallAttempted = true;
    coordinator.lastMemoryRecallPreview = ["默认中文回答", "常驻上海"];
    coordinator.lastTranscriptRecallAttempted = true;
    coordinator.lastTranscriptRecallHitCount = 1;
    coordinator.lastTranscriptRecallPreview = ["Dialog：继续完善设置页"];

    const msg = system.publishResult("coordinator", "已经完成设置页优化");

    expect(msg?.memoryRecallAttempted).toBe(true);
    expect(msg?.appliedMemoryPreview).toEqual(["默认中文回答", "常驻上海"]);
    expect(msg?.transcriptRecallAttempted).toBe(true);
    expect(msg?.transcriptRecallHitCount).toBe(1);
    expect(msg?.appliedTranscriptPreview).toEqual(["Dialog：继续完善设置页"]);
  });

  it("attaches recall metadata to agent-to-agent messages", () => {
    const system = new ActorSystem();
    const coordinator = system.spawn(buildActorConfig("coordinator", "Coordinator")) as unknown as {
      lastMemoryRecallAttempted: boolean;
      lastMemoryRecallPreview: string[];
      lastTranscriptRecallAttempted: boolean;
      lastTranscriptRecallHitCount: number;
      lastTranscriptRecallPreview: string[];
    };
    system.spawn(buildActorConfig("specialist", "Specialist"));

    coordinator.lastMemoryRecallAttempted = true;
    coordinator.lastMemoryRecallPreview = ["默认输出结论优先"];
    coordinator.lastTranscriptRecallAttempted = true;
    coordinator.lastTranscriptRecallHitCount = 2;
    coordinator.lastTranscriptRecallPreview = ["Agent：继续处理页面布局", "Ask：之前确认过配色"];

    const msg = system.send("coordinator", "specialist", "继续补齐页面样式");

    expect(msg.memoryRecallAttempted).toBe(true);
    expect(msg.appliedMemoryPreview).toEqual(["默认输出结论优先"]);
    expect(msg.transcriptRecallAttempted).toBe(true);
    expect(msg.transcriptRecallHitCount).toBe(2);
    expect(msg.appliedTranscriptPreview).toEqual([
      "Agent：继续处理页面布局",
      "Ask：之前确认过配色",
    ]);
  });
});
