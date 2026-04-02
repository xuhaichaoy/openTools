import type { AgentActor } from "./agent-actor";
import type { TimeoutReason } from "./timeout-policy";
import { cloneScopedSourceItems } from "./types";
import type {
  DialogArtifactRecord,
  DialogArtifactSource,
  DialogSubtaskExecutionIntent,
  DialogSubtaskProfile,
  DialogSubtaskRuntimeState,
  ScopedSourceItem,
  SpawnTaskOverrides,
  SpawnedTaskEventDetail,
  SpawnMode,
  SpawnedTaskRecord,
  SpawnedTaskRoleBoundary,
  SpawnedTaskStatus,
  WorkerProfileId,
} from "./types";
import { validateSpawnedTaskResult } from "./spawned-task-result-validator";
import {
  TIMEOUT_CHECK_INTERVAL_MS,
  formatTimeoutError,
} from "./timeout-policy";
import {
  applyTaskExecutorLifecycle,
  ensureTaskExecutorRuntime,
  resetTaskExecutorRuntimeForResume,
  TaskExecutorRuntimeCore,
  type TaskExecutorTimeoutTrigger,
  type TaskExecutorUpdateReason,
} from "./task-executor-runtime-core";
import {
  extractNormalizedStructuredRows,
  inferColumnsFromRows,
  type StructuredRowRecord,
} from "./dynamic-workbook-builder";
import { tryParseStructuredPayload } from "./structured-json-utils";
import { createLogger } from "@/core/logger";
import { getAgentTaskManager } from "@/core/task-center";

const runtimeLogger = createLogger("DialogSubtaskRuntime");
const RESTORED_RUNNING_TASK_ERROR =
  "会话恢复后，之前进行中的子任务无法自动续跑，已标记为中断。";
const RESTORED_RUNNING_SESSION_ERROR =
  "会话恢复后，之前进行中的子会话执行无法自动续跑；你可以继续向该子会话发送消息重新开始。";
const TOOL_PROGRESS_SUMMARY_BY_NAME: Record<string, string> = {
  list_directory: "查看目录",
  read_file: "读取文件",
  read_document: "读取文档",
  export_document: "导出文档",
  export_spreadsheet: "导出表格",
  write_file: "写入文件",
  str_replace_edit: "修改文件",
  json_edit: "更新 JSON",
  run_shell_command: "执行命令",
  persistent_shell: "执行命令",
  wait_for_spawned_tasks: "等待子任务",
  search_web: "搜索资料",
};
const GENERIC_PROGRESS_BY_STEP_TYPE: Record<string, string> = {
  answer: "正在整理结果",
  thinking: "正在分析",
  thought: "正在分析",
};

function compactRuntimeText(value: string | undefined, maxLength = 120): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function looksLikeStructuredBlob(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if ((normalized.startsWith("{") && normalized.endsWith("}")) || (normalized.startsWith("[") && normalized.endsWith("]"))) {
    return true;
  }
  return normalized.length > 160 && /[:{}[\],]/.test(normalized);
}

function summarizeToolProgress(toolName?: string, opts?: {
  prefix?: "正在" | "已";
}): string | undefined {
  const normalizedToolName = String(toolName ?? "").trim();
  if (!normalizedToolName) return undefined;
  const summary = TOOL_PROGRESS_SUMMARY_BY_NAME[normalizedToolName] ?? `调用 ${normalizedToolName}`;
  return `${opts?.prefix ?? "正在"}${summary}`;
}

function summarizeNarrativeProgress(
  content: string | undefined,
  stepType?: string,
): string | undefined {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const structuredItemCount = inferStructuredRowCount(normalized);
  if (typeof structuredItemCount === "number" && structuredItemCount > 0) {
    return `已产出 ${structuredItemCount} 条结构化结果`;
  }
  if (/(?:excel|xlsx|xls|csv|表格|工作簿)/iu.test(normalized)) {
    if (/(?:导出|写入|保存|落盘)/iu.test(normalized)) {
      return "正在导出表格";
    }
    return "正在整理表格结果";
  }
  if (/(?:验证|测试|回归|验收|check|assert)/iu.test(normalized)) {
    return "正在验证结果";
  }
  if (/(?:修复|实现|编码|开发|代码|补丁|页面|组件|接口|调试|debug)/iu.test(normalized)) {
    return stepType === "thinking" || stepType === "thought"
      ? "正在处理实现细节"
      : "正在整理实现结果";
  }
  return GENERIC_PROGRESS_BY_STEP_TYPE[stepType ?? ""];
}

