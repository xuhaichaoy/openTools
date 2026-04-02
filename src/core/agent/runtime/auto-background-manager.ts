export interface AutoBackgroundConfig {
  enabled: boolean;
  thresholdMs: number;
}

export class AutoBackgroundManager {
  private readonly config: AutoBackgroundConfig;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(config: AutoBackgroundConfig = { enabled: true, thresholdMs: 120000 }) {
    this.config = config;
  }

  scheduleAutoBackground(taskId: string, callback: () => void): void {
    if (!this.config.enabled) return;

    const timer = setTimeout(() => {
      callback();
      this.timers.delete(taskId);
    }, this.config.thresholdMs);

    this.timers.set(taskId, timer);
  }

  cancel(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
