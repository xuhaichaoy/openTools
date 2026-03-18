import type { AICenterHandoff } from "@/store/app-store";
import {
  describeCodingExecutionProfile,
  inferCodingExecutionProfile,
  type ResolvedCodingExecutionProfile,
} from "@/core/agent/coding-profile";
import type { ClusterPlan, ClusterStep } from "@/core/agent/cluster/types";
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

interface DialogSupportAssignment {
  actor: DialogPlanningActor;
  roleId: DialogSupportRoleId;
  roleLabel: string;
}

type CapabilityWeights = Partial<Record<AgentCapability, number>>;
type DialogSupportRoleId = "architect" | "implementer" | "reviewer" | "debugger" | "tester" | "support";

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
  routeReason?: string | null;
}): string {
  const {
    routingMode,
    taskSummary,
    focus,
    largeProjectMode,
    routeReason,
  } = params;
  const focusText = getFocusLabel(focus);
  const routeText = formatRouteReason(routeReason);
  if (routingMode === "smart") {
    if (largeProjectMode) {
      return `优先接手大型编码任务，先按“探索 -> 设计 -> 实施 -> 独立审查 -> 验证”拆解范围，再按需派发实现/评审/验证子任务：${taskSummary.slice(0, 240)}${routeText}`;
    }
    if (focus === "debugging") {
      return `优先接手问题定位与修复任务，先确认根因和受影响范围，再按需派发修复、独立审查或验证子任务：${taskSummary.slice(0, 240)}${routeText}`;
    }
    if (focus === "review") {
      return `优先接手代码评审任务，先标出风险与待确认点，再按需派发修复或验证子任务：${taskSummary.slice(0, 240)}${routeText}`;
    }
    return `优先接手编码任务${focusText ? `（${focusText}）` : ""}，先确认修改范围与验证路径，并预留独立 review，再按需派发子任务：${taskSummary.slice(0, 240)}${routeText}`;
  }

  if (largeProjectMode) {
    return `作为技术协调者先拆解大型编码任务，明确受影响模块、修改边界、独立审查点与验证顺序，再通过 spawn_task 调度实现/评审/验证：${taskSummary.slice(0, 240)}`;
  }
  if (focus === "debugging") {
    return `作为协调者先定位问题根因和最小修复路径，再按需派发实现、独立审查与验证子任务：${taskSummary.slice(0, 240)}`;
  }
  if (focus === "review") {
    return `作为协调者先归纳需要审查的风险点，再按需派发修复建议与验证子任务：${taskSummary.slice(0, 240)}`;
  }
  return `作为协调者先拆解编码任务${focusText ? `（${focusText}）` : ""}，再按需 spawn_task 派发实现、独立评审和验证：${taskSummary.slice(0, 240)}`;
}

function buildCodingSupportTask(
  assignment: DialogSupportAssignment,
  primaryActorName: string,
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): string {
  switch (assignment.roleId) {
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

function buildCodingRuntimeSummary(
  routingMode: DialogRoutingMode,
  primaryActor: DialogPlanningActor,
  assignments: DialogSupportAssignment[],
  focus: DialogCodingFocus,
  largeProjectMode: boolean,
): string {
  const focusText = getFocusLabel(focus);
  if (assignments.length === 0) {
    return `${primaryActor.roleName} 单独处理${largeProjectMode ? "大型" : ""}编码任务${focusText ? ` · ${focusText}` : ""}`;
  }
  const roleSummary = assignments
    .slice(0, 3)
    .map((assignment) => `${assignment.actor.roleName} 负责${assignment.roleLabel}`)
    .join("；");
  if (routingMode === "smart") {
    return `${primaryActor.roleName} 主接手编码任务${focusText ? ` · ${focusText}` : ""}，并协调 ${roleSummary}`;
  }
  return `${primaryActor.roleName} 作为技术协调者推进编码任务${focusText ? ` · ${focusText}` : ""}，并调度 ${roleSummary}`;
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
  assignments: Array<{
    actor: DialogPlanningActor;
    task: string;
    label: string;
    roleBoundary?: SpawnedTaskRoleBoundary;
  }>,
): DialogExecutionPlannedSpawn[] {
  return assignments.map((assignment, index) => ({
    id: `spawn-${index + 1}`,
    targetActorId: assignment.actor.id,
    task: assignment.task,
    label: assignment.label,
    roleBoundary: assignment.roleBoundary,
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
  handoff?: Partial<AICenterHandoff> | null;
}): DialogDispatchInsight {
  const content = params.content.trim() || "等待用户输入任务";
  const taskSummary = params.attachmentSummary
    ? `${params.attachmentSummary}\n${content}`.trim()
    : content;
  const codingProfile = inferCodingExecutionProfile({
    query: taskSummary,
    attachmentPaths: params.attachmentPaths,
    handoff: params.handoff,
  });
  const autoModeLabel = describeCodingExecutionProfile(codingProfile.profile);
  const focus = codingProfile.profile.codingMode
    ? inferCodingFocus(taskSummary, codingProfile.profile.largeProjectMode)
    : null;

  return {
    codingProfile,
    autoModeLabel,
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
        plannedSpawns: buildPlannedSpawns(supportTasks),
        state: "armed",
      },
      insight,
    };
  }

  const assignments = assignSupportRoles(
    actors,
    primaryActor.id,
    insight.focus,
    insight.codingProfile.profile.largeProjectMode,
  );
  const steps: ClusterStep[] = [
    {
      id: "plan-1",
      role: primaryActor.roleName,
      task: buildCodingLeadTask({
        routingMode,
        taskSummary,
        primaryActorName: primaryActor.roleName,
        focus: insight.focus,
        largeProjectMode: insight.codingProfile.profile.largeProjectMode,
        routeReason: selectedRoute?.reason,
      }),
      dependencies: [],
      critical: true,
    },
    ...assignments.map((assignment, index) => ({
      id: `plan-${index + 2}`,
      role: assignment.actor.roleName,
      task: buildCodingSupportTask(
        assignment,
        primaryActor.roleName,
        insight.focus!,
        insight.codingProfile.profile.largeProjectMode,
      ),
      dependencies: ["plan-1"],
      critical: false,
    })),
  ];
  const plannedSpawns = buildPlannedSpawns(
    assignments.map((assignment) => ({
      actor: assignment.actor,
      task: buildCodingSupportTask(
        assignment,
        primaryActor.roleName,
        insight.focus!,
        insight.codingProfile.profile.largeProjectMode,
      ),
      label: assignment.roleLabel,
      roleBoundary: mapSupportRoleToBoundary(assignment.roleId),
    })),
  );

  return {
    clusterPlan: {
      id: planId,
      mode: "multi_role",
      sharedContext: {
        routingMode,
        coordinator: primaryActor.roleName,
        taskType: "coding",
        codingFocus: insight.focus,
        codingModeLabel: insight.autoModeLabel,
      },
      steps,
    },
    runtimePlan: {
      id: planId,
      routingMode: routingMode === "smart" ? "smart" : "coordinator",
      summary: buildCodingRuntimeSummary(
        routingMode,
        primaryActor,
        assignments,
        insight.focus,
        insight.codingProfile.profile.largeProjectMode,
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
