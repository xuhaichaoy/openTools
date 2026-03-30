export type TaskExecutorUpdateReason = "task_update" | "timeout";
export type TaskExecutorTimeoutReason = "idle" | "budget";
export type TaskExecutorTerminalStatus = "completed" | "error" | "aborted";

export interface TaskExecutorRuntimeState<TProfile extends string = string> {
  subtaskId: string;
  profile: TProfile;
  progressSummary?: string;
  terminalResult?: string;
  terminalError?: string;
  startedAt: number;
  completedAt?: number;
  timeoutSeconds?: number;
  eventCount: number;
}

export interface TaskExecutorLifecycleRecord<
  TStatus extends string = string,
  TProfile extends string = string,
  TTimeoutReason extends string = string,
> {
  runId: string;
  status: TStatus;
  spawnedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  timeoutReason?: TTimeoutReason;
  budgetSeconds?: number;
  lastActiveAt?: number;
  runtime?: TaskExecutorRuntimeState<TProfile>;
}

export interface TaskExecutorLifecyclePatch<
  TStatus extends string = string,
  TProfile extends string = string,
  TTimeoutReason extends string = string,
> {
  status?: TStatus;
  profile?: TProfile;
  progressSummary?: string | null;
  terminalResult?: string | null;
  terminalError?: string | null;
  startedAt?: number;
  completedAt?: number | null;
  timeoutSeconds?: number;
  lastActiveAt?: number;
  timeoutReason?: TTimeoutReason;
  countEvent?: boolean;
}

export interface TaskExecutorTimeoutTrigger {
  reason: TaskExecutorTimeoutReason;
  now: number;
  durationMs: number;
  thresholdSeconds: number;
}

type ProgressSnapshot = {
  summary: string;
  timestamp: number;
  contentLength: number;
  streaming: boolean;
};

export function ensureTaskExecutorRuntime<
  TStatus extends string,
  TProfile extends string,
  TTimeoutReason extends string,
  TRecord extends TaskExecutorLifecycleRecord<TStatus, TProfile, TTimeoutReason>,
>(
  record: TRecord,
  opts: {
    subtaskId?: string;
    profile: TProfile;
    startedAt?: number;
    timeoutSeconds?: number;
  },
): TaskExecutorRuntimeState<TProfile> {
  const runtime = record.runtime ?? {
    subtaskId: opts.subtaskId ?? record.runId,
    profile: opts.profile,
    startedAt: opts.startedAt ?? record.spawnedAt,
    timeoutSeconds: opts.timeoutSeconds ?? record.budgetSeconds,
    eventCount: 0,
  };

  runtime.subtaskId = runtime.subtaskId || opts.subtaskId || record.runId;
  runtime.profile = runtime.profile || opts.profile;
  runtime.startedAt = runtime.startedAt || opts.startedAt || record.spawnedAt;
  if (typeof runtime.timeoutSeconds !== "number" && typeof opts.timeoutSeconds === "number") {
    runtime.timeoutSeconds = opts.timeoutSeconds;
  }
  if (typeof runtime.eventCount !== "number") {
    runtime.eventCount = 0;
  }

  record.runtime = runtime;
  return runtime;
}

export function resetTaskExecutorRuntimeForResume<
  TStatus extends string,
  TProfile extends string,
  TTimeoutReason extends string,
  TRecord extends TaskExecutorLifecycleRecord<TStatus, TProfile, TTimeoutReason>,
>(
  record: TRecord,
  opts: {
    subtaskId?: string;
    profile: TProfile;
    startedAt?: number;
    timeoutSeconds?: number;
  },
): TaskExecutorRuntimeState<TProfile> {
  const runtime = ensureTaskExecutorRuntime(record, opts);
  runtime.completedAt = undefined;
  runtime.terminalResult = undefined;
  runtime.terminalError = undefined;
  record.completedAt = undefined;
  record.result = undefined;
  record.error = undefined;
  record.timeoutReason = undefined;
  return runtime;
}

export function applyTaskExecutorLifecycle<
  TStatus extends string,
  TProfile extends string,
  TTimeoutReason extends string,
  TRecord extends TaskExecutorLifecycleRecord<TStatus, TProfile, TTimeoutReason>,
