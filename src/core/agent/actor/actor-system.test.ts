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
