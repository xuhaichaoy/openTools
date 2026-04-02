/**
 * TaskQueue — 持久化任务队列引擎
 *
 * 职责：
 * 1. 任务 CRUD + 持久化到 localStorage
 * 2. 优先级排序与依赖解析
 * 3. 任务调度（并发控制、延迟执行、重试）
 * 4. 事件通知
 */

import type {
  TaskDefinition,
  TaskRecord,
  TaskStatus,
  TaskEvent,
  TaskEventHandler,
  TaskFilter,
  TaskStats,
  TaskPriority,
} from "./types";
import { createLogger } from "@/core/logger";

const log = createLogger("TaskQueue");
const STORAGE_KEY = "mtools_task_center";
const MAX_CONCURRENT = 3;
const MAX_PERSISTED = 500;

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function generateId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TaskQueue {
  private tasks = new Map<string, TaskRecord>();
  private eventHandlers: TaskEventHandler[] = [];
  private _schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private _executor: TaskExecutor | null = null;

  constructor() {
    this._loadFromStorage();
  }

  /** 注册任务执行器 */
  setExecutor(executor: TaskExecutor): void {
    this._executor = executor;
  }

  /** 创建任务 */
  create(def: Omit<TaskDefinition, "id"> & { id?: string }): TaskRecord {
    const record: TaskRecord = {
      ...def,
      id: def.id || generateId(),
      status: "pending",
      createdAt: Date.now(),
      retryCount: 0,
    };

    this.tasks.set(record.id, record);
    this._persist();
    this._emit({ type: "task_created", task: record });
    log.info(`Task created: ${record.title} (${record.id})`, { type: record.type, priority: record.priority });

    // 检查是否可以立即调度
    this._scheduleNext();

    return record;
  }

  /** 获取任务 */
  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  /** 更新任务字段 */
  update(id: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const next: TaskRecord = {
      ...task,
      ...patch,
      id: task.id,
      createdAt: task.createdAt,
    };
    this.tasks.set(id, next);
    this._persist();
    this._emit({ type: "task_updated", taskId: id, patch });

    if (patch.status === "pending" || patch.status === "queued") {
      this._scheduleNext();
    }
    return next;
  }

  /** 查询任务列表 */
  list(filter?: TaskFilter): TaskRecord[] {
    let results = [...this.tasks.values()];

    if (filter) {
      if (filter.status?.length) results = results.filter((t) => filter.status!.includes(t.status));
      if (filter.type?.length) results = results.filter((t) => filter.type!.includes(t.type));
      if (filter.priority?.length) results = results.filter((t) => filter.priority!.includes(t.priority));
      if (filter.tags?.length) results = results.filter((t) => t.tags?.some((tag) => filter.tags!.includes(tag)));
      if (filter.createdBy) results = results.filter((t) => t.createdBy === filter.createdBy);
      if (filter.assignee) results = results.filter((t) => t.assignee === filter.assignee);
      if (filter.since) results = results.filter((t) => t.createdAt >= filter.since!);
      if (filter.until) results = results.filter((t) => t.createdAt <= filter.until!);
    }

    return results.sort((a, b) => {
      const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pDiff !== 0) return pDiff;
      return a.createdAt - b.createdAt;
    });
  }

  /** 取消任务 */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status === "completed" || task.status === "cancelled") return false;

    task.status = "cancelled";
    task.completedAt = Date.now();
    this._persist();
    this._emit({ type: "task_cancelled", taskId: id });
    log.info(`Task cancelled: ${task.title} (${id})`);
    return true;
  }

  /** 删除任务 */
  remove(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (!existed) return false;
    this._persist();
    this._emit({ type: "task_deleted", taskId: id });
    log.info(`Task deleted: ${id}`);
    return true;
  }

  /** 更新任务进度 */
  updateProgress(id: string, progress: number, label?: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;

    task.progress = Math.min(100, Math.max(0, progress));
    task.progressLabel = label;
    this._emit({ type: "task_progress", taskId: id, progress: task.progress, label });
  }

  /** 标记任务完成 */
  complete(id: string, result?: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.status = "completed";
    task.completedAt = Date.now();
    task.progress = 100;
    task.result = result;
    this._persist();
    this._emit({ type: "task_completed", taskId: id, result });
    log.info(`Task completed: ${task.title} (${id})`, { elapsed: task.completedAt - (task.startedAt ?? task.createdAt) });

    this._scheduleNext();
  }

  /** 标记任务失败 */
  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    // 尝试重试
    if (task.maxRetries && task.retryCount < task.maxRetries) {
      task.retryCount++;
      task.status = "queued";
      task.error = error;
      this._persist();
      this._emit({ type: "task_retrying", taskId: id, retryCount: task.retryCount });
      log.info(`Task retrying: ${task.title} (${id}), attempt ${task.retryCount}/${task.maxRetries}`);
      this._scheduleNext();
      return;
    }

    task.status = "failed";
    task.completedAt = Date.now();
    task.error = error;
    this._persist();
    this._emit({ type: "task_failed", taskId: id, error });
    log.warn(`Task failed: ${task.title} (${id}): ${error}`);

    this._scheduleNext();
  }

  /** 获取统计信息 */
  getStats(): TaskStats {
    const all = [...this.tasks.values()];
    const byStatus = { pending: 0, queued: 0, running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 };
    const byPriority = { low: 0, normal: 0, high: 0, urgent: 0 };

    let totalCompletionTime = 0;
    let completedCount = 0;
    let failedCount = 0;

    for (const t of all) {
      byStatus[t.status]++;
      byPriority[t.priority]++;
      if (t.status === "completed" && t.startedAt && t.completedAt) {
        totalCompletionTime += t.completedAt - t.startedAt;
        completedCount++;
      }
      if (t.status === "failed") failedCount++;
    }

    return {
      total: all.length,
      byStatus,
      byPriority,
      avgCompletionTimeMs: completedCount > 0 ? totalCompletionTime / completedCount : 0,
      failureRate: all.length > 0 ? failedCount / all.length : 0,
    };
  }

  /** 清理已完成/取消的旧任务 */
  cleanup(maxAge = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    let removed = 0;

    for (const [id, task] of this.tasks) {
      if ((task.status === "completed" || task.status === "cancelled" || task.status === "failed") &&
        (task.completedAt ?? task.createdAt) < cutoff) {
        this.tasks.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this._persist();
      log.info(`Cleaned up ${removed} old tasks`);
    }
    return removed;
  }

  /** 注册事件处理器 */
  onEvent(handler: TaskEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  /** 启动调度器 */
  startScheduler(intervalMs = 5000): void {
    this.stopScheduler();
    this._schedulerTimer = setInterval(() => this._scheduleNext(), intervalMs);
    this._scheduleNext();
  }

  /** 停止调度器 */
  stopScheduler(): void {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
    }
  }

  // ── Private ──

  private _scheduleNext(): void {
    if (!this._executor) return;

    const running = [...this.tasks.values()].filter((t) => t.status === "running");
    if (running.length >= MAX_CONCURRENT) return;

    const available = this._getSchedulable();
    const toRun = available.slice(0, MAX_CONCURRENT - running.length);

    for (const task of toRun) {
      task.status = "running";
      task.startedAt = Date.now();
      this._persist();
      this._emit({ type: "task_started", taskId: task.id });

      if (this._executor) {
        this._executor.execute(task).catch((err) => {
          this.fail(task.id, err instanceof Error ? err.message : String(err));
        });
      }
    }
  }

  private _getSchedulable(): TaskRecord[] {
    const now = Date.now();
    return [...this.tasks.values()]
      .filter((t) => {
        if (t.status !== "pending" && t.status !== "queued") return false;
        if (t.type === "agent_spawn") return false;
        if (t.scheduledAt && t.scheduledAt > now) return false;
        if (t.dependencies?.length) {
          return t.dependencies.every((depId) => {
            const dep = this.tasks.get(depId);
            return dep?.status === "completed";
          });
        }
        return true;
      })
      .sort((a, b) => {
        const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (pDiff !== 0) return pDiff;
        return a.createdAt - b.createdAt;
      });
  }

  private _emit(event: TaskEvent): void {
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch (err) {
        log.warn("Task event handler error", err);
      }
    }
  }

  private _persist(): void {
    try {
      const all = [...this.tasks.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_PERSISTED);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (err) {
      log.warn("TaskQueue persist failed", err);
    }
  }

  private _loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw) as TaskRecord[];
      if (!Array.isArray(arr)) return;

      for (const t of arr) {
        if (!t.id || !t.title) continue;
        if (t.type === "agent_spawn") continue;
        // 恢复时，将 running 状态重置为 queued（进程重启不保留执行状态）
        if (t.status === "running") t.status = "queued";
        this.tasks.set(t.id, t);
      }
      log.info(`TaskQueue loaded ${this.tasks.size} tasks from storage`);
    } catch (err) {
      log.warn("TaskQueue load failed", err);
    }
  }
}

