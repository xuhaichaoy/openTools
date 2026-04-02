import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import {
  appendToolCallSync,
  appendToolResultSync,
} from "@/core/agent/actor/actor-transcript";

export interface RuntimeTranscriptBridge {
  recordStep(step: AgentStep): void;
}

export function createRuntimeTranscriptBridge(params: {
  sessionId: string;
  actorId: string;
  onToolCall?: (toolName: string, params: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
}): RuntimeTranscriptBridge {
  return {
    recordStep(step) {
      if (!step.toolName) return;
      if (step.type === "action" && step.toolInput) {
        appendToolCallSync(params.sessionId, params.actorId, step.toolName, step.toolInput);
        params.onToolCall?.(step.toolName, step.toolInput);
        return;
      }
      if (step.type === "observation" && step.toolOutput !== undefined) {
        appendToolResultSync(params.sessionId, params.actorId, step.toolName, step.toolOutput);
        params.onToolResult?.(step.toolName, step.toolOutput);
      }
    },
  };
}
