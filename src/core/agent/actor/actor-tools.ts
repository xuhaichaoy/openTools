import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorSystem } from "./actor-system";
import type { AgentCapability, SpawnedTaskRoleBoundary, WorkerProfileId } from "./types";
import type { AgentScheduledTask, AgentTaskOriginMode } from "@/core/ai/types";
import { isLikelyVisualAttachmentPath } from "@/core/ai/ai-center-handoff";
import {
  buildPersistentScheduledQuery,
  inferDirectScheduledDelivery,
  isScheduledTaskActive,
  parsePersistentScheduledQuery,
} from "@/core/agent/scheduled-task-utils";
import {
  readSessionHistory,
  getSessionSummary,
  listTranscriptSessionIds,
} from "./actor-transcript";
import {
  applyBuiltinAgentDefaults,
  listBuiltinAgentIds,
  resolveBuiltinAgentDefinition,
  type BuiltinAgentId,
} from "@/core/agent/definitions/builtin";
import {
  enableStructuredDeliveryAdapter,
  getStructuredDeliveryStrategyReferenceId,
  resolveStructuredDeliveryManifest,
} from "./structured-delivery-strategy";
import type { SourceGroundingItem } from "./source-grounding";
import { resolveWorkerProfile } from "./worker-profiles";
import type { ScopedSourceItem } from "./types";

const KNOWN_AGENT_CAPABILITIES = new Set<AgentCapability>([
  "coordinator",
  "code_review",
  "code_write",
  "code_analysis",
  "security",
  "performance",
  "architecture",
  "debugging",
  "research",
  "documentation",
  "testing",
  "devops",
  "data_analysis",
  "creative",
  "synthesis",
  "file_write",
  "shell_execute",
  "information_retrieval",
  "web_search",
]);

const KNOWN_ROLE_BOUNDARIES = new Set<SpawnedTaskRoleBoundary>([
  "general",
  "executor",
  "reviewer",
  "validator",
]);
const KNOWN_WORKER_PROFILES = new Set<WorkerProfileId>([
  "general_worker",
  "content_worker",
  "coding_worker",
  "validator_worker",
  "review_worker",
  "spreadsheet_worker",
]);
const BUILTIN_AGENT_DESCRIPTION = listBuiltinAgentIds().join("', '");

function previewSpawnTargetText(value?: string, maxLength = 32): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function deriveEphemeralSpawnTarget(params: {
  target?: string;
  label?: string;
  description?: string;
  task?: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
}): string {
  const candidates = [
    params.target,
    params.label,
    params.description,
    previewSpawnTargetText(params.task),
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").replace(/\s+/g, " ").trim();
    if (normalized) return normalized;
  }

  switch (params.roleBoundary) {
    case "reviewer":
      return "Independent Reviewer";
    case "validator":
      return "QA Validator";
    case "executor":
      return "Task Executor";
    default:
      return "Temporary Worker";
  }
}

async function invokeTauriCommand<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function formatScheduledTaskTime(timestamp?: number | null): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  return new Date(timestamp).toLocaleString("zh-CN");
}

function getScheduledTaskOriginMode(task: Pick<AgentScheduledTask, "origin_mode">): AgentTaskOriginMode {
  return task.origin_mode ?? "local";
}

function getScheduledTaskOriginLabel(task: Pick<AgentScheduledTask, "origin_mode" | "origin_label">): string {
  if (task.origin_label?.trim()) return task.origin_label.trim();
  switch (getScheduledTaskOriginMode(task)) {
    case "dingtalk":
      return "钉钉";
    case "feishu":
      return "飞书";
    default:
      return "本机";
  }
}

function describeScheduledTaskState(task: AgentScheduledTask): string {
  const active = isScheduledTaskActive(task);
  if (task.status === "running") {
    return "正在执行中";
  }
  if (active) {
    if (task.last_result_status === "success") {
      return "已启用，最近一次执行成功，仍会继续执行";
    }
    if (task.last_result_status === "error") {
      return "已启用，最近一次执行失败，仍会继续重试后续调度";
    }
    if (task.last_result_status === "skipped") {
      return `已启用，最近一次跳过${task.last_skip_reason ? `（${task.last_skip_reason}）` : ""}`;
    }
    return "已启用，等待下次执行";
  }
  if (task.status === "paused") return "已暂停";
  if (task.status === "cancelled") return "已取消";
  if (task.status === "success") return "已完成";
  if (task.status === "error") return "已停止，最近一次执行失败";
  return "等待执行";
}

function inferScheduledTaskOrigin(system: ActorSystem): {
  originMode: AgentTaskOriginMode;
  originLabel: string;
  channelId?: string;
  conversationId?: string;
  sessionId?: string;
} {
  const latestUserMessage = [...system.getDialogHistory()]
    .reverse()
    .find((message) => message.from === "user" && message.kind === "user_input");

  switch (latestUserMessage?.externalChannelType) {
    case "dingtalk":
      return {
        originMode: "dingtalk",
        originLabel: "钉钉",
        channelId: latestUserMessage.externalChannelId,
        conversationId: latestUserMessage.externalConversationId,
        sessionId: latestUserMessage.externalSessionId ?? system.sessionId,
      };
    case "feishu":
      return {
        originMode: "feishu",
        originLabel: "飞书",
        channelId: latestUserMessage.externalChannelId,
        conversationId: latestUserMessage.externalConversationId,
        sessionId: latestUserMessage.externalSessionId ?? system.sessionId,
      };
    default:
      return {
        originMode: "local",
        originLabel: "本机",
        sessionId: system.sessionId,
      };
  }
}

function normalizeMediaPathCandidate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^file:\/\//i.test(trimmed)) {
    return trimmed.replace(/\\/g, "/");
  }

  try {
    const url = new URL(trimmed);
    const pathname = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      return pathname.slice(1).replace(/\\/g, "/");
    }
    return (pathname || trimmed).replace(/\\/g, "/");
  } catch {
    return trimmed.replace(/\\/g, "/");
  }
}

function parseLocalMediaCandidates(params: {
  path?: unknown;
  paths?: unknown;
}): string[] {
  const single = typeof params.path === "string" ? [params.path] : [];
  const multiple = typeof params.paths === "string"
    ? params.paths
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean)
    : [];
  return [...single, ...multiple]
    .map((item) => normalizeMediaPathCandidate(item))
    .filter(Boolean);
}

function getMediaFileName(path: string): string {
  const normalized = normalizeMediaPathCandidate(path);
  const cleanPath = normalized.split("?")[0]?.split("#")[0] ?? normalized;
  const parts = cleanPath.split("/");
  return parts[parts.length - 1] || cleanPath;
}

function parseChecklist(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/\r?\n|[；;]+/u)
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)、．])\s*/u, "").trim())
    .filter(Boolean);
}

function buildDelegationTaskText(params: {
  goal: string;
  acceptance?: string;
  defaultAcceptance?: string[];
}): string {
  const goal = params.goal.trim();
  const acceptanceItems = parseChecklist(params.acceptance);
  const mergedAcceptanceItems = acceptanceItems.length > 0
    ? acceptanceItems
    : (params.defaultAcceptance ?? []).filter(Boolean);
  const lines = ["## 任务目标", goal];
  if (mergedAcceptanceItems.length > 0) {
    lines.push("", "## 验收标准", ...mergedAcceptanceItems.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

function isSpreadsheetDeliveryManifest(
  manifest: ReturnType<typeof resolveStructuredDeliveryManifest> | null | undefined,
): boolean {
  return Boolean(
    manifest
    && (manifest.deliveryContract === "spreadsheet" || manifest.parentContract === "single_workbook"),
  );
}

function isWorkbookAggregationDelegation(params: {
  task: string;
  manifest: ReturnType<typeof resolveStructuredDeliveryManifest> | null | undefined;
  workerProfileId?: WorkerProfileId;
  resultContract?: "default" | "inline_structured_result";
}): boolean {
  if (!params.manifest || params.manifest.parentContract !== "single_workbook") {
    return false;
  }

  const normalizedTask = String(params.task ?? "").trim();
  if (!normalizedTask) return false;

  const aggregateWorkbookIntent =
    /(?:整合|汇总|合并|聚合|aggregate|combine|collect all)/iu.test(normalizedTask)
    && /(?:excel|xlsx|xls|csv|表格|工作簿|导出|生成文件|最终文件|最终工作簿|export)/iu.test(normalizedTask)
    && /(?:所有|全部|all|子任务|工作簿|结果文件|current\s*run)/iu.test(normalizedTask);
  const childResultScanningIntent =
    /(?:子任务|子Agent|当前\s*run|结果文件|工作目录|其他\d*个?子)/iu.test(normalizedTask)
    && /(?:整合|汇总|读取|收集|访问|扫描|导出)/iu.test(normalizedTask);

  return (
    aggregateWorkbookIntent
    || childResultScanningIntent
    || (
      String(params.workerProfileId ?? "").trim() === "spreadsheet_worker"
      && params.resultContract !== "inline_structured_result"
      && /(?:excel|xlsx|xls|csv|表格|工作簿)/iu.test(normalizedTask)
    )
  );
}

function buildScopedSourceItemsFromGroundingItems(
  items: readonly SourceGroundingItem[] | undefined,
): ScopedSourceItem[] | undefined {
  if (!items?.length) return undefined;
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    raw: item.raw,
    order: item.order,
    sourcePath: item.sourcePath,
    sectionLabel: item.sectionLabel,
    topicIndex: item.topicIndex,
    topicTitle: item.topicTitle,
    themeGroup: item.themeGroup,
    trainingTarget: item.trainingTarget,
    trainingAudience: item.trainingAudience,
    outline: item.outline,
  }));
}

