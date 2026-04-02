import { createLogger } from "@/core/logger";

const log = createLogger("AgentAttachmentState");

export type AttachmentMode = "foreground" | "background";

export interface AgentAttachmentState {
  taskId: string;
  mode: AttachmentMode;
  attachedAt: number;
  detachedAt?: number;
}

class AgentAttachmentManager {
  private states = new Map<string, AgentAttachmentState>();

  attach(taskId: string, mode: AttachmentMode = "foreground"): void {
    this.states.set(taskId, {
      taskId,
      mode,
      attachedAt: Date.now(),
    });
    log.info(`Attached agent ${taskId} in ${mode} mode`);
  }

  detach(taskId: string): void {
    const state = this.states.get(taskId);
    if (state) {
      state.detachedAt = Date.now();
      state.mode = "background";
      log.info(`Detached agent ${taskId} to background`);
    }
  }

  getMode(taskId: string): AttachmentMode | undefined {
    return this.states.get(taskId)?.mode;
  }

  isAttached(taskId: string): boolean {
    const state = this.states.get(taskId);
    return state?.mode === "foreground" && !state.detachedAt;
  }

  switchToBackground(taskId: string): void {
    const state = this.states.get(taskId);
    if (state) {
      state.mode = "background";
      log.info(`Switched agent ${taskId} to background`);
    }
  }

  switchToForeground(taskId: string): void {
    const state = this.states.get(taskId);
    if (state) {
      state.mode = "foreground";
      state.detachedAt = undefined;
      log.info(`Switched agent ${taskId} to foreground`);
    }
  }
}

const manager = new AgentAttachmentManager();
export function getAgentAttachmentManager(): AgentAttachmentManager {
  return manager;
}
