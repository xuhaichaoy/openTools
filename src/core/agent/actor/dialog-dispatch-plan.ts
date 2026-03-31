import type { AICenterHandoff } from "@/store/app-store";
import {
  describeCodingExecutionProfile,
  inferCodingExecutionProfile,
  normalizeCodingExecutionProfile,
  type ResolvedCodingExecutionProfile,
} from "@/core/agent/coding-profile";
import {
  buildExecutionContractDraftFromDialogBundle,
  sealExecutionContract as sealDialogExecutionContract,
} from "@/core/collaboration/execution-contract";
import type {
  CollaborationActorRosterEntry,
  ExecutionContract,
  ExecutionContractDraft,
} from "@/core/collaboration/types";
import type { ApprovalDialogPresentation } from "@/store/cluster-plan-approval-store";
import type { ClusterPlan, ClusterStep } from "@/core/agent/cluster/types";
import {
  enableStructuredDeliveryAdapter,
  getStructuredDeliveryStrategyReferenceId,
  isStructuredDeliveryAdapterEnabled,
  resolveStructuredDeliveryManifest,
  resolveStructuredDeliveryStrategyById,
  type StructuredDeliveryManifest,
} from "./structured-delivery-strategy";
import type { DialogRoutingMode } from "./dialog-presets";
import type {
  AgentCapability,
  AgentCapabilities,
  DialogExecutionPlan,
  DialogExecutionPlannedSpawn,
  SpawnedTaskRoleBoundary,
} from "./types";

export interface DialogPlanningActor {
  id: string;
  roleName: string;
  capabilities?: Pick<AgentCapabilities, "tags">;
}

export type DialogCodingFocus =
  | "implementation"
  | "debugging"
  | "review"
  | "testing"
  | "architecture";

export interface DialogDispatchInsight {
  codingProfile: ResolvedCodingExecutionProfile;
  autoModeLabel: string | null;
  modeSource: "auto" | "manual" | "none";
  preferredCapabilities: AgentCapability[];
  focus: DialogCodingFocus | null;
  focusLabel: string | null;
  reasons: string[];
  taskSummary: string;
}

export interface DialogDispatchPlanBundle {
  clusterPlan: ClusterPlan;
  runtimePlan: DialogExecutionPlan;
  insight: DialogDispatchInsight;
}

export interface BuildExecutionContractDraftFromDialogParams {
  actors: DialogPlanningActor[];
  routingMode: DialogRoutingMode;
  content: string;
  attachmentSummary?: string;
  attachmentPaths?: readonly string[];
  structuredDeliveryManifest?: StructuredDeliveryManifest;
  manualCodingMode?: boolean;
  handoff?: Partial<AICenterHandoff> | null;
  mentionedTargetId?: string | null;
  selectedRoute?: { agentId: string; reason: string } | null;
  coordinatorActorId?: string | null;
  actorRoster?: readonly CollaborationActorRosterEntry[];
}

interface DialogSupportAssignment {
  actor: DialogPlanningActor;
  roleId: DialogSupportRoleId;
  roleLabel: string;
}

interface DialogDelegateLane {
  roleId: DialogSupportRoleId;
  roleLabel: string;
  targetActorId: string;
  targetActorName: string;
  task: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
  createIfMissing?: boolean;
  childDescription?: string;
  childCapabilities?: AgentCapability[];
  childMaxIterations?: number;
}

type CapabilityWeights = Partial<Record<AgentCapability, number>>;
type DialogSupportRoleId = "architect" | "implementer" | "reviewer" | "debugger" | "tester" | "support";
type ConcreteDialogSupportRoleId = Exclude<DialogSupportRoleId, "support">;

const EPHEMERAL_CHILD_LIBRARY: Record<
  ConcreteDialogSupportRoleId,
  {
    targetActorName: string;
    roleLabel: string;
    roleBoundary: SpawnedTaskRoleBoundary;
    childDescription: string;
    childCapabilities: AgentCapability[];
    childMaxIterations: number;
  }
> = {
  architect: {
    targetActorName: "Architect",
    roleLabel: "架构把关",
    roleBoundary: "reviewer",
    childDescription: "负责从架构边界、模块依赖与长期演进角度独立评估方案。",
    childCapabilities: ["architecture", "code_analysis", "synthesis", "code_review"],
    childMaxIterations: 18,
  },
  implementer: {
    targetActorName: "Implementer",
    roleLabel: "核心实现",
    roleBoundary: "executor",
    childDescription: "负责按照协调者给出的范围落地实现、修复与必要验证，避免抢总协调权。",
    childCapabilities: ["code_write", "code_analysis", "debugging", "testing", "file_write", "shell_execute"],
    childMaxIterations: 32,
  },
  reviewer: {
    targetActorName: "Reviewer",
    roleLabel: "代码评审",
    roleBoundary: "reviewer",
    childDescription: "负责独立审查实现方案与改动结果，重点关注边界条件、回归风险与可维护性。",
    childCapabilities: ["code_review", "code_analysis", "security", "testing"],
    childMaxIterations: 20,
  },
  debugger: {
    targetActorName: "Debugger",
    roleLabel: "问题定位",
    roleBoundary: "executor",
    childDescription: "负责定位异常链路、复现条件和根因证据，帮助主代理快速收敛排查路径。",
    childCapabilities: ["debugging", "code_analysis", "testing", "code_write"],
    childMaxIterations: 24,
  },
  tester: {
    targetActorName: "Validator",
    roleLabel: "验证回归",
    roleBoundary: "validator",
    childDescription: "负责执行测试、构建、回归与验收，给出可复验结论，默认不直接修改代码。",
    childCapabilities: ["testing", "debugging", "code_analysis", "shell_execute"],
    childMaxIterations: 20,
  },
};

const ROOM_ROLE_COVERAGE_CAPABILITIES: Record<ConcreteDialogSupportRoleId, AgentCapability[]> = {
  architect: ["architecture", "coordinator", "synthesis"],
  implementer: ["code_write", "file_write", "shell_execute"],
  reviewer: ["code_review", "security"],
  debugger: ["debugging"],
  tester: ["testing", "shell_execute"],
};

