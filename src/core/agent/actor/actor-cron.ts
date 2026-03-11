/**
 * Actor Cron — 定时 / 延迟任务调度器。
 * 对标 OpenClaw 的 cron 系统。
 *
 * 支持：
 * - once：延迟执行一次
 * - interval：按间隔重复执行（可限最大次数）
 * - 列表查看、取消
 */

import type { ActorSystem } from "./actor-system";

const generateId = () =>
  Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

const MAX_JOBS = 20;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_INTERVAL_MS = 5_000; // 5s

export type CronJobStatus = "active" | "completed" | "cancelled";

export interface CronJob {
  id: string;
  actorId: string;
  task: string;
  type: "once" | "interval";
  delayMs: number;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  runCount: number;
  maxRuns?: number;
  status: CronJobStatus;
}

const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();

export class ActorCron {
  private jobs = new Map<string, CronJob>();
  private system: ActorSystem;

  constructor(system: ActorSystem) {
    this.system = system;
  }

  scheduleOnce(
    actorId: string,
    task: string,
    delayMs: number,
  ): CronJob | { error: string } {
    const clamped = Math.max(MIN_INTERVAL_MS, Math.min(delayMs, MAX_INTERVAL_MS));
    if (this.jobs.size >= MAX_JOBS) {
      return { error: `已达最大定时任务数 (${MAX_JOBS})` };
    }

    const job: CronJob = {
      id: generateId(),
      actorId,
      task,
      type: "once",
      delayMs: clamped,
      createdAt: Date.now(),
      nextRunAt: Date.now() + clamped,
      runCount: 0,
      maxRuns: 1,
      status: "active",
    };
    this.jobs.set(job.id, job);

    const timerId = setTimeout(() => this.executeJob(job), clamped);
    jobTimers.set(job.id, timerId);

    return job;
  }

  scheduleInterval(
    actorId: string,
    task: string,
    intervalMs: number,
    maxRuns?: number,
  ): CronJob | { error: string } {
    const clamped = Math.max(MIN_INTERVAL_MS, Math.min(intervalMs, MAX_INTERVAL_MS));
    if (this.jobs.size >= MAX_JOBS) {
      return { error: `已达最大定时任务数 (${MAX_JOBS})` };
    }

    const job: CronJob = {
      id: generateId(),
      actorId,
      task,
      type: "interval",
      delayMs: clamped,
      createdAt: Date.now(),
      nextRunAt: Date.now() + clamped,
      runCount: 0,
      maxRuns,
      status: "active",
    };
    this.jobs.set(job.id, job);
    this.scheduleNext(job);
    return job;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "active") return false;

    const timerId = jobTimers.get(jobId);
    if (timerId) {
      clearTimeout(timerId);
      jobTimers.delete(jobId);
    }

    job.status = "cancelled";
    return true;
  }

  list(): CronJob[] {
    return [...this.jobs.values()];
  }

  listActive(): CronJob[] {
    return [...this.jobs.values()].filter((j) => j.status === "active");
  }

  cancelAll(): void {
    for (const [id] of this.jobs) {
      this.cancel(id);
    }
  }

  private executeJob(job: CronJob): void {
    if (job.status !== "active") return;

    const actor = this.system.get(job.actorId);
    if (!actor) {
      job.status = "cancelled";
      jobTimers.delete(job.id);
      return;
    }

    job.runCount++;
    job.lastRunAt = Date.now();

    void actor.assignTask(`[定时任务] ${job.task}`);

    if (job.type === "once" || (job.maxRuns && job.runCount >= job.maxRuns)) {
      job.status = "completed";
      jobTimers.delete(job.id);
    } else if (job.type === "interval") {
      this.scheduleNext(job);
    }
  }

  private scheduleNext(job: CronJob): void {
    if (job.status !== "active") return;
    job.nextRunAt = Date.now() + job.delayMs;

    const timerId = setTimeout(() => this.executeJob(job), job.delayMs);
    jobTimers.set(job.id, timerId);
  }
}
