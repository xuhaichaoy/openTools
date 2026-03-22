import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import type {
  CollaborationChildSession,
  CollaborationContractDelegation,
  CollaborationChildSessionStatus,
  ExecutionContract,
} from "./types";

function summarizeText(text: string | undefined, maxLength = 160): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildChildStatusSummary(record: SpawnedTaskRecord): string | undefined {
  if (record.error?.trim()) {
    return summarizeText(`子线程异常：${record.error.trim()}`, 160);
  }
  if (record.result?.trim()) {
    return summarizeText(record.result.trim(), 160);
  }
  if (record.label?.trim()) {
    if (record.status === "running") {
      return summarizeText(`${record.label.trim()} 正在执行中`, 160);
    }
    if (record.mode === "session" && record.sessionOpen) {
      return summarizeText(`${record.label.trim()} 当前保留中`, 160);
    }
  }
  if (record.task?.trim()) {
    return summarizeText(record.task.trim(), 160);
  }
  return undefined;
}

function buildChildNextStepHint(record: SpawnedTaskRecord): string | undefined {
  if (record.status === "error" || record.status === "aborted") {
    return "主 Agent 需要处理异常，决定是否补充上下文或重新派工";
  }
  if (record.mode === "session" && record.sessionOpen) {
    if (record.status === "completed") {
      return "主 Agent 可按需继续复用该子会话，补充新的指令";
    }
    if (record.status === "running") {
      return "等待子线程继续推进，只有被结果阻塞时再等待";
    }
    return "主 Agent 可按需继续复用该子会话";
  }
  if (record.status === "completed") {
    return "主 Agent 可复核结果，并决定是否继续下一步";
  }
  if (record.status === "running") {
    return "等待本轮子任务完成后再决定是否继续派工";
  }
  return undefined;
}

function buildAvailableDelegationSummary(
  delegation: ExecutionContract["plannedDelegations"][number],
): string {
  return summarizeText(
    delegation.task
    || delegation.label
    || delegation.targetActorName
    || delegation.targetActorId,
    160,
  ) || "等待主 Agent 决定是否派工";
}

function buildAvailableDelegationNextStep(
  delegation: ExecutionContract["plannedDelegations"][number],
): string {
  return delegation.createIfMissing
    ? "主 Agent 可按需创建或复用目标线程"
    : "主 Agent 可按需复用现有线程或发起新的派工";
}

function mapSpawnedTaskStatus(record: SpawnedTaskRecord): CollaborationChildSessionStatus {
  switch (record.status) {
    case "running":
      return "running";
    case "completed":
      if (record.mode === "session" && record.sessionOpen) {
        return "waiting";
      }
      return "completed";
    case "error":
      return "failed";
    case "aborted":
      return "aborted";
    default:
      return "pending";
  }
}

export function buildCollaborationChildSession(
  record: SpawnedTaskRecord,
): CollaborationChildSession {
  const status = mapSpawnedTaskStatus(record);
  const endedAt = record.completedAt ?? record.sessionClosedAt;
  const updatedAt = Math.max(
    record.lastActiveAt ?? 0,
    record.completedAt ?? 0,
    record.sessionClosedAt ?? 0,
    record.spawnedAt,
  );

  return {
    id: record.runId,
    runId: record.runId,
    parentRunId: record.parentRunId,
    ownerActorId: record.spawnerActorId,
    targetActorId: record.targetActorId,
    label: record.label?.trim() || summarizeText(record.task, 96) || record.runId,
    roleBoundary: record.roleBoundary ?? "general",
    mode: record.mode,
    status,
    focusable: record.mode === "session" && record.sessionOpen === true && status !== "aborted" && status !== "failed",
    resumable: record.mode === "session" && record.sessionOpen === true && status !== "aborted" && status !== "failed",
    announceToParent: record.expectsCompletionMessage,
    lastResultSummary: summarizeText(record.result),
    lastError: summarizeText(record.error),
    statusSummary: buildChildStatusSummary(record),
    nextStepHint: buildChildNextStepHint(record),
    startedAt: record.spawnedAt,
    updatedAt,
    endedAt,
  };
}