function inferStructuredRowCount(value: string | undefined): number | undefined {
  const payload = tryParseStructuredPayload(value);
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === "object") {
    for (const nested of Object.values(payload as Record<string, unknown>)) {
      if (Array.isArray(nested)) return nested.length;
    }
  }
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const countMatch = normalized.match(/已(?:生成|完成|整理|汇总)?\s*(\d+)\s*(?:门|条|项|个|行|份)/u);
  if (countMatch) {
    const value = Number.parseInt(countMatch[1] || "", 10);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function inferStructuredResultKind(params: {
  status: SpawnedTaskStatus;
  terminalResult?: string;
  terminalError?: string;
  artifacts?: readonly DialogSubtaskArtifactSummary[];
  executionIntent?: DialogSubtaskExecutionIntent;
  resultContract?: "default" | "inline_structured_result";
  structuredRowCount?: number;
}): "structured_rows" | "file_artifact" | "blocker" | "unknown" {
  if (params.status === "error" || params.status === "aborted" || params.terminalError) {
    return "blocker";
  }
  if (params.resultContract === "inline_structured_result") {
    return (params.structuredRowCount ?? 0) > 0 ? "structured_rows" : "blocker";
  }
  if (params.executionIntent === "content_executor" && (params.structuredRowCount ?? 0) > 0) {
    return "structured_rows";
  }
  if ((params.artifacts?.length ?? 0) > 0) {
    return "file_artifact";
  }
  return "unknown";
}

export interface DialogSubtaskArtifactSummary {
  path: string;
  source: DialogArtifactSource;
  timestamp: number;
  relatedRunId?: string;
  preview?: string;
}

type AgentTaskManagerHandle = {
  syncSpawnedTask: (params: {
    sessionId: string;
    record: SpawnedTaskRecord;
    spawnerName?: string;
    targetName?: string;
    pendingMessageCount?: number;
  }) => void;
  clearSession: (sessionId: string) => void;
};

type RuntimeActorEvent = {
  type: string;
  actorId: string;
  timestamp: number;
  detail?: unknown;
};

export interface DialogStructuredSubtaskResult {
  runId: string;
  subtaskId: string;
  targetActorId: string;
  targetActorName: string;
  workerProfileId?: WorkerProfileId;
  resultContract?: "default" | "inline_structured_result";
  deliveryTargetId?: string;
  deliveryTargetLabel?: string;
  sheetName?: string;
  label?: string;
  task: string;
  mode: SpawnMode;
  roleBoundary?: SpawnedTaskRoleBoundary;
  profile: DialogSubtaskProfile;
  executionIntent?: DialogSubtaskExecutionIntent;
  status: SpawnedTaskStatus;
  progressSummary?: string;
  terminalResult?: string;
  terminalError?: string;
  startedAt: number;
  completedAt?: number;
  timeoutSeconds?: number;
  eventCount: number;
  sessionOpen?: boolean;
  timeoutReason?: TimeoutReason;
  budgetSeconds?: number;
  idleLeaseSeconds?: number;
  artifacts?: DialogSubtaskArtifactSummary[];
  resultKind?: "structured_rows" | "file_artifact" | "blocker" | "unknown";
  rowCount?: number;
  schemaFields?: string[];
  structuredRows?: StructuredRowRecord[];
  sourceItemIds?: string[];
  sourceItemCount?: number;
  scopedSourceItems?: ScopedSourceItem[];
  blocker?: string;
}

export function resolveDialogSubtaskProfile(
  roleBoundary?: SpawnedTaskRoleBoundary,
): DialogSubtaskProfile {
  switch (roleBoundary) {
    case "executor":
    case "reviewer":
    case "validator":
      return roleBoundary;
    default:
      return "general";
  }
}

export function ensureDialogSubtaskRuntime(
  record: SpawnedTaskRecord,
  opts?: {
    subtaskId?: string;
    profile?: DialogSubtaskProfile;
    startedAt?: number;
    timeoutSeconds?: number;
  },
): DialogSubtaskRuntimeState {
  return ensureTaskExecutorRuntime(record, {
    subtaskId: opts?.subtaskId ?? record.runId,
    profile: opts?.profile ?? resolveDialogSubtaskProfile(record.roleBoundary),
    startedAt: opts?.startedAt,
    timeoutSeconds: opts?.timeoutSeconds ?? record.budgetSeconds,
  });
}

export function resetDialogSubtaskRuntimeForResume(
  record: SpawnedTaskRecord,
): DialogSubtaskRuntimeState {
  return resetTaskExecutorRuntimeForResume(record, {
    subtaskId: record.runId,
    profile: resolveDialogSubtaskProfile(record.roleBoundary),
    timeoutSeconds: record.budgetSeconds,
  });
}

export function applyDialogSubtaskLifecycle(
  record: SpawnedTaskRecord,
  patch: {
    status?: SpawnedTaskStatus;
    profile?: DialogSubtaskProfile;
    progressSummary?: string | null;
    terminalResult?: string | null;
    terminalError?: string | null;
    startedAt?: number;
    completedAt?: number | null;
    timeoutSeconds?: number;
    lastActiveAt?: number;
    timeoutReason?: TimeoutReason;
    countEvent?: boolean;
  },
): DialogSubtaskRuntimeState {
  return applyTaskExecutorLifecycle(record, patch, {
    subtaskId: record.runId,
    fallbackProfile: resolveDialogSubtaskProfile(record.roleBoundary),
  });
}

export function buildDialogSubtaskEventDetail(
  record: SpawnedTaskRecord,
  names: {
    targetName: string;
    spawnerName: string;
  },
  overrides?: Partial<SpawnedTaskEventDetail>,
): SpawnedTaskEventDetail {
  const runtime = ensureDialogSubtaskRuntime(record);

  return {
    runId: record.runId,
    spawnerActorId: record.spawnerActorId,
    ownerTaskId: record.ownerTaskId,
    targetActorId: record.targetActorId,
    targetName: names.targetName,
    spawnerName: names.spawnerName,
    contractId: record.contractId,
    plannedDelegationId: record.plannedDelegationId,
    dispatchSource: record.dispatchSource,
    parentRunId: record.parentRunId,
    rootRunId: record.rootRunId,
    mode: record.mode,
    roleBoundary: record.roleBoundary,
    label: record.label,
    task: record.task,
    status: record.status,
    result: record.result,
    error: record.error,
    budgetSeconds: record.budgetSeconds,
    idleLeaseSeconds: record.idleLeaseSeconds,
    timeoutReason: record.timeoutReason,
    subtaskId: runtime.subtaskId,
    profile: runtime.profile,
    executionIntent: record.executionIntent,
    progressSummary: runtime.progressSummary,
    terminalResult: runtime.terminalResult,
    terminalError: runtime.terminalError,
    timeoutSeconds: runtime.timeoutSeconds,
    eventCount: runtime.eventCount,
    ...overrides,
  };
}

export function buildDialogSubtaskWaitResult(
  tasks: readonly SpawnedTaskRecord[],
  actorNameById: ReadonlyMap<string, string>,
  artifactRecords: readonly DialogArtifactRecord[] = [],
): {
  wait_complete: boolean;
  summary: string;
  pending_count: number;
  completed_count: number;
  failed_count: number;
  buffered_terminal_count: number;
  aggregation_ready: boolean;
  tasks: Array<{
    task_id: string;
    subtask_id: string;
    target_actor_id: string;
    target_actor_name: string;
    label?: string;
    task: string;
    mode: SpawnedTaskRecord["mode"];
    role_boundary?: SpawnedTaskRoleBoundary;
    profile: DialogSubtaskProfile;
    execution_intent?: DialogSubtaskExecutionIntent;
    status: SpawnedTaskStatus;
    progress_summary?: string;
    terminal_result?: string;
    terminal_error?: string;
    result?: string;
    error?: string;
    started_at: number;
    completed_at?: number;
    timeout_seconds?: number;
    event_count: number;
    session_open?: boolean;
    timeout_reason?: TimeoutReason;
    budget_seconds?: number;
    idle_lease_seconds?: number;
    artifacts?: DialogSubtaskArtifactSummary[];
    result_kind?: "structured_rows" | "file_artifact" | "blocker" | "unknown";
    row_count?: number;
    schema_fields?: string[];
    source_item_ids?: string[];
    source_item_count?: number;
    blocker?: string;
  }>;
} {
  const structuredTasks = buildDialogStructuredSubtaskResults(tasks, actorNameById, artifactRecords)
    .map((task) => ({
      task_id: task.runId,
      subtask_id: task.subtaskId,
      target_actor_id: task.targetActorId,
      target_actor_name: task.targetActorName,
      label: task.label,
      task: task.task,
      mode: task.mode,
      role_boundary: task.roleBoundary,
      profile: task.profile,
      execution_intent: task.executionIntent,
      status: task.status,
      progress_summary: task.progressSummary,
      terminal_result: task.terminalResult,
      terminal_error: task.terminalError,
      result: task.terminalResult,
      error: task.terminalError,
      started_at: task.startedAt,
      completed_at: task.completedAt,
      timeout_seconds: task.timeoutSeconds,
      event_count: task.eventCount,
      session_open: task.sessionOpen,
      timeout_reason: task.timeoutReason,
      budget_seconds: task.budgetSeconds,
      idle_lease_seconds: task.idleLeaseSeconds,
      artifacts: task.artifacts,
      result_kind: task.resultKind,
      row_count: task.rowCount,
      schema_fields: task.schemaFields,
      source_item_ids: task.sourceItemIds,
      source_item_count: task.sourceItemCount,
      scoped_source_items: task.scopedSourceItems,
      blocker: task.blocker,
    }));
  const pendingCount = structuredTasks.filter((task) => task.status === "running").length;
  const completedCount = structuredTasks.filter((task) => task.status === "completed").length;
  const failedCount = structuredTasks.length - pendingCount - completedCount;
  const bufferedTerminalCount = structuredTasks.length - pendingCount;

  let summary = "当前并未发现派发任何子任务。";
  if (structuredTasks.length > 0) {
    if (pendingCount > 0) {
      summary = `仍有 ${pendingCount} 个子任务运行中，继续等待其结构化结果。`;
    } else if (failedCount > 0) {
      summary = `所有已派发子任务均已结束，其中 ${failedCount} 个失败或中止。请基于结构化结果做最终整合。`;
    } else {
      summary = "所有已派发子任务均已完成。请基于结构化结果做最终整合。";
    }
  }

  return {
    wait_complete: pendingCount === 0,
    summary,
    pending_count: pendingCount,
    completed_count: completedCount,
    failed_count: failedCount,
    buffered_terminal_count: bufferedTerminalCount,
    aggregation_ready: pendingCount === 0 && bufferedTerminalCount > 0,
    tasks: structuredTasks,
  };
}

function summarizeArtifactRecord(record: DialogArtifactRecord): DialogSubtaskArtifactSummary {
  return {
    path: record.path,
    source: record.source,
    timestamp: record.timestamp,
    relatedRunId: record.relatedRunId,
    preview: compactRuntimeText(record.preview ?? record.summary, 80),
  };
}

function collectScopedSubtaskArtifactRecords(
  task: SpawnedTaskRecord,
  artifactRecords: readonly DialogArtifactRecord[],
): DialogArtifactRecord[] {
  if (artifactRecords.length === 0) return [];
  const completedAt = task.completedAt ?? task.runtime?.completedAt ?? Number.POSITIVE_INFINITY;
  const directMatches = artifactRecords.filter((artifact) => artifact.relatedRunId === task.runId);
  const scopedArtifacts = directMatches.length > 0
    ? directMatches
    : artifactRecords.filter((artifact) => {
      if (artifact.actorId !== task.targetActorId) return false;
      return artifact.timestamp >= task.spawnedAt - 1000 && artifact.timestamp <= completedAt;
    });
  const deduped = new Map<string, DialogArtifactRecord>();
  for (const artifact of scopedArtifacts) {
    deduped.set(`${artifact.path}::${artifact.source}`, artifact);
  }
  return [...deduped.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function collectSubtaskArtifacts(
  task: SpawnedTaskRecord,
  artifactRecords: readonly DialogArtifactRecord[],
): DialogSubtaskArtifactSummary[] {
  return collectScopedSubtaskArtifactRecords(task, artifactRecords)
    .map((artifact) => summarizeArtifactRecord(artifact));
}

function buildStructuredRowKey(row: StructuredRowRecord): string {
  return JSON.stringify(
    Object.entries(row)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function appendUniqueStructuredRows(
  rows: StructuredRowRecord[],
  rowKeys: Set<string>,
  nextRows: readonly StructuredRowRecord[],
): void {
  for (const row of nextRows) {
    const rowKey = buildStructuredRowKey(row);
    if (rowKeys.has(rowKey)) continue;
    rowKeys.add(rowKey);
    rows.push({ ...row });
  }
}

function extractStructuredRowsFromArtifacts(params: {
  baseResult: DialogStructuredSubtaskResult;
  artifactRecords: readonly DialogArtifactRecord[];
}): StructuredRowRecord[] {
  const rows: StructuredRowRecord[] = [];
  const rowKeys = new Set<string>();

  for (const artifact of params.artifactRecords) {
    const contentCandidates = [
      artifact.fullContent,
      artifact.preview,
    ]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);

    for (const content of contentCandidates) {
      if (!looksLikeStructuredBlob(content) && !tryParseStructuredPayload(content)) {
        continue;
      }
      const extractedRows = extractNormalizedStructuredRows({
        result: {
          ...params.baseResult,
          terminalResult: content,
          terminalError: undefined,
          structuredRows: undefined,
        },
      });
      if (extractedRows.length === 0) continue;
      appendUniqueStructuredRows(rows, rowKeys, extractedRows);
      break;
    }
  }

  return rows;
}

export function buildDialogStructuredSubtaskResults(
  tasks: readonly SpawnedTaskRecord[],
  actorNameById: ReadonlyMap<string, string>,
  artifactRecords: readonly DialogArtifactRecord[] = [],
): DialogStructuredSubtaskResult[] {
  return [...tasks]
    .sort((left, right) => left.spawnedAt - right.spawnedAt)
    .map((task) => {
      const runtime = ensureDialogSubtaskRuntime(task);
      const terminalResult = runtime.terminalResult ?? task.result;
      const terminalError = runtime.terminalError ?? task.error;
      const scopedArtifactRecords = collectScopedSubtaskArtifactRecords(task, artifactRecords);
      const artifacts = scopedArtifactRecords.map((artifact) => summarizeArtifactRecord(artifact));
      const baseResult: DialogStructuredSubtaskResult = {
        runId: task.runId,
        subtaskId: runtime.subtaskId,
        targetActorId: task.targetActorId,
        targetActorName: actorNameById.get(task.targetActorId) ?? task.targetActorId,
        workerProfileId: task.workerProfileId,
        resultContract: task.resultContract,
        deliveryTargetId: task.deliveryTargetId,
        deliveryTargetLabel: task.deliveryTargetLabel,
        sheetName: task.sheetName,
        label: task.label,
        task: task.task,
        mode: task.mode,
        roleBoundary: task.roleBoundary,
        profile: runtime.profile,
        executionIntent: task.executionIntent,
        status: task.status,
        progressSummary: runtime.progressSummary,
        terminalResult,
        terminalError,
        startedAt: runtime.startedAt ?? task.spawnedAt,
        completedAt: runtime.completedAt ?? task.completedAt,
        timeoutSeconds: runtime.timeoutSeconds ?? task.budgetSeconds,
        eventCount: runtime.eventCount,
        sessionOpen: task.sessionOpen,
        timeoutReason: task.timeoutReason,
        budgetSeconds: task.budgetSeconds,
        idleLeaseSeconds: task.idleLeaseSeconds,
        artifacts,
        sourceItemIds: task.sourceItemIds ? [...task.sourceItemIds] : undefined,
        sourceItemCount: task.sourceItemCount,
        scopedSourceItems: cloneScopedSourceItems(task.scopedSourceItems),
      };
      const structuredRowsFromTerminal = extractNormalizedStructuredRows({ result: baseResult });
      const structuredRows = structuredRowsFromTerminal.length > 0
        ? structuredRowsFromTerminal
        : extractStructuredRowsFromArtifacts({
            baseResult,
            artifactRecords: scopedArtifactRecords,
          });
      const rowCount = structuredRows.length > 0
        ? structuredRows.length
        : inferStructuredRowCount(terminalResult);
      const schemaFields = structuredRows.length > 0
        ? inferColumnsFromRows(structuredRows)
        : undefined;
      const inlineStructuredContractViolated = (
        task.resultContract === "inline_structured_result"
        && task.status === "completed"
        && structuredRows.length === 0
        && artifacts.length === 0
      );
      const blocker = terminalError
        ?? (inlineStructuredContractViolated
          ? "当前子任务声明为 inline_structured_result，但没有返回任何结构化 rows。"
          : undefined)
        ?? (/阻塞(?:原因|点)?[:：]?/u.test(String(terminalResult ?? "")) ? terminalResult : undefined);
      return {
        runId: task.runId,
        subtaskId: runtime.subtaskId,
        targetActorId: task.targetActorId,
        targetActorName: actorNameById.get(task.targetActorId) ?? task.targetActorId,
        workerProfileId: task.workerProfileId,
        resultContract: task.resultContract,
        deliveryTargetId: task.deliveryTargetId,
        deliveryTargetLabel: task.deliveryTargetLabel,
        sheetName: task.sheetName,
        label: task.label,
        task: task.task,
        mode: task.mode,
        roleBoundary: task.roleBoundary,
        profile: runtime.profile,
        executionIntent: task.executionIntent,
        status: task.status,
        progressSummary: runtime.progressSummary,
        terminalResult,
        terminalError,
        startedAt: runtime.startedAt ?? task.spawnedAt,
        completedAt: runtime.completedAt ?? task.completedAt,
        timeoutSeconds: runtime.timeoutSeconds ?? task.budgetSeconds,
        eventCount: runtime.eventCount,
        sessionOpen: task.sessionOpen,
        timeoutReason: task.timeoutReason,
        budgetSeconds: task.budgetSeconds,
        idleLeaseSeconds: task.idleLeaseSeconds,
        artifacts,
        resultKind: inferStructuredResultKind({
          status: task.status,
          terminalResult,
          terminalError,
          artifacts,
          executionIntent: task.executionIntent,
          resultContract: task.resultContract,
          structuredRowCount: structuredRows.length,
        }),
        rowCount,
        schemaFields,
        structuredRows,
        sourceItemIds: task.sourceItemIds ? [...task.sourceItemIds] : undefined,
        sourceItemCount: task.sourceItemCount,
        scopedSourceItems: cloneScopedSourceItems(task.scopedSourceItems),
        blocker,
      };
    });
}

type DialogSubtaskRuntimeDeps = {
  sessionId: string;
  getActor: (actorId: string) => AgentActor | undefined;
  getActorName: (actorId: string) => string;
  getActorNames: () => ReadonlyMap<string, string>;
  emitEvent: (event: RuntimeActorEvent) => void;
  appendSpawnEvent: (spawnerActorId: string, targetActorId: string, task: string, runId: string) => void;
  appendAnnounceEvent: (
    runId: string,
    status: "completed" | "error" | "aborted",
    result?: string,
    error?: string,
  ) => void;
  announceWithRetry: (
    fromActorId: string,
    toActorId: string,
    content: string,
    runId: string,
  ) => void;
  finalizeSpawnedTaskHistoryWindow: (record: SpawnedTaskRecord, targetActor?: AgentActor) => void;
  cancelPendingInteractionsForActor: (actorId: string) => number;
  killActor: (actorId: string) => void;
  getArtifactRecordsSnapshot: () => DialogArtifactRecord[];
  onTaskSettled?: (params: {
    record: SpawnedTaskRecord;
    targetActorId: string;
    targetName: string;
    status: "completed" | "error" | "aborted";
    task: string;
  }) => void;
};

export interface DialogSubtaskExecutionParams {
  record: SpawnedTaskRecord;
  target: AgentActor;
  fullTask: string;
  images?: string[];
  runOverrides?: SpawnTaskOverrides;
}

export class DialogSubtaskRuntime {
  private readonly core = new TaskExecutorRuntimeCore<SpawnedTaskRecord>();
  private readonly progressListeners = new Map<string, () => void>();
  private readonly deps: DialogSubtaskRuntimeDeps;
  private focusedSessionRunId: string | null = null;

  constructor(deps: DialogSubtaskRuntimeDeps) {
    this.deps = deps;
  }

  replaceSessionId(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || normalizedSessionId === this.deps.sessionId) return;

    const previousSessionId = this.deps.sessionId;
    const manager = this.getAgentTaskManager();
    manager?.clearSession(previousSessionId);
    this.deps.sessionId = normalizedSessionId;

    for (const record of this.records.values()) {
      this.syncAgentTaskRecord(record);
    }
  }

  private get records(): Map<string, SpawnedTaskRecord> {
    return this.core.getRecordsMap();
  }

  registerRecord(record: SpawnedTaskRecord): DialogSubtaskRuntimeState {
    this.core.registerRecord(record);
    return ensureDialogSubtaskRuntime(record, {
      subtaskId: record.runId,
      profile: resolveDialogSubtaskProfile(record.roleBoundary),
      startedAt: record.spawnedAt,
      timeoutSeconds: record.budgetSeconds,
    });
  }

  restoreRecord(record: SpawnedTaskRecord): DialogSubtaskRuntimeState {
    const wasRunning = record.status === "running";
    const runtime = ensureDialogSubtaskRuntime(record, {
      subtaskId: record.runId,
      profile: resolveDialogSubtaskProfile(record.roleBoundary),
      startedAt: record.spawnedAt,
      timeoutSeconds: record.budgetSeconds,
    });
    this.core.registerRecord(record);
    if (wasRunning) {
      this.reconcileRestoredRunningRecord(record);
    } else {
      this.syncAgentTaskRecord(record);
    }
    return runtime;
  }

  getSpawnedTasks(
    actorId: string,
    opts?: {
      ownerTaskId?: string;
    },
  ): SpawnedTaskRecord[] {
    const ownerTaskId = opts?.ownerTaskId?.trim();
    return [...this.records.values()].filter((record) => (
      record.spawnerActorId === actorId
      && (!ownerTaskId || record.ownerTaskId === ownerTaskId)
    ));
  }

  getActiveSpawnedTasks(
    actorId: string,
    opts?: {
      ownerTaskId?: string;
    },
  ): SpawnedTaskRecord[] {
    return this.getSpawnedTasks(actorId, opts).filter((record) => record.status === "running");
  }

  abortActiveRunTasksForSpawner(
    spawnerActorId: string,
    error: string,
    opts?: {
      excludeOwnerTaskId?: string;
    },
  ): number {
    const excludeOwnerTaskId = opts?.excludeOwnerTaskId?.trim();
    const activeRunTasks = [...this.records.values()].filter((record) =>
      record.spawnerActorId === spawnerActorId
      && record.mode === "run"
      && record.status === "running"
      && (!excludeOwnerTaskId || record.ownerTaskId !== excludeOwnerTaskId)
    );

    for (const record of activeRunTasks) {
      this.abortTask(record, {
        error,
        targetActor: this.deps.getActor(record.targetActorId),
      });
    }

    return activeRunTasks.length;
  }

  buildWaitForSpawnedTasksResult(
    actorId: string,
    opts?: {
      ownerTaskId?: string;
    },
  ) {
    return buildDialogSubtaskWaitResult(
      this.getSpawnedTasks(actorId, opts),
      this.deps.getActorNames(),
      this.deps.getArtifactRecordsSnapshot(),
    );
  }

  collectStructuredSpawnedTaskResults(
    actorId: string,
    opts?: {
      ownerTaskId?: string;
      terminalOnly?: boolean;
      excludeRunIds?: Iterable<string>;
    },
  ): DialogStructuredSubtaskResult[] {
    const excluded = new Set(opts?.excludeRunIds ?? []);
    const structured = buildDialogStructuredSubtaskResults(
      this.getSpawnedTasks(actorId, { ownerTaskId: opts?.ownerTaskId }).filter((task) => !excluded.has(task.runId)),
      this.deps.getActorNames(),
      this.deps.getArtifactRecordsSnapshot(),
    );
    if (opts?.terminalOnly === false) {
      return structured;
    }
    return structured.filter((task) => task.status !== "running");
  }

  getStructuredSubtaskResult(runId: string): DialogStructuredSubtaskResult | undefined {
    const record = this.records.get(runId);
    if (!record) return undefined;
    return buildDialogStructuredSubtaskResults(
      [record],
      this.deps.getActorNames(),
      this.deps.getArtifactRecordsSnapshot(),
    )[0];
  }

  getSpawnedTask(runId: string): SpawnedTaskRecord | undefined {
    return this.core.getRecord(runId);
  }

  getSpawnedTasksSnapshot(): SpawnedTaskRecord[] {
    return this.core.getRecordsSnapshot();
  }

  getSpawnedTasksMap(): Map<string, SpawnedTaskRecord> {
    return this.core.getRecordsMap();
  }

  getOpenSessionByRunId(runId: string): SpawnedTaskRecord | undefined {
    const record = this.records.get(runId);
    if (!record || record.mode !== "session" || !record.sessionOpen) return undefined;
    return record;
  }

  getOpenSessionByTarget(targetActorId: string): SpawnedTaskRecord | undefined {
    return [...this.records.values()]
      .filter((record) => record.mode === "session" && record.sessionOpen && record.targetActorId === targetActorId)
      .sort((a, b) => (b.lastActiveAt ?? b.spawnedAt) - (a.lastActiveAt ?? a.spawnedAt))[0];
  }

  getRelatedRunIdForActor(actorId: string): string | undefined {
    return this.getOpenSessionByTarget(actorId)?.runId
      ?? this.getOwningTaskForActor(actorId)?.runId
      ?? [...this.records.values()]
        .filter((record) => record.targetActorId === actorId)
        .sort((left, right) => {
          const leftTimestamp = left.lastActiveAt
            ?? left.completedAt
            ?? left.runtime?.completedAt
            ?? left.runtime?.startedAt
            ?? left.spawnedAt;
          const rightTimestamp = right.lastActiveAt
            ?? right.completedAt
            ?? right.runtime?.completedAt
            ?? right.runtime?.startedAt
            ?? right.spawnedAt;
          return rightTimestamp - leftTimestamp;
        })[0]?.runId;
  }

  getFocusedSessionRunId(): string | null {
    return this.focusedSessionRunId;
  }

  focusSession(runId: string | null): void {
    if (runId === null) {
      this.focusedSessionRunId = null;
      return;
    }
    const record = this.touchOpenSessionRun(runId);
    if (!record) {
      throw new Error(`Spawned session ${runId} 不存在或已关闭`);
    }
    this.focusedSessionRunId = runId;
  }

  getOwningTaskForActor(actorId: string): SpawnedTaskRecord | undefined {
    return [...this.records.values()]
      .filter((record) =>
        record.targetActorId === actorId
        && (
          record.status === "running"
          || (record.mode === "session" && record.sessionOpen)
        ))
      .sort((a, b) => (b.lastActiveAt ?? b.spawnedAt) - (a.lastActiveAt ?? a.spawnedAt))[0];
  }

  getDescendantTasks(
    actorId: string,
    opts?: {
      ownerTaskId?: string;
    },
  ): Array<SpawnedTaskRecord & { depth: number }> {
    const result: Array<SpawnedTaskRecord & { depth: number }> = [];
    const visited = new Set<string>();
    const taskByParentRunId = new Map<string, SpawnedTaskRecord[]>();
    const ownerTaskId = opts?.ownerTaskId?.trim();

    for (const record of this.records.values()) {
      if (ownerTaskId && record.ownerTaskId !== ownerTaskId) continue;
      if (!record.parentRunId) continue;
      const bucket = taskByParentRunId.get(record.parentRunId) ?? [];
      bucket.push(record);
      taskByParentRunId.set(record.parentRunId, bucket);
    }

    const collect = (records: SpawnedTaskRecord[], depth: number) => {
      for (const child of records) {
        if (visited.has(child.runId)) continue;
        visited.add(child.runId);
        result.push({ ...child, depth });
        collect(taskByParentRunId.get(child.runId) ?? [], depth + 1);
      }
    };

    const roots = this.getSpawnedTasks(actorId, { ownerTaskId }).sort((a, b) => a.spawnedAt - b.spawnedAt);
    collect(roots, 1);
    return result;
  }

  getSpawnDepth(actorId: string): number {
    let depth = 0;
    let currentRecord = this.getOwningTaskForActor(actorId);
    const visited = new Set<string>();
    while (true) {
      if (!currentRecord) break;
      if (visited.has(currentRecord.runId)) break;
      visited.add(currentRecord.runId);
      depth += 1;
      currentRecord = currentRecord.parentRunId
        ? this.getSpawnedTask(currentRecord.parentRunId)
        : undefined;
    }
    return depth;
  }

  hasActiveSpawnedTasks(): boolean {
    return [...this.records.values()].some((record) =>
      record.status === "running" || (record.mode === "session" && record.sessionOpen)
    );
  }

  pruneCompletedTasks(): number {
    return this.core.pruneRecords(
      (record) => record.status !== "running",
      (record) => {
        this.clearTimeoutMonitor(record);
        this.detachProgressListener(record.runId);
      },
    );
  }

  pruneCompletedTasksForSpawner(
    spawnerActorId: string,
    opts?: {
      excludeOwnerTaskId?: string;
    },
  ): number {
    const excludeOwnerTaskId = opts?.excludeOwnerTaskId?.trim();
    return this.core.pruneRecords(
      (record) => (
        record.spawnerActorId === spawnerActorId
        && record.status !== "running"
        && (!excludeOwnerTaskId || record.ownerTaskId !== excludeOwnerTaskId)
      ),
      (record) => {
        this.clearTimeoutMonitor(record);
        this.detachProgressListener(record.runId);
      },
    );
  }

  clearAll(): void {
    const manager = this.getAgentTaskManager();
    for (const record of this.records.values()) {
      this.clearTimeoutMonitor(record);
      this.detachProgressListener(record.runId);
      if (record.sessionOpen) {
        this.closeSession(record);
      }
    }
    this.core.clearRecords();
    this.progressListeners.clear();
    this.focusedSessionRunId = null;
    manager?.clearSession(this.deps.sessionId);
  }

  waitForSpawnedTaskUpdate(actorId: string, timeoutMs: number): Promise<{ reason: TaskExecutorUpdateReason }> {
    return this.core.waitForOwnerUpdate(actorId, timeoutMs);
  }

  notifySpawnedTaskUpdate(actorId: string, opts?: {
    minIntervalMs?: number;
    channel?: "default" | "progress";
  }): boolean {
    return this.core.notifyOwnerUpdate(actorId, opts);
  }

  markSessionTaskStarted(actorId: string, timestamp: number): void {
    let touched = false;
    for (const record of this.records.values()) {
      if (record.mode !== "session" || !record.sessionOpen || record.targetActorId !== actorId) continue;
      resetDialogSubtaskRuntimeForResume(record);
      record.status = "running";
      record.lastActiveAt = timestamp;
      record.sessionHistoryEndIndex = undefined;
      touched = true;
      this.syncAgentTaskRecord(record);
      this.notifySpawnedTaskUpdate(record.spawnerActorId);
    }
    if (touched) {
      runtimeLogger.info(`session task started: actor=${actorId}`);
    }
  }

  touchSessionActivity(
    actorId: string,
    timestamp: number,
    progressSummary?: string,
  ): void {
    for (const record of this.records.values()) {
      if (record.mode !== "session" || !record.sessionOpen || record.targetActorId !== actorId) continue;
      if (progressSummary?.trim()) {
        this.applyLifecycle(record, {
          lastActiveAt: timestamp,
          progressSummary,
        });
      } else {
        ensureDialogSubtaskRuntime(record, {
          subtaskId: record.runId,
          profile: resolveDialogSubtaskProfile(record.roleBoundary),
          startedAt: record.spawnedAt,
          timeoutSeconds: record.budgetSeconds,
        });
        record.lastActiveAt = timestamp;
        this.syncAgentTaskRecord(record);
        this.notifySpawnedTaskUpdate(record.spawnerActorId);
      }
    }
  }

  markSessionTaskEnded(
    actorId: string,
    status: "completed" | "error" | "aborted",
    timestamp: number,
    detail?: { result?: string; error?: string },
  ): void {
    for (const record of this.records.values()) {
      if (record.mode !== "session" || !record.sessionOpen || record.targetActorId !== actorId) continue;
      this.applyLifecycle(record, {
        status,
        completedAt: timestamp,
        lastActiveAt: timestamp,
        ...(typeof detail?.result === "string" ? { terminalResult: detail.result } : {}),
        ...(typeof detail?.error === "string" ? { terminalError: detail.error } : {}),
        countEvent: false,
      });
      record.sessionHistoryEndIndex = this.deps.getActor(record.targetActorId)?.getSessionHistory().length
        ?? record.sessionHistoryEndIndex;
    }
  }

  closeSession(record: SpawnedTaskRecord, closedAt = Date.now()): void {
    if (!record.sessionOpen) return;
    record.sessionOpen = false;
    record.sessionClosedAt = closedAt;
    record.lastActiveAt = closedAt;
    record.sessionHistoryEndIndex = this.deps.getActor(record.targetActorId)?.getSessionHistory().length
      ?? record.sessionHistoryEndIndex;
    if (this.focusedSessionRunId === record.runId) {
      this.focusedSessionRunId = null;
    }
    this.syncAgentTaskRecord(record);
    this.notifySpawnedTaskUpdate(record.spawnerActorId);
  }

  closeSessionByRunId(runId: string, closedAt = Date.now()): SpawnedTaskRecord | undefined {
    const record = this.getOpenSessionByRunId(runId);
    if (!record) return undefined;
    this.closeSession(record, closedAt);
    return record;
  }

  touchOpenSessionRun(runId: string, timestamp = Date.now()): SpawnedTaskRecord | undefined {
    const record = this.getOpenSessionByRunId(runId);
    if (!record) return undefined;
    record.lastActiveAt = Math.max(record.lastActiveAt ?? 0, timestamp);
    this.syncAgentTaskRecord(record);
    this.notifySpawnedTaskUpdate(record.spawnerActorId);
    return record;
  }

  refreshTaskProjection(runId: string, opts?: { notifyOwner?: boolean }): SpawnedTaskRecord | undefined {
    const record = this.records.get(runId);
    if (!record) return undefined;
    this.syncAgentTaskRecord(record);
    if (opts?.notifyOwner !== false) {
      this.notifySpawnedTaskUpdate(record.spawnerActorId);
    }
    return record;
  }

  resetSessionTaskForResume(
    record: SpawnedTaskRecord,
    params?: {
      timestamp?: number;
      label?: string;
      images?: string[];
      reopenSession?: boolean;
    },
  ): DialogSubtaskRuntimeState {
    const timestamp = params?.timestamp ?? Date.now();
    const runtime = resetDialogSubtaskRuntimeForResume(record);
    record.status = "running";
    record.lastActiveAt = timestamp;
    record.sessionHistoryEndIndex = undefined;
    if (params?.label) {
      record.label = params.label;
    }
    if (params?.images?.length) {
      record.images = [...new Set([...(record.images ?? []), ...params.images])];
    }
    if (params?.reopenSession) {
      record.sessionOpen = true;
      record.sessionClosedAt = undefined;
    }
    this.syncAgentTaskRecord(record);
    this.notifySpawnedTaskUpdate(record.spawnerActorId);
    return runtime;
  }

  startTask(params: DialogSubtaskExecutionParams): SpawnedTaskRecord {
    const { record, target } = params;
    const spawnerName = this.deps.getActorName(record.spawnerActorId);
    const targetName = this.deps.getActorName(record.targetActorId);
    this.registerRecord(record);
    this.deps.appendSpawnEvent(record.spawnerActorId, record.targetActorId, record.task, record.runId);
    this.syncTaskQueueCreate(record, spawnerName, targetName);
    runtimeLogger.info(
      `spawn task start: ${spawnerName} -> ${targetName}, runId=${record.runId}, mode=${record.mode}, budget=${record.budgetSeconds}s, idleLease=${record.idleLeaseSeconds}s`,
    );

    this.applyLifecycle(record, {
      status: "running",
      startedAt: record.spawnedAt,
      timeoutSeconds: record.budgetSeconds,
    });
    this.deps.emitEvent({
      type: "spawned_task_started",
      actorId: record.targetActorId,
      timestamp: record.spawnedAt,
      detail: this.buildEventDetail(record, {
        status: "running",
        elapsed: 0,
      }),
    });

    this.attachProgressListener(record, target);
    this.attachTimeoutMonitor(record, target);

    void target.assignTask(params.fullTask, params.images, {
      publishResult: false,
      runOverrides: params.runOverrides,
    }).then((taskResult) => {
      this.detachProgressListener(record.runId);
      this.clearTimeoutMonitor(record);
      if (record.status !== "running") return;

      if (taskResult.status === "completed" && taskResult.result) {
        const validation = validateSpawnedTaskResult({
          task: record,
          result: taskResult.result,
          artifacts: this.deps.getArtifactRecordsSnapshot(),
        });
        if (!validation.accepted) {
          const errorMessage = validation.reason ?? "子任务结果未通过有效性校验";
          this.failTask(record, target, targetName, {
            status: "error",
            error: errorMessage,
            resultStatus: "error",
            announceContent: record.expectsCompletionMessage
              ? `[Task failed: ${record.label ?? record.task.slice(0, 30)}]\n\nError: ${errorMessage}`
              : undefined,
            transcriptStatus: "error",
            queueError: errorMessage,
            logLabel: "INVALID_RESULT",
          });
          return;
        }

        this.completeTask(record, target, targetName, {
          result: taskResult.result,
        });
        return;
      }

      this.failTask(record, target, targetName, {
        status: taskResult.status === "aborted" ? "aborted" : "error",
        error: taskResult.error ?? "unknown error",
        resultStatus: taskResult.status === "aborted" ? "aborted" : "error",
        announceContent: record.expectsCompletionMessage
          ? `[Task failed: ${record.label ?? record.task.slice(0, 30)}]\n\nError: ${taskResult.error ?? "unknown error"}`
          : undefined,
        transcriptStatus: taskResult.status === "aborted" ? "aborted" : "error",
        queueError: taskResult.error ?? "unknown",
        logLabel: "FAILED",
      });
    }).catch((error) => {
      this.detachProgressListener(record.runId);
      this.clearTimeoutMonitor(record);
      if (record.status !== "running") return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.failTask(record, target, targetName, {
        status: "error",
        error: errorMessage || "unknown error",
        resultStatus: "error",
        announceContent: record.expectsCompletionMessage
          ? `[Task failed: ${record.label ?? record.task.slice(0, 30)}]\n\nError: ${errorMessage || "unknown error"}`
          : undefined,
        transcriptStatus: "error",
        queueError: errorMessage || "unknown",
        logLabel: "REJECTED",
      });
    });

    return record;
  }

  abortTask(
    record: SpawnedTaskRecord,
    options: {
      error: string;
      targetActor?: AgentActor;
    },
  ): void {
    if (record.status !== "running" && !(record.mode === "session" && record.sessionOpen)) {
      return;
    }
    this.detachProgressListener(record.runId);
    this.clearTimeoutMonitor(record);
    const targetActor = options.targetActor ?? this.deps.getActor(record.targetActorId);
    const transition = this.core.settleRecord({
      canTransition: () => record.status === "running" || Boolean(record.mode === "session" && record.sessionOpen),
      apply: (abortedAt) => {
        this.applyLifecycle(record, {
          status: "aborted",
          completedAt: abortedAt,
          lastActiveAt: abortedAt,
          terminalError: options.error,
        });
      },
    });
    if (!transition.transitioned) return;
    const abortedAt = transition.settledAt;

    if (targetActor) {
      targetActor.abort(options.error);
      this.deps.finalizeSpawnedTaskHistoryWindow(record, targetActor);
    } else {
      this.deps.finalizeSpawnedTaskHistoryWindow(record);
    }

    this.deps.cancelPendingInteractionsForActor(record.targetActorId);
    if (record.mode === "session") {
      this.closeSession(record, abortedAt);
    }

    this.deps.emitEvent({
      type: "spawned_task_failed",
      actorId: record.targetActorId,
      timestamp: abortedAt,
      detail: this.buildEventDetail(record, {
        status: "aborted",
        elapsed: abortedAt - record.spawnedAt,
        error: options.error,
        terminalError: options.error,
      }),
    });
  }

  private applyLifecycle(
    record: SpawnedTaskRecord,
    patch: Parameters<typeof applyDialogSubtaskLifecycle>[1],
    opts?: {
      notifyOwner?: boolean;
      minOwnerNotifyIntervalMs?: number;
    },
  ): DialogSubtaskRuntimeState {
    const runtime = applyDialogSubtaskLifecycle(record, patch);
    this.syncAgentTaskRecord(record);
    if (opts?.notifyOwner !== false) {
      this.notifySpawnedTaskUpdate(record.spawnerActorId, {
        minIntervalMs: opts?.minOwnerNotifyIntervalMs,
        channel: opts?.minOwnerNotifyIntervalMs ? "progress" : "default",
      });
    }
    return runtime;
  }

  private summarizeProgressStep(step: {
    type?: string;
    content?: string;
    toolName?: string;
    streaming?: boolean;
  }): string | undefined {
    const normalizedContent = String(step.content ?? "").replace(/\s+/g, " ").trim();
    if ((step.type === "action" || step.type === "tool_streaming") && step.toolName) {
      return summarizeToolProgress(step.toolName, { prefix: "正在" });
    }
    if (normalizedContent) {
      if (looksLikeStructuredBlob(normalizedContent)) {
        return step.toolName
          ? summarizeToolProgress(
              step.toolName,
              { prefix: step.type === "observation" ? "已" : "正在" },
            )
          : GENERIC_PROGRESS_BY_STEP_TYPE[step.type ?? ""] ?? "正在处理";
      }
      if (step.type === "observation" && step.toolName) {
        const compact = compactRuntimeText(normalizedContent, 96);
        return compact ?? summarizeToolProgress(step.toolName, { prefix: "已" });
      }
      if (step.type === "answer" || step.type === "thinking" || step.type === "thought") {
        return summarizeNarrativeProgress(normalizedContent, step.type)
          ?? GENERIC_PROGRESS_BY_STEP_TYPE[step.type ?? "answer"]
          ?? "正在处理";
      }
      return compactRuntimeText(normalizedContent, 120);
    }
    if (step.toolName) {
      return summarizeToolProgress(step.toolName, { prefix: "正在" });
    }
    return undefined;
  }

  private shouldEmitProgressSnapshot(params: {
    runId: string;
    summary: string;
    timestamp: number;
    streaming: boolean;
  }): boolean {
    return this.core.shouldEmitProgressSnapshot(params);
  }

  private clearProgressSnapshot(runId: string): void {
    this.core.clearProgressSnapshot(runId);
  }

  private attachProgressListener(record: SpawnedTaskRecord, target: AgentActor): void {
    this.detachProgressListener(record.runId);
    const detach = target.on((event) => {
      if (record.status !== "running") return;
      record.lastActiveAt = Math.max(record.lastActiveAt ?? 0, event.timestamp);
      if (event.type !== "step") {
        this.notifySpawnedTaskUpdate(record.spawnerActorId);
        return;
      }
      const step = (event.detail as {
        step?: { content?: string; type?: string; streaming?: boolean; toolName?: string };
      } | undefined)?.step;
      if (!step) return;
      const runtime = ensureDialogSubtaskRuntime(record, {
        subtaskId: record.runId,
        profile: resolveDialogSubtaskProfile(record.roleBoundary),
        startedAt: record.spawnedAt,
        timeoutSeconds: record.budgetSeconds,
      });
      const toolActivityChanged = step.type === "action" && Boolean(step.toolName?.trim());
      if (toolActivityChanged) {
        runtime.toolUseCount = (runtime.toolUseCount ?? 0) + 1;
        runtime.lastToolName = step.toolName?.trim();
        runtime.lastToolAt = event.timestamp;
      }
      const message = this.summarizeProgressStep(step) ?? "";
      if (!message) {
        if (toolActivityChanged) {
          this.syncAgentTaskRecord(record);
        }
        this.notifySpawnedTaskUpdate(record.spawnerActorId);
        return;
      }
      if (!this.shouldEmitProgressSnapshot({
        runId: record.runId,
        summary: message,
        timestamp: event.timestamp,
        streaming: Boolean(step.streaming),
      })) {
        if (toolActivityChanged) {
          this.syncAgentTaskRecord(record);
          this.notifySpawnedTaskUpdate(record.spawnerActorId, {
            minIntervalMs: 1_000,
            channel: "progress",
          });
        }
        return;
      }
      this.applyLifecycle(record, {
        lastActiveAt: event.timestamp,
        progressSummary: message,
      }, {
        notifyOwner: true,
        minOwnerNotifyIntervalMs: 2_500,
      });
      this.deps.emitEvent({
        type: "spawned_task_running",
        actorId: record.targetActorId,
        timestamp: event.timestamp,
        detail: this.buildEventDetail(record, {
          status: "running",
          elapsed: event.timestamp - record.spawnedAt,
          message,
          progressSummary: message || record.runtime?.progressSummary,
          stepType: step.type as SpawnedTaskEventDetail["stepType"],
        }),
      });
    });
    this.progressListeners.set(record.runId, detach);
  }

  private detachProgressListener(runId: string): void {
    const detach = this.progressListeners.get(runId);
    if (detach) {
      detach();
      this.progressListeners.delete(runId);
    }
    this.clearProgressSnapshot(runId);
  }

  private attachTimeoutMonitor(record: SpawnedTaskRecord, target: AgentActor): void {
    this.core.attachTimeoutMonitor({
      record,
      intervalMs: TIMEOUT_CHECK_INTERVAL_MS,
      isRunning: (item) => item.status === "running",
      getStartedAt: (item) => item.spawnedAt,
      getLastActiveAt: (item) => item.lastActiveAt ?? item.spawnedAt,
      getBudgetSeconds: (item) => item.budgetSeconds ?? item.runtime?.timeoutSeconds ?? 0,
      getIdleLeaseSeconds: (item) => item.idleLeaseSeconds ?? 0,
      onTimeout: (trigger) => {
        this.abortTaskForTimeout(record, target, trigger);
      },
    });
  }

  private clearTimeoutMonitor(record: SpawnedTaskRecord): void {
    this.core.clearTimeoutMonitor(record);
  }

  private abortTaskForTimeout(
    record: SpawnedTaskRecord,
    target: AgentActor,
    trigger: TaskExecutorTimeoutTrigger,
  ): void {
    if (record.status !== "running") return;
    this.detachProgressListener(record.runId);
    const timeoutError = formatTimeoutError(trigger.reason, trigger.thresholdSeconds);
    runtimeLogger.info(
      `spawn task timeout: runId=${record.runId}, actor=${record.targetActorId}, duration=${trigger.durationMs}ms, reason=${trigger.reason}`,
    );
    const transition = this.core.settleRecord({
      canTransition: () => record.status === "running",
      settledAt: trigger.now,
      apply: (settledAt) => {
        this.applyLifecycle(record, {
          status: "aborted",
          completedAt: settledAt,
          lastActiveAt: settledAt,
          terminalError: timeoutError,
          timeoutReason: trigger.reason,
        });
      },
    });
    if (!transition.transitioned) return;
    this.clearTimeoutMonitor(record);
    target.abort(timeoutError);
    this.deps.finalizeSpawnedTaskHistoryWindow(record, target);
    this.deps.appendAnnounceEvent(record.runId, "aborted", undefined, timeoutError);
    this.syncTaskQueueFail(record.runId, timeoutError);

    if (record.expectsCompletionMessage) {
      const followUpHint = trigger.reason === "idle"
        ? "长时间无进展，主 Agent 应接管或改派更窄范围的子任务。"
        : "已超过总预算，主 Agent 应接管收尾或明确真实 blocker。";
      this.deps.announceWithRetry(
        record.targetActorId,
        record.spawnerActorId,
        `[Task timeout: ${record.label ?? record.task.slice(0, 30)}]\n\n${timeoutError}\n${followUpHint}`,
        record.runId,
      );
    }

    this.deps.emitEvent({
      type: "task_error",
      actorId: record.targetActorId,
      timestamp: transition.settledAt,
      detail: {
        runId: record.runId,
        reason: "timeout",
        timeoutReason: trigger.reason,
        error: timeoutError,
      },
    });
    this.deps.emitEvent({
      type: "spawned_task_timeout",
      actorId: record.targetActorId,
      timestamp: transition.settledAt,
      detail: this.buildEventDetail(record, {
        status: "aborted",
        elapsed: trigger.durationMs,
        error: timeoutError,
        terminalError: timeoutError,
        timeoutReason: trigger.reason,
      }),
    });

    if (record.cleanup === "delete" && record.mode !== "session") {
      if (!target.persistent) {
        this.deps.killActor(record.targetActorId);
      } else {
        runtimeLogger.info(`spawn task cleanup skipped on timeout: actor=${record.targetActorId} is persistent`);
      }
    }
  }

  private completeTask(
    record: SpawnedTaskRecord,
    target: AgentActor,
    targetName: string,
    params: {
      result: string;
    },
  ): void {
    const transition = this.core.settleRecord({
      canTransition: () => record.status === "running",
      apply: (completedAt) => {
        this.applyLifecycle(record, {
          status: "completed",
          completedAt,
          lastActiveAt: completedAt,
          terminalResult: params.result,
        });
      },
    });
    if (!transition.transitioned) return;
    this.deps.finalizeSpawnedTaskHistoryWindow(record, target);
    runtimeLogger.info(`spawn task completed: actor=${targetName}, runId=${record.runId}`);
    this.deps.appendAnnounceEvent(record.runId, "completed", params.result);
    this.syncTaskQueueComplete(record.runId, params.result);

    if (record.expectsCompletionMessage) {
      const artifacts = collectSubtaskArtifacts(record, this.deps.getArtifactRecordsSnapshot());
      const latestArtifactPath = artifacts[artifacts.length - 1]?.path;
      const shortResult = latestArtifactPath
        ? `已完成，产物：${latestArtifactPath}\n结构化结果已回传协调者。`
        : `${record.runtime?.progressSummary ?? summarizeNarrativeProgress(params.result, "answer") ?? "已完成"}\n结构化结果已回传协调者。`;
      this.deps.announceWithRetry(
        record.targetActorId,
        record.spawnerActorId,
        `[Task completed: ${record.label ?? record.task.slice(0, 30)}]\n\n${shortResult}`,
        record.runId,
      );
    }

    this.finishRun(record, target, targetName, "completed");
  }

  private failTask(
    record: SpawnedTaskRecord,
    target: AgentActor,
    targetName: string,
    params: {
      status: "error" | "aborted";
      error: string;
      resultStatus: "error" | "aborted";
      announceContent?: string;
      transcriptStatus: "error" | "aborted";
      queueError: string;
      logLabel: string;
    },
  ): void {
    const transition = this.core.settleRecord({
      canTransition: () => record.status === "running",
      apply: (completedAt) => {
        this.applyLifecycle(record, {
          status: params.status,
          completedAt,
          lastActiveAt: completedAt,
          terminalError: params.error,
        });
      },
    });
    if (!transition.transitioned) return;
    this.deps.finalizeSpawnedTaskHistoryWindow(record, target);
    runtimeLogger.info(`spawn task ${params.logLabel.toLowerCase()}: actor=${targetName}, runId=${record.runId}, error=${params.error}`);
    this.deps.appendAnnounceEvent(record.runId, params.transcriptStatus, undefined, params.error);
    this.syncTaskQueueFail(record.runId, params.queueError);

    if (params.announceContent) {
      this.deps.announceWithRetry(
        record.targetActorId,
        record.spawnerActorId,
        params.announceContent,
        record.runId,
      );
    }
    this.deps.cancelPendingInteractionsForActor(record.targetActorId);
    this.finishRun(record, target, targetName, params.resultStatus);
  }

  private finishRun(
    record: SpawnedTaskRecord,
    target: AgentActor,
    targetName: string,
    terminalStatus: "completed" | "error" | "aborted",
  ): void {
    const finishedAt = record.completedAt ?? Date.now();
    this.deps.emitEvent({
      type: "task_completed",
      actorId: record.targetActorId,
      timestamp: finishedAt,
      detail: { runId: record.runId },
    });

    if (terminalStatus === "completed") {
      this.deps.emitEvent({
        type: "spawned_task_completed",
        actorId: record.targetActorId,
        timestamp: finishedAt,
        detail: this.buildEventDetail(record, {
          status: "completed",
          elapsed: finishedAt - record.spawnedAt,
          result: record.result?.slice(0, 500),
          terminalResult: record.runtime?.terminalResult?.slice(0, 500),
        }),
      });
    } else {
      this.deps.emitEvent({
        type: "spawned_task_failed",
        actorId: record.targetActorId,
        timestamp: finishedAt,
        detail: this.buildEventDetail(record, {
          status: terminalStatus,
          elapsed: finishedAt - record.spawnedAt,
          error: record.error,
          terminalError: record.runtime?.terminalError ?? record.error,
        }),
      });
    }

    this.deps.onTaskSettled?.({
      record,
      targetActorId: record.targetActorId,
      targetName,
      status: terminalStatus,
      task: record.task,
    });

    if (record.cleanup === "delete" && record.mode !== "session") {
      if (!target.persistent) {
        this.deps.killActor(record.targetActorId);
      } else {
        runtimeLogger.info(`spawn task cleanup skipped: actor=${targetName} is persistent (runId=${record.runId})`);
      }
    }
  }

  private buildEventDetail(
    record: SpawnedTaskRecord,
    overrides?: Partial<SpawnedTaskEventDetail>,
  ): SpawnedTaskEventDetail {
    return buildDialogSubtaskEventDetail(record, {
      targetName: this.deps.getActorName(record.targetActorId),
      spawnerName: this.deps.getActorName(record.spawnerActorId),
      }, overrides);
  }

  private reconcileRestoredRunningRecord(record: SpawnedTaskRecord): void {
    if (record.status !== "running") return;

    const restoredAt = Date.now();
    const canContinueSession = record.mode === "session" && record.sessionOpen;
    const terminalError = canContinueSession
      ? RESTORED_RUNNING_SESSION_ERROR
      : RESTORED_RUNNING_TASK_ERROR;

    applyDialogSubtaskLifecycle(record, {
      status: "aborted",
      completedAt: restoredAt,
      lastActiveAt: restoredAt,
      terminalError,
      countEvent: false,
    });
    this.syncAgentTaskRecord(record);

    if (!canContinueSession) {
      this.deps.finalizeSpawnedTaskHistoryWindow(record, this.deps.getActor(record.targetActorId));
    }

    this.notifySpawnedTaskUpdate(record.spawnerActorId);
    this.deps.emitEvent({
      type: "spawned_task_failed",
      actorId: record.targetActorId,
      timestamp: restoredAt,
      detail: this.buildEventDetail(record, {
        status: "aborted",
        elapsed: Math.max(0, restoredAt - record.spawnedAt),
        error: terminalError,
        terminalError,
      }),
    });
    this.deps.onTaskSettled?.({
      record,
      targetActorId: record.targetActorId,
      targetName: this.deps.getActorName(record.targetActorId),
      status: "aborted",
      task: record.task,
    });
  }

  private syncTaskQueueCreate(
    _record: SpawnedTaskRecord,
    _spawnerName: string,
    _targetName: string,
  ): void {
  }

  private syncTaskQueueComplete(_runId: string, _result?: string): void {
  }

  private syncTaskQueueFail(_runId: string, _error: string): void {
  }

  private syncAgentTaskRecord(record: SpawnedTaskRecord): void {
    const manager = this.getAgentTaskManager();
    if (!manager) return;
    manager.syncSpawnedTask({
      sessionId: this.deps.sessionId,
      record,
      spawnerName: this.deps.getActorName(record.spawnerActorId),
      targetName: this.deps.getActorName(record.targetActorId),
      pendingMessageCount: this.deps.getActor(record.targetActorId)?.pendingInboxCount ?? 0,
    });
  }

  private getAgentTaskManager(): AgentTaskManagerHandle | null {
    try {
      return getAgentTaskManager() as AgentTaskManagerHandle;
    } catch {
      return null;
    }
  }
}
