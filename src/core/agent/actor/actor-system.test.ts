import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ActorConfig, ToolPolicy } from "./types";

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
    private toolPolicy?: ToolPolicy;
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
      this.toolPolicy = config.toolPolicy;
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
      return undefined;
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

  it("delivers a coordinator bootstrap instead of auto-spawning planned tasks", async () => {
    const system = new ActorSystem();
    const coordinator = system.spawn(buildActorConfig("coordinator", "Coordinator"));
    const specialist = system.spawn(buildActorConfig("specialist", "Specialist")) as unknown as {
      lastAssignedQuery?: string;
    };

    system.armDialogExecutionPlan({
      id: "plan-1",
      routingMode: "coordinator",
      summary: "Coordinator 协调 Specialist",
      approvedAt: Date.now(),
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
          id: "spawn-1",
          targetActorId: "specialist",
          task: "从验证视角补充实现风险与测试建议。",
          label: "验证支援",
        },
      ],
      state: "armed",
    });

    const msg = system.broadcastAndResolve("user", "请继续完善这个实现");

    expect(msg.content).toBe("请继续完善这个实现");
    expect(coordinator.pendingInboxCount).toBe(2);
    expect(specialist.lastAssignedQuery).toBeUndefined();
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

    system.armDialogExecutionPlan({
      id: "plan-dynamic-1",
      routingMode: "coordinator",
      summary: "Coordinator 可创建临时子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      coordinatorActorId: "coordinator",
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      state: "armed",
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

    const child = system.get(record.targetActorId);
    expect(child?.role.name).toBe("Independent Reviewer");
    expect(child?.persistent).toBe(false);
    expect(record.roleBoundary).toBe("reviewer");
    expect(system.getDialogExecutionPlan()?.participantActorIds).toContain(record.targetActorId);
    expect(system.getDialogExecutionPlan()?.allowedSpawnPairs).toContainEqual({
      fromActorId: "coordinator",
      toActorId: record.targetActorId,
    });
    expect(system.getDialogExecutionPlan()?.allowedMessagePairs).toContainEqual({
      fromActorId: record.targetActorId,
      toActorId: "coordinator",
    });
  });

  it("supports nested child-agent creation while keeping the hierarchy scoped", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armDialogExecutionPlan({
      id: "plan-dynamic-2",
      routingMode: "coordinator",
      summary: "Coordinator -> Fixer -> Tester",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      coordinatorActorId: "coordinator",
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      state: "armed",
    });

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

    expect("error" in tester).toBe(false);
    if ("error" in tester) return;

    expect(fixer.parentRunId).toBeUndefined();
    expect(fixer.rootRunId).toBe(fixer.runId);
    expect(tester.parentRunId).toBe(fixer.runId);
    expect(tester.rootRunId).toBe(fixer.runId);

    expect(system.getDialogExecutionPlan()?.allowedSpawnPairs).toContainEqual({
      fromActorId: fixer.targetActorId,
      toActorId: tester.targetActorId,
    });
    expect(system.getDialogExecutionPlan()?.allowedMessagePairs).toContainEqual({
      fromActorId: tester.targetActorId,
      toActorId: fixer.targetActorId,
    });

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
      {
        runId: tester.runId,
        parentRunId: fixer.runId,
        depth: 2,
      },
    ]);

    expect(system.getDescendantTasks(fixer.targetActorId).map((task) => ({
      runId: task.runId,
      parentRunId: task.parentRunId,
      depth: task.depth,
    }))).toEqual([
      {
        runId: tester.runId,
        parentRunId: fixer.runId,
        depth: 1,
      },
    ]);
  });

  it("applies read-only defaults to reviewer-like temporary child agents", () => {
    const system = new ActorSystem();
    system.spawn(buildActorConfig("coordinator", "Coordinator"));

    system.armDialogExecutionPlan({
      id: "plan-dynamic-reviewer",
      routingMode: "coordinator",
      summary: "Coordinator 可创建审查子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      coordinatorActorId: "coordinator",
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      state: "armed",
    });

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

    system.armDialogExecutionPlan({
      id: "plan-dynamic-validator",
      routingMode: "coordinator",
      summary: "Coordinator 可创建验证子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      coordinatorActorId: "coordinator",
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      state: "armed",
    });

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

    system.armDialogExecutionPlan({
      id: "plan-dynamic-executor",
      routingMode: "coordinator",
      summary: "Coordinator 可创建执行子 Agent",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      coordinatorActorId: "coordinator",
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      state: "armed",
    });

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

    system.armDialogExecutionPlan({
      id: "plan-dynamic-explicit-boundary",
      routingMode: "coordinator",
      summary: "Coordinator 显式指定子 Agent 边界",
      approvedAt: Date.now(),
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      coordinatorActorId: "coordinator",
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      state: "armed",
    });

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

    system.armDialogExecutionPlan({
      id: "plan-boundary-sync",
      routingMode: "coordinator",
      summary: "Coordinator 协调 Specialist 做验证",
      approvedAt: Date.now(),
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
          id: "spawn-1",
          targetActorId: "specialist",
          task: "从验证视角补充实现风险与测试建议。",
          label: "验证支援",
          context: "重点覆盖回归与复现路径。",
          roleBoundary: "validator",
        },
      ],
      state: "active",
    });

    const record = system.spawnTask("coordinator", "specialist", "补充验证结论", {
      cleanup: "keep",
    });

    expect("error" in record).toBe(false);
    if ("error" in record) return;

    expect(record.roleBoundary).toBe("validator");
    expect(record.label).toBe("验证支援");
    expect(specialist.lastAssignedQuery).toContain("## 本轮职责边界");
    expect(specialist.lastAssignedQuery).toContain("你本轮是验证角色");
    expect(specialist.lastAssignedQuery).toContain("## 已知上下文");
    expect(specialist.lastAssignedQuery).toContain("重点覆盖回归与复现路径");
  });
});

describe("ActorSystem.send", () => {
  it("delivers a bootstrap to the primary actor when direct user delivery activates the plan", async () => {
    const system = new ActorSystem();
    const reviewer = system.spawn(buildActorConfig("reviewer", "Reviewer"));
    const specialist = system.spawn(buildActorConfig("fixer", "Fixer")) as unknown as {
      lastAssignedQuery?: string;
    };

    system.armDialogExecutionPlan({
      id: "plan-smart-1",
      routingMode: "smart",
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
      plannedSpawns: [
        {
          id: "spawn-1",
          targetActorId: "fixer",
          task: "给出最小修复方案与验证建议。",
          label: "修复支援",
        },
      ],
      state: "armed",
    });

    system.send("user", "reviewer", "帮我 review 这次改动");

    expect(reviewer.pendingInboxCount).toBe(2);
    expect(specialist.lastAssignedQuery).toBeUndefined();
  });
});

describe("ActorSystem dialog recall metadata", () => {
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
