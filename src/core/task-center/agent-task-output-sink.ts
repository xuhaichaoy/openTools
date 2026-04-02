import type { AgentTaskOutputEntry } from "./agent-task-types";

const MAX_OUTPUTS_PER_TASK = 20;

export class AgentTaskOutputSink {
  private entries = new Map<string, AgentTaskOutputEntry[]>();

  append(entry: AgentTaskOutputEntry): void {
    const bucket = this.entries.get(entry.taskId) ?? [];
    bucket.push(entry);
    this.entries.set(entry.taskId, bucket.slice(-MAX_OUTPUTS_PER_TASK));
  }

  list(taskId: string): AgentTaskOutputEntry[] {
    return [...(this.entries.get(taskId) ?? [])];
  }

  remove(taskId: string): void {
    this.entries.delete(taskId);
  }

  clear(): void {
    this.entries.clear();
  }

  snapshot(): Record<string, AgentTaskOutputEntry[]> {
    return Object.fromEntries(
      [...this.entries.entries()].map(([taskId, value]) => [taskId, [...value]]),
    );
  }

  restore(snapshot?: Record<string, AgentTaskOutputEntry[]>): void {
    this.entries.clear();
    for (const [taskId, value] of Object.entries(snapshot ?? {})) {
      if (!Array.isArray(value) || value.length === 0) continue;
      this.entries.set(taskId, value.slice(-MAX_OUTPUTS_PER_TASK));
    }
  }
}
