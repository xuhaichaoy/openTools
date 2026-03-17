import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ActorConfig } from "./types";

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
    private _status = "idle";
    private inbox: unknown[] = [];
    lastAssignedQuery?: string;
    lastAssignedImages?: string[];

    constructor(config: ActorConfig) {
      this.id = config.id;
      this.role = config.role;
      this.persistent = config.persistent !== false;
      this.modelOverride = config.modelOverride;
      this.capabilities = config.capabilities;
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
      return undefined;
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
      return undefined;
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

function buildActorConfig(id: string, name: string): ActorConfig {
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
});