>(
  record: TRecord,
  patch: TaskExecutorLifecyclePatch<TStatus, TProfile, TTimeoutReason>,
  opts: {
    subtaskId?: string;
    fallbackProfile: TProfile;
  },
): TaskExecutorRuntimeState<TProfile> {
  const runtime = ensureTaskExecutorRuntime(record, {
    subtaskId: opts.subtaskId,
    profile: patch.profile ?? record.runtime?.profile ?? opts.fallbackProfile,
    startedAt: patch.startedAt,
    timeoutSeconds: patch.timeoutSeconds,
  });

  if (patch.status) {
    record.status = patch.status;
  }
  if (patch.profile) {
    runtime.profile = patch.profile;
  }
  if (typeof patch.startedAt === "number") {
    runtime.startedAt = patch.startedAt;
  }
  if (typeof patch.timeoutSeconds === "number") {
    runtime.timeoutSeconds = patch.timeoutSeconds;
  }
  if ("progressSummary" in patch) {
    runtime.progressSummary = patch.progressSummary?.trim() ? patch.progressSummary.trim() : undefined;
  }
  if ("terminalResult" in patch) {
    const value = patch.terminalResult?.trim() ? patch.terminalResult : undefined;
    runtime.terminalResult = value;
    record.result = value;
    if (value) {
      runtime.terminalError = undefined;
      record.error = undefined;
    }
  }
  if ("terminalError" in patch) {
    const value = patch.terminalError?.trim() ? patch.terminalError : undefined;
    runtime.terminalError = value;
    record.error = value;
    if (value && !("terminalResult" in patch)) {
      runtime.terminalResult = undefined;
      record.result = undefined;
    }
  }
  if ("completedAt" in patch) {
    if (typeof patch.completedAt === "number") {
      runtime.completedAt = patch.completedAt;
      record.completedAt = patch.completedAt;
      record.lastActiveAt = Math.max(record.lastActiveAt ?? 0, patch.completedAt);
    } else {
      runtime.completedAt = undefined;
      record.completedAt = undefined;
    }
  }
  if (typeof patch.lastActiveAt === "number") {
    record.lastActiveAt = Math.max(record.lastActiveAt ?? 0, patch.lastActiveAt);
  }
  if ("timeoutReason" in patch) {
    record.timeoutReason = patch.timeoutReason;
  }
  if (patch.countEvent !== false) {
    runtime.eventCount += 1;
  }

  return runtime;
}

export class TaskExecutorRuntimeCore<TRecord extends { runId: string }> {
  private readonly records = new Map<string, TRecord>();
  private readonly waiters = new Map<string, Set<(reason: TaskExecutorUpdateReason) => void>>();
  private readonly progressSnapshots = new Map<string, ProgressSnapshot>();
  private readonly ownerUpdateTimestamps = new Map<string, number>();
  private readonly ownerProgressUpdateTimestamps = new Map<string, number>();

  registerRecord(record: TRecord): TRecord {
    this.records.set(record.runId, record);
    return record;
  }

  getRecord(runId: string): TRecord | undefined {
    return this.records.get(runId);
  }

  getRecordsSnapshot(): TRecord[] {
    return [...this.records.values()];
  }

  getRecordsMap(): Map<string, TRecord> {
    return this.records;
  }

  deleteRecord(runId: string): boolean {
    this.clearProgressSnapshot(runId);
    return this.records.delete(runId);
  }

  pruneRecords(
    shouldRemove: (record: TRecord) => boolean,
    onRemove?: (record: TRecord) => void,
  ): number {
    let removed = 0;
    for (const [runId, record] of this.records) {
      if (!shouldRemove(record)) continue;
      onRemove?.(record);
      this.records.delete(runId);
      this.clearProgressSnapshot(runId);
      removed += 1;
    }
    return removed;
  }

  clearRecords(onRemove?: (record: TRecord) => void): void {
    for (const record of this.records.values()) {
      onRemove?.(record);
    }
    this.records.clear();
    this.waiters.clear();
    this.progressSnapshots.clear();
  }

