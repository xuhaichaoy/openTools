import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ActorConfig, DialogExecutionMode, ExecutionPolicy, ToolPolicy } from "./types";
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
    private dialogExecutionModeValue: DialogExecutionMode = "execute";
    private systemPromptOverride?: string;
    private timeoutSecondsValue?: number;
    private idleLeaseSecondsValue?: number;
    private _status = "idle";
    private inbox: unknown[] = [];
    private handlers: Array<(event: { type: string; actorId: string; timestamp: number; detail?: unknown }) => void> = [];
    lastAssignedQuery?: string;
    lastAssignedImages?: string[];
    lastAssignOptions?: { publishResult?: boolean; runOverrides?: Record<string, unknown> };
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
      this.timeoutSecondsValue = config.timeoutSeconds;
      this.idleLeaseSecondsValue = config.idleLeaseSeconds;
    }

    on(handler: (event: { type: string; actorId: string; timestamp: number; detail?: unknown }) => void) {
      this.handlers.push(handler);
      return () => {
        this.handlers = this.handlers.filter((item) => item !== handler);
      };
    }

    emitEvent(type: string, detail?: unknown) {
      const event = {
        type,
        actorId: this.id,
        timestamp: Date.now(),
        detail,
      };
      this.handlers.forEach((handler) => handler(event));
    }

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

    get dialogExecutionMode() {
      return this.dialogExecutionModeValue;
    }

    get timeoutSeconds() {
      return this.timeoutSecondsValue;
    }

    get idleLeaseSeconds() {
      return this.idleLeaseSecondsValue;
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

    assignTask(query: string, images?: string[], opts?: { publishResult?: boolean; runOverrides?: Record<string, unknown> }) {
      this.lastAssignedQuery = query;
      this.lastAssignedImages = images;
      this.lastAssignOptions = opts;
      this._status = "running";
      this.emitEvent("task_started", { taskId: "task-1", query });
      return Promise.resolve({
        id: "task-1",
        query,
        status: "completed" as const,
        result: "ok",
        steps: [],
        startedAt: Date.now(),
        finishedAt: Date.now(),
      }).then((result) => {
        this._status = "idle";
        this.emitEvent("task_completed", { taskId: result.id, result: result.result });
        return result;
      });
    }

    abort() {
      this._status = "idle";
    }

    setDialogExecutionMode(mode: DialogExecutionMode) {
      this.dialogExecutionModeValue = mode;
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
    accepted: true,
    requiresConcreteOutput: false,
  })),
}));

let ActorSystem: typeof import("./actor-system").ActorSystem;

afterEach(() => {
  vi.useRealTimers();
});

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

describe("ActorSystem dialog execution mode", () => {
  it("applies plan mode to existing actors and newly spawned actors", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("lead", "Lead"));

    system.setDialogExecutionMode("plan");

    expect(system.getDialogExecutionMode()).toBe("plan");
    expect(system.get("lead")?.dialogExecutionMode).toBe("plan");

    system.spawn(buildActorConfig("reviewer", "Reviewer"));
    expect(system.get("reviewer")?.dialogExecutionMode).toBe("plan");

    system.setDialogExecutionMode("execute");
    expect(system.get("lead")?.dialogExecutionMode).toBe("execute");
    expect(system.get("reviewer")?.dialogExecutionMode).toBe("execute");
  });

  it("keeps dialog subagent mode independent from plan mode", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("lead", "Lead"));

    expect(system.getDialogSubagentEnabled()).toBe(false);

    system.setDialogSubagentEnabled(true);
    system.setDialogExecutionMode("plan");

    expect(system.getDialogSubagentEnabled()).toBe(true);
    expect(system.getDialogExecutionMode()).toBe("plan");

    system.setDialogExecutionMode("execute");
    system.setDialogSubagentEnabled(false);

    expect(system.getDialogExecutionMode()).toBe("execute");
    expect(system.getDialogSubagentEnabled()).toBe(false);
  });
});

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

