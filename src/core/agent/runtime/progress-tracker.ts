export interface ProgressUpdate {
  taskId: string;
  status: string;
  progress?: number;
  message?: string;
  timestamp: number;
}

export class ProgressTracker {
  private updates = new Map<string, ProgressUpdate[]>();

  track(taskId: string, status: string, message?: string, progress?: number): void {
    const update: ProgressUpdate = {
      taskId,
      status,
      message,
      progress,
      timestamp: Date.now(),
    };

    const existing = this.updates.get(taskId) || [];
    existing.push(update);
    this.updates.set(taskId, existing);
  }

  getUpdates(taskId: string): ProgressUpdate[] {
    return this.updates.get(taskId) || [];
  }

  getLatest(taskId: string): ProgressUpdate | undefined {
    const updates = this.getUpdates(taskId);
    return updates[updates.length - 1];
  }

  clear(taskId: string): void {
    this.updates.delete(taskId);
  }
}
