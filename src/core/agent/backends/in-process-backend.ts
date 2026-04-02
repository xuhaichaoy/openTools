import type { ActorSystem } from "../actor/actor-system";
import type {
  AgentBackendMessageRequest,
  AgentBackendMessageResult,
  AgentBackendStatus,
  AgentBackendTaskRequest,
  AgentExecutorBackend,
} from "./types";

function resolveTargetActorId(
  system: ActorSystem,
  request: Pick<AgentBackendTaskRequest | AgentBackendMessageRequest, "target">,
): string | undefined {
  const directActorId = request.target.actorId?.trim();
  if (directActorId && system.get(directActorId)) {
    return directActorId;
  }

  const candidateNames = [
    request.target.actorName,
    request.target.name,
    request.target.actorId,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  for (const candidate of candidateNames) {
    if (system.get(candidate)) {
      return candidate;
    }

    const actorByName = system.getAll().find((actor) => actor.role.name === candidate);
    if (actorByName) {
      return actorByName.id;
    }
  }

  return undefined;
}

export class InProcessAgentBackend implements AgentExecutorBackend {
  readonly id = "in_process";
  readonly kind = "in_process" as const;
  readonly label = "In-Process Actor Runtime";
  private readonly system: ActorSystem;

  constructor(system: ActorSystem) {
    this.system = system;
  }

  getStatus(): AgentBackendStatus {
    return { available: true };
  }

  async dispatchTask(request: AgentBackendTaskRequest) {
    const resolvedTarget = resolveTargetActorId(this.system, request)
      ?? request.target.actorName?.trim()
      ?? request.target.name?.trim()
      ?? request.target.actorId?.trim()
      ?? "";

    if (!resolvedTarget && request.target.createIfMissing !== true) {
      return { error: "in_process backend 缺少可解析的目标 actor。" };
    }

    return this.system.spawnTask(request.senderActorId, resolvedTarget, request.task, {
      label: request.label,
      context: request.context,
      attachments: request.attachments,
      images: request.images,
      mode: request.mode,
      cleanup: request.cleanup,
      expectsCompletionMessage: request.expectsCompletionMessage,
      roleBoundary: request.roleBoundary,
      createIfMissing: request.target.createIfMissing,
      createChildSpec: {
        description: request.target.description,
        capabilities: request.target.capabilities,
        workspace: request.target.workspace,
      },
      overrides: request.overrides,
      plannedDelegationId: request.plannedDelegationId,
    });
  }

  async sendMessage(request: AgentBackendMessageRequest): Promise<AgentBackendMessageResult> {
    const targetActorId = resolveTargetActorId(this.system, request);
    if (!targetActorId) {
      return {
        sent: false,
        backendId: this.id,
        error: `in_process backend 未找到目标 teammate：${request.target.name ?? request.target.actorName ?? request.target.actorId ?? "unknown"}`,
      };
    }

    try {
      const message = this.system.send(request.senderActorId, targetActorId, request.content, {
        replyTo: request.replyTo,
        relatedRunId: request.relatedRunId,
      });
      return {
        sent: true,
        backendId: this.id,
        targetId: targetActorId,
        targetName: this.system.get(targetActorId)?.role.name ?? targetActorId,
        messageId: message.id,
      };
    } catch (error) {
      return {
        sent: false,
        backendId: this.id,
        targetId: targetActorId,
        targetName: this.system.get(targetActorId)?.role.name ?? targetActorId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
