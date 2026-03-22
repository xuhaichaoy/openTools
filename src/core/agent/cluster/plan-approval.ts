import type { ClusterPlan, ClusterStep } from "./types";
import type {
  ToolApprovalDecision,
  ToolApprovalLayer,
  ToolApprovalRisk,
  ToolApprovalTrustMode,
} from "@/core/agent/actor/tool-approval-policy";

export interface ClusterPlanApprovalAssessment {
  decision: ToolApprovalDecision;
  risk: ToolApprovalRisk;
  layer: ToolApprovalLayer;
  reason: string;
  permissions: string[];
  notes: string[];
}

export interface AssessClusterPlanApprovalOptions {
  trustMode?: ToolApprovalTrustMode;
  codingMode?: boolean;
  largeProjectMode?: boolean;
  openClawMode?: boolean;
  autoReviewCodeSteps?: boolean;
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

function pushUnique(list: string[], value: string | undefined): void {
  const normalized = String(value ?? "").trim();
  if (!normalized || list.includes(normalized)) return;
  list.push(normalized);
}

function isExecutionStep(step: ClusterStep): boolean {
  const text = `${step.role}\n${step.task}`.toLowerCase();
  return /implement|fix|coder|engineer|write|build feature|develop|patch|refactor|实现|修复|开发|编码|改造/.test(text);
}

function isReviewStep(step: ClusterStep): boolean {
  const text = `${step.role}\n${step.task}`.toLowerCase();
  return /review|audit|security|architect|评审|审查|审核|安全|架构/.test(text);
}

function isValidationStep(step: ClusterStep): boolean {
  const text = `${step.role}\n${step.task}`.toLowerCase();
  return /test|verify|validate|lint|typecheck|qa|验收|验证|测试|回归|检查/.test(text);
}

function isHighImpactStep(step: ClusterStep): boolean {
  const text = `${step.role}\n${step.task}`.toLowerCase();
  return /deploy|release|publish|database|migration|production|prod|delete|rm\b|上线|发布|部署|数据库|迁移|删除/.test(text);
}

export function assessClusterPlanApproval(
  plan: ClusterPlan,
  options: AssessClusterPlanApprovalOptions = {},
): ClusterPlanApprovalAssessment {
  const permissions: string[] = [];
  const notes: string[] = [];

  if (!plan.steps.length) {
    return {
      decision: "deny",
      risk: "high",
      layer: "policy",
      reason: "执行计划为空，不能直接进入集群执行。",
      permissions,
      notes,
    };
  }

  const executionSteps = plan.steps.filter(isExecutionStep);
  const reviewSteps = plan.steps.filter(isReviewStep);
  const validationSteps = plan.steps.filter(isValidationStep);
  const highImpactSteps = plan.steps.filter(isHighImpactStep);

  pushUnique(
    permissions,
    `执行模式：${plan.mode === "parallel_split" ? "并行分治" : "多角色协作"}；步骤 ${plan.steps.length} 个`,
  );
  if (executionSteps.length > 0) {
    pushUnique(permissions, `包含 ${executionSteps.length} 个实现/修复步骤，可能会生成或修改工程产物`);
  }
  if (reviewSteps.length > 0 || validationSteps.length > 0) {
    pushUnique(
      permissions,
      `包含 ${reviewSteps.length} 个评审步骤、${validationSteps.length} 个验证步骤`,
    );
  }
  if (options.autoReviewCodeSteps) {
    pushUnique(notes, "当前开启了自动代码审查，执行后会自动进入 Review/Fix 循环。");
  }

  let highestRisk: ToolApprovalRisk = "safe";
  let primaryReason = "当前计划主要是收敛型分析/协作，自动审核可直接放行。";
  const bumpRisk = (risk: ToolApprovalRisk, reason: string, note?: string) => {
    if (riskRank(risk) > riskRank(highestRisk)) {
      highestRisk = risk;
      primaryReason = reason;
    }
    pushUnique(notes, note ?? reason);
  };

  if (executionSteps.length > 0) {
    bumpRisk("medium", "计划包含实际实现/修复步骤，会驱动代码或产物变更。");
  }
  if (reviewSteps.length > 0 && executionSteps.length === 0) {
    bumpRisk("low", "计划以审查/分析为主，协作边界相对收敛。");
  }
  if (validationSteps.length > 0) {
    bumpRisk("low", "计划包含验证或回归步骤，通常用于收束风险。");
  }
  if (plan.steps.length >= 6) {
    bumpRisk("medium", "计划步骤较多，建议确认拆分是否仍然必要。");
  }
  if (plan.mode === "parallel_split" && plan.steps.length >= 4) {
    bumpRisk("medium", "当前计划会并行展开多个步骤，执行面较宽。");
  }
  if (options.largeProjectMode || options.openClawMode) {
    bumpRisk(
      options.openClawMode ? "high" : "medium",
      options.openClawMode
        ? "当前是 OpenClaw 式大项目执行，计划跨度和执行时间都更大。"
        : "当前按大项目编码模式执行，建议额外确认分工边界。",
    );
  }
  if (highImpactSteps.length > 0) {
    bumpRisk("high", "计划包含部署、数据库或删除类高影响步骤，需要人工确认。");
  }

  if (options.trustMode === "full_auto") {
    return {
      decision: "allow",
      risk: highestRisk,
      layer: "policy",
      reason: "当前策略允许直接跳过计划人工确认。",
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

  if (riskRank(highestRisk) >= trustThreshold(options.trustMode ?? "auto_review")) {
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
