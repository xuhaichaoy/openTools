import { describe, expect, it } from "vitest";

import { AgentBackendRegistry } from "@/core/agent/backends/registry";
import type {
  AgentBackendMessageRequest,
  AgentBackendMessageResult,
  AgentBackendStatus,
  AgentBackendTaskRequest,
  AgentExecutorBackend,
} from "@/core/agent/backends/types";
import { TeamRegistry } from "./team-registry";

class FakeInProcessBackend implements AgentExecutorBackend {
  readonly id = "in_process";
  readonly kind = "in_process" as const;
  readonly label = "Fake In-Process Backend";
  readonly sentMessages: AgentBackendMessageRequest[] = [];

  getStatus(): AgentBackendStatus {
    return { available: true };
  }

  async dispatchTask(_request: AgentBackendTaskRequest) {
    return { error: "not used in this test" };
  }

  async sendMessage(request: AgentBackendMessageRequest): Promise<AgentBackendMessageResult> {
    this.sentMessages.push(request);
    return {
      sent: true,
      backendId: this.id,
      targetId: request.target.actorId ?? request.target.name,
      targetName: request.target.actorName ?? request.target.name,
      messageId: `msg-${this.sentMessages.length}`,
    };
  }
}

class FakeRemoteBackend implements AgentExecutorBackend {
  readonly id = "remote";
  readonly kind = "remote" as const;
  readonly label = "Fake Remote Backend";

  getStatus(): AgentBackendStatus {
    return { available: true };
  }

  async dispatchTask(_request: AgentBackendTaskRequest) {
    return { error: "not used in this test" };
  }

  async sendMessage(request: AgentBackendMessageRequest): Promise<AgentBackendMessageResult> {
    return {
      sent: true,
      backendId: this.id,
      targetId: request.target.actorId ?? request.target.name,
      targetName: request.target.actorName ?? request.target.name,
      messageId: "remote-msg-1",
    };
  }
}

describe("TeamRegistry", () => {
  it("creates teams, resolves teammate aliases, and records mailbox delivery", async () => {
    const backendRegistry = new AgentBackendRegistry({ defaultBackendId: "in_process" });
    const backend = new FakeInProcessBackend();
    backendRegistry.register(backend);

    const registry = new TeamRegistry({
      backendRegistry,
      listKnownActors: () => [
        { id: "coordinator", name: "Coordinator" },
        { id: "specialist", name: "Specialist" },
        { id: "reviewer", name: "Reviewer" },
      ],
    });

    const created = registry.createTeam({
      name: "Delivery Team",
      createdByActorId: "coordinator",
      teammates: [
        {
          name: "Frontend Specialist",
          actorId: "specialist",
          aliases: ["specialist", "frontend"],
        },
        "Reviewer",
      ],
    });

    expect(created.created).toBe(true);
    expect(created.team.teammates).toHaveLength(2);

    const team = registry.getTeam("Delivery Team");
    expect(team).toBeTruthy();
    if (!team) return;

    const sendResult = await team.sendMessage({
      senderActorId: "coordinator",
      teammate: "frontend",
      content: "请先补齐实现说明",
    });
    const broadcastResult = await team.broadcastMessage({
      senderActorId: "coordinator",
      content: "同步当前状态",
    });

    expect(sendResult).toEqual(expect.objectContaining({
      sent: true,
      targetId: "specialist",
      targetName: "Specialist",
    }));
    expect(broadcastResult).toEqual(expect.objectContaining({
      sent: true,
      total: 2,
      sentCount: 2,
      failedCount: 0,
    }));
    expect(team.getMailboxSnapshot()).toEqual([
      expect.objectContaining({
        recipientName: "Frontend Specialist",
        status: "sent",
      }),
      expect.objectContaining({
        recipientName: "Frontend Specialist",
        status: "sent",
      }),
      expect.objectContaining({
        recipientName: "Reviewer",
        status: "sent",
      }),
    ]);
    expect(backend.sentMessages).toHaveLength(3);
  });

  it("rebinds teammates that were using the previous default backend on team update", () => {
    const backendRegistry = new AgentBackendRegistry({ defaultBackendId: "in_process" });
    backendRegistry.register(new FakeInProcessBackend());
    backendRegistry.register(new FakeRemoteBackend());

    const registry = new TeamRegistry({
      backendRegistry,
      listKnownActors: () => [
        { id: "coordinator", name: "Coordinator" },
        { id: "specialist", name: "Specialist" },
      ],
    });

    registry.createTeam({
      name: "Delivery Team",
      createdByActorId: "coordinator",
      teammates: ["Specialist"],
    });

    const updated = registry.createTeam({
      name: "Delivery Team",
      createdByActorId: "coordinator",
      defaultBackendId: "remote",
    });

    expect(updated.updated).toBe(true);
    expect(updated.team.defaultBackendId).toBe("remote");
    expect(updated.team.teammates[0]).toEqual(expect.objectContaining({
      name: "Specialist",
      backendId: "remote",
    }));
  });
});