const REVIEW_PATTERNS = [
  /code review/i,
  /\breview\b/i,
  /审查|评审|审阅|代码质量|可维护性|边界条件|回归风险/i,
  /\bCR\b/i,
];

const DEBUG_PATTERNS = [
  /\bdebug\b/i,
  /\bbug\b/i,
  /调试|排查|定位|报错|异常|堆栈|错误|根因|复现|修复/i,
];

const TEST_PATTERNS = [
  /\btest\b/i,
  /\blint\b/i,
  /\bbuild\b/i,
  /测试|单测|回归|验证|编译|构建|用例/i,
];

const ARCHITECTURE_PATTERNS = [
  /architecture/i,
  /架构|设计|重构|模块边界|技术方案|依赖关系|拆解方案/i,
];

function uniqueCapabilities(capabilities: AgentCapability[]): AgentCapability[] {
  return [...new Set(capabilities)];
}

function getActorCapabilities(actor: DialogPlanningActor): AgentCapability[] {
  return actor.capabilities?.tags ?? [];
}

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function scoreActor(actor: DialogPlanningActor, weights: CapabilityWeights): number {
  const caps = getActorCapabilities(actor);
  if (caps.length === 0) return 0;
  return caps.reduce((total, capability) => total + (weights[capability] ?? 0), 0);
}

