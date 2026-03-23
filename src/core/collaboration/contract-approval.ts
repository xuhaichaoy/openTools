import {
  getRoleBoundaryPolicyProfile,
  normalizeExecutionPolicy,
  type ToolApprovalDecision,
  type ToolApprovalLayer,
  type ToolApprovalRisk,
  type ToolApprovalTrustMode,
} from "@/core/agent/actor/execution-policy";
import type { ExecutionPolicy, SpawnedTaskRoleBoundary } from "@/core/agent/actor/types";
import { getExecutionStrategyLabel } from "./presentation";
import type { ExecutionContract, ExecutionContractDraft } from "./types";

type ApprovalSubject = Pick<
  ExecutionContractDraft | ExecutionContract,
  | "executionStrategy"
  | "executionPolicy"
  | "coordinatorActorId"
  | "initialRecipientActorIds"
  | "participantActorIds"
  | "plannedDelegations"
>;

export interface ExecutionContractApprovalActor {
  id: string;
  roleName?: string;
  executionPolicy?: ExecutionPolicy;
}

export interface ExecutionContractApprovalAssessment {
  decision: ToolApprovalDecision;
  risk: ToolApprovalRisk;
  layer: ToolApprovalLayer;
  reason: string;
  permissions: string[];
  notes: string[];
}

export interface AssessExecutionContractApprovalOptions {
  trustMode?: ToolApprovalTrustMode;
}

function riskRank(risk: ToolApprovalRisk): number {
  switch (risk) {
    case "safe":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    default:
      return 4;
  }
}

function trustThreshold(mode: ToolApprovalTrustMode): number {
  switch (mode) {
    case "full_auto":
      return Number.POSITIVE_INFINITY;
    case "strict_manual":
      return 1;
    default:
      return 3;
  }
}

function approvalThreshold(mode: ReturnType<typeof normalizeExecutionPolicy>["approvalMode"]): number {
  switch (mode) {
    case "off":
      return Number.POSITIVE_INFINITY;
    case "strict":
      return 1;
    default:
      return 3;
  }
}

function accessModeLabel(accessMode: ReturnType<typeof normalizeExecutionPolicy>["accessMode"]): string {
  switch (accessMode) {
    case "read_only":
      return "只读";
    case "full_access":
      return "完全访问";
    default:
      return "自动执行";
  }
}

function approvalModeLabel(approvalMode: ReturnType<typeof normalizeExecutionPolicy>["approvalMode"]): string {
  switch (approvalMode) {
    case "strict":
      return "严格确认";
    case "permissive":
      return "宽松确认";
    case "off":
      return "关闭人工确认";
    default:
      return "标准确认";
  }
}

function pushUnique(list: string[], value: string | undefined): void {
  const normalized = String(value ?? "").trim();
  if (!normalized || list.includes(normalized)) return;
  list.push(normalized);
}

function labelActor(
  actorId: string | undefined,
  actorById: ReadonlyMap<string, ExecutionContractApprovalActor>,
): string {
  if (!actorId) return "主协调者";
  return actorById.get(actorId)?.roleName ?? actorId;
}

function labelDelegationTarget(
  targetActorId: string,
  actorById: ReadonlyMap<string, ExecutionContractApprovalActor>,
): string {
  return actorById.get(targetActorId)?.roleName ?? targetActorId;
}

function boundaryPolicy(boundary?: SpawnedTaskRoleBoundary): ReturnType<typeof normalizeExecutionPolicy> {
  return getRoleBoundaryPolicyProfile(boundary ?? "general").executionPolicy;
}