describe("ActorSystem coordinator cleanup", () => {
  it("removes idle support actors after the coordinator completes the main task", async () => {
    const system = new ActorSystem();
    const coordinator = system.spawn(buildActorConfig("coordinator", "Coordinator")) as unknown as {
      emitEvent: (type: string, detail?: unknown) => void;
    };
    system.spawn(buildActorConfig("specialist-a", "Specialist A"));
    system.spawn(buildActorConfig("specialist-b", "Specialist B"));

    coordinator.emitEvent("task_completed", {
      taskId: "task-main",
      result: "最终结果已输出",
      elapsed: 1234,
    });

    await Promise.resolve();

    expect(system.get("coordinator")).toBeDefined();
    expect(system.get("specialist-a")).toBeUndefined();
    expect(system.get("specialist-b")).toBeUndefined();
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
    expect(record.runtime).toEqual(expect.objectContaining({
      subtaskId: record.runId,
      profile: "general",
      startedAt: record.spawnedAt,
      timeoutSeconds: 420,
      eventCount: 1,
    }));
  });

  it("passes the effective worker timeout policy down into the per-run overrides", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist", {
      timeoutSeconds: 240,
    })) as unknown as {
      lastAssignOptions?: { runOverrides?: Record<string, unknown> };
    };

    const record = system.spawnTask("coordinator", "specialist", "长任务", {
      timeoutSeconds: 420,
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;
    expect(specialist.lastAssignOptions?.runOverrides).toMatchObject({
      timeoutSeconds: 420,
      idleLeaseSeconds: 120,
    });
  });

  it("does not let create_if_missing workers shrink below the default budget", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    const record = system.spawnTask("coordinator", "course-designer-1", "生成课程名称与课程介绍", {
      createIfMissing: true,
      timeoutSeconds: 300,
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const worker = system.get(record.targetActorId) as unknown as {
      timeoutSeconds?: number;
      lastAssignOptions?: { runOverrides?: Record<string, unknown> };
    };

    expect(record.budgetSeconds).toBe(420);
    expect(worker.timeoutSeconds).toBe(420);
    expect(worker.lastAssignOptions?.runOverrides).toMatchObject({
      timeoutSeconds: 420,
      idleLeaseSeconds: 120,
    });
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

  it("falls back to the label when create_if_missing omits a target name", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-label-fallback",
      summary: "Coordinator 可按标签创建临时子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask("coordinator", "", "基于技术方向主题生成课程名称和课程介绍", {
      label: "技术方向课程生成",
      createIfMissing: true,
      createChildSpec: {
        description: "负责技术方向课程内容整理",
        capabilities: ["documentation"],
      },
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId);
    expect(child?.role.name).toBe("技术方向课程生成");
    expect(record.label).toBe("技术方向课程生成");
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
    const lifecycleEvents: Array<{ type: string; detail?: unknown }> = [];
    system.onEvent((event) => {
      if ("type" in event) {
        lifecycleEvents.push(event as { type: string; detail?: unknown });
      }
    });
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
    expect(aborted?.sessionClosedAt).toBeTypeOf("number");
    expect(aborted?.runtime).toEqual(expect.objectContaining({
      subtaskId: record.runId,
      terminalError: "用户手动中止子会话",
      completedAt: aborted?.completedAt,
    }));
    expect(system.getFocusedSpawnedSessionRunId()).toBeNull();
    expect(lifecycleEvents.find((event) => event.type === "spawned_task_failed")).toMatchObject({
      detail: expect.objectContaining({
        runId: record.runId,
        subtaskId: record.runId,
        terminalError: "用户手动中止子会话",
      }),
    });
  });

  it("aborts only active run children when the parent task exits abnormally", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const runner = system.spawn(buildActorConfig("runner", "Runner")) as unknown as {
      assignTask: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
    };
    const reviewer = system.spawn(buildActorConfig("reviewer", "Reviewer")) as unknown as {
      assignTask: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
    };

    runner.abort = vi.fn();
    reviewer.abort = vi.fn();
    runner.assignTask = vi.fn(() => new Promise(() => undefined));
    reviewer.assignTask = vi.fn(() => new Promise(() => undefined));

    const runRecord = system.spawnTask("coordinator", "runner", "执行实现", {
      cleanup: "keep",
    });
    const sessionRecord = system.spawnTask("coordinator", "reviewer", "保持审查会话", {
      mode: "session",
      cleanup: "keep",
    });

    expect("error" in runRecord).toBe(false);
    expect("error" in sessionRecord).toBe(false);
    if ("error" in runRecord || "error" in sessionRecord) return;

    const abortedCount = system.abortActiveRunSpawnedTasks("coordinator", "Lead timeout");

    expect(abortedCount).toBe(1);
    expect(runner.abort).toHaveBeenCalledTimes(1);
    expect(reviewer.abort).not.toHaveBeenCalled();
    expect(system.getSpawnedTask(runRecord.runId)?.status).toBe("aborted");
    expect(system.getSpawnedTask(sessionRecord.runId)?.status).toBe("running");
    expect(system.getSpawnedTask(sessionRecord.runId)?.sessionOpen).toBe(true);
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
    expect(record.runtime?.profile).toBe("reviewer");
    expect(child?.toolPolicyConfig?.allow).toEqual(expect.arrayContaining([
      "task_done",
      "list_*",
      "read_*",
      "search_*",
    ]));
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
    expect(record.runtime?.profile).toBe("validator");
    expect(child?.toolPolicyConfig?.allow).toEqual(expect.arrayContaining([
      "task_done",
      "run_shell_command",
      "persistent_shell",
    ]));
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
    expect(record.executionIntent).toBe("coding_executor");
    expect(record.runtime?.profile).toBe("executor");
    expect(child?.toolPolicyConfig?.allow).toEqual(expect.arrayContaining([
      "task_done",
      "write_file",
      "str_replace_edit",
      "json_edit",
      "run_shell_command",
    ]));
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "delegate_subtask",
      "wait_for_spawned_tasks",
      "send_message",
      "agents",
      "ask_user",
      "ask_clarification",
      "send_local_media",
      "enter_plan_mode",
      "exit_plan_mode",
      "memory_*",
      "delete_file",
      "native_*",
      "ssh_*",
      "database_execute",
    ]));
    expect(child?.getSystemPromptOverride()).toContain("你当前是执行子 Agent");
    expect(child?.getSystemPromptOverride()).toContain("优先输出最小改动方案。");
  });

  it("keeps non-coding executor children inline-only by disabling write and shell tools", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-executor-inline",
      summary: "Coordinator 可创建执行子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask("coordinator", "Course Writer", "整理这批课程并直接返回最终课程清单，输出保存到 /Users/demo/Downloads/课程候选A_重跑.json", {
      createIfMissing: true,
      roleBoundary: "executor",
      createChildSpec: {
        description: "只负责执行内容整理",
        capabilities: ["documentation"],
      },
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId) as unknown as {
      toolPolicyConfig?: { deny?: string[] };
      lastAssignedQuery?: string;
    };
    expect(record.roleBoundary).toBe("executor");
    expect(record.executionIntent).toBe("content_executor");
    expect(child?.toolPolicyConfig?.allow).toEqual(expect.arrayContaining([
      "task_done",
      "read_document",
      "calculate",
    ]));
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "delegate_subtask",
      "wait_for_spawned_tasks",
      "send_message",
      "agents",
      "ask_user",
      "ask_clarification",
      "memory_*",
      "list_*",
      "search_*",
      "web_search",
      "read_file",
      "read_file_range",
      "write_file",
      "str_replace_edit",
      "json_edit",
      "export_spreadsheet",
      "run_shell_command",
      "persistent_shell",
    ]));
    expect(child?.toolPolicyConfig?.allow).not.toContain("export_spreadsheet");
    expect(child?.lastAssignedQuery).toContain("不要写入任何中间 JSON / 临时文件");
    expect(child?.lastAssignedQuery).toContain("先给完整结果，再在末尾补一行简短摘要");
    expect(child?.lastAssignedQuery).not.toContain("/Users/demo/Downloads/课程候选A_重跑.json");
  });

  it("still treats course-generation tasks as inline-only even when they mention 开发和测试", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-executor-course-content",
      summary: "Coordinator 可创建执行子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask(
      "coordinator",
      "Course Writer",
      "读取 Excel，围绕应用开发、安全、运维、测试方向生成课程候选 JSON，保存到 /Users/demo/Downloads/课程候选A_本轮.json 并返回摘要。",
      {
        createIfMissing: true,
        roleBoundary: "executor",
        createChildSpec: {
          description: "只负责课程内容整理",
          capabilities: ["documentation"],
        },
        cleanup: "keep",
      },
    );

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId) as unknown as {
      toolPolicyConfig?: { deny?: string[] };
      lastAssignedQuery?: string;
    };
    expect(record.executionIntent).toBe("content_executor");
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "list_*",
      "search_*",
      "web_search",
      "read_file",
      "read_file_range",
      "write_file",
      "str_replace_edit",
      "json_edit",
      "run_shell_command",
      "persistent_shell",
    ]));
    expect(child?.lastAssignedQuery).toContain("不要写入任何中间 JSON / 临时文件");
    expect(child?.lastAssignedQuery).toContain("先给完整结果，再在末尾补一行简短摘要");
    expect(child?.lastAssignedQuery).not.toContain("/Users/demo/Downloads/课程候选A_本轮.json");
  });

  it("promotes spreadsheet content subtasks from general to strict executor defaults", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-dynamic-executor-auto-promote",
      summary: "Coordinator 可创建内容执行子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask(
      "coordinator",
      "Course Planner",
      "读取 Excel 并生成课程候选清单，最终给我一个 excel 文件，先直接返回结构化课程结果，不要写中间文件。",
      {
        createIfMissing: true,
        createChildSpec: {
          description: "负责课程内容整理",
          capabilities: ["documentation"],
        },
        cleanup: "keep",
      },
    );

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId) as unknown as {
      toolPolicyConfig?: { deny?: string[] };
      getSystemPromptOverride?: () => string | undefined;
    };
    expect(record.roleBoundary).toBe("executor");
    expect(record.executionIntent).toBe("content_executor");
    expect(record.runtime?.profile).toBe("executor");
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "list_*",
      "search_*",
      "read_file",
      "read_file_range",
      "write_file",
      "str_replace_edit",
      "json_edit",
      "export_spreadsheet",
    ]));
    expect(child?.getSystemPromptOverride?.()).toContain("默认直接在 terminal result 返回完整结果");
    expect(child?.getSystemPromptOverride?.()).not.toContain("必须通过 `write_file` 或 `export_spreadsheet` 工具实际写入文件");
  });

  it("locks inline-structured content executors away from rereading the source document", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-sheet-bound-content-executor",
      summary: "Coordinator 可创建受限的 sheet-bound content executor",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask(
      "coordinator",
      "Course Planner",
      "围绕以下主题，为「技术方向课程」工作表生成课程候选，直接返回结构化结果。",
      {
        createIfMissing: true,
        createChildSpec: {
          description: "负责技术方向课程生成",
          capabilities: ["documentation"],
        },
        cleanup: "keep",
        overrides: {
          executionIntent: "content_executor",
          resultContract: "inline_structured_result",
          deliveryTargetLabel: "技术方向课程",
          sheetName: "技术方向课程",
        },
      },
    );

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId) as unknown as {
      toolPolicyConfig?: { allow?: string[]; deny?: string[] };
    };
    expect(record.executionIntent).toBe("content_executor");
    expect(record.resultContract).toBe("inline_structured_result");
    expect(record.deliveryTargetLabel).toBe("技术方向课程");
    expect(record.sheetName).toBe("技术方向课程");
    expect(child?.toolPolicyConfig?.allow).toEqual(["task_done", "read_document", "read_file_range"]);
    expect(child?.toolPolicyConfig?.deny).toEqual(expect.arrayContaining([
      "read_file",
      "write_file",
      "export_spreadsheet",
    ]));
  });

  it("passes scoped source shards directly into child prompts and records", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract(buildExecutionContract({
      contractId: "contract-sheet-bound-source-shard",
      summary: "Coordinator 可创建带 scoped source shard 的内容执行子任务",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
    }));

    const record = system.spawnTask(
      "coordinator",
      "Course Planner",
      "围绕以下主题，为「技术方向课程」工作表生成课程候选，直接返回结构化结果。",
      {
        createIfMissing: true,
        createChildSpec: {
          description: "负责技术方向课程生成",
          capabilities: ["documentation"],
        },
        cleanup: "keep",
        overrides: {
          executionIntent: "content_executor",
          resultContract: "inline_structured_result",
          deliveryTargetLabel: "技术方向课程",
          sheetName: "技术方向课程",
          scopedSourceItems: [
            {
              id: "source-item-7",
              label: "银行AI解决方案咨询方法论",
              order: 7,
              topicIndex: 7,
              topicTitle: "银行AI解决方案咨询方法论",
              trainingAudience: "咨询顾问",
            },
            {
              id: "source-item-8",
              label: "数据分析与经营洞察实战",
              order: 8,
              topicIndex: 8,
              topicTitle: "数据分析与经营洞察实战",
              trainingTarget: "提升数据洞察能力",
            },
          ],
        },
      },
    );

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    const child = system.get(record.targetActorId) as unknown as {
      lastAssignedQuery?: string;
      getSystemPromptOverride?: () => string | undefined;
    };

    expect(record.scopedSourceItems).toEqual([
      expect.objectContaining({ id: "source-item-7", topicTitle: "银行AI解决方案咨询方法论" }),
      expect.objectContaining({ id: "source-item-8", topicTitle: "数据分析与经营洞察实战" }),
    ]);
    expect(child?.lastAssignedQuery).toContain("## 当前分片真相（系统下传）");
    expect(child?.lastAssignedQuery).toContain("source-item-7");
    expect(child?.lastAssignedQuery).toContain("银行AI解决方案咨询方法论");
    expect(child?.lastAssignedQuery).toContain("提升数据洞察能力");
    expect(child?.getSystemPromptOverride?.()).toContain("当前已随派工下传 2 个 scoped source items");
    expect((child as unknown as { toolPolicyConfig?: { deny?: string[] } })?.toolPolicyConfig?.deny).toEqual(
      expect.arrayContaining(["read_document", "read_file", "read_file_range"]),
    );
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

  it("inherits structured delivery overrides from planned delegations", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armExecutionContract({
      contractId: "contract-structured-delegation",
      surface: "local_dialog",
      executionStrategy: "coordinator",
      summary: "Coordinator 协调结构化内容子任务",
      coordinatorActorId: "coordinator",
      inputHash: "input-hash",
      actorRosterHash: "roster-hash",
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      plannedDelegations: [
        {
          id: "delegation-structured-1",
          targetActorId: "delivery-target-tech",
          targetActorName: "技术方向课程生成",
          task: "围绕以下主题生成技术方向课程候选。",
          label: "技术方向课程生成",
          roleBoundary: "executor",
          createIfMissing: true,
          overrides: {
            workerProfileId: "spreadsheet_worker",
            executionIntent: "content_executor",
            resultContract: "inline_structured_result",
            deliveryTargetId: "tech-sheet",
            deliveryTargetLabel: "技术方向课程",
            sheetName: "技术方向课程",
          },
        },
      ],
      approvedAt: 1,
      state: "active",
    });

    const record = system.spawnTask("coordinator", "", "", {
      plannedDelegationId: "delegation-structured-1",
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    expect(record.plannedDelegationId).toBe("delegation-structured-1");
    expect(record.workerProfileId).toBe("spreadsheet_worker");
    expect(record.executionIntent).toBe("content_executor");
    expect(record.resultContract).toBe("inline_structured_result");
    expect(record.deliveryTargetId).toBe("tech-sheet");
    expect(record.deliveryTargetLabel).toBe("技术方向课程");
    expect(record.sheetName).toBe("技术方向课程");
  });

  it("queues retryable max-active-children spawn failures for deferred spreadsheet repair dispatch", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const workers = ["worker-1", "worker-2", "worker-3", "worker-4", "worker-5"]
      .map((id, index) => system.spawn(buildActorConfig(id, `Worker ${index + 1}`)));

    workers.forEach((worker, index) => {
      const record = system.spawnTask("coordinator", worker.id, `先跑第 ${index + 1} 批任务`, { cleanup: "keep" });
      expect("error" in record).toBe(false);
    });

    const queued = system.enqueueDeferredSpawnTask("coordinator", "repair-worker", "补齐缺失主题", {
      cleanup: "keep",
      roleBoundary: "executor",
      overrides: {
        workerProfileId: "spreadsheet_worker",
        resultContract: "inline_structured_result",
      },
    });

    expect(queued.overrides?.workerProfileId).toBe("spreadsheet_worker");
    expect(queued.overrides?.resultContract).toBe("inline_structured_result");
  });

  it("dispatches deferred child tasks after earlier workers settle", async () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    const finishByWorker = new Map<string, () => void>();
    const workers = ["worker-1", "worker-2", "worker-3", "worker-4", "worker-5", "worker-6"]
      .map((id, index) => {
        const actor = system.spawn(buildActorConfig(id, `Worker ${index + 1}`)) as unknown as {
          assignTask: ReturnType<typeof vi.fn>;
          emitEvent: (type: string, detail?: unknown) => void;
          lastAssignedQuery?: string;
          _status?: string;
        };
        actor.assignTask = vi.fn((query: string) => {
          actor.lastAssignedQuery = query;
          actor._status = "running";
          actor.emitEvent("task_started", { taskId: `task-${id}`, query });
          return new Promise((resolve) => {
            finishByWorker.set(id, () => {
              actor._status = "idle";
              const result = {
                id: `task-${id}`,
                query,
                status: "completed" as const,
                result: `done-${id}`,
                steps: [],
                startedAt: Date.now(),
                finishedAt: Date.now(),
              };
              actor.emitEvent("task_completed", { taskId: result.id, result: result.result });
              resolve(result);
            });
          });
        });
        return actor;
      });

    const initialRuns = workers.slice(0, 3).map((worker, index) =>
      system.spawnTask("coordinator", worker.id, `先跑第 ${index + 1} 批任务`, { cleanup: "keep" }),
    );

    initialRuns.forEach((record) => expect("error" in record).toBe(false));
    expect(system.getActiveSpawnedTasks("coordinator")).toHaveLength(3);

    workers.slice(3).forEach((worker, index) => {
      system.enqueueDeferredSpawnTask("coordinator", worker.id, `排队的第 ${index + 4} 批任务`, {
        cleanup: "keep",
        roleBoundary: "executor",
      });
    });

    expect(system.getPendingDeferredSpawnTaskCount("coordinator")).toBe(3);

    finishByWorker.get("worker-1")?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(system.getPendingDeferredSpawnTaskCount("coordinator")).toBe(2);
    expect(system.getActiveSpawnedTasks("coordinator")).toHaveLength(3);
    expect(workers[3].lastAssignedQuery).toContain("排队的第 4 批任务");

    finishByWorker.get("worker-2")?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(system.getPendingDeferredSpawnTaskCount("coordinator")).toBe(1);
    expect(workers[4].lastAssignedQuery).toContain("排队的第 5 批任务");

    finishByWorker.get("worker-3")?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(system.getPendingDeferredSpawnTaskCount("coordinator")).toBe(0);
    expect(workers[5].lastAssignedQuery).toContain("排队的第 6 批任务");
  });

  it("keeps a worker alive past the old idle cutoff while progress continues", () => {
    vi.useFakeTimers();
    const system = new ActorSystem();
    const lifecycleEvents: Array<{ type: string; detail?: unknown }> = [];
    system.onEvent((event) => {
      if ("type" in event) {
        lifecycleEvents.push(event as { type: string; detail?: unknown });
      }
    });
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      assignTask: ReturnType<typeof vi.fn>;
      emitEvent: (type: string, detail?: unknown) => void;
    };

    specialist.assignTask = vi.fn(() => new Promise(() => undefined));

    const record = system.spawnTask("coordinator", "specialist", "长时间整理实现方案", {
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    vi.advanceTimersByTime(100_000);
    specialist.emitEvent("step", {
      step: {
        type: "thinking",
        content: "仍在持续分析范围和依赖",
      },
    });

    vi.advanceTimersByTime(100_000);
    specialist.emitEvent("step", {
      step: {
        type: "action",
        content: "开始整理实施步骤",
      },
    });

    vi.advanceTimersByTime(115_000);

    const updated = system.getSpawnedTask(record.runId);
    expect(updated?.status).toBe("running");
    expect(updated?.runtime).toEqual(expect.objectContaining({
      subtaskId: record.runId,
      profile: "general",
      progressSummary: "开始整理实施步骤",
      eventCount: 3,
    }));
    expect(lifecycleEvents.find((event) => event.type === "spawned_task_started")).toMatchObject({
      detail: expect.objectContaining({
        runId: record.runId,
        subtaskId: record.runId,
        profile: "general",
        timeoutSeconds: 420,
        eventCount: 1,
      }),
    });
    expect(lifecycleEvents.filter((event) => event.type === "spawned_task_running")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detail: expect.objectContaining({
          progressSummary: "正在分析",
          eventCount: 2,
        }),
      }),
      expect.objectContaining({
        detail: expect.objectContaining({
          progressSummary: "开始整理实施步骤",
          eventCount: 3,
        }),
      }),
    ]));

    system.abortSpawnedTask(record.runId, {
      error: "test cleanup",
    });
  });

  it("stores terminal results in runtime when a spawned task completes", async () => {
    const system = new ActorSystem();
    const lifecycleEvents: Array<{ type: string; detail?: unknown }> = [];
    system.onEvent((event) => {
      if ("type" in event) {
        lifecycleEvents.push(event as { type: string; detail?: unknown });
      }
    });
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      assignTask: ReturnType<typeof vi.fn>;
    };

    specialist.assignTask = vi.fn(async () => ({
      status: "completed",
      result: "已修改 /repo/src/core/agent/actor/actor-system.ts，并补充验证结论：spawn_task 已返回结构化 task_id，wait_for_spawned_tasks 已输出结构化任务列表。",
    }));

    const record = system.spawnTask("coordinator", "specialist", "补充验证结论", {
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    await Promise.resolve();
    await Promise.resolve();

    const updated = system.getSpawnedTask(record.runId);
    expect(updated?.status).toBe("completed");
    expect(updated?.runtime).toEqual(expect.objectContaining({
      subtaskId: record.runId,
      profile: "general",
      terminalResult: "已修改 /repo/src/core/agent/actor/actor-system.ts，并补充验证结论：spawn_task 已返回结构化 task_id，wait_for_spawned_tasks 已输出结构化任务列表。",
    }));
    expect(lifecycleEvents.find((event) => event.type === "spawned_task_completed")).toMatchObject({
      detail: expect.objectContaining({
        runId: record.runId,
        subtaskId: record.runId,
        terminalResult: "已修改 /repo/src/core/agent/actor/actor-system.ts，并补充验证结论：spawn_task 已返回结构化 task_id，wait_for_spawned_tasks 已输出结构化任务列表。",
      }),
    });
  });

  it("attaches structured child-result payloads to announce messages", async () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      assignTask: ReturnType<typeof vi.fn>;
    };

    specialist.assignTask = vi.fn(async () => ({
      status: "completed",
      result: "已创建 /Users/demo/Downloads/index.html",
    }));

    const record = system.spawnTask("coordinator", "specialist", "实现页面", {
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    await Promise.resolve();
    await Promise.resolve();

    const announce = system.getMessagesBetween("specialist", "coordinator").at(-1);
    expect(announce?.relatedRunId).toBe(record.runId);
    expect(announce?.spawnedTaskResult).toEqual(expect.objectContaining({
      runId: record.runId,
      subtaskId: record.runId,
      targetActorId: "specialist",
      targetActorName: "Specialist",
      profile: "general",
      status: "completed",
      terminalResult: "已创建 /Users/demo/Downloads/index.html",
    }));
  });

  it("times out a worker as idle when no activity arrives within the lease", () => {
    vi.useFakeTimers();
    const system = new ActorSystem();
    const timeoutEvents: Array<{
      type: string;
      detail?: unknown;
    }> = [];
    system.onEvent((event) => {
      if ("type" in event) {
        timeoutEvents.push(event as { type: string; detail?: unknown });
      }
    });
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      assignTask: ReturnType<typeof vi.fn>;
    };

    specialist.assignTask = vi.fn(() => new Promise(() => undefined));

    const record = system.spawnTask("coordinator", "specialist", "无进展任务", {
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    vi.advanceTimersByTime(125_000);

    const updated = system.getSpawnedTask(record.runId);
    expect(updated?.status).toBe("aborted");
    expect(updated?.timeoutReason).toBe("idle");
    expect(updated?.error).toBe("Idle timeout after 120s");
    expect(timeoutEvents.find((event) => event.type === "spawned_task_timeout")).toMatchObject({
      detail: expect.objectContaining({
        runId: record.runId,
        timeoutReason: "idle",
        budgetSeconds: 420,
        idleLeaseSeconds: 120,
      }),
    });
  });

  it("still aborts a worker when the total budget is exceeded despite progress", () => {
    vi.useFakeTimers();
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      assignTask: ReturnType<typeof vi.fn>;
      emitEvent: (type: string, detail?: unknown) => void;
    };

    specialist.assignTask = vi.fn(() => new Promise(() => undefined));

    const record = system.spawnTask("coordinator", "specialist", "持续推进但超过预算", {
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(100_000);
      specialist.emitEvent("step", {
        step: {
          type: "thinking",
          content: `progress-${i}`,
        },
      });
    }

    vi.advanceTimersByTime(125_000);

    const updated = system.getSpawnedTask(record.runId);
    expect(updated?.status).toBe("aborted");
    expect(updated?.timeoutReason).toBe("budget");
    expect(updated?.error).toBe("Budget exceeded after 420s");
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

  it("attaches explicitly staged media to the next agent result even inside workspace", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator", {
      workspace: "/repo/project",
    }));

    system.stageResultMedia("coordinator", {
      images: ["/repo/project/assets/mockup.png"],
      attachments: [{ path: "/repo/project/output/internal-report.pdf", fileName: "internal-report.pdf" }],
    });

    const msg = system.publishResult("coordinator", "已附上本地图片和文档。");

    expect(msg?.images).toEqual(["/repo/project/assets/mockup.png"]);
    expect(msg?.attachments).toEqual([
      { path: "/repo/project/output/internal-report.pdf", fileName: "internal-report.pdf" },
    ]);
    expect(system.getStagedResultMediaSnapshot("coordinator")).toEqual({});
  });

  it("extracts MEDIA lines into local dialog result media and strips them from text", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator", {
      workspace: "/repo/project",
    }));

    const msg = system.publishResult("coordinator", [
      "已完成，见截图。",
      "MEDIA:/tmp/baidu_today_weather.png",
    ].join("\n"));

    expect(msg?.content).toBe("已完成，见截图。");
    expect(msg?.images).toEqual(["/tmp/baidu_today_weather.png"]);
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