function pickBestActor(
  actors: DialogPlanningActor[],
  weights: CapabilityWeights,
  excludeIds: Set<string>,
  requiredAny?: AgentCapability[],
): DialogPlanningActor | null {
  let best: DialogPlanningActor | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const actor of actors) {
    if (excludeIds.has(actor.id)) continue;
    const caps = getActorCapabilities(actor);
    if (requiredAny?.length && !requiredAny.some((capability) => caps.includes(capability))) {
      continue;
    }
    const score = scoreActor(actor, weights);
    if (score > bestScore) {
      best = actor;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function inferCodingFocus(taskSummary: string, largeProjectMode: boolean): DialogCodingFocus {
  if (hasPattern(taskSummary, REVIEW_PATTERNS)) return "review";
  if (hasPattern(taskSummary, DEBUG_PATTERNS)) return "debugging";
  if (hasPattern(taskSummary, TEST_PATTERNS)) return "testing";
  if (largeProjectMode && hasPattern(taskSummary, ARCHITECTURE_PATTERNS)) return "architecture";
  return "implementation";
}

function getFocusLabel(focus: DialogCodingFocus | null): string | null {
  switch (focus) {
    case "debugging":
      return "调试优先";
    case "review":
      return "评审优先";
    case "testing":
      return "验证优先";
    case "architecture":
      return "架构拆解";
    case "implementation":
      return "实现优先";
    default:
      return null;
  }
}

function getPreferredCapabilities(focus: DialogCodingFocus, largeProjectMode: boolean): AgentCapability[] {
  const base = (() => {
    switch (focus) {
      case "review":
        return ["code_review", "code_analysis", "security", "testing"] satisfies AgentCapability[];
      case "debugging":
        return ["debugging", "code_analysis", "testing", "code_write"] satisfies AgentCapability[];
      case "testing":
        return ["testing", "debugging", "code_write", "code_analysis"] satisfies AgentCapability[];
      case "architecture":
        return ["architecture", "coordinator", "code_analysis", "code_review"] satisfies AgentCapability[];
      default:
        return ["code_write", "code_analysis", "debugging", "testing"] satisfies AgentCapability[];
    }
  })();
  return uniqueCapabilities(largeProjectMode ? ["coordinator", ...base] : base);
}

function toPlannerStructuredDeliveryManifest(
  manifest: StructuredDeliveryManifest,
): StructuredDeliveryManifest {
  return getStructuredDeliveryStrategyReferenceId(manifest)
    ? enableStructuredDeliveryAdapter(manifest, "planner")
    : manifest;
}

function buildStructuredPlannedDelegations(params: {
  taskText: string;
  manifest: StructuredDeliveryManifest;
}): ExecutionContractDraft["plannedDelegations"] | null {
  if (!isStructuredDeliveryAdapterEnabled(params.manifest)) return null;
  const strategy = resolveStructuredDeliveryStrategyById(
    getStructuredDeliveryStrategyReferenceId(params.manifest),
  );
  const dispatchPlan = strategy?.buildInitialDispatchPlan?.({
    taskText: params.taskText,
    manifest: params.manifest,
  }) ?? null;
  if (!dispatchPlan?.shards.length) return null;
  return dispatchPlan.shards.map((shard, index) => ({
    id: `structured-delegation-${index + 1}`,
    targetActorId: shard.overrides?.deliveryTargetId
      ? `delivery-target-${shard.overrides.deliveryTargetId}`
      : `structured-target-${index + 1}`,
    targetActorName: shard.label,
    task: shard.task,
    label: shard.label,
    roleBoundary: shard.roleBoundary,
    createIfMissing: shard.createIfMissing,
    overrides: shard.overrides
      ? {
          ...(shard.overrides.workerProfileId ? { workerProfileId: shard.overrides.workerProfileId } : {}),
          ...(shard.overrides.executionIntent ? { executionIntent: shard.overrides.executionIntent } : {}),
          ...(shard.overrides.resultContract ? { resultContract: shard.overrides.resultContract } : {}),
          ...(shard.overrides.deliveryTargetId ? { deliveryTargetId: shard.overrides.deliveryTargetId } : {}),
          ...(shard.overrides.deliveryTargetLabel ? { deliveryTargetLabel: shard.overrides.deliveryTargetLabel } : {}),
          ...(shard.overrides.sheetName ? { sheetName: shard.overrides.sheetName } : {}),
          ...(shard.overrides.sourceItemIds ? { sourceItemIds: [...shard.overrides.sourceItemIds] } : {}),
          ...(typeof shard.overrides.sourceItemCount === "number" ? { sourceItemCount: shard.overrides.sourceItemCount } : {}),
          ...(shard.overrides.scopedSourceItems
            ? { scopedSourceItems: shard.overrides.scopedSourceItems.map((item) => ({ ...item })) }
            : {}),
        }
      : undefined,
  }));
}

function getPrimaryWeights(
  focus: DialogCodingFocus,
  routingMode: DialogRoutingMode,
  largeProjectMode: boolean,
): CapabilityWeights {
  if (routingMode === "coordinator" || largeProjectMode) {
    return {
      coordinator: 6,
      synthesis: 3,
      architecture: 2,
      code_analysis: 2,
      debugging: focus === "debugging" ? 1 : 0,
      code_review: focus === "review" ? 1 : 0,
    };
  }
  switch (focus) {
    case "review":
      return {
        code_review: 6,
        code_analysis: 4,
        security: 2,
        architecture: 1,
      };
    case "debugging":
      return {
        debugging: 6,
        code_analysis: 4,
        testing: 2,
        code_write: 2,
      };
    case "testing":
      return {
        testing: 6,
        debugging: 3,
        code_analysis: 2,
        code_write: 1,
      };
    case "architecture":
      return {
        architecture: 5,
        coordinator: 3,
        code_analysis: 3,
        synthesis: 2,
      };
    default:
      return {
        code_write: 6,
        code_analysis: 4,
        debugging: 2,
        testing: 1,
      };
  }
}

function getSupportRoleSpecs(
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): Array<{ id: DialogSupportRoleId; label: string; weights: CapabilityWeights; requiredAny?: AgentCapability[] }> {
  const queue = (() => {
    switch (focus) {
      case "review":
        return ["reviewer", "implementer", "tester", "debugger"] as const;
      case "debugging":
        return ["debugger", "implementer", "tester", "reviewer"] as const;
      case "testing":
        return ["tester", "implementer", "debugger", "reviewer"] as const;
      case "architecture":
        return ["architect", "implementer", "reviewer", "tester"] as const;
      default:
        return ["implementer", "reviewer", "tester", "debugger"] as const;
    }
  })();

  const specs: Record<DialogSupportRoleId, { label: string; weights: CapabilityWeights; requiredAny?: AgentCapability[] }> = {
    architect: {
      label: "架构把关",
      weights: {
        architecture: 6,
        code_analysis: 3,
        coordinator: 2,
        synthesis: 2,
        code_review: 1,
      },
      requiredAny: ["architecture", "code_analysis", "synthesis"],
    },
    implementer: {
      label: "核心实现",
      weights: {
        code_write: 6,
        code_analysis: 3,
        debugging: 2,
        testing: 1,
        file_write: 1,
        shell_execute: 1,
      },
      requiredAny: ["code_write", "file_write", "shell_execute"],
    },
    reviewer: {
      label: "代码评审",
      weights: {
        code_review: 6,
        code_analysis: 4,
        security: 2,
        architecture: 1,
        testing: 1,
      },
      requiredAny: ["code_review", "security", "architecture"],
    },
    debugger: {
      label: "问题定位",
      weights: {
        debugging: 6,
        code_analysis: 4,
        testing: 2,
        code_write: 2,
      },
      requiredAny: ["debugging"],
    },
    tester: {
      label: "验证回归",
      weights: {
        testing: 6,
        debugging: 2,
        code_write: 1,
        shell_execute: 1,
      },
      requiredAny: ["testing", "debugging"],
    },
    support: {
      label: largeProjectMode ? "模块支援" : "补充支援",
      weights: {
        code_analysis: 1,
        synthesis: 1,
        research: 1,
      },
    },
  };

  return queue.map((id) => ({ id, ...specs[id] }));
}

function canActorCoverSupportRole(
  actor: DialogPlanningActor,
  roleId: Exclude<DialogSupportRoleId, "support">,
): boolean {
  const capabilities = getActorCapabilities(actor);
  switch (roleId) {
    case "architect":
      return capabilities.some((capability) => ["architecture", "code_analysis", "synthesis"].includes(capability));
    case "implementer":
      return capabilities.some((capability) => ["code_write", "file_write", "shell_execute"].includes(capability));
    case "reviewer":
      return capabilities.some((capability) => ["code_review", "security", "architecture"].includes(capability));
    case "debugger":
      return capabilities.includes("debugging");
    case "tester":
      return capabilities.some((capability) => ["testing", "debugging"].includes(capability));
  }
}

function getCoveredSupportRoles(
  actors: DialogPlanningActor[],
): Set<Exclude<DialogSupportRoleId, "support">> {
  const coveredRoles = new Set<Exclude<DialogSupportRoleId, "support">>();
  const candidateRoles = ["architect", "implementer", "reviewer", "debugger", "tester"] as const;
  for (const actor of actors) {
    for (const roleId of candidateRoles) {
      if (canActorCoverSupportRole(actor, roleId)) {
        coveredRoles.add(roleId);
      }
    }
  }
  return coveredRoles;
}

function assignSupportRoles(
  actors: DialogPlanningActor[],
  primaryActorId: string,
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): DialogSupportAssignment[] {
  const supportingActors = actors.filter((actor) => actor.id !== primaryActorId);
  if (supportingActors.length === 0) return [];

  const usedIds = new Set<string>([primaryActorId]);
  const assignments: DialogSupportAssignment[] = [];
  for (const spec of getSupportRoleSpecs(focus, largeProjectMode)) {
    const actor = pickBestActor(supportingActors, spec.weights, usedIds, spec.requiredAny);
    if (!actor) continue;
    usedIds.add(actor.id);
    assignments.push({
      actor,
      roleId: spec.id,
      roleLabel: spec.label,
    });
    if (assignments.length >= supportingActors.length) break;
  }

  for (const actor of supportingActors) {
    if (usedIds.has(actor.id)) continue;
    assignments.push({
      actor,
      roleId: "support",
      roleLabel: largeProjectMode ? "模块支援" : "补充支援",
    });
  }

  return assignments;
}

function shouldUseSoloLeadFlow(insight: DialogDispatchInsight, supportingActorCount: number): boolean {
  if (supportingActorCount > 0) return false;
  if (!insight.codingProfile.profile.codingMode || !insight.focus) return true;
  if (insight.codingProfile.profile.largeProjectMode) return false;
  return insight.focus === "implementation";
}

function getEphemeralRoleQueue(
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): Array<Exclude<DialogSupportRoleId, "support">> {
  switch (focus) {
    case "review":
      return largeProjectMode
        ? ["reviewer", "implementer", "tester"]
        : ["reviewer"];
    case "debugging":
      return largeProjectMode
        ? ["debugger", "implementer", "tester"]
        : ["debugger", "tester"];
    case "testing":
      return largeProjectMode
        ? ["tester", "implementer"]
        : ["tester"];
    case "architecture":
      return largeProjectMode
        ? ["architect", "reviewer", "implementer"]
        : ["architect", "reviewer"];
    default:
      return largeProjectMode
        ? ["implementer", "reviewer", "tester"]
        : ["reviewer"];
  }
}

function buildEphemeralDelegates(
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
  coveredRoleIds: Set<Exclude<DialogSupportRoleId, "support">>,
  supportingActorCount: number,
): DialogDelegateLane[] {
  const maxDelegates = supportingActorCount > 0 ? 1 : largeProjectMode ? 2 : 1;
  if (maxDelegates <= 0) return [];
  const usedNames = new Set<string>();
  return getEphemeralRoleQueue(focus, largeProjectMode)
    .filter((roleId) => !coveredRoleIds.has(roleId))
    .slice(0, maxDelegates)
    .flatMap((roleId) => {
      const blueprint = EPHEMERAL_CHILD_LIBRARY[roleId];
      if (!blueprint || usedNames.has(blueprint.targetActorName)) return [];
      usedNames.add(blueprint.targetActorName);
      return [{
        roleId,
        roleLabel: blueprint.roleLabel,
        targetActorId: blueprint.targetActorName,
        targetActorName: blueprint.targetActorName,
        task: "",
        roleBoundary: blueprint.roleBoundary,
        createIfMissing: true,
        childDescription: blueprint.childDescription,
        childCapabilities: blueprint.childCapabilities,
        childMaxIterations: blueprint.childMaxIterations,
      }];
    });
}

function formatRouteReason(reason?: string | null): string {
  const text = String(reason ?? "").trim();
  return text ? `（路由理由：${text}）` : "";
}

function buildDirectTask(taskSummary: string, insight: DialogDispatchInsight): string {
  if (!insight.codingProfile.profile.codingMode) {
    return `直接处理用户指派任务：${taskSummary.slice(0, 240)}`;
  }
  const focus = insight.focusLabel ? `，按${insight.focusLabel}` : "";
  return `直接处理用户指派的编码任务${focus}：${taskSummary.slice(0, 240)}`;
}

function buildGeneralSupportTask(
  actor: DialogPlanningActor,
  primaryActorName: string,
  taskSummary: string,
): string {
  const capabilities = getActorCapabilities(actor);
  const perspective = (() => {
    if (capabilities.includes("security")) return "从安全、权限边界和潜在风险角度";
    if (capabilities.includes("performance")) return "从性能瓶颈、资源消耗和扩展性角度";
    if (capabilities.includes("architecture")) return "从架构边界、模块依赖和长期演进角度";
    if (capabilities.includes("testing")) return "从验证路径、回归覆盖和可复验性角度";
    if (capabilities.includes("code_review")) return "从质量、边界条件和回归风险角度";
    if (capabilities.includes("debugging")) return "从异常链路、根因定位和排查证据角度";
    if (capabilities.includes("creative")) return "从新方案、替代思路和差异化角度";
    if (capabilities.includes("synthesis")) return "从信息整合、优先级和结构化输出角度";
    if (capabilities.includes("documentation")) return "从需求澄清、约束归纳和文档表达角度";
    if (capabilities.includes("research") || capabilities.includes("web_search") || capabilities.includes("information_retrieval")) {
      return "从资料调研、事实核对和可引用信息角度";
    }
    if (capabilities.includes("code_write")) return "从可落地实现和最小改动方案角度";
    return "从你的专长角度";
  })();

  return `${perspective}分析当前任务：${taskSummary.slice(0, 220)}。输出关键发现、风险、建议与下一步，并回传给 ${primaryActorName} 统一整合。`;
}

function buildCodingLeadTask(params: {
  routingMode: DialogRoutingMode;
  taskSummary: string;
  primaryActorName: string;
  focus: DialogCodingFocus;
  largeProjectMode: boolean;
  hasDelegates: boolean;
  routeReason?: string | null;
}): string {
  const {
    routingMode,
    taskSummary,
    focus,
    largeProjectMode,
    hasDelegates,
    routeReason,
  } = params;
  const focusText = getFocusLabel(focus);
  const routeText = formatRouteReason(routeReason);
  if (!hasDelegates) {
    return `你是本轮主代理，请先独立推进编码任务${focusText ? `（${focusText}）` : ""}：${taskSummary.slice(0, 240)}。优先自己完成探索、实现与验证，只有在真正需要隔离审查或验证时再临时创建子代理。${routeText}`;
  }
  if (routingMode === "smart") {
    if (largeProjectMode) {
      return `优先接手大型编码任务，先自己收敛问题，再按“探索 -> 实施 -> 独立审查 -> 验证”决定是否临时创建子代理：${taskSummary.slice(0, 240)}${routeText}`;
    }
    if (focus === "debugging") {
      return `优先接手问题定位与修复任务，先确认根因和受影响范围，再按需临时创建定位、修复或验证子代理：${taskSummary.slice(0, 240)}${routeText}`;
    }
    if (focus === "review") {
      return `优先接手代码评审任务，先标出风险与待确认点，再按需临时创建修复或验证子代理：${taskSummary.slice(0, 240)}${routeText}`;
    }
    return `优先接手编码任务${focusText ? `（${focusText}）` : ""}，先确认修改范围与验证路径，并在必要时临时创建审查/验证子代理：${taskSummary.slice(0, 240)}${routeText}`;
  }

  if (largeProjectMode) {
    return `作为主代理先拆解大型编码任务，明确受影响模块、修改边界、独立审查点与验证顺序，再通过 spawn_task 按需调度实现/评审/验证子代理：${taskSummary.slice(0, 240)}`;
  }
  if (focus === "debugging") {
    return `作为主代理先定位问题根因和最小修复路径，再按需调度实现、独立审查与验证子代理：${taskSummary.slice(0, 240)}`;
  }
  if (focus === "review") {
    return `作为主代理先归纳需要审查的风险点，再按需调度修复建议与验证子代理：${taskSummary.slice(0, 240)}`;
  }
  return `作为主代理先拆解编码任务${focusText ? `（${focusText}）` : ""}，再按需 spawn_task 调度实现、独立评审和验证：${taskSummary.slice(0, 240)}`;
}

function buildCodingSupportTaskByRole(
  roleId: DialogSupportRoleId,
  primaryActorName: string,
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): string {
  switch (roleId) {
    case "architect":
      return `从模块边界、依赖关系和后续演进角度把关方案，帮助 ${primaryActorName} 控制${largeProjectMode ? "大型改动" : "改动范围"}。`;
    case "implementer":
      if (focus === "debugging") {
        return `根据 ${primaryActorName} 收敛出的根因实施修复，说明改动文件、关键 patch 与回归风险。`;
      }
      if (focus === "review") {
        return `若 ${primaryActorName} 判定需要改动，给出最小修复方案、修改文件清单与关键实现细节。`;
      }
      if (focus === "testing") {
        return `补齐必要实现或测试支撑，确保验证路径真正可执行，并汇总落盘文件。`;
      }
      return `负责核心实现，明确修改文件、接口变化与验证结果，并及时回报给 ${primaryActorName}。`;
    case "reviewer":
      return `作为独立审查者，对实现方案或代码改动做 review，重点检查边界条件、回归风险、可维护性与潜在副作用；尽量不要被实现细节带偏。`;
    case "debugger":
      return `定位异常链路与复现条件，帮助 ${primaryActorName} 快速锁定根因；必要时补充最小复现与排查证据。`;
    case "tester":
      return `设计并执行验证步骤，优先覆盖复现、回归、lint/build 或关键测试路径，给出可复验结论。`;
    default:
      return `保持待命；当 ${primaryActorName} 派发任务时，补充自己擅长的实现、评审或验证细节。`;
  }
}

function buildCodingSupportTask(
  assignment: DialogSupportAssignment,
  primaryActorName: string,
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): string {
  return buildCodingSupportTaskByRole(
    assignment.roleId,
    primaryActorName,
    focus,
    largeProjectMode,
  );
}

function buildCodingRuntimeSummary(
  primaryActor: DialogPlanningActor,
  delegates: DialogDelegateLane[],
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): string {
  const focusText = getFocusLabel(focus);
  if (delegates.length === 0) {
    return `${primaryActor.roleName} 以单主代理方式处理${largeProjectMode ? "大型" : ""}编码任务${focusText ? ` · ${focusText}` : ""}`;
  }
  const roleSummary = delegates
    .slice(0, 3)
    .map((delegate) => `${delegate.targetActorName} 负责${delegate.roleLabel}`)
    .join("；");
  return `${primaryActor.roleName} 主接手编码任务${focusText ? ` · ${focusText}` : ""}，并按需委派 ${roleSummary}`;
}

function mapSupportRoleToBoundary(roleId: DialogSupportRoleId): SpawnedTaskRoleBoundary {
  switch (roleId) {
    case "implementer":
    case "debugger":
      return "executor";
    case "reviewer":
    case "architect":
      return "reviewer";
    case "tester":
      return "validator";
    default:
      return "general";
  }
}

function buildPlannedSpawns(
  delegates: DialogDelegateLane[],
): DialogExecutionPlannedSpawn[] {
  return delegates.map((delegate, index) => ({
    id: `spawn-${index + 1}`,
    targetActorId: delegate.targetActorId,
    targetActorName: delegate.targetActorName,
    task: delegate.task,
    label: delegate.roleLabel,
    roleBoundary: delegate.roleBoundary,
    createIfMissing: delegate.createIfMissing,
    childDescription: delegate.childDescription,
    childCapabilities: delegate.childCapabilities,
    childMaxIterations: delegate.childMaxIterations,
  }));
}

function buildCodingBroadcastSteps(
  actors: DialogPlanningActor[],
  taskSummary: string,
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): ClusterStep[] {
  const assignments = assignSupportRoles(actors, "__broadcast__", focus, largeProjectMode);
  const fallbackTask = `并行分析同一编码任务${getFocusLabel(focus) ? `（${getFocusLabel(focus)}）` : ""}，给出自己的实现/风险/验证判断：${taskSummary.slice(0, 220)}`;
  if (assignments.length === 0) {
    return actors.map((actor, index) => ({
      id: `broadcast-${index + 1}`,
      role: actor.roleName,
      task: fallbackTask,
      dependencies: [],
      critical: index === 0,
    }));
  }
  return assignments.map((assignment, index) => ({
    id: `broadcast-${index + 1}`,
    role: assignment.actor.roleName,
    task: `${assignment.roleLabel}视角并行处理：${taskSummary.slice(0, 180)}。${buildCodingSupportTask(assignment, "主线程", focus, largeProjectMode)}`,
    dependencies: [],
    critical: index === 0,
  }));
}

export function inferDialogDispatchInsight(params: {
  content: string;
  attachmentSummary?: string;
  attachmentPaths?: readonly string[];
  manualCodingMode?: boolean;
  handoff?: Partial<AICenterHandoff> | null;
}): DialogDispatchInsight {
  const content = params.content.trim() || "等待用户输入任务";
  const taskSummary = params.attachmentSummary
    ? `${params.attachmentSummary}\n${content}`.trim()
    : content;
  const inferredCodingProfile = inferCodingExecutionProfile({
    query: taskSummary,
    attachmentPaths: params.attachmentPaths,
    handoff: params.handoff,
  });
  const codingProfile = params.manualCodingMode === true
    ? {
        profile: normalizeCodingExecutionProfile({ codingMode: true }),
        autoDetected: false,
        reasons: ["Dialog 已手动开启 Coding 模式"],
      } satisfies ResolvedCodingExecutionProfile
    : params.manualCodingMode === false
      ? {
          profile: normalizeCodingExecutionProfile({ codingMode: false }),
          autoDetected: false,
          reasons: ["Dialog 当前未开启 Coding 模式，按普通协作处理"],
        } satisfies ResolvedCodingExecutionProfile
      : inferredCodingProfile;
  const autoModeLabel = describeCodingExecutionProfile(codingProfile.profile);
  const focus = codingProfile.profile.codingMode
    ? inferCodingFocus(taskSummary, codingProfile.profile.largeProjectMode)
    : null;

  return {
    codingProfile,
    autoModeLabel,
    modeSource: params.manualCodingMode === true
      ? "manual"
      : params.manualCodingMode === false
        ? "none"
        : (codingProfile.profile.codingMode ? "auto" : "none"),
    preferredCapabilities: focus
      ? getPreferredCapabilities(focus, codingProfile.profile.largeProjectMode)
      : [],
    focus,
    focusLabel: getFocusLabel(focus),
    reasons: codingProfile.reasons,
    taskSummary,
  };
}

export function buildDialogDispatchPlanBundle(params: {
  actors: DialogPlanningActor[];
  routingMode: DialogRoutingMode;
  content: string;
  attachmentSummary?: string;
  attachmentPaths?: readonly string[];
  manualCodingMode?: boolean;
  handoff?: Partial<AICenterHandoff> | null;
  mentionedTargetId?: string | null;
  selectedRoute?: { agentId: string; reason: string } | null;
  coordinatorActorId?: string | null;
}): DialogDispatchPlanBundle | null {
  const {
    actors,
    routingMode,
    content,
    attachmentSummary,
    attachmentPaths,
    manualCodingMode,
    handoff,
    mentionedTargetId,
    selectedRoute,
    coordinatorActorId,
  } = params;
  if (actors.length === 0) return null;

  const planId = `dialog-plan-${Date.now().toString(36)}`;
  const insight = inferDialogDispatchInsight({
    content,
    attachmentSummary,
    attachmentPaths,
    manualCodingMode,
    handoff,
  });
  const taskSummary = insight.taskSummary;

  if (mentionedTargetId) {
    const target = actors.find((actor) => actor.id === mentionedTargetId);
    if (!target) return null;
    return {
      clusterPlan: {
        id: planId,
        mode: "multi_role",
        sharedContext: {
          routingMode: "direct",
          taskType: insight.codingProfile.profile.codingMode ? "coding" : "general",
          codingFocus: insight.focus,
        },
        steps: [
          {
            id: "direct-1",
            role: target.roleName,
            task: buildDirectTask(taskSummary, insight),
            dependencies: [],
            critical: true,
          },
        ],
      },
      runtimePlan: {
        id: planId,
        routingMode: "direct",
        summary: insight.codingProfile.profile.codingMode
          ? `仅 ${target.roleName} 直接处理编码任务`
          : `仅 ${target.roleName} 直接处理本轮任务`,
        approvedAt: Date.now(),
        initialRecipientActorIds: [target.id],
        participantActorIds: [target.id],
        allowedMessagePairs: [],
        allowedSpawnPairs: [],
        state: "armed",
      },
      insight,
    };
  }

  if (routingMode === "broadcast") {
    const steps = insight.codingProfile.profile.codingMode && insight.focus
      ? buildCodingBroadcastSteps(
          actors,
          taskSummary,
          insight.focus,
          insight.codingProfile.profile.largeProjectMode,
        )
      : actors.map((actor, index) => ({
          id: `broadcast-${index + 1}`,
          role: actor.roleName,
          task: `并行处理同一主题并给出视角：${taskSummary.slice(0, 220)}`,
          dependencies: [],
          critical: index === 0,
        }));
    return {
      clusterPlan: {
        id: planId,
        mode: "parallel_split",
        sharedContext: {
          routingMode,
          actorCount: actors.length,
          taskType: insight.codingProfile.profile.codingMode ? "coding" : "general",
          codingFocus: insight.focus,
        },
        steps,
      },
      runtimePlan: {
        id: planId,
        routingMode: "broadcast",
        summary: insight.codingProfile.profile.codingMode
          ? `广播到 ${actors.length} 个 Agent，并行处理编码任务`
          : `广播到 ${actors.length} 个 Agent 并行处理`,
        approvedAt: Date.now(),
        initialRecipientActorIds: actors.map((actor) => actor.id),
        participantActorIds: actors.map((actor) => actor.id),
        allowedMessagePairs: [],
        allowedSpawnPairs: [],
        state: "armed",
      },
      insight,
    };
  }

  const preferredPrimaryId = routingMode === "smart"
    ? selectedRoute?.agentId ?? (insight.codingProfile.profile.largeProjectMode ? coordinatorActorId : null)
    : coordinatorActorId;
  const primaryWeights = insight.focus
    ? getPrimaryWeights(insight.focus, routingMode, insight.codingProfile.profile.largeProjectMode)
    : {};
  const primaryActor = preferredPrimaryId
    ? actors.find((actor) => actor.id === preferredPrimaryId)
      ?? pickBestActor(actors, primaryWeights, new Set<string>())
      ?? actors[0]
    : pickBestActor(actors, primaryWeights, new Set<string>()) ?? actors[0];
  const supportingActors = actors.filter((actor) => actor.id !== primaryActor.id);
  const allowedMessagePairs = supportingActors.flatMap((actor) => ([
    { fromActorId: primaryActor.id, toActorId: actor.id },
    { fromActorId: actor.id, toActorId: primaryActor.id },
  ]));
  const allowedSpawnPairs = supportingActors.map((actor) => ({
    fromActorId: primaryActor.id,
    toActorId: actor.id,
  }));

  if (!insight.codingProfile.profile.codingMode || !insight.focus) {
    if (supportingActors.length === 0) {
      return {
        clusterPlan: {
          id: planId,
          mode: "multi_role",
          sharedContext: { routingMode, coordinator: primaryActor.roleName },
          steps: [
            {
              id: "plan-1",
              role: primaryActor.roleName,
              task: `由 ${primaryActor.roleName} 作为单主代理直接处理当前任务：${taskSummary.slice(0, 240)}`,
              dependencies: [],
              critical: true,
            },
          ],
        },
        runtimePlan: {
          id: planId,
          routingMode: routingMode === "smart" ? "smart" : "coordinator",
          summary: `${primaryActor.roleName} 以单主代理方式直接处理本轮任务`,
          approvedAt: Date.now(),
          initialRecipientActorIds: [primaryActor.id],
          participantActorIds: [primaryActor.id],
          coordinatorActorId: primaryActor.id,
          allowedMessagePairs: [],
          allowedSpawnPairs: [],
          state: "armed",
        },
        insight,
      };
    }

    const supportTasks = supportingActors.map((actor) => ({
      actor,
      task: buildGeneralSupportTask(actor, primaryActor.roleName, taskSummary),
      label: actor.roleName,
      roleBoundary: "general" as const,
    }));
    const steps = [
      {
        id: "plan-1",
        role: primaryActor.roleName,
        task: routingMode === "smart"
          ? `优先接手用户任务并判断是否要派发子任务：${taskSummary.slice(0, 240)}${selectedRoute?.reason ? `（路由理由：${selectedRoute.reason}）` : ""}`
          : `作为协调者先拆解任务，再按需 spawn_task：${taskSummary.slice(0, 240)}`,
        dependencies: [],
        critical: true,
      },
      ...supportTasks.map((assignment, index) => ({
        id: `plan-${index + 2}`,
        role: assignment.actor.roleName,
        task: assignment.task,
        dependencies: ["plan-1"],
        critical: false,
      })),
    ];

    return {
      clusterPlan: {
        id: planId,
        mode: "multi_role",
        sharedContext: { routingMode, coordinator: primaryActor.roleName },
        steps,
      },
      runtimePlan: {
        id: planId,
        routingMode: routingMode === "smart" ? "smart" : "coordinator",
        summary: `${primaryActor.roleName} 作为主协调者按需调度其他 Agent`,
        approvedAt: Date.now(),
        initialRecipientActorIds: [primaryActor.id],
        participantActorIds: [primaryActor.id, ...supportingActors.map((actor) => actor.id)],
        coordinatorActorId: primaryActor.id,
        allowedMessagePairs,
        allowedSpawnPairs,
        plannedSpawns: buildPlannedSpawns(
          supportTasks.map((assignment) => ({
            roleId: "support",
            roleLabel: assignment.label,
            targetActorId: assignment.actor.id,
            targetActorName: assignment.actor.roleName,
            task: assignment.task,
            roleBoundary: assignment.roleBoundary,
          })),
        ),
        state: "armed",
      },
      insight,
    };
  }

  const focus = insight.focus;
  const largeProjectMode = insight.codingProfile.profile.largeProjectMode;
  const soloLeadFlow = shouldUseSoloLeadFlow(insight, supportingActors.length);
  if (soloLeadFlow) {
    return {
      clusterPlan: {
        id: planId,
        mode: "multi_role",
        sharedContext: {
          routingMode,
          coordinator: primaryActor.roleName,
          taskType: "coding",
          codingFocus: focus,
          codingModeLabel: insight.autoModeLabel,
          collaboration: "solo_lead",
        },
        steps: [
          {
            id: "plan-1",
            role: primaryActor.roleName,
            task: buildCodingLeadTask({
              routingMode,
              taskSummary,
              primaryActorName: primaryActor.roleName,
              focus,
              largeProjectMode,
              hasDelegates: false,
              routeReason: selectedRoute?.reason,
            }),
            dependencies: [],
            critical: true,
          },
        ],
      },
      runtimePlan: {
        id: planId,
        routingMode: routingMode === "smart" ? "smart" : "coordinator",
        summary: `${primaryActor.roleName} 以单主代理方式推进编码任务${insight.focusLabel ? ` · ${insight.focusLabel}` : ""}`,
        approvedAt: Date.now(),
        initialRecipientActorIds: [primaryActor.id],
        participantActorIds: [primaryActor.id],
        coordinatorActorId: primaryActor.id,
        allowedMessagePairs: [],
        allowedSpawnPairs: [],
        state: "armed",
      },
      insight,
    };
  }

  const assignments = assignSupportRoles(
    actors,
    primaryActor.id,
    focus,
    largeProjectMode,
  );
  const existingDelegates: DialogDelegateLane[] = assignments.map((assignment) => ({
    roleId: assignment.roleId,
    roleLabel: assignment.roleLabel,
    targetActorId: assignment.actor.id,
    targetActorName: assignment.actor.roleName,
    task: buildCodingSupportTask(
      assignment,
      primaryActor.roleName,
      focus,
      largeProjectMode,
    ),
    roleBoundary: mapSupportRoleToBoundary(assignment.roleId),
  }));
  const coveredRoleIds = supportingActors.length > 0
    ? getCoveredSupportRoles(actors)
    : new Set<Exclude<DialogSupportRoleId, "support">>();
  const ephemeralDelegates = buildEphemeralDelegates(
    focus,
    largeProjectMode,
    coveredRoleIds,
    supportingActors.length,
  ).map((delegate) => ({
    ...delegate,
    task: buildCodingSupportTaskByRole(
      delegate.roleId,
      primaryActor.roleName,
      focus,
      largeProjectMode,
    ),
  }));
  const delegates = [...existingDelegates, ...ephemeralDelegates];
  const steps: ClusterStep[] = [
    {
      id: "plan-1",
      role: primaryActor.roleName,
      task: buildCodingLeadTask({
        routingMode,
        taskSummary,
        primaryActorName: primaryActor.roleName,
        focus,
        largeProjectMode,
        hasDelegates: delegates.length > 0,
        routeReason: selectedRoute?.reason,
      }),
      dependencies: [],
      critical: true,
    },
    ...delegates.map((delegate, index) => ({
      id: `plan-${index + 2}`,
      role: delegate.targetActorName,
      task: delegate.task,
      dependencies: ["plan-1"],
      critical: false,
    })),
  ];
  const plannedSpawns = buildPlannedSpawns(delegates);

  return {
    clusterPlan: {
      id: planId,
      mode: "multi_role",
      sharedContext: {
        routingMode,
        coordinator: primaryActor.roleName,
        taskType: "coding",
        codingFocus: focus,
        codingModeLabel: insight.autoModeLabel,
      },
      steps,
    },
    runtimePlan: {
      id: planId,
      routingMode: routingMode === "smart" ? "smart" : "coordinator",
      summary: buildCodingRuntimeSummary(
        primaryActor,
        delegates,
        focus,
        largeProjectMode,
      ),
      approvedAt: Date.now(),
      initialRecipientActorIds: [primaryActor.id],
      participantActorIds: [primaryActor.id, ...supportingActors.map((actor) => actor.id)],
      coordinatorActorId: primaryActor.id,
      allowedMessagePairs,
      allowedSpawnPairs,
      plannedSpawns,
      state: "armed",
    },
    insight,
  };
}

export function buildExecutionContractDraftFromDialog(
  params: BuildExecutionContractDraftFromDialogParams,
): (ExecutionContractDraft & { insight: DialogDispatchInsight }) | null {
  const planBundle = buildDialogDispatchPlanBundle(params);
  if (!planBundle) return null;
  const structuredDeliveryManifest = toPlannerStructuredDeliveryManifest(
    params.structuredDeliveryManifest ?? resolveStructuredDeliveryManifest(params.content),
  );
  const draft = buildExecutionContractDraftFromDialogBundle({
    surface: "local_dialog",
    bundle: planBundle,
    input: {
      content: params.content,
      briefContent: params.attachmentSummary,
      attachmentPaths: params.attachmentPaths ? [...params.attachmentPaths] : undefined,
    },
    structuredDeliveryManifest,
    actorRoster: params.actorRoster ?? params.actors.map((actor) => ({
      actorId: actor.id,
      roleName: actor.roleName,
      capabilities: actor.capabilities?.tags,
    })),
  });
  const structuredPlannedDelegations = buildStructuredPlannedDelegations({
    taskText: params.content,
    manifest: structuredDeliveryManifest,
  });
  if (structuredPlannedDelegations?.length) {
    draft.plannedDelegations = structuredPlannedDelegations;
    const coordinatorActorId = draft.coordinatorActorId ?? draft.initialRecipientActorIds[0];
    for (const delegation of structuredPlannedDelegations) {
      if (!draft.participantActorIds.includes(delegation.targetActorId)) {
        draft.participantActorIds.push(delegation.targetActorId);
      }
      if (coordinatorActorId) {
        if (!draft.allowedSpawnPairs.some((pair) => pair.fromActorId === coordinatorActorId && pair.toActorId === delegation.targetActorId)) {
          draft.allowedSpawnPairs.push({ fromActorId: coordinatorActorId, toActorId: delegation.targetActorId });
        }
        if (!draft.allowedMessagePairs.some((pair) => pair.fromActorId === coordinatorActorId && pair.toActorId === delegation.targetActorId)) {
          draft.allowedMessagePairs.push({ fromActorId: coordinatorActorId, toActorId: delegation.targetActorId });
        }
        if (!draft.allowedMessagePairs.some((pair) => pair.fromActorId === delegation.targetActorId && pair.toActorId === coordinatorActorId)) {
          draft.allowedMessagePairs.push({ fromActorId: delegation.targetActorId, toActorId: coordinatorActorId });
        }
      }
    }
  }
  return { ...draft, insight: planBundle.insight };
}

export function buildClusterPresentationFromDraft(params: {
  draft: ExecutionContractDraft & { insight?: DialogDispatchInsight };
  actors: readonly { id: string; roleName: string }[];
}): ApprovalDialogPresentation {
  const actorById = new Map(params.actors.map((actor) => [actor.id, actor.roleName] as const));
  const coordinatorLabel = params.draft.coordinatorActorId
    ? actorById.get(params.draft.coordinatorActorId) ?? params.draft.coordinatorActorId
    : undefined;
  const participantLabels = [...new Set(
    params.draft.participantActorIds.map((actorId) => actorById.get(actorId) ?? actorId),
  )];
  const structuredDeliveryNotes: string[] = [];
  const manifest = params.draft.structuredDeliveryManifest;
  if (manifest && (manifest.applyInitialIsolation || manifest.deliveryContract !== "general" || getStructuredDeliveryStrategyReferenceId(manifest))) {
    structuredDeliveryNotes.push(`交付合同：${manifest.deliveryContract} / ${manifest.parentContract}`);
    const strategyReferenceId = getStructuredDeliveryStrategyReferenceId(manifest);
    if (strategyReferenceId) {
      structuredDeliveryNotes.push(`adapter：${strategyReferenceId}${manifest.adapterEnabled ? "（已启用）" : "（建议）"}`);
    }
    if (manifest.targets?.length) {
      structuredDeliveryNotes.push(`交付目标：${[...new Set(manifest.targets.map((target) => target.label))].join("、")}`);
    }
    const groundedItemCount = manifest.sourceSnapshot?.items.length
      ?? manifest.sourceSnapshot?.expectedItemCount;
    if (typeof groundedItemCount === "number" && groundedItemCount > 0) {
      structuredDeliveryNotes.push(`源条目数：${groundedItemCount}`);
    }
    if (manifest.resultSchema?.fields?.length) {
      structuredDeliveryNotes.push(`结构化字段：${manifest.resultSchema.fields.map((field) => field.label).join("、")}`);
    }
  }
  return {
    kind: "boundary",
    title: "审批协作边界",
    description: "请确认本轮协作的主负责人、可参与范围和授权边界是否合理。",
    modeLabel: params.draft.insight?.autoModeLabel
      ? `${params.draft.insight.autoModeLabel} · ${params.draft.executionStrategy}`
      : params.draft.executionStrategy,
    taskPreview: params.draft.input.briefContent ?? params.draft.input.content,
    summary: params.draft.summary,
    coordinatorLabel,
    participantLabels,
    permissions: [
      coordinatorLabel
        ? `${coordinatorLabel} 负责主协调、分工和最终输出。`
        : "主接手 Agent 负责主协调、分工和最终输出。",
      "本次审批的是协作边界与 delegation 上限，而不是固定的逐条执行脚本。",
      "建议 delegations 可以被主协调者在运行时调整，但越界行为会被 runtime 拒绝。",
    ],
    notes: [
      ...(params.draft.plannedDelegations.length > 0
        ? [`建议 delegation：${params.draft.plannedDelegations.map((item) => item.label || item.targetActorName || item.targetActorId).join("、")}`]
        : ["本轮没有预设 delegation，主协调者会按现场情况决定是否拆分。"]),
      ...structuredDeliveryNotes,
    ],
  };
}

export function sealExecutionContractFromDialog(params: {
  draft: ExecutionContractDraft;
  approvedAt?: number;
}): ExecutionContract {
  return sealDialogExecutionContract(params.draft, {
    approvedAt: params.approvedAt,
  });
}