export function assessExecutionContractApproval(
  subject: ApprovalSubject,
  actors: readonly ExecutionContractApprovalActor[],
  options: AssessExecutionContractApprovalOptions = {},
): ExecutionContractApprovalAssessment {
  const actorById = new Map(actors.map((actor) => [actor.id, actor] as const));
  const contractPolicy = normalizeExecutionPolicy(subject.executionPolicy);
  const permissions: string[] = [];
  const notes: string[] = [];

  pushUnique(
    permissions,
    `执行策略：${getExecutionStrategyLabel(subject.executionStrategy)}；参与者 ${subject.participantActorIds.length}；建议 delegation ${subject.plannedDelegations.length}`,
  );
  pushUnique(
    permissions,
    `主协作权限：${accessModeLabel(contractPolicy.accessMode)} / ${approvalModeLabel(contractPolicy.approvalMode)}`,
  );
  pushUnique(
    permissions,
    `主协调者：${labelActor(subject.coordinatorActorId, actorById)}；首发目标 ${subject.initialRecipientActorIds.length || 0} 个`,
  );

  if (subject.initialRecipientActorIds.length === 0 || subject.participantActorIds.length === 0) {
    return {
      decision: "deny",
      risk: "high",
      layer: "policy",
      reason: "当前协作契约缺少有效接收方或参与者，不能进入执行。",
      permissions,
      notes,
    };
  }

  const missingStaticDelegations = subject.plannedDelegations.filter((delegation) => {
    if (delegation.createIfMissing) return false;
    return !actorById.has(delegation.targetActorId);
  });
  if (missingStaticDelegations.length > 0) {
    return {
      decision: "deny",
      risk: "high",
      layer: "policy",
      reason: `存在未命中当前 actor roster 的静态 delegation：${missingStaticDelegations
        .map((item) => item.label || item.targetActorName || item.targetActorId)
        .join("、")}`,
      permissions,
      notes,
    };
  }

  let highestRisk: ToolApprovalRisk = "safe";
  let primaryReason = "本轮协作边界较收敛，自动审核可直接放行。";
  const bumpRisk = (risk: ToolApprovalRisk, reason: string, note?: string) => {
    if (riskRank(risk) > riskRank(highestRisk)) {
      highestRisk = risk;
      primaryReason = reason;
    }
    pushUnique(notes, note ?? reason);
  };

  switch (subject.executionStrategy) {
    case "direct":
      bumpRisk("safe", "当前采用直达执行，不会额外扩散协作面。");
      break;
    case "coordinator":
      bumpRisk("low", "当前由主协调者统一接住输入，再决定是否继续派工。");
      break;
    case "smart":
      bumpRisk("low", "当前由主协调者结合智能路由决定首轮接手方。");
      break;
    case "broadcast":
      bumpRisk("medium", "当前会把输入广播给多个参与者，协作面更宽。");
      break;
  }

  if (subject.participantActorIds.length >= 4) {
    bumpRisk("medium", "参与者数量较多，建议确认协作边界是否仍然收敛。");
  }
  if (subject.plannedDelegations.length >= 3) {
    bumpRisk("medium", "预设 delegation 较多，建议确认是否真的需要同时展开。");
  }

  if (contractPolicy.accessMode === "full_access") {
    bumpRisk("medium", "主协作权限允许完全访问本地环境。");
  } else if (contractPolicy.accessMode === "auto") {
    bumpRisk("low", "主协作权限允许在工作区内做常规执行。");
  } else {
    pushUnique(notes, "主协作权限当前是只读，默认不会直接改写本地文件。");
  }

  for (const delegation of subject.plannedDelegations) {
    const targetLabel = delegation.label?.trim()
      || delegation.targetActorName?.trim()
      || labelDelegationTarget(delegation.targetActorId, actorById);
    const targetActor = actorById.get(delegation.targetActorId);
    const resolvedPolicy = targetActor?.executionPolicy
      ? normalizeExecutionPolicy(targetActor.executionPolicy)
      : boundaryPolicy(delegation.roleBoundary);

    if (delegation.createIfMissing) {
      pushUnique(
        permissions,
        `允许按需创建子线程：${targetLabel}（${delegation.roleBoundary ?? "general"}）`,
      );
      if ((delegation.roleBoundary ?? "general") === "executor") {
        bumpRisk("medium", `${targetLabel} 是可自动创建的执行子线程，具备实际落地修改能力。`);
      } else {
        bumpRisk("low", `${targetLabel} 可在缺失时自动创建，用于补充分析或验证。`);
      }
    }

    if (
      subject.executionStrategy === "broadcast"
      && delegation.createIfMissing
      && (delegation.roleBoundary ?? "general") === "executor"
    ) {
      bumpRisk("high", `${targetLabel} 会在广播协作中按需创建执行子线程，授权面偏宽，需要人工确认。`);
    }

    if (resolvedPolicy.approvalMode === "off") {
      bumpRisk("high", `${targetLabel} 的审批策略已关闭人工确认，需要额外谨慎。`);
    } else if (resolvedPolicy.approvalMode === "strict") {
      pushUnique(notes, `${targetLabel} 会在更严格的确认边界内执行。`);
    }

    if (resolvedPolicy.accessMode === "full_access") {
      bumpRisk("medium", `${targetLabel} 具备完全访问权限，可以直接写文件或执行命令。`);
    } else if (resolvedPolicy.accessMode === "auto") {
      pushUnique(notes, `${targetLabel} 可在工作区内做常规实现或验证。`);
    } else {
      pushUnique(notes, `${targetLabel} 当前是只读子线程。`);
    }
  }

  if (contractPolicy.approvalMode === "off" || options.trustMode === "full_auto") {
    return {
      decision: "allow",
      risk: highestRisk,
      layer: "policy",
      reason: "当前策略允许直接通过协作边界审批。",
      permissions,
      notes,
    };
  }

  if (highestRisk === "safe") {
    return {
      decision: "allow",
      risk: highestRisk,
      layer: "policy",
      reason: primaryReason,
      permissions,
      notes,
    };
  }

  const threshold = Math.min(
    trustThreshold(options.trustMode ?? "auto_review"),
    approvalThreshold(contractPolicy.approvalMode),
  );

  if (riskRank(highestRisk) >= threshold) {
    return {
      decision: "ask",
      risk: highestRisk,
      layer: "human",
      reason: primaryReason,
      permissions,
      notes,
    };
  }

  return {
    decision: "allow",
    risk: highestRisk,
    layer: "auto_review",
    reason: primaryReason,
    permissions,
    notes,
  };
}