  waitForOwnerUpdate(ownerId: string, timeoutMs: number): Promise<{ reason: TaskExecutorUpdateReason }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason: TaskExecutorUpdateReason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const watchers = this.waiters.get(ownerId);
        if (watchers) {
          watchers.delete(onUpdate);
          if (watchers.size === 0) {
            this.waiters.delete(ownerId);
          }
        }
        resolve({ reason });
      };
      const onUpdate = (reason: TaskExecutorUpdateReason) => finish(reason);
      const watchers = this.waiters.get(ownerId) ?? new Set<(reason: TaskExecutorUpdateReason) => void>();
      watchers.add(onUpdate);
      this.waiters.set(ownerId, watchers);
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
    });
  }

  notifyOwnerUpdate(ownerId: string, opts?: {
    minIntervalMs?: number;
    channel?: "default" | "progress";
  }): boolean {
    const minIntervalMs = Math.max(0, opts?.minIntervalMs ?? 0);
    const now = Date.now();
    const timestampMap = opts?.channel === "progress"
      ? this.ownerProgressUpdateTimestamps
      : this.ownerUpdateTimestamps;
    const previousTimestamp = timestampMap.get(ownerId);
    if (
      minIntervalMs > 0
      && typeof previousTimestamp === "number"
      && now - previousTimestamp < minIntervalMs
    ) {
      return false;
    }
    timestampMap.set(ownerId, now);
    const watchers = this.waiters.get(ownerId);
    if (!watchers?.size) return false;
    for (const watcher of [...watchers]) {
      watcher("task_update");
    }
    return true;
  }

  shouldEmitProgressSnapshot(params: {
    runId: string;
    summary: string;
    timestamp: number;
    streaming: boolean;
  }): boolean {
    const previous = this.progressSnapshots.get(params.runId);
    if (!previous) {
      this.progressSnapshots.set(params.runId, {
        summary: params.summary,
        timestamp: params.timestamp,
        contentLength: params.summary.length,
        streaming: params.streaming,
      });
      return true;
    }

    const elapsed = params.timestamp - previous.timestamp;
    const grewBy = params.summary.length - previous.contentLength;
    const isSameSummary = params.summary === previous.summary;
    const extendsPrevious = params.summary.startsWith(previous.summary) && grewBy >= 0;

    if (params.streaming) {
      if (isSameSummary && elapsed < 1500) {
        return false;
      }
      if (extendsPrevious && grewBy < 64 && elapsed < 900) {
        return false;
      }
    } else if (isSameSummary) {
      return false;
    }

    this.progressSnapshots.set(params.runId, {
      summary: params.summary,
      timestamp: params.timestamp,
      contentLength: params.summary.length,
      streaming: params.streaming,
    });
    return true;
  }

  clearProgressSnapshot(runId: string): void {
    this.progressSnapshots.delete(runId);
  }

  settleRecord(params: {
    canTransition?: () => boolean;
    settledAt?: number;
    apply: (settledAt: number) => void;
  }): {
    transitioned: boolean;
    settledAt: number;
  } {
    const settledAt = params.settledAt ?? Date.now();
    if (params.canTransition && !params.canTransition()) {
      return {
        transitioned: false,
        settledAt,
      };
    }
    params.apply(settledAt);
    return {
      transitioned: true,
      settledAt,
    };
  }

  attachTimeoutMonitor<TTimedRecord extends TRecord & {
    timeoutId?: ReturnType<typeof setInterval>;
  }>(params: {
    record: TTimedRecord;
    intervalMs: number;
    isRunning: (record: TTimedRecord) => boolean;
    getStartedAt: (record: TTimedRecord) => number;
    getLastActiveAt: (record: TTimedRecord) => number;
    getBudgetSeconds: (record: TTimedRecord) => number;
    getIdleLeaseSeconds: (record: TTimedRecord) => number;
    onTimeout: (trigger: TaskExecutorTimeoutTrigger) => void;
  }): void {
    this.clearTimeoutMonitor(params.record);
    params.record.timeoutId = setInterval(() => {
      const trigger = this.detectTimeoutTrigger({
        now: Date.now(),
        isRunning: params.isRunning(params.record),
        startedAt: params.getStartedAt(params.record),
        lastActiveAt: params.getLastActiveAt(params.record),
        budgetSeconds: params.getBudgetSeconds(params.record),
        idleLeaseSeconds: params.getIdleLeaseSeconds(params.record),
      });
      if (!trigger) return;
      params.onTimeout(trigger);
    }, params.intervalMs);
  }

  clearTimeoutMonitor<TTimedRecord extends TRecord & {
    timeoutId?: ReturnType<typeof setInterval>;
  }>(record: TTimedRecord): void {
    if (!record.timeoutId) return;
    clearInterval(record.timeoutId);
    record.timeoutId = undefined;
  }

  detectTimeoutTrigger(params: {
    now: number;
    isRunning: boolean;
    startedAt: number;
    lastActiveAt: number;
    budgetSeconds: number;
    idleLeaseSeconds: number;
  }): TaskExecutorTimeoutTrigger | null {
    if (!params.isRunning) return null;

    const timeoutMs = params.budgetSeconds * 1000;
    if (timeoutMs > 0 && params.now - params.startedAt >= timeoutMs) {
      return {
        reason: "budget",
        now: params.now,
        durationMs: params.now - params.startedAt,
        thresholdSeconds: params.budgetSeconds,
      };
    }

    if (
      params.idleLeaseSeconds > 0
      && params.now - params.lastActiveAt >= params.idleLeaseSeconds * 1000
    ) {
      return {
        reason: "idle",
        now: params.now,
        durationMs: params.now - params.startedAt,
        thresholdSeconds: params.idleLeaseSeconds,
      };
    }

    return null;
  }
}