export function buildCollaborationChildSessions(
  records: readonly SpawnedTaskRecord[],
): CollaborationChildSession[] {
  return records
    .map((record) => buildCollaborationChildSession(record))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function cloneCollaborationChildSession(
  session: CollaborationChildSession,
): CollaborationChildSession {
  return { ...session };
}

function getTaskRecency(record: SpawnedTaskRecord): number {
  return Math.max(
    record.lastActiveAt ?? 0,
    record.completedAt ?? 0,
    record.sessionClosedAt ?? 0,
    record.spawnedAt,
  );
}

function mapDelegationState(
  record: SpawnedTaskRecord | undefined,
): CollaborationContractDelegation["state"] {
  if (!record) return "available";
  const childSessionStatus = mapSpawnedTaskStatus(record);
  switch (childSessionStatus) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
    case "aborted":
      return "failed";
    default:
      return "available";
  }
}

function isWeakDelegationMatch(
  record: SpawnedTaskRecord,
  contract: ExecutionContract,
  delegation: ExecutionContract["plannedDelegations"][number],
): boolean {
  const coordinatorActorId = contract.coordinatorActorId ?? contract.initialRecipientActorIds[0];
  if (record.contractId && record.contractId !== contract.contractId) return false;
  if (record.plannedDelegationId && record.plannedDelegationId !== delegation.id) return false;
  if (record.targetActorId !== delegation.targetActorId) return false;
  if (coordinatorActorId && record.spawnerActorId !== coordinatorActorId) return false;
  return true;
}

export function buildCollaborationContractDelegations(
  contract: ExecutionContract | null | undefined,
  records: readonly SpawnedTaskRecord[],
): CollaborationContractDelegation[] {
  if (!contract?.plannedDelegations?.length) return [];

  const sortedRecords = [...records].sort((left, right) => getTaskRecency(right) - getTaskRecency(left));
  const claimedRunIds = new Set<string>();

  return contract.plannedDelegations.map((delegation) => {
    const explicitRecord = sortedRecords.find((record) =>
      record.contractId === contract.contractId
      && record.plannedDelegationId === delegation.id,
    );
    if (explicitRecord) {
      claimedRunIds.add(explicitRecord.runId);
      return {
        delegationId: delegation.id,
        targetActorId: delegation.targetActorId,
        label: delegation.label?.trim() || delegation.targetActorName?.trim() || delegation.targetActorId,
        state: explicitRecord.targetActorId === delegation.targetActorId
          ? mapDelegationState(explicitRecord)
          : "stale",
        runId: explicitRecord.runId,
        statusSummary: explicitRecord.targetActorId === delegation.targetActorId
          ? buildChildStatusSummary(explicitRecord)
          : "当前关联线程与建议目标不一致，建议主 Agent 重新派工",
        nextStepHint: explicitRecord.targetActorId === delegation.targetActorId
          ? buildChildNextStepHint(explicitRecord)
          : "主 Agent 需要重新确认目标线程或重建建议委派",
        updatedAt: getTaskRecency(explicitRecord),
      };
    }

    const weakMatch = sortedRecords.find((record) =>
      !claimedRunIds.has(record.runId)
      && isWeakDelegationMatch(record, contract, delegation)
    );
    if (weakMatch) {
      claimedRunIds.add(weakMatch.runId);
    }

    return {
      delegationId: delegation.id,
      targetActorId: delegation.targetActorId,
      label: delegation.label?.trim() || delegation.targetActorName?.trim() || delegation.targetActorId,
      state: mapDelegationState(weakMatch),
      statusSummary: weakMatch
        ? buildChildStatusSummary(weakMatch)
        : buildAvailableDelegationSummary(delegation),
      nextStepHint: weakMatch
        ? buildChildNextStepHint(weakMatch)
        : buildAvailableDelegationNextStep(delegation),
      updatedAt: weakMatch ? getTaskRecency(weakMatch) : undefined,
      ...(weakMatch ? { runId: weakMatch.runId } : {}),
    };
  });
}

export const projectChildSessions = buildCollaborationChildSessions;
