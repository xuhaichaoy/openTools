import type {
  AgentBackendMessageRequest,
  AgentBackendMessageResult,
  AgentBackendStatus,
  AgentBackendTaskRequest,
  AgentExecutorBackend,
} from "./types";

const REMOTE_NOT_READY_REASON = "remote backend 尚未接入远程执行承载层。";

export class RemoteAgentBackend implements AgentExecutorBackend {
  readonly id = "remote";
  readonly kind = "remote" as const;
  readonly label = "Remote Backend";

  getStatus(): AgentBackendStatus {
    return {
      available: false,
      reason: REMOTE_NOT_READY_REASON,
    };
  }

  async dispatchTask(_request: AgentBackendTaskRequest) {
    return { error: REMOTE_NOT_READY_REASON };
  }

  async sendMessage(_request: AgentBackendMessageRequest): Promise<AgentBackendMessageResult> {
    return {
      sent: false,
      backendId: this.id,
      error: REMOTE_NOT_READY_REASON,
    };
  }
}