function parseStringArrayParam(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const values = raw
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
    return values.length > 0 ? values : undefined;
  }
  if (typeof raw === "string") {
    const values = raw
      .split(/[\r\n,]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

function parseScopedSourceItemsParam(raw: unknown): ScopedSourceItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      label: String(item.label ?? "").trim(),
      raw: String(item.raw ?? "").trim(),
      order: Number(item.order ?? 0),
      sourcePath: item.sourcePath ? String(item.sourcePath).trim() : undefined,
      sectionLabel: item.sectionLabel ? String(item.sectionLabel).trim() : undefined,
      topicIndex: Number.isFinite(Number(item.topicIndex)) ? Number(item.topicIndex) : undefined,
      topicTitle: item.topicTitle ? String(item.topicTitle).trim() : undefined,
      themeGroup: item.themeGroup ? String(item.themeGroup).trim() : undefined,
      trainingTarget: item.trainingTarget ? String(item.trainingTarget).trim() : undefined,
      trainingAudience: item.trainingAudience ? String(item.trainingAudience).trim() : undefined,
      outline: item.outline ? String(item.outline).trim() : undefined,
    }))
    .filter((item) => item.id && item.label);
  return items.length > 0 ? items : undefined;
}

function resolveParentStructuredDeliveryManifest(
  actorId: string,
  system: ActorSystem,
): ReturnType<typeof resolveStructuredDeliveryManifest> | null {
  const contractManifest = system.getActiveExecutionContract?.()?.structuredDeliveryManifest ?? null;
  const actor = system.get(actorId) as
    | {
        currentTask?: { query?: string };
        getEngagedStructuredDeliveryManifest?: () => ReturnType<typeof resolveStructuredDeliveryManifest> | null;
      }
    | undefined;
  const engagedManifest = actor?.getEngagedStructuredDeliveryManifest?.() ?? null;
  const currentTaskQuery = actor?.currentTask?.query?.trim();
  const queryManifest = currentTaskQuery ? resolveStructuredDeliveryManifest(currentTaskQuery) : null;
  if ((contractManifest?.sourceSnapshot?.items.length ?? 0) > 0) return contractManifest;
  if ((engagedManifest?.sourceSnapshot?.items.length ?? 0) > 0) return engagedManifest;
  if ((queryManifest?.sourceSnapshot?.items.length ?? 0) > 0) return queryManifest;
  return contractManifest ?? engagedManifest ?? queryManifest;
}

function buildDefaultDelegationAcceptance(params: {
  roleBoundary?: SpawnedTaskRoleBoundary;
  workerProfileId?: WorkerProfileId;
}): string[] {
  if (params.workerProfileId === "spreadsheet_worker") {
    return [
      "完整返回结构化 rows，不写文件、不导出表格。",
      "每行只绑定 1 个 `sourceItemId`，并显式包含 `topicIndex`、`topicTitle`、`coverageType`。",
      "说明已覆盖条目数、产出行数，以及是否存在 blocker。",
    ];
  }
  if (params.workerProfileId === "content_worker") {
    return [
      "直接返回完整内容结果，不写中间文件。",
      "给出关键结论、证据和未完成部分。",
      "如果存在 blocker，明确写出原因和建议后续动作。",
    ];
  }
  switch (params.roleBoundary) {
    case "reviewer":
      return [
        "给出主要风险、边界条件和回归点。",
        "每个风险都附带证据或触发条件。",
        "默认不接管实现，只提出修复建议。",
      ];
    case "validator":
      return [
        "给出复现/验证步骤、命令或输入条件。",
        "明确写出验证结论：通过、失败或受阻。",
        "列出剩余风险和建议补充验证项。",
      ];
    case "executor":
      return [
        "给出最终结论和关键产出。",
        "若涉及代码/文件/页面，提供可核查路径或修改点。",
        "若未完成，明确 blocker 与建议下一步。",
      ];
    default:
      return [
        "给出结论、关键证据和下一步建议。",
        "不要只回复已完成或已处理。",
      ];
  }
}

function mergeDelegationAcceptance(...groups: Array<string[] | undefined>): string[] {
  const merged = new Set<string>();
  for (const group of groups) {
    for (const item of group ?? []) {
      const normalized = String(item ?? "").trim();
      if (normalized) merged.add(normalized);
    }
  }
  return [...merged];
}

