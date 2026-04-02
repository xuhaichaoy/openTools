import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import type { AgentTaskProgress, AgentTaskStatus } from "./agent-task-types";

function compactText(value: string | undefined, maxLength = 160): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function extractOutputFile(value: string | undefined): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  return normalized.match(/\/[^\s"'`]+\.[A-Za-z0-9_-]+\b/)?.[0];
}

export function deriveAgentTaskStatusFromSpawnedTask(record: SpawnedTaskRecord): AgentTaskStatus {
  switch (record.status) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "aborted":
      return "aborted";
    default:
      return "running";
  }
}

export function describeAgentTaskLifecycle(record: SpawnedTaskRecord): string {
  const label = record.label ?? record.task.slice(0, 48);
  switch (record.status) {
    case "completed":
      return `${label} 已完成`;
    case "error":
      return record.error?.trim() ? `${label} 失败：${compactText(record.error, 96)}` : `${label} 执行失败`;
    case "aborted":
      return record.error?.trim() ? `${label} 已中止：${compactText(record.error, 96)}` : `${label} 已中止`;
    default:
      return record.runtime?.progressSummary?.trim()
        || (record.mode === "session" ? `${label} 子会话运行中` : `${label} 子任务运行中`);
  }
}

export function buildAgentTaskProgressFromSpawnedTask(record: SpawnedTaskRecord): AgentTaskProgress | undefined {
  const updatedAt = record.lastActiveAt ?? record.completedAt ?? record.spawnedAt;
  const status = deriveAgentTaskStatusFromSpawnedTask(record);
  const summary = compactText(
    record.runtime?.progressSummary
      ?? (status === "completed" ? record.runtime?.terminalResult ?? record.result : record.runtime?.terminalError ?? record.error),
  );

  if (!summary && status === "running" && !record.runtime?.eventCount) {
    return undefined;
  }

  return {
    summary: summary ?? describeAgentTaskLifecycle(record),
    percent: status === "completed" ? 100 : undefined,
    updatedAt,
    eventCount: record.runtime?.eventCount,
    toolUseCount: record.runtime?.toolUseCount,
    latestToolName: record.runtime?.lastToolName,
    latestToolAt: record.runtime?.lastToolAt,
  };
}

export function buildAgentTaskOutputSummary(record: SpawnedTaskRecord): string | undefined {
  const terminalValue = record.runtime?.terminalResult
    ?? record.result
    ?? record.runtime?.terminalError
    ?? record.error;
  return compactText(terminalValue, 240) ?? compactText(record.runtime?.progressSummary, 120);
}

export function buildAgentTaskOutputFile(record: SpawnedTaskRecord): string | undefined {
  return extractOutputFile(
    record.runtime?.terminalResult
    ?? record.result
    ?? record.runtime?.terminalError
    ?? record.error,
  );
}
