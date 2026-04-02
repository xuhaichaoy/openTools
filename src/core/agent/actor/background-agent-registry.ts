import { createLogger } from "@/core/logger";

const log = createLogger("BackgroundAgentRegistry");

export interface BackgroundAgentInfo {
  taskId: string;
  agentId: string;
  sessionId: string;
  agentName: string;
  description?: string;
  prompt?: string;
  subagentType?: string;
  parentActorId?: string;
  model?: string;
  status: "queued" | "running" | "resuming" | "completed" | "failed" | "aborted";
  startedAt: number;
  lastActiveAt?: number;
  completedAt?: number;
  outputFile?: string;
  error?: string;
}

class BackgroundAgentRegistry {
  private agents = new Map<string, BackgroundAgentInfo>();
  private taskIdByAgentId = new Map<string, string>();
  private taskIdsByName = new Map<string, Set<string>>();

  private normalizeIdentifier(value: string): string {
    return value.trim().toLowerCase();
  }

  private unindex(info: BackgroundAgentInfo | undefined): void {
    if (!info) return;
    this.taskIdByAgentId.delete(info.agentId);
    const normalizedName = this.normalizeIdentifier(info.agentName);
    const taskIds = this.taskIdsByName.get(normalizedName);
    if (!taskIds) return;
    taskIds.delete(info.taskId);
    if (taskIds.size === 0) {
      this.taskIdsByName.delete(normalizedName);
    }
  }

  private index(info: BackgroundAgentInfo): void {
    this.taskIdByAgentId.set(info.agentId, info.taskId);
    const normalizedName = this.normalizeIdentifier(info.agentName);
    const taskIds = this.taskIdsByName.get(normalizedName) ?? new Set<string>();
    taskIds.add(info.taskId);
    this.taskIdsByName.set(normalizedName, taskIds);
  }

  register(info: BackgroundAgentInfo): void {
    const next: BackgroundAgentInfo = {
      ...info,
      lastActiveAt: info.lastActiveAt ?? info.startedAt,
    };
    this.unindex(this.agents.get(next.taskId));
    this.agents.set(next.taskId, next);
    this.index(next);
    log.info(`Registered background agent: ${info.taskId}`);
  }

  get(taskId: string): BackgroundAgentInfo | undefined {
    return this.agents.get(taskId);
  }

  getByAgentId(agentId: string): BackgroundAgentInfo | undefined {
    const taskId = this.taskIdByAgentId.get(agentId);
    return taskId ? this.agents.get(taskId) : undefined;
  }

  find(identifier: string): BackgroundAgentInfo | undefined {
    const normalized = identifier.trim();
    if (!normalized) return undefined;

    return this.agents.get(normalized)
      ?? this.getByAgentId(normalized)
      ?? (() => {
        const taskIds = this.taskIdsByName.get(this.normalizeIdentifier(normalized));
        if (!taskIds || taskIds.size === 0) return undefined;
        return [...taskIds]
          .map((taskId) => this.agents.get(taskId))
          .filter((item): item is BackgroundAgentInfo => Boolean(item))
          .sort((left, right) => {
            const leftAt = left.lastActiveAt ?? left.completedAt ?? left.startedAt;
            const rightAt = right.lastActiveAt ?? right.completedAt ?? right.startedAt;
            return rightAt - leftAt;
          })[0];
      })();
  }

  update(taskId: string, updates: Partial<BackgroundAgentInfo>): void {
    const info = this.agents.get(taskId);
    if (info) {
      const next: BackgroundAgentInfo = {
        ...info,
        ...updates,
        lastActiveAt: updates.lastActiveAt ?? Date.now(),
      };
      this.unindex(info);
      this.agents.set(taskId, next);
      this.index(next);
    }
  }

  complete(taskId: string, outputFile?: string): void {
    this.update(taskId, {
      status: "completed",
      completedAt: Date.now(),
      lastActiveAt: Date.now(),
      outputFile,
    });
  }

  fail(taskId: string, error: string): void {
    this.update(taskId, {
      status: "failed",
      completedAt: Date.now(),
      lastActiveAt: Date.now(),
      error,
    });
  }

  abort(taskId: string, error?: string): void {
    this.update(taskId, {
      status: "aborted",
      completedAt: Date.now(),
      lastActiveAt: Date.now(),
      ...(error ? { error } : {}),
    });
  }

  listRunning(): BackgroundAgentInfo[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.status === "running" || agent.status === "resuming",
    );
  }

  list(): BackgroundAgentInfo[] {
    return [...this.agents.values()].sort((left, right) => {
      const leftAt = left.lastActiveAt ?? left.completedAt ?? left.startedAt;
      const rightAt = right.lastActiveAt ?? right.completedAt ?? right.startedAt;
      return rightAt - leftAt;
    });
  }

  remove(taskId: string): void {
    const existing = this.agents.get(taskId);
    this.unindex(existing);
    this.agents.delete(taskId);
  }

  reset(): void {
    this.agents.clear();
    this.taskIdByAgentId.clear();
    this.taskIdsByName.clear();
  }
}

const registry = new BackgroundAgentRegistry();
export function getBackgroundAgentRegistry(): BackgroundAgentRegistry {
  return registry;
}

export function resetBackgroundAgentRegistry(): void {
  registry.reset();
}