/** 任务执行器接口（由 ActorSystem 桥接层实现） */
export interface TaskExecutor {
  execute(task: TaskRecord): Promise<void>;
}

/** 全局单例 */
let _instance: TaskQueue | null = null;
export function getTaskQueue(): TaskQueue {
  if (!_instance) {
    _instance = new TaskQueue();
    _instance.startScheduler();
  }
  return _instance;
}

export function resetTaskQueue(): void {
  _instance?.stopScheduler();
  _instance = null;
}

/**
 * 创建一个 ActorSystem 桥接的 TaskExecutor。
 * ActorSystem 在 spawn 任务时已经直接调用 create/complete/fail，
 * 但对于手动创建的通用任务，也可以通过 executor 委派执行。
 */
export function createActorSystemExecutor(
  actorSystem: {
    assignTask: (actorId: string, query: string) => Promise<{ status: string; result?: string; error?: string }>;
    getAll: () => Array<{ id: string; status: string }>;
  },
): TaskExecutor {
  return {
    async execute(task: TaskRecord): Promise<void> {
      const queue = getTaskQueue();
      const actors = actorSystem.getAll() as Array<{ id: string; status: string }>;
      const idle = actors.find((a) => a.status === "idle") ?? actors[0];
      if (!idle) {
        queue.fail(task.id, "没有可用的 Agent");
        return;
      }

      try {
        const result = await actorSystem.assignTask(idle.id, task.description || task.title);
        if (result.status === "completed") {
          queue.complete(task.id, result.result);
        } else if (result.status === "error" || result.status === "aborted") {
          queue.fail(task.id, result.error ?? "任务执行失败");
        }
        // "pending" / "running" — task still in progress, don't mark as done yet
      } catch (err) {
        queue.fail(task.id, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
