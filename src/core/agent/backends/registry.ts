import type { ActorSystem } from "../actor/actor-system";
import { InProcessAgentBackend } from "./in-process-backend";
import { RemoteAgentBackend } from "./remote-backend";
import { WorktreeAgentBackend } from "./worktree-backend";
import type {
  AgentBackendId,
  AgentBackendMessageRequest,
  AgentBackendMessageResult,
  AgentBackendSummary,
  AgentBackendTaskRequest,
  AgentExecutorBackend,
} from "./types";

export interface AgentBackendRegistryOptions {
  defaultBackendId?: AgentBackendId;
}

export class AgentBackendRegistry {
  private readonly backends = new Map<AgentBackendId, AgentExecutorBackend>();
  readonly defaultBackendId: AgentBackendId;

  constructor(options: AgentBackendRegistryOptions = {}) {
    this.defaultBackendId = options.defaultBackendId?.trim() || "in_process";
  }

  register(backend: AgentExecutorBackend): void {
    this.backends.set(backend.id, backend);
  }

  unregister(backendId: AgentBackendId): void {
    this.backends.delete(backendId);
  }

  get(backendId?: AgentBackendId): AgentExecutorBackend | undefined {
    const normalizedId = backendId?.trim() || this.defaultBackendId;
    return this.backends.get(normalizedId);
  }

  has(backendId: AgentBackendId): boolean {
    return this.backends.has(backendId.trim());
  }

  list(): AgentBackendSummary[] {
    return [...this.backends.values()].map((backend) => {
      const status = backend.getStatus();
      return {
        id: backend.id,
        kind: backend.kind,
        label: backend.label,
        available: status.available,
        reason: status.reason,
      };
    });
  }

  async dispatchTask(
    request: AgentBackendTaskRequest & { backendId?: AgentBackendId },
  ) {
    const backend = this.get(request.backendId);
    if (!backend) {
      return {
        error: `backend "${request.backendId ?? this.defaultBackendId}" 不存在`,
      };
    }
    return backend.dispatchTask(request);
  }

  async sendMessage(
    request: AgentBackendMessageRequest & { backendId?: AgentBackendId },
  ): Promise<AgentBackendMessageResult> {
    const backend = this.get(request.backendId);
    if (!backend) {
      return {
        sent: false,
        backendId: request.backendId ?? this.defaultBackendId,
        error: `backend "${request.backendId ?? this.defaultBackendId}" 不存在`,
      };
    }
    return backend.sendMessage(request);
  }
}

export function createDefaultAgentBackendRegistry(system: ActorSystem): AgentBackendRegistry {
  const registry = new AgentBackendRegistry({
    defaultBackendId: "in_process",
  });
  registry.register(new InProcessAgentBackend(system));
  registry.register(new WorktreeAgentBackend());
  registry.register(new RemoteAgentBackend());
  return registry;
}