async function doesMediaPathExist(path: string): Promise<boolean> {
  if (/^https?:\/\//i.test(path)) return true;
  try {
    return await invokeTauriCommand<boolean>("path_exists", { path });
  } catch {
    return false;
  }
}

/**
 * 创建 Actor 间通信工具集（对标 OpenClaw sessions_spawn / subagents / sessions_send）。
 * 每个 AgentActor 实例获得一组绑定了自身 id 的工具。
 */
export function createActorCommunicationTools(
  actorId: string,
  system: ActorSystem,
  opts?: {
    inheritedImages?: string[];
    getInheritedImages?: () => string[] | undefined;
  },
): AgentTool[] {
  const tools: AgentTool[] = [];

  const resolveExistingTargetActor = (nameOrId: string) => {
    const actor = system.get(nameOrId);
    if (actor) return actor;
    const all = system.getAll();
    const found = all.find((a) => a.role.name === nameOrId);
    return found;
  };

  const resolveTarget = (nameOrId: string): string => {
    const found = resolveExistingTargetActor(nameOrId);
    return found?.id ?? "";
  };

  const getActorName = (id: string): string => {
    const actor = system.get(id);
    return actor?.role.name ?? id;
  };

  const requireCoordinatorForTeamTool = (toolName: string) => {
    const coordinatorId = system.getCoordinatorId();
    if (coordinatorId && actorId !== coordinatorId) {
      return {
        error: `${toolName} 只能由协调者调用；请把 team/swarm 操作建议回传给 ${getActorName(coordinatorId)} 统一执行。`,
        coordinator: getActorName(coordinatorId),
        delegated: true,
      };
    }
    return null;
  };

  const parseCapabilities = (raw: unknown): AgentCapability[] | undefined => {
    if (!raw) return undefined;
    const values = String(raw)
      .split(",")
      .map((item) => item.trim())
      .filter((item): item is AgentCapability => KNOWN_AGENT_CAPABILITIES.has(item as AgentCapability));
    return values.length > 0 ? values : undefined;
  };

  const parseRoleBoundary = (raw: unknown): SpawnedTaskRoleBoundary | undefined => {
    if (!raw) return undefined;
    const value = String(raw).trim() as SpawnedTaskRoleBoundary;
    return KNOWN_ROLE_BOUNDARIES.has(value) ? value : undefined;
  };

  const parseWorkerProfileId = (raw: unknown): WorkerProfileId | undefined => {
    if (!raw) return undefined;
    const value = String(raw).trim() as WorkerProfileId;
    return KNOWN_WORKER_PROFILES.has(value) ? value : undefined;
  };

  const parseBuiltinAgentId = (raw: unknown): BuiltinAgentId | undefined => {
    const definition = resolveBuiltinAgentDefinition(typeof raw === "string" ? raw : undefined);
    return definition?.id;
  };

  tools.push({
    name: "engage_delivery_adapter",
    description: [
      "显式启用一个高可靠 delivery adapter，让主 Agent 决定当前任务进入更强约束的交付模式。",
      "适用于你已经判断：当前任务需要 structured child result、host-managed export、quality gate 这类更强交付保障时。",
      "这不会自动派工；它只是把 adapter 从“建议态”切换为“已启用”。",
    ].join("\n"),
    parameters: {
      strategy_id: {
        type: "string",
        description: "要启用的 adapter/strategy id。通常可留空，系统会优先使用当前任务的推荐 adapter。",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const actor = system.get(actorId) as
        | {
            currentTask?: { query?: string };
            getEngagedStructuredDeliveryManifest?: () => ReturnType<typeof resolveStructuredDeliveryManifest> | null;
            engageStructuredDeliveryAdapter?: (manifest: ReturnType<typeof resolveStructuredDeliveryManifest>) => void;
          }
        | undefined;
      if (!actor?.currentTask?.query?.trim()) {
        return { error: "当前没有可用的运行中任务，无法启用 delivery adapter。" };
      }

      const ownerRecord = typeof system.getSpawnedTasksSnapshot === "function"
        ? system.getSpawnedTasksSnapshot().find((record) =>
            record.targetActorId === actorId
            && (record.status === "running" || (record.mode === "session" && record.sessionOpen)))
        : undefined;
      if (ownerRecord) {
        return { error: "当前子任务不能自行启用 delivery adapter，请回传协调者决定。" };
      }

      const existingManifest = system.getActiveExecutionContract?.()?.structuredDeliveryManifest
        ?? actor.getEngagedStructuredDeliveryManifest?.()
        ?? resolveStructuredDeliveryManifest(actor.currentTask.query);
      const preferredStrategyId = params.strategy_id
        ? String(params.strategy_id).trim()
        : getStructuredDeliveryStrategyReferenceId(existingManifest);
      if (!preferredStrategyId) {
        return { error: "当前任务没有可启用的推荐 delivery adapter。" };
      }

      const nextManifest = enableStructuredDeliveryAdapter({
        ...existingManifest,
        recommendedStrategyId: existingManifest.recommendedStrategyId ?? preferredStrategyId,
        strategyId: preferredStrategyId,
      }, "runtime");

      if (typeof system.updateStructuredDeliveryManifest === "function" && system.getActiveExecutionContract?.()) {
        system.updateStructuredDeliveryManifest(nextManifest);
      } else {
        actor.engageStructuredDeliveryAdapter?.(nextManifest);
      }

      return {
        ok: true,
        adapter_enabled: true,
        strategy_id: nextManifest.strategyId,
        delivery_contract: `${nextManifest.deliveryContract}/${nextManifest.parentContract}`,
        hint: "delivery adapter 已启用。接下来如有必要，可继续派工、等待结构化结果，或进入 host-managed export 路径。",
      };
    },
  });

  // ── spawn_task (对标 OpenClaw sessions_spawn) ──
  tools.push({
    name: "spawn_task",
    description:
      "将一个子任务派发给另一个 Agent 执行。系统会自动追踪任务进度，" +
      "目标 Agent 完成后结果会自动发送到你的收件箱。此操作是非阻塞的。" +
      "适用于将大任务分解为子任务分配给不同 Agent 并行执行。" +
      "默认仅顶层协调者可以继续创建子线程；非协调子 Agent 应把新增分工建议回传给协调者。" +
      "当未提供 target_agent，或提供的名称当前不存在时，系统会按 Claude Code 风格自动 fork 一个临时子 Agent。",
    parameters: {
      target_agent: {
        type: "string",
        description: "目标 Agent 的名称。可留空；留空或名称当前不存在时，系统默认自动 fork 一个临时子 Agent。",
        required: false,
      },
      planned_delegation_id: {
        type: "string",
        description: "已批准建议委派的 ID。提供后会优先复用 contract 中的目标 Agent、职责边界和 child 配置。",
        required: false,
      },
      task: {
        type: "string",
        description: "详细的任务描述，包含足够的上下文让对方理解需要做什么",
        required: true,
      },
      label: {
        type: "string",
        description: "简短标签用于识别此子任务（如 '搜索技术架构'）",
        required: false,
      },
      context: {
        type: "string",
        description: "额外上下文信息（如相关文件路径、之前的讨论结论等）",
        required: false,
      },
      timeout_seconds: {
        type: "number",
        description: "子任务总预算（秒）。默认按 Dialog worker 预算 600 秒执行；期间只要持续有进展就不会因旧式 wall-clock 被误杀。若填写值低于默认预算，系统会按默认预算执行，避免模型把复杂任务过早超时。超过预算后子任务会停止。",
        required: false,
      },
      attachments: {
        type: "string",
        description: "附件文件路径列表，逗号分隔（如 'src/main.ts,README.md'）。文件内容会附带传给目标 Agent。",
        required: false,
      },
      // 对标 OpenClaw sessions_spawn 参数
      mode: {
        type: "string",
        description: "spawn 模式：'run'=一次性任务（默认），'session'=保持会话（可继续交互）",
        required: false,
      },
      cleanup: {
        type: "string",
        description: "任务结束后的清理策略：'keep'=保持 Agent（默认），'delete'=仅删除临时子 agent",
        required: false,
      },
      expects_completion: {
        type: "boolean",
        description: "是否期望收到完成消息通知（默认 true）。设为 false 可用于 fire-and-forget 场景。",
        required: false,
      },
      create_if_missing: {
        type: "boolean",
        description: "是否显式要求自动创建临时子 Agent。默认会在 target_agent 留空或目标不存在时自动 fork；设为 false 可关闭该行为。",
        required: false,
      },
      agent_description: {
        type: "string",
        description: "创建临时子 Agent 时的职责描述，例如“只负责独立审查 patch 的回归风险”",
        required: false,
      },
      agent_capabilities: {
        type: "string",
        description: "创建临时子 Agent 时的能力标签，逗号分隔，如 'code_review,testing'",
        required: false,
      },
      agent_workspace: {
        type: "string",
        description: "创建临时子 Agent 时的工作目录；不填则继承当前 Agent 的工作目录",
        required: false,
      },
      role_boundary: {
        type: "string",
        description: "显式声明本轮子任务职责边界：'executor'、'reviewer'、'validator' 或 'general'。用于把计划层的职责边界稳定传到执行层。",
        required: false,
      },
      worker_profile: {
        type: "string",
        description: "显式指定 worker profile：'general_worker'、'content_worker'、'coding_worker'、'review_worker'、'validator_worker' 或 'spreadsheet_worker'。优先于系统 heuristics。",
        required: false,
      },
      builtin_agent: {
        type: "string",
        description: `显式指定内建专用 agent：'${BUILTIN_AGENT_DESCRIPTION}'。系统会自动补齐默认角色边界、worker profile、提示词约束和临时 agent 画像。`,
        required: false,
      },
      result_contract: {
        type: "string",
        description: "显式指定结果合同：'default' 或 'inline_structured_result'。用于强制 child 直接返回结构化 terminal result。",
        required: false,
      },
      override_model: {
        type: "string",
        description: "覆盖目标 Agent 的 LLM 模型（如 'gpt-4o'、'claude-3-sonnet' 等）。不提供则使用目标 Agent 的默认模型。",
        required: false,
      },
      override_max_iterations: {
        type: "number",
        description: "覆盖目标 Agent 的最大迭代次数。适用于简单任务可设小值（如 5），复杂任务可设大值（如 30）。",
        required: false,
      },
      override_tools_allow: {
        type: "string",
        description: "覆盖目标 Agent 允许使用的工具名称列表（逗号分隔）。如 'read_file,search' 则只允许这两个工具。",
        required: false,
      },
      override_tools_deny: {
        type: "string",
        description: "覆盖目标 Agent 禁止使用的工具名称列表（逗号分隔）。如 'shell_execute' 则禁止执行 shell。",
        required: false,
      },
      override_system_prompt_append: {
        type: "string",
        description: "追加到目标 Agent 系统提示的额外指令（不替换原有指令）。用于为子任务提供特定约束。",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const currentInheritedImages = opts?.getInheritedImages?.() ?? opts?.inheritedImages;
      const queueIfBusy = params.__queue_if_busy === true;
      const softSpawnLimit = Number.isFinite(Number(params.__spawn_limit))
        ? Number(params.__spawn_limit)
        : undefined;
      const targetInput = params.target_agent ? String(params.target_agent).trim() : "";
      const actor = system.get(actorId) as { currentTask?: { id?: string } } | null;
      const currentOwnerTaskId = actor?.currentTask?.id?.trim();
      const existingTargetActor = targetInput ? resolveExistingTargetActor(targetInput) : undefined;
      const target = targetInput ? resolveTarget(targetInput) : "";
      const plannedDelegationId = params.planned_delegation_id ? String(params.planned_delegation_id).trim() : undefined;
      const task = String(params.task);
      const label = params.label ? String(params.label) : undefined;
      const context = params.context ? String(params.context) : undefined;
      const timeoutSeconds = params.timeout_seconds ? Number(params.timeout_seconds) : undefined;
      const attachments = params.attachments
        ? String(params.attachments).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const mode = params.mode === "session" ? "session" : "run";
      const cleanup = params.cleanup === "delete"
        ? "delete"
        : (params.cleanup === "keep" ? "keep" : undefined);
      const expectsCompletionMessage = params.expects_completion !== false;
      const childCapabilities = parseCapabilities(params.agent_capabilities);
      const requestedRoleBoundary = parseRoleBoundary(params.role_boundary);
      const requestedWorkerProfileId = parseWorkerProfileId(params.worker_profile);
      const builtinAgentId = parseBuiltinAgentId(params.builtin_agent);
      const explicitCreateIfMissing = params.create_if_missing === true
        ? true
        : (params.create_if_missing === false ? false : undefined);
      const resultContract = params.result_contract === "inline_structured_result"
        ? "inline_structured_result"
        : undefined;
      const deliveryTargetId = typeof params.deliveryTargetId === "string"
        ? String(params.deliveryTargetId).trim()
        : undefined;
      const deliveryTargetLabel = typeof params.deliveryTargetLabel === "string"
        ? String(params.deliveryTargetLabel).trim()
        : undefined;
      const sheetName = typeof params.sheetName === "string"
        ? String(params.sheetName).trim()
        : undefined;
      const sourceItemIds = parseStringArrayParam(params.sourceItemIds);
      const sourceItemCount = Number.isFinite(Number(params.sourceItemCount))
        ? Number(params.sourceItemCount)
        : undefined;
      const scopedSourceItems = parseScopedSourceItemsParam(params.scopedSourceItems);
      const baseOverrides: import("./types").SpawnTaskOverrides = {};
      if (requestedWorkerProfileId) baseOverrides.workerProfileId = requestedWorkerProfileId;
      if (resultContract) baseOverrides.resultContract = resultContract;
      if (deliveryTargetId) baseOverrides.deliveryTargetId = deliveryTargetId;
      if (deliveryTargetLabel) baseOverrides.deliveryTargetLabel = deliveryTargetLabel;
      if (sheetName) baseOverrides.sheetName = sheetName;
      if (sourceItemIds?.length) baseOverrides.sourceItemIds = sourceItemIds;
      if (typeof sourceItemCount === "number" && sourceItemCount > 0) baseOverrides.sourceItemCount = sourceItemCount;
      if (scopedSourceItems?.length) baseOverrides.scopedSourceItems = scopedSourceItems;
      if (params.override_model) baseOverrides.model = String(params.override_model);
      if (params.override_max_iterations) baseOverrides.maxIterations = Number(params.override_max_iterations);
      if (params.override_tools_allow || params.override_tools_deny) {
        baseOverrides.toolPolicy = {};
        if (params.override_tools_allow) {
          baseOverrides.toolPolicy.allow = String(params.override_tools_allow).split(",").map((s) => s.trim()).filter(Boolean);
        }
        if (params.override_tools_deny) {
          baseOverrides.toolPolicy.deny = String(params.override_tools_deny).split(",").map((s) => s.trim()).filter(Boolean);
        }
      }
      if (params.override_system_prompt_append) {
        baseOverrides.systemPromptAppend = String(params.override_system_prompt_append);
      }
      const builtinDefaults = applyBuiltinAgentDefaults({
        builtinAgentId,
        requestedTargetName: targetInput || undefined,
        requestedRoleBoundary,
        requestedWorkerProfileId,
        requestedChildDescription: params.agent_description ? String(params.agent_description) : undefined,
        requestedChildCapabilities: childCapabilities,
        overrides: baseOverrides,
      });
      const effectiveRoleBoundary = builtinDefaults.roleBoundary ?? requestedRoleBoundary;
      const shouldImplicitFork = explicitCreateIfMissing !== false
        && !plannedDelegationId
        && !existingTargetActor;
      const createIfMissing = explicitCreateIfMissing
        ?? (shouldImplicitFork ? true : undefined);
      const derivedTarget = createIfMissing
        ? (
          builtinDefaults.targetName
          || deriveEphemeralSpawnTarget({
            target: targetInput || existingTargetActor?.role.name,
            label,
            description: builtinDefaults.childDescription,
            task,
            roleBoundary: effectiveRoleBoundary,
          })
        )
        : "";
      const resolvedTarget = target || derivedTarget || targetInput;
      const overrides = builtinDefaults.overrides;
      const hasOverrides = Object.keys(overrides).length > 0;
      const shouldAutoQueueIfBusy = !queueIfBusy
        && mode === "run"
        && explicitCreateIfMissing !== false
        && !existingTargetActor
        && (overrides.workerProfileId === "content_worker" || overrides.workerProfileId === "spreadsheet_worker");
      const effectiveQueueIfBusy = queueIfBusy || shouldAutoQueueIfBusy;
      const effectiveSoftSpawnLimit = softSpawnLimit
        ?? (
          effectiveQueueIfBusy && typeof system.getDialogSpawnConcurrencyLimit === "function"
            ? system.getDialogSpawnConcurrencyLimit()
            : undefined
        );
      const parentManifest = resolveParentStructuredDeliveryManifest(actorId, system);
      if (isWorkbookAggregationDelegation({
        task,
        manifest: parentManifest,
        workerProfileId: overrides.workerProfileId,
        resultContract: overrides.resultContract,
      })) {
        return {
          spawned: false,
          error: "single_workbook / host-managed 表格合同下，禁止再委派“整合所有结果并导出 Excel”的聚合型子任务；请继续派发表格分片，或直接调用 wait_for_spawned_tasks 进入主线程聚合。",
        };
      }
      const queuedSpawnCount = typeof system.getPendingDeferredSpawnTaskCount === "function"
        ? system.getPendingDeferredSpawnTaskCount(actorId, { ownerTaskId: currentOwnerTaskId })
        : 0;
      const activeSpawnCount = typeof system.getActiveSpawnedTasks === "function"
        ? system.getActiveSpawnedTasks(actorId, { ownerTaskId: currentOwnerTaskId }).length
        : 0;

      if (
        effectiveQueueIfBusy
        && mode === "run"
        && typeof effectiveSoftSpawnLimit === "number"
        && (activeSpawnCount >= effectiveSoftSpawnLimit || queuedSpawnCount > 0)
        && typeof system.enqueueDeferredSpawnTask === "function"
      ) {
        const queued = system.enqueueDeferredSpawnTask(actorId, resolvedTarget, task, {
          label,
          context,
          timeoutSeconds,
          attachments,
          images: currentInheritedImages,
          mode,
          cleanup,
          expectsCompletionMessage,
          roleBoundary: effectiveRoleBoundary,
          createIfMissing,
          createChildSpec: createIfMissing
            ? {
                description: builtinDefaults.childDescription,
                capabilities: builtinDefaults.childCapabilities,
                workspace: params.agent_workspace ? String(params.agent_workspace) : undefined,
              }
            : undefined,
          overrides: hasOverrides ? overrides : undefined,
          plannedDelegationId,
          ownerTaskId: currentOwnerTaskId,
        });
        const pendingDispatchCount = typeof system.getPendingDeferredSpawnTaskCount === "function"
          ? system.getPendingDeferredSpawnTaskCount(actorId, { ownerTaskId: currentOwnerTaskId })
          : queuedSpawnCount + 1;
        return {
          spawned: false,
          queued: true,
          dispatch_status: "queued",
          queue_id: queued.id,
          pending_dispatch_count: pendingDispatchCount,
          profile: queued.profile,
          worker_profile: queued.overrides?.workerProfileId,
          execution_intent: queued.executionIntent ?? queued.overrides?.executionIntent,
          role_boundary: queued.roleBoundary ?? "general",
          roleBoundary: queued.roleBoundary,
          builtin_agent: builtinDefaults.definition?.id,
          mode: queued.mode ?? mode,
          hint: `已加入待派发队列（第 ${pendingDispatchCount} 个）。当前并发达到上限时，系统会在空位出现后自动补派。`,
        };
      }

      const result = system.spawnTask(actorId, resolvedTarget, task, {
        label,
        context,
        timeoutSeconds,
        attachments,
        images: currentInheritedImages,
        mode,
        cleanup,
        expectsCompletionMessage,
        roleBoundary: effectiveRoleBoundary,
        createIfMissing,
        createChildSpec: createIfMissing
          ? {
              description: builtinDefaults.childDescription,
              capabilities: builtinDefaults.childCapabilities,
              workspace: params.agent_workspace ? String(params.agent_workspace) : undefined,
            }
          : undefined,
        overrides: hasOverrides ? overrides : undefined,
        plannedDelegationId,
        ownerTaskId: currentOwnerTaskId,
      });

      if ("error" in result) {
        return { spawned: false, error: result.error };
      }
      return {
        spawned: true,
        task_id: result.runId,
        subtask_id: result.runtime?.subtaskId ?? result.runId,
        runId: result.runId,
        mode: result.mode,
        to: getActorName(result.targetActorId),
        label: result.label,
        profile: result.runtime?.profile ?? result.roleBoundary ?? "general",
        worker_profile: result.workerProfileId,
        execution_intent: result.executionIntent,
        role_boundary: result.roleBoundary ?? "general",
        roleBoundary: result.roleBoundary,
        builtin_agent: builtinDefaults.definition?.id,
        hint: `任务已派发（mode=${result.mode}）。当你的下一步明确依赖这些子任务结果时，再调用 wait_for_spawned_tasks 挂起等待。`,
      };
    },
  });

  tools.push({
    name: "delegate_task",
    description: [
      "更高层的 agent-first 委派接口：你只需说明目标、验收标准和职责边界，系统会整理成稳定的子任务 prompt 并派发。",
      "适用于主 Agent 已判断“需要协作”，但不想手写完整 spawn_task 任务正文的场景。",
      "如果你需要完全控制任务正文、附件或底层 override，请继续使用 spawn_task。",
    ].join("\n"),
    parameters: {
      goal: {
        type: "string",
        description: "子任务目标。用一句或几句清楚说明要让子 agent 完成什么。",
        required: true,
      },
      acceptance: {
        type: "string",
        description: "验收标准。支持换行、分号或项目符号；系统会整理成结构化验收清单。",
        required: false,
      },
      target_agent: {
        type: "string",
        description: "目标 Agent 名称；若留空或名称当前不存在，系统会自动 fork 一个临时子 Agent。",
        required: false,
      },
      label: {
        type: "string",
        description: "短标签，用于标识本次委派。",
        required: false,
      },
      context: {
        type: "string",
        description: "补充上下文，例如限制范围、已知结论、建议关注的模块等。",
        required: false,
      },
      timeout_seconds: {
        type: "number",
        description: "子任务总预算（秒）。",
        required: false,
      },
      attachments: {
        type: "string",
        description: "附件文件路径列表，逗号分隔。",
        required: false,
      },
      planned_delegation_id: {
        type: "string",
        description: "若要复用系统已批准的委派建议，可传入对应 ID。",
        required: false,
      },
      create_if_missing: {
        type: "boolean",
        description: "是否显式要求自动创建临时子 Agent。默认在 target_agent 留空或目标不存在时会自动 fork；设为 false 可关闭。",
        required: false,
      },
      agent_description: {
        type: "string",
        description: "创建临时子 Agent 时的职责描述。",
        required: false,
      },
      agent_capabilities: {
        type: "string",
        description: "创建临时子 Agent 时的能力标签，逗号分隔。",
        required: false,
      },
      agent_workspace: {
        type: "string",
        description: "创建临时子 Agent 时的工作目录。",
        required: false,
      },
      role_boundary: {
        type: "string",
        description: "职责边界：'executor'、'reviewer'、'validator' 或 'general'。",
        required: false,
      },
      worker_profile: {
        type: "string",
        description: "显式指定 worker profile。",
        required: false,
      },
      builtin_agent: {
        type: "string",
        description: `显式指定内建专用 agent：'${BUILTIN_AGENT_DESCRIPTION}'。适用于稳定拉起 Planner / Explorer / Verifier / Implementer 这类产品化角色。`,
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const goal = String(params.goal ?? "").trim();
      if (!goal) {
        return { delegated: false, error: "delegate_task 需要提供 goal。" };
      }
      const explicitTargetAgent = typeof params.target_agent === "string"
        ? String(params.target_agent).trim()
        : "";
      const explicitTargetActor = explicitTargetAgent
        ? resolveExistingTargetActor(explicitTargetAgent)
        : undefined;
      const explicitCreateIfMissing = params.create_if_missing;
      const requestedLabel = typeof params.label === "string"
        ? String(params.label).trim()
        : "";
      const effectiveLabel = requestedLabel || previewSpawnTargetText(goal, 24);
      const requestedRoleBoundary = parseRoleBoundary(params.role_boundary);
      const requestedWorkerProfileId = parseWorkerProfileId(params.worker_profile);
      const builtinAgentId = parseBuiltinAgentId(params.builtin_agent);
      const goalManifest = resolveStructuredDeliveryManifest(goal);
      const parentManifest = resolveParentStructuredDeliveryManifest(actorId, system);
      const initialBuiltinDefaults = applyBuiltinAgentDefaults({
        builtinAgentId,
        requestedTargetName: explicitTargetAgent || undefined,
        requestedRoleBoundary,
        requestedWorkerProfileId,
        requestedChildDescription: typeof params.agent_description === "string"
          ? String(params.agent_description).trim()
          : undefined,
        requestedChildCapabilities: parseCapabilities(params.agent_capabilities),
      });
      const spreadsheetInheritanceAllowed = !requestedWorkerProfileId
        && !initialBuiltinDefaults.definition
        && (!requestedRoleBoundary || requestedRoleBoundary === "general" || requestedRoleBoundary === "executor");
      const effectiveStructuredManifest = (
        initialBuiltinDefaults.definition
        ? null
        : spreadsheetInheritanceAllowed
        && !isSpreadsheetDeliveryManifest(goalManifest)
        && isSpreadsheetDeliveryManifest(parentManifest)
      )
        ? parentManifest
        : goalManifest;
      const manifestSuggestedWorkerProfileId = (
        isSpreadsheetDeliveryManifest(effectiveStructuredManifest)
      )
        ? "spreadsheet_worker"
        : undefined;
      const inheritedScopedSourceItems = manifestSuggestedWorkerProfileId === "spreadsheet_worker"
        ? buildScopedSourceItemsFromGroundingItems(effectiveStructuredManifest?.sourceSnapshot?.items)
        : undefined;
      const manifestStructuredOverrides = manifestSuggestedWorkerProfileId === "spreadsheet_worker"
        ? {
            resultContract: "inline_structured_result" as const,
            ...(inheritedScopedSourceItems?.length
              ? {
                  scopedSourceItems: inheritedScopedSourceItems,
                  sourceItemIds: inheritedScopedSourceItems.map((item) => item.id),
                  sourceItemCount: inheritedScopedSourceItems.length,
                }
              : {}),
          }
        : undefined;
      const builtinDefaults = applyBuiltinAgentDefaults({
        builtinAgentId,
        requestedTargetName: initialBuiltinDefaults.targetName,
        requestedRoleBoundary: initialBuiltinDefaults.roleBoundary,
        requestedWorkerProfileId: initialBuiltinDefaults.workerProfileId ?? manifestSuggestedWorkerProfileId,
        requestedChildDescription: initialBuiltinDefaults.childDescription,
        requestedChildCapabilities: initialBuiltinDefaults.childCapabilities,
        overrides: manifestStructuredOverrides,
      });
      const resolvedWorkerProfile = resolveWorkerProfile({
        roleBoundary: builtinDefaults.roleBoundary ?? requestedRoleBoundary ?? "general",
        task: goal,
        explicitWorkerProfileId: builtinDefaults.workerProfileId,
        resultContract: builtinDefaults.overrides.resultContract,
        allowGeneralPromotion: true,
      });
      const effectiveWorkerProfileId = builtinDefaults.workerProfileId
        ?? resolvedWorkerProfile.id;
      const effectiveRoleBoundary = builtinDefaults.roleBoundary ?? resolvedWorkerProfile.roleBoundary;
      const spawnTool = tools.find((tool) => tool.name === "spawn_task");
      if (!spawnTool) {
        return { delegated: false, error: "spawn_task 工具不可用，无法完成委派。" };
      }
      const delegationTask = buildDelegationTaskText({
        goal,
        acceptance: typeof params.acceptance === "string" ? params.acceptance : undefined,
        defaultAcceptance: mergeDelegationAcceptance(
          buildDefaultDelegationAcceptance({
            roleBoundary: effectiveRoleBoundary,
            workerProfileId: effectiveWorkerProfileId,
          }),
          builtinDefaults.defaultAcceptance,
        ),
      });
      if (isWorkbookAggregationDelegation({
        task: delegationTask,
        manifest: effectiveStructuredManifest,
        workerProfileId: effectiveWorkerProfileId,
        resultContract: builtinDefaults.overrides.resultContract,
      })) {
        return {
          delegated: false,
          error: "single_workbook / host-managed 表格合同下，禁止再委派“整合所有结果并导出 Excel”的聚合型子任务；请继续派发表格分片，或直接调用 wait_for_spawned_tasks 进入主线程聚合。",
        };
      }
      const shouldAutoCreateIfMissing = explicitCreateIfMissing === true
        || (
          explicitCreateIfMissing !== false
          && !params.planned_delegation_id
          && (!explicitTargetAgent || !explicitTargetActor)
        );
      const shouldQueueIfBusy = effectiveWorkerProfileId === "spreadsheet_worker";
      const spawnLimit = typeof system.getDialogSpawnConcurrencyLimit === "function"
        ? system.getDialogSpawnConcurrencyLimit()
        : undefined;
      const executeDelegatedSpawn = async (createIfMissing?: boolean) => spawnTool.execute({
        target_agent: builtinDefaults.targetName ?? params.target_agent,
        planned_delegation_id: params.planned_delegation_id,
        task: delegationTask,
        label: effectiveLabel,
        context: params.context,
        timeout_seconds: params.timeout_seconds,
        attachments: params.attachments,
        ...(createIfMissing !== undefined ? { create_if_missing: createIfMissing } : {}),
        agent_description: builtinDefaults.childDescription ?? params.agent_description,
        agent_capabilities: builtinDefaults.childCapabilities?.join(",") ?? params.agent_capabilities,
        agent_workspace: params.agent_workspace,
        role_boundary: effectiveRoleBoundary,
        worker_profile: effectiveWorkerProfileId,
        builtin_agent: builtinAgentId,
        result_contract: builtinDefaults.overrides.resultContract,
        __queue_if_busy: shouldQueueIfBusy,
        ...(typeof spawnLimit === "number" ? { __spawn_limit: spawnLimit } : {}),
        ...(builtinDefaults.overrides ?? {}),
      });
      let result = await executeDelegatedSpawn(shouldAutoCreateIfMissing);
      const shouldRetryWithAutoCreate = Boolean(
        result
        && typeof result === "object"
        && "error" in result
        && (result as Record<string, unknown>).error === "Target not found"
        && explicitCreateIfMissing !== false,
      );
      if (shouldRetryWithAutoCreate && !shouldAutoCreateIfMissing) {
        result = await executeDelegatedSpawn(true);
      }
      const resultObject = result && typeof result === "object"
        ? result as Record<string, unknown>
        : { result };
      return {
        ...resultObject,
        delegated: !("error" in resultObject),
        interface: "delegate_task",
        builtin_agent: builtinAgentId,
        auto_create_if_missing: explicitCreateIfMissing === undefined
          ? (shouldAutoCreateIfMissing || shouldRetryWithAutoCreate)
          : undefined,
        inferred_role_boundary: requestedRoleBoundary || builtinAgentId ? undefined : effectiveRoleBoundary,
        inferred_worker_profile: requestedWorkerProfileId || builtinAgentId ? undefined : effectiveWorkerProfileId,
        result_contract: builtinDefaults.overrides.resultContract,
      };
    },
  });

  // ── wait_for_spawned_tasks ──
  tools.push({
    name: "wait_for_spawned_tasks",
    description:
      "挂起当前执行，等待所有你派发的子任务（跑在后台的）全部完成。当你的下一步明确依赖这些子任务结果时，再调用此工具。" +
      "工具会等待一次运行时更新，然后返回最新结构化快照；如果目标子任务都已完成，会直接返回完整终态。" +
      "这样你可以拿到各方的结构化结果继续综合，而不会因为长时间阻塞把当前主链路卡死。",
    parameters: {},
    readonly: true,
    execute: async () => {
      const WAIT_UPDATE_TIMEOUT_MS = 30_000;
      const actor = system.get(actorId);
      if (!actor || actor.status !== "running") {
        return { error: "任务已终止或被叫停，结束等待。" };
      }
      const currentOwnerTaskId = actor.currentTask?.id?.trim();

      const initialState = system.buildWaitForSpawnedTasksResult(actorId, {
        ownerTaskId: currentOwnerTaskId,
      });
      if (initialState.pending_count === 0 && (initialState.pending_dispatch_count ?? 0) === 0) {
        return initialState;
      }

      await system.waitForSpawnedTaskUpdate(actorId, WAIT_UPDATE_TIMEOUT_MS);
      const latestState = system.buildWaitForSpawnedTasksResult(actorId, {
        ownerTaskId: currentOwnerTaskId,
      });
      if (latestState.pending_count === 0 && (latestState.pending_dispatch_count ?? 0) === 0) {
        return latestState;
      }

      return {
        ...latestState,
        wait_complete: false,
        summary: latestState.summary
          || `仍有 ${latestState.pending_count} 个子任务运行中；已返回最新结构化快照。若当前步骤不再必须同步等待，请结束本轮，由父运行时继续后台等待并在子结果回流后自动恢复。`,
      };
    },
  });

  // ── send_message (对标 OpenClaw sessions_send) ──
  tools.push({
    name: "send_message",
    description:
      "向另一个 Agent 发送消息。对方会在当前任务的下一个思考步骤收到。" +
      "适用于分享发现、提出建议、回复对方消息等。",
    parameters: {
      target_agent: {
        type: "string",
        description: "目标 Agent 的名称",
        required: true,
      },
      content: {
        type: "string",
        description: "消息内容",
        required: true,
      },
      reply_to: {
        type: "string",
        description: "如果是回复某条消息，填入该消息的 ID",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const targetInput = String(params.target_agent);
      const target = resolveTarget(targetInput);
      const content = String(params.content);
      const replyTo = params.reply_to ? String(params.reply_to) : undefined;

      try {
        const msg = system.send(actorId, target, content, { replyTo });
        return { sent: true, messageId: msg.id, to: getActorName(target) };
      } catch (e) {
        return { sent: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  tools.push({
    name: "create_team",
    description:
      "创建或更新一个命名 team/swarm。team 会保存 teammate roster、默认 backend 和 mailbox，便于后续按 teammate 名称路由。",
    parameters: {
      team_name: {
        type: "string",
        description: "team 名称",
        required: true,
      },
      teammates: {
        type: "string",
        description: "teammate 列表，支持逗号或换行分隔；留空时默认收纳当前房间里的其他 Agent",
        required: false,
      },
      backend: {
        type: "string",
        description: "默认 backend id，默认 in_process；可选 worktree / remote 作为未来扩展点",
        required: false,
      },
      description: {
        type: "string",
        description: "team 说明",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const coordinatorGuard = requireCoordinatorForTeamTool("create_team");
      if (coordinatorGuard) return coordinatorGuard;

      const teamName = String(params.team_name ?? "").trim();
      if (!teamName) return { error: "team_name 不能为空" };

      try {
        const result = system.createTeam({
          name: teamName,
          description: typeof params.description === "string" ? params.description.trim() : undefined,
          defaultBackendId: typeof params.backend === "string" ? params.backend.trim() : undefined,
          createdByActorId: actorId,
          teammates: parseStringArrayParam(params.teammates),
        });

        return {
          created: result.created,
          updated: result.updated,
          team_id: result.team.id,
          team_name: result.team.name,
          backend: result.team.defaultBackendId,
          teammate_count: result.team.teammates.length,
          teammates: result.team.teammates.map((teammate) => ({
            id: teammate.id,
            name: teammate.name,
            actorId: teammate.actorId ?? null,
            backend: teammate.backendId ?? result.team.defaultBackendId,
          })),
          available_backends: system.getBackendRegistry().list(),
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  tools.push({
    name: "delete_team",
    description: "删除一个已创建的 team/swarm。",
    parameters: {
      team_name: {
        type: "string",
        description: "要删除的 team 名称或 team id",
        required: true,
      },
    },
    readonly: false,
    execute: async (params) => {
      const coordinatorGuard = requireCoordinatorForTeamTool("delete_team");
      if (coordinatorGuard) return coordinatorGuard;

      const teamName = String(params.team_name ?? "").trim();
      if (!teamName) return { error: "team_name 不能为空" };

      return system.deleteTeam(teamName, actorId);
    },
  });

  tools.push({
    name: "send_team_message",
    description:
      "按 team roster 中的 teammate 名称路由消息。适合 coordinator 基于 team/swarm 抽象给指定成员发指令。",
    parameters: {
      team_name: {
        type: "string",
        description: "team 名称或 id",
        required: true,
      },
      teammate: {
        type: "string",
        description: "目标 teammate 名称、别名或 actor id",
        required: true,
      },
      content: {
        type: "string",
        description: "消息正文",
        required: true,
      },
      reply_to: {
        type: "string",
        description: "可选：回复某条消息的 ID",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const coordinatorGuard = requireCoordinatorForTeamTool("send_team_message");
      if (coordinatorGuard) return coordinatorGuard;

      const teamName = String(params.team_name ?? "").trim();
      const teammate = String(params.teammate ?? "").trim();
      const content = String(params.content ?? "").trim();
      if (!teamName) return { error: "team_name 不能为空" };
      if (!teammate) return { error: "teammate 不能为空" };
      if (!content) return { error: "content 不能为空" };

      return system.sendTeamMessage({
        senderActorId: actorId,
        team: teamName,
        teammate,
        content,
        replyTo: typeof params.reply_to === "string" ? params.reply_to.trim() : undefined,
      });
    },
  });

  tools.push({
    name: "broadcast_team_message",
    description: "向某个 team 的全部 teammate 广播消息。",
    parameters: {
      team_name: {
        type: "string",
        description: "team 名称或 id",
        required: true,
      },
      content: {
        type: "string",
        description: "广播正文",
        required: true,
      },
      reply_to: {
        type: "string",
        description: "可选：回复某条消息的 ID",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const coordinatorGuard = requireCoordinatorForTeamTool("broadcast_team_message");
      if (coordinatorGuard) return coordinatorGuard;

      const teamName = String(params.team_name ?? "").trim();
      const content = String(params.content ?? "").trim();
      if (!teamName) return { error: "team_name 不能为空" };
      if (!content) return { error: "content 不能为空" };

      return system.broadcastTeamMessage({
        senderActorId: actorId,
        team: teamName,
        content,
        replyTo: typeof params.reply_to === "string" ? params.reply_to.trim() : undefined,
      });
    },
  });

  tools.push({
    name: "dispatch_team_task",
    description:
      "按 team roster 中的 teammate 名称派发任务。适合 coordinator 基于 team/swarm 抽象并行拉起多个执行者。",
    parameters: {
      team_name: {
        type: "string",
        description: "team 名称或 id",
        required: true,
      },
      teammate: {
        type: "string",
        description: "目标 teammate 名称、别名或 actor id",
        required: true,
      },
      task: {
        type: "string",
        description: "要派发给 teammate 的详细任务描述",
        required: true,
      },
      label: {
        type: "string",
        description: "短标签，用于识别该 team task",
        required: false,
      },
      context: {
        type: "string",
        description: "补充上下文",
        required: false,
      },
      attachments: {
        type: "string",
        description: "附件路径列表，逗号分隔",
        required: false,
      },
      mode: {
        type: "string",
        description: "spawn 模式：'run' 或 'session'",
        required: false,
      },
      cleanup: {
        type: "string",
        description: "结束后的清理策略：'keep' 或 'delete'",
        required: false,
      },
      expects_completion: {
        type: "boolean",
        description: "是否期望收到完成通知（默认 true）",
        required: false,
      },
      create_if_missing: {
        type: "boolean",
        description: "当 teammate 还不是现存 actor 时，允许按 roster 信息创建临时 teammate",
        required: false,
      },
      agent_description: {
        type: "string",
        description: "创建临时 teammate 时使用的职责描述",
        required: false,
      },
      agent_capabilities: {
        type: "string",
        description: "创建临时 teammate 时的能力标签，逗号分隔",
        required: false,
      },
      agent_workspace: {
        type: "string",
        description: "创建临时 teammate 时的工作目录",
        required: false,
      },
      role_boundary: {
        type: "string",
        description: "职责边界：'executor'、'reviewer'、'validator' 或 'general'",
        required: false,
      },
      worker_profile: {
        type: "string",
        description: "显式指定 worker profile",
        required: false,
      },
      builtin_agent: {
        type: "string",
        description: `显式指定内建专用 agent：'${BUILTIN_AGENT_DESCRIPTION}'。`,
        required: false,
      },
      override_model: {
        type: "string",
        description: "覆盖 teammate 的模型",
        required: false,
      },
      override_max_iterations: {
        type: "number",
        description: "覆盖 teammate 的最大迭代次数",
        required: false,
      },
      override_tools_allow: {
        type: "string",
        description: "覆盖允许工具列表，逗号分隔",
        required: false,
      },
      override_tools_deny: {
        type: "string",
        description: "覆盖禁止工具列表，逗号分隔",
        required: false,
      },
      override_system_prompt_append: {
        type: "string",
        description: "追加到 teammate 系统提示的额外约束",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const coordinatorGuard = requireCoordinatorForTeamTool("dispatch_team_task");
      if (coordinatorGuard) return coordinatorGuard;

      const teamName = String(params.team_name ?? "").trim();
      const teammate = String(params.teammate ?? "").trim();
      const task = String(params.task ?? "").trim();
      if (!teamName) return { error: "team_name 不能为空" };
      if (!teammate) return { error: "teammate 不能为空" };
      if (!task) return { error: "task 不能为空" };

      const requestedRoleBoundary = parseRoleBoundary(params.role_boundary);
      const requestedWorkerProfileId = parseWorkerProfileId(params.worker_profile);
      const builtinAgentId = parseBuiltinAgentId(params.builtin_agent);
      const childCapabilities = parseCapabilities(params.agent_capabilities);
      const attachments = params.attachments
        ? String(params.attachments).split(",").map((item) => item.trim()).filter(Boolean)
        : undefined;
      const mode = params.mode === "session" ? "session" : "run";
      const cleanup = params.cleanup === "delete"
        ? "delete"
        : (params.cleanup === "keep" ? "keep" : undefined);

      const baseOverrides: import("./types").SpawnTaskOverrides = {};
      if (requestedWorkerProfileId) baseOverrides.workerProfileId = requestedWorkerProfileId;
      if (params.override_model) baseOverrides.model = String(params.override_model);
      if (params.override_max_iterations) baseOverrides.maxIterations = Number(params.override_max_iterations);
      if (params.override_tools_allow || params.override_tools_deny) {
        baseOverrides.toolPolicy = {};
        if (params.override_tools_allow) {
          baseOverrides.toolPolicy.allow = String(params.override_tools_allow).split(",").map((item) => item.trim()).filter(Boolean);
        }
        if (params.override_tools_deny) {
          baseOverrides.toolPolicy.deny = String(params.override_tools_deny).split(",").map((item) => item.trim()).filter(Boolean);
        }
      }
      if (params.override_system_prompt_append) {
        baseOverrides.systemPromptAppend = String(params.override_system_prompt_append);
      }

      const builtinDefaults = applyBuiltinAgentDefaults({
        builtinAgentId,
        requestedTargetName: teammate,
        requestedRoleBoundary,
        requestedWorkerProfileId,
        requestedChildDescription: typeof params.agent_description === "string"
          ? String(params.agent_description).trim()
          : undefined,
        requestedChildCapabilities: childCapabilities,
        overrides: baseOverrides,
      });

      return system.dispatchTeamTask({
        senderActorId: actorId,
        team: teamName,
        teammate,
        task,
        label: typeof params.label === "string" ? params.label.trim() : undefined,
        context: typeof params.context === "string" ? params.context.trim() : undefined,
        attachments,
        images: opts?.getInheritedImages?.() ?? opts?.inheritedImages,
        mode,
        cleanup,
        expectsCompletionMessage: params.expects_completion !== false,
        roleBoundary: builtinDefaults.roleBoundary ?? requestedRoleBoundary,
        overrides: Object.keys(builtinDefaults.overrides).length > 0 ? builtinDefaults.overrides : undefined,
        createIfMissing: params.create_if_missing === true,
        targetDescription: builtinDefaults.childDescription,
        targetCapabilities: builtinDefaults.childCapabilities,
        targetWorkspace: typeof params.agent_workspace === "string" ? params.agent_workspace.trim() : undefined,
      }).then((result) => ({
        ...result,
        builtin_agent: builtinDefaults.definition?.id,
      }));
    },
  });

  tools.push({
    name: "send_local_media",
    description:
      "把本地图片或文件作为当前外部 IM 回复的附件发给用户。" +
      "适合把截图、海报、生成图片、导出文件等回传给当前渠道用户。" +
      "调用后，最终答复会自动带上这些媒体；最终正文只需简短说明，不要重复输出路径。",
    parameters: {
      path: {
        type: "string",
        description: "单个本地文件路径或 http(s) URL；优先使用绝对路径",
        required: false,
      },
      paths: {
        type: "string",
        description: "多个本地文件路径或 URL；支持换行或逗号分隔",
        required: false,
      },
      attachment_name: {
        type: "string",
        description: "当前会话里已上传/已生成文件的名称；当你只知道名字不知道路径时使用",
        required: false,
      },
      use_current_images: {
        type: "boolean",
        description: "把当前任务继承到的图片一并回发给用户，适合“把这张图发给我”",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const coordinatorId = system.getCoordinatorId();
      if (coordinatorId && actorId !== coordinatorId) {
        return {
          queued: false,
          error: `send_local_media 只能由主协调者 ${getActorName(coordinatorId)} 调用；请把媒体路径回传给主协调者统一回复用户。`,
        };
      }

      const latestExternalUserMessage = [...system.getDialogHistory()]
        .slice()
        .reverse()
        .find((message) => message.from === "user" && message.kind === "user_input" && message.externalChannelType);
      if (!latestExternalUserMessage?.externalChannelType) {
        return {
          queued: false,
          error: "send_local_media 仅适用于外部 IM 会话；当前不是可直接回发媒体的渠道上下文。",
        };
      }

      const currentInheritedImages = params.use_current_images === true
        ? (opts?.getInheritedImages?.() ?? opts?.inheritedImages ?? [])
        : [];
      const attachmentName = typeof params.attachment_name === "string"
        ? params.attachment_name.trim()
        : "";
      const namedAttachmentPaths = attachmentName
        ? system.getSessionUploadsSnapshot()
          .filter((record) => record.path && record.name.trim().toLowerCase() === attachmentName.toLowerCase())
          .map((record) => record.path as string)
        : [];

      const candidates = [...new Set([
        ...parseLocalMediaCandidates({
          path: params.path,
          paths: params.paths,
        }),
        ...namedAttachmentPaths.map((item) => normalizeMediaPathCandidate(item)),
        ...currentInheritedImages.map((item) => normalizeMediaPathCandidate(item)),
      ].filter(Boolean))];

      if (candidates.length === 0) {
        return {
          queued: false,
          error: "未提供可发送的媒体路径。请传入 path / paths，或指定 attachment_name，或启用 use_current_images。",
        };
      }

      const existingPaths: string[] = [];
      const missingPaths: string[] = [];
      for (const candidate of candidates) {
        if (await doesMediaPathExist(candidate)) {
          existingPaths.push(candidate);
        } else {
          missingPaths.push(candidate);
        }
      }

      if (existingPaths.length === 0) {
        return {
          queued: false,
          error: `没有找到可发送的媒体文件：${missingPaths.join("、")}`,
        };
      }

      const images = existingPaths.filter((path) => isLikelyVisualAttachmentPath(path));
      const attachments = existingPaths
        .filter((path) => !isLikelyVisualAttachmentPath(path))
        .map((path) => ({
          path,
          fileName: getMediaFileName(path),
        }));

      system.stageResultMedia(actorId, {
        ...(images.length ? { images } : {}),
        ...(attachments.length ? { attachments } : {}),
      });

      const timestamp = Date.now();
      for (const path of existingPaths) {
        system.recordArtifact({
          actorId,
          path,
          source: "message",
          toolName: "send_local_media",
          summary: `准备回传给当前 IM 用户：${getMediaFileName(path)}`,
          timestamp,
        });
      }

      return {
        queued: true,
        count: existingPaths.length,
        images,
        attachments,
        ...(missingPaths.length ? { missing: missingPaths } : {}),
        hint: "这些媒体已加入本轮外部回复。最终答复只需简短说明结果，不要重复输出路径。",
      };
    },
  });

  // ── agents (对标 OpenClaw subagents) ──
  tools.push({
    name: "agents",
    description:
      "管理和查看所有 Agent。action='list' 查看状态和任务树；" +
      "action='kill' 终止 Agent 及其子任务；action='steer' 向运行中的 Agent 发送方向指令。",
    parameters: {
      action: {
        type: "string",
        description: "'list'、'kill' 或 'steer'",
        required: true,
      },
      target: {
        type: "string",
        description: "目标 Agent 名称（kill/steer 时需要）",
        required: false,
      },
      directive: {
        type: "string",
        description: "steer 时的指令内容（如 '改为关注性能方面'）",
        required: false,
      },
    },
    readonly: true,
    execute: async (params) => {
      const action = String(params.action);

      if (action === "kill") {
        const targetInput = params.target ? String(params.target) : "";
        if (!targetInput) return { error: "kill 操作需要指定 target" };
        const target = resolveTarget(targetInput);
        const actor = system.get(target);
        if (!actor) return { error: `Agent "${targetInput}" 不存在` };
        actor.abort();
        system.kill(target);
        return { killed: true, target: getActorName(target) };
      }

      if (action === "steer") {
        const targetInput = params.target ? String(params.target) : "";
        const directive = params.directive ? String(params.directive) : "";
        if (!targetInput) return { error: "steer 操作需要指定 target" };
        if (!directive) return { error: "steer 操作需要指定 directive" };
        const target = resolveTarget(targetInput);
        const result = system.steer(target, directive, actorId);
        if ("error" in result) return result;
        return { steered: true, target: getActorName(target), directive };
      }

      // action === "list"
      const allActors = system.getAll();
      const selfActor = system.get(actorId);
      const currentOwnerTaskId = selfActor?.currentTask?.id?.trim();
      const descendants = system.getDescendantTasks(
        actorId,
        currentOwnerTaskId ? { ownerTaskId: currentOwnerTaskId } : undefined,
      );

      return {
        agents: allActors
          .filter((a) => a.id !== actorId)
          .map((a) => ({
            name: a.role.name,
            isCoordinator: system.getCoordinatorId() === a.id,
            status: a.status,
            currentTask: a.currentTask?.query?.slice(0, 100) ?? null,
            model: a.modelOverride ?? "(default)",
          })),
        self: {
          name: selfActor?.role.name ?? actorId,
          isCoordinator: system.getCoordinatorId() === actorId,
        },
        task_tree: descendants.map((r) => ({
          runId: r.runId,
          parentRunId: r.parentRunId ?? null,
          rootRunId: r.rootRunId ?? r.runId,
          roleBoundary: r.roleBoundary ?? "general",
          spawner: getActorName(r.spawnerActorId),
          target: getActorName(r.targetActorId),
          label: r.label,
          status: r.status,
          depth: r.depth,
          task: r.task.slice(0, 80),
          result: r.result ? r.result.slice(0, 100) : null,
          error: r.error ?? null,
          // 新增：对标 OpenClaw
          mode: r.mode,
          cleanup: r.cleanup,
          expectsCompletionMessage: r.expectsCompletionMessage,
        })),
      };
    },
  });

  // ── session_history (对标 OpenClaw sessions_history) ──
  tools.push({
    name: "session_history",
    description:
      "读取当前或指定 session 的对话历史记录。可按消息类型和数量过滤。" +
      "用于回顾之前的对话、查看 tool 调用记录等。",
    parameters: {
      limit: {
        type: "number",
        description: "返回最近 N 条记录，默认 30",
        required: false,
      },
      types: {
        type: "string",
        description: "过滤类型，逗号分隔（message/tool_call/tool_result/spawn/announce），默认全部",
        required: false,
      },
      actor: {
        type: "string",
        description: "只看某个 Agent 的记录（名称）",
        required: false,
      },
    },
    readonly: true,
    execute: async (params) => {
      const limit = params.limit ? Number(params.limit) : 30;
      const types = params.types ? String(params.types).split(",").map((s) => s.trim()) : undefined;
      const actorFilter = params.actor ? resolveTarget(String(params.actor)) : undefined;

      const entries = await readSessionHistory(system.sessionId, { limit, types, actorId: actorFilter });
      return {
        sessionId: system.sessionId,
        entries: entries.map((e) => ({
          type: e.type,
          timestamp: e.timestamp,
          ...e.data,
          from: e.data.from ? getActorName(String(e.data.from)) : undefined,
          to: e.data.to ? getActorName(String(e.data.to)) : undefined,
        })),
        total: entries.length,
      };
    },
  });

  // ── session_list (对标 OpenClaw sessions_list) ──
  tools.push({
    name: "session_list",
    description: "列出所有活跃和归档的对话 session，包含摘要信息。",
    parameters: {},
    readonly: true,
    execute: async () => {
      const activeIds = await listTranscriptSessionIds();
      const sessions = await Promise.all(activeIds.map((id) => getSessionSummary(id)));
      return {
        current: system.sessionId,
        sessions: sessions.map((s) => ({
          ...s,
          isCurrent: s.sessionId === system.sessionId,
        })),
      };
    },
  });

  // ── schedule_task (对标 OpenClaw cron) ──
  tools.push({
    name: "schedule_task",
    description:
      "创建定时/延迟任务。可用于设置提醒、定期检查、巡检等场景。" +
      "type='once' 延迟执行一次；type='interval' 按间隔重复执行。",
    parameters: {
      target_agent: {
        type: "string",
        description: "执行任务的 Agent 名称",
        required: true,
      },
      task: {
        type: "string",
        description: "任务描述",
        required: true,
      },
      delay_seconds: {
        type: "number",
        description: "延迟/间隔秒数（最小 5 秒，最大 86400 秒）",
        required: true,
      },
      type: {
        type: "string",
        description: "'once'（一次性）或 'interval'（重复），默认 'once'",
        required: false,
      },
      max_runs: {
        type: "number",
        description: "interval 模式下的最大执行次数（默认无限）",
        required: false,
      },
    },
    readonly: false,
    execute: async (params) => {
      const coordinatorId = system.getCoordinatorId();
      if (coordinatorId && actorId !== coordinatorId) {
        return {
          error: `schedule_task 只能由协调者调用；请将定时任务方案回传给 ${getActorName(coordinatorId)} 统一创建。`,
          coordinator: getActorName(coordinatorId),
          delegated: true,
        };
      }

      const targetInput = String(params.target_agent);
      const target = resolveTarget(targetInput);
      const targetName = getActorName(target);
      const task = String(params.task).trim();
      const delaySec = Number(params.delay_seconds);
      const type = params.type ? String(params.type) : "once";
      const maxRuns = params.max_runs ? Number(params.max_runs) : undefined;

      if (!task) {
        return { error: "task 不能为空" };
      }
      if (isNaN(delaySec) || delaySec <= 0) {
        return { error: "delay_seconds 必须是正数" };
      }

      const delayMs = delaySec * 1000;
      const normalizedType = type === "interval" ? "interval" : "once";
      const { originMode, originLabel, channelId, conversationId, sessionId } = inferScheduledTaskOrigin(system);
      const directDelivery = inferDirectScheduledDelivery(task);

      try {
        const scheduledTask = await invokeTauriCommand<AgentScheduledTask>("agent_task_create", {
          query: buildPersistentScheduledQuery(targetName, task),
          sessionId: null,
          triggerAction: directDelivery ? "deliver_message" : "run_agent",
          ...(directDelivery?.text ? { deliveryText: directDelivery.text } : {}),
          scheduleType: normalizedType,
          scheduleValue: normalizedType === "interval"
            ? String(delayMs)
            : String(Date.now() + delayMs),
          originMode,
          originLabel,
          ...(channelId ? { originChannelId: channelId } : {}),
          ...(conversationId ? { originConversationId: conversationId } : {}),
          ...(sessionId ? { originSessionId: sessionId } : {}),
        });
        try {
          const { useAgentStore } = await import("@/store/agent-store");
          const store = useAgentStore.getState();
          store.upsertScheduledTask(scheduledTask);
          void store.loadScheduledTasks();
        } catch {
          // ignore store sync errors; backend task is already created
        }
        return {
          scheduled: true,
          jobId: scheduledTask.id,
          target: targetName,
          type: scheduledTask.schedule_type ?? normalizedType,
          delaySeconds: delayMs / 1000,
          nextRunAt: formatScheduledTaskTime(scheduledTask.next_run_at),
          maxRuns: maxRuns ?? "无限",
          persistent: true,
          note: normalizedType === "interval" && typeof maxRuns === "number"
            ? "长期任务中心当前未接入 max_runs，已按持续重复任务创建。"
            : "已创建为可在长期任务中心查看的持久化任务。",
        };
      } catch {
        const cron = system.cron;
        let result;
        if (normalizedType === "interval") {
          result = cron.scheduleInterval(target, task, delayMs, maxRuns);
        } else {
          result = cron.scheduleOnce(target, task, delayMs);
        }

        if ("error" in result) return result;

        return {
          scheduled: true,
          jobId: result.id,
          target: targetName,
          type: result.type,
          delaySeconds: result.delayMs / 1000,
          nextRunAt: new Date(result.nextRunAt).toLocaleTimeString("zh-CN"),
          maxRuns: result.maxRuns ?? "无限",
          persistent: false,
          note: "当前环境未启用长期任务后端，已回退到本房间临时定时任务。",
        };
      }
    },
  });

  // ── list_schedules ──
  tools.push({
    name: "list_schedules",
    description: "列出所有定时任务（含已完成和已取消的）。",
    parameters: {
      active_only: {
        type: "string",
        description: "'true' 只看活跃任务",
        required: false,
      },
    },
    readonly: true,
    execute: async (params) => {
      const activeOnly = String(params.active_only) === "true";
      try {
        const tasks = await invokeTauriCommand<AgentScheduledTask[]>("agent_task_list");
        const enabledTasks = tasks.filter((task) => task.schedule_type).filter((task) => isScheduledTaskActive(task));
        const jobs = tasks
          .filter((task) => task.schedule_type)
          .filter((task) => {
            if (!activeOnly) return true;
            return isScheduledTaskActive(task);
          });

        return {
          summary: {
            total: tasks.filter((task) => task.schedule_type).length,
            enabled: enabledTasks.length,
            running: enabledTasks.filter((task) => task.status === "running").length,
            paused: tasks.filter((task) => task.schedule_type && task.status === "paused").length,
            attention: tasks.filter(
              (task) => task.schedule_type && (task.status === "error" || task.last_result_status === "skipped"),
            ).length,
          },
          jobs: jobs.map((task) => {
            const parsed = parsePersistentScheduledQuery(task.query);
            return {
              id: task.id,
              agent: task.session_id ? `Agent 会话 ${task.session_id}` : "Agent 编排",
              targetAgent: parsed.agentName ?? null,
              task: parsed.title.slice(0, 100),
              type: task.schedule_type,
              status: task.status,
              active: isScheduledTaskActive(task),
              currentlyRunning: task.status === "running",
              stateSummary: describeScheduledTaskState(task),
              originMode: getScheduledTaskOriginMode(task),
              originLabel: getScheduledTaskOriginLabel(task),
              intervalSeconds: task.schedule_type === "interval" && task.schedule_value
                ? Number(task.schedule_value) / 1000
                : null,
              scheduleValue: task.schedule_value ?? null,
              runCount: task.retry_count ?? 0,
              maxRuns: "未知/未限制",
              nextRunAt: formatScheduledTaskTime(task.next_run_at),
              lastRunAt: formatScheduledTaskTime(task.last_finished_at ?? task.last_started_at),
              persistent: true,
            };
          }),
        };
      } catch {
        const cron = system.cron;
        const jobs = activeOnly ? cron.listActive() : cron.list();

        return {
          summary: {
            total: cron.list().length,
            enabled: cron.listActive().length,
            running: cron.list().filter((job) => job.status === "active").length,
            paused: 0,
            attention: 0,
          },
          jobs: jobs.map((j) => ({
            id: j.id,
            agent: getActorName(j.actorId),
            task: j.task.slice(0, 100),
            type: j.type,
            status: j.status,
            intervalSeconds: j.delayMs / 1000,
            runCount: j.runCount,
            maxRuns: j.maxRuns ?? "无限",
            nextRunAt: j.status === "active" ? new Date(j.nextRunAt).toLocaleTimeString("zh-CN") : null,
            lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toLocaleTimeString("zh-CN") : null,
            persistent: false,
          })),
        };
      }
    },
  });

  // ── cancel_schedule ──
  tools.push({
    name: "cancel_schedule",
    description: "取消一个定时任务。",
    parameters: {
      job_id: {
        type: "string",
        description: "定时任务 ID",
        required: true,
      },
    },
    readonly: false,
    execute: async (params) => {
      const jobId = String(params.job_id);
      try {
        await invokeTauriCommand("agent_task_cancel", { taskId: jobId });
        return { cancelled: true, jobId, persistent: true };
      } catch {
        const cancelled = system.cron.cancel(jobId);
        return cancelled
          ? { cancelled: true, jobId, persistent: false }
          : { cancelled: false, error: `任务 ${jobId} 不存在或已结束` };
      }
    },
  });

  return tools;
}
