import {
  AgentActor,
  DIALOG_FULL_ROLE,
  type AskUserCallback,
  type ConfirmDangerousAction,
} from "./agent-actor";
import { isLikelyVisualAttachmentPath } from "@/core/ai/ai-center-handoff";
import type {
  ApprovalRequest,
  AgentCapability,
  AgentCapabilities,
  ActorConfig,
  ActorEvent,
  DialogArtifactRecord,
  DialogExecutionPlan,
  DialogMessage,
  DialogRoomCompactionState,
  ExecutionPolicy,
  InboxMessage,
  PendingInteraction,
  PendingInteractionReplyMode,
  PendingInteractionResult,
  PendingInteractionType,
  PendingReply,
  SessionUploadRecord,
  SpawnedTaskRecord,
  SpawnedTaskRoleBoundary,
  SpawnedTaskEventDetail,
  ToolPolicy,
} from "./types";
import {
  appendDialogMessageSync as appendDialogMessage,
  appendSpawnEventSync as appendSpawnEvent,
  appendAnnounceEventSync as appendAnnounceEvent,
  updateTranscriptActors,
  archiveSession,
  deleteTranscriptSession,
  clearSessionCache,
} from "./actor-transcript";
import { ActorCron } from "./actor-cron";
import { cloneDialogRoomCompaction } from "./dialog-room-compaction";
import { clearSessionApprovals, clearAllTodos, resetTitleGeneration, clearTelemetry } from "./middlewares";
import {
  buildSpawnTaskExecutionHint,
  validateSpawnedTaskResult,
} from "./spawned-task-result-validator";
import {
  cloneExecutionContract,
  resolveChildExecutionSettings,
} from "@/core/collaboration/execution-contract";
import type { ExecutionContract } from "@/core/collaboration/types";
import { splitStructuredMediaReply } from "@/core/media/structured-media";
import {
  buildExecutionContractFromLegacyDialogExecutionPlan,
  buildLegacyDialogExecutionPlanFromContract,
  cloneLegacyDialogExecutionPlan,
  type LegacyDialogExecutionPlanRuntimeState,
} from "./dialog-execution-plan-compat";
import { getRoleBoundaryPolicyProfile } from "./execution-policy";

const generateId = (): string => {
  // 使用更安全的随机 ID 生成
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 12);
  return `${timestamp}-${randomPart}`;
};

const ASK_AGENT_TIMEOUT_MS = 120_000; // 2 min default
const DEFAULT_SPAWN_TIMEOUT_MS = 300_000; // spawn_task default timeout (5 min)
const MAX_SPAWN_DEPTH = 3; // 最大 spawn 链深度
const MAX_CHILDREN_PER_AGENT = 5; // 单个 Agent 同时运行的子任务上限
const ANNOUNCE_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;
const ANNOUNCE_HARD_EXPIRY_MS = 30 * 60 * 1000; // 30 分钟硬超时
const RESULT_SHAREABLE_ARTIFACT_SOURCES = new Set(["message", "tool_write", "tool_edit"]);
const USER_SHAREABLE_ARTIFACT_DIR_PATTERNS = [
  /(?:^|\/)downloads(?:\/|$)/i,
  /(?:^|\/)desktop(?:\/|$)/i,
  /(?:^|\/)documents(?:\/|$)/i,
  /^\/tmp(?:\/|$)/i,
  /^\/var\/folders(?:\/|$)/i,
] as const;

// 错误分类：对标 OpenClaw announce 机制
const TRANSIENT_ERROR_PATTERNS = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/i,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
] as const;

const PERMANENT_ERROR_PATTERNS = [
  /unknown actor/i,
  /actor.*not found/i,
  /invalid.*target/i,
] as const;

function isTransientAnnounceError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (!msg) return false;

  // 先检查是否是 permanent 错误
  if (PERMANENT_ERROR_PATTERNS.some((p) => p.test(msg))) {
    return false;
  }

  // 检查是否是 transient 错误
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg));
}

type EphemeralChildRoleBoundary = {
  role: SpawnedTaskRoleBoundary;
  systemPromptAppend?: string;
  toolPolicy?: ToolPolicy;
  executionPolicy?: ExecutionPolicy;
};

function buildEphemeralChildBoundary(role: SpawnedTaskRoleBoundary): EphemeralChildRoleBoundary {
  const profile = getRoleBoundaryPolicyProfile(role);
  switch (role) {
    case "reviewer":
      return {
        role,
        toolPolicy: profile.toolPolicy,
        executionPolicy: profile.executionPolicy,
        systemPromptAppend: [
          "你当前是独立审查子 Agent。",
          "默认不要修改文件、不要运行写操作、不要直接接管实现任务。",
          "重点输出发现、风险、证据和建议修复方向；如果认为必须改代码，应回传上游协调者，由其决定是否另派实现任务。",
        ].join("\n"),
      };
    case "validator":
      return {
        role,
        toolPolicy: profile.toolPolicy,
        executionPolicy: profile.executionPolicy,
        systemPromptAppend: [
          "你当前是验证子 Agent。",
          "默认不要修改代码；重点做复现、测试、验收和回归检查。",
          "可以运行测试、构建或检查命令，但若被实现缺口阻塞，应明确说明阻塞点和建议的上游动作。",
        ].join("\n"),
      };
    case "executor":
      return {
        role,
        toolPolicy: profile.toolPolicy,
        executionPolicy: profile.executionPolicy,
        systemPromptAppend: [
          "你当前是执行子 Agent。",
          "聚焦实现、修复或探索，不要抢协调权。",
          "如需额外审查或验证，优先把结果和缺口回传给上游协调者，再由其继续分派。",
        ].join("\n"),
      };
    default:
      return {
        role: "general",
        toolPolicy: profile.toolPolicy,
        executionPolicy: profile.executionPolicy,
        systemPromptAppend: [
          "你当前是通用支援子 Agent。",
          "聚焦补充分析、资料整理和局部线索确认，默认不要修改文件或继续派发新的子任务。",
          "如果发现需要新增实现、审查或验证线程，请把建议与原因回传给上游协调者，由其继续派工。",
        ].join("\n"),
      };
  }
}

function inferEphemeralChildBoundary(params: {
  name: string;
  description?: string;
  capabilities?: AgentCapability[];
}): EphemeralChildRoleBoundary {
  const text = `${params.name}\n${params.description ?? ""}`.toLowerCase();
  const capabilities = new Set(params.capabilities ?? []);
  const reviewLike =
    capabilities.has("code_review")
    || capabilities.has("security")
    || /review|reviewer|审查|审阅|评审|审核|安全/.test(text);
  const validationLike =
    capabilities.has("testing")
    || /tester|test|qa|验证|回归|验收|测试/.test(text);
  const executorLike =
    capabilities.has("code_write")
    || capabilities.has("debugging")
    || /fix|fixer|implement|coder|修复|实现|开发|编码/.test(text);

  if (reviewLike && !executorLike) {
    return buildEphemeralChildBoundary("reviewer");
  }

  if (validationLike && !executorLike) {
    return buildEphemeralChildBoundary("validator");
  }

  if (executorLike) {
    return buildEphemeralChildBoundary("executor");
  }

  return buildEphemeralChildBoundary("general");
}

function formatRoleBoundaryLabel(role: SpawnedTaskRoleBoundary): string | null {
  switch (role) {
    case "reviewer":
      return "独立审查";
    case "validator":
      return "验证回归";
    case "executor":
      return "执行实现";
    default:
      return null;
  }
}

function buildSpawnTaskRoleBoundaryInstruction(role: SpawnedTaskRoleBoundary): string | undefined {
  switch (role) {
    case "reviewer":
      return "你本轮是独立审查角色。重点检查边界条件、回归风险、证据和修复建议，默认不要直接接管实现。";
    case "validator":
      return "你本轮是验证角色。重点做复现、测试、构建、验收和回归检查，默认不要直接修改代码。";
    case "executor":
      return "你本轮是执行角色。聚焦实现、修复和探索，不要抢协调权，也不要继续派发新的子任务；若需要独立审查或验证，请把缺口回传上游。";
    default:
      return "你本轮是通用支援角色。聚焦分析、整理和补充线索，不要继续派发新的子任务；若发现需要新增线程，请把建议回传上游协调者。";
  }
}

function buildDelegatedTaskPrompt(params: {
  spawnerName: string;
  task: string;
  label?: string;
  roleBoundaryInstruction?: string;
  context?: string;
  attachments?: readonly string[];
  executionHint?: string;
}): string {
  const task = params.task.trim() || "未命名任务";
  const label = params.label?.trim();
  const context = params.context?.trim();
  const attachments = (params.attachments ?? [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  const executionHint = params.executionHint?.trim();

  const lines: string[] = [
    `[由 ${params.spawnerName} 委派的任务]`,
    "",
    "## 任务目标",
    task,
  ];

  if (label && label !== task) {
    lines.push("", "## 任务焦点", label);
  }

  lines.push(
    "",
    "## 协作方式",
    "- 这是主 Agent 委派给你的子任务。你需要在给定目标和边界内自行决定执行步骤。",
    "- 不要等待上游继续逐步指挥，也不要擅自改写任务目标。",
    "- 如果发现缺少关键前提或必须扩大范围，先尽量在当前边界内推进，再明确回报缺口、原因和建议的上游动作。",
  );

  if (params.roleBoundaryInstruction) {
    lines.push("", "## 本轮职责边界", params.roleBoundaryInstruction);
  }

  lines.push(
    "",
    "## 范围与边界",
    attachments.length > 0
      ? "- 优先围绕下方工作集和补充上下文涉及的文件、目录或模块开展工作。"
      : "- 优先围绕任务描述和补充上下文涉及的范围开展工作，不要无边界发散。",
    "- 如需越过当前范围，请确认确有必要，并在结果里说明原因。",
  );

  if (context) {
    lines.push("", "## 已知上下文", context);
  }

  if (attachments.length > 0) {
    lines.push("", "## 工作集 / 附件文件", ...attachments.map((file) => `- ${file}`));
  }

  lines.push(
    "",
    "## 交付要求",
    "- 返回时给出结论、关键证据和下一步建议，不要只回复“已处理”或“看过了”。",
    "- 若任务涉及代码、文件、页面或验证，请优先提供文件路径、关键修改点、命令或测试结果等可核查信息。",
    "- 若未完成，请明确说明阻塞原因、已完成部分和建议的后续动作。",
  );

  if (executionHint) {
    lines.push("", executionHint);
  }

  return lines.join("\n");
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message || "error";
  if (typeof error === "string") return error;
  return "unknown error";
}

function basename(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function normalizePath(path?: string | null): string {
  return String(path ?? "").trim().replace(/\\/g, "/");
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function dirname(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/") || "/";
}

function inferLanguageFromPath(path: string): string | undefined {
  const fileName = basename(path).toLowerCase();
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    default:
      return ext || undefined;
  }
}

function isPathWithinDirectory(path: string, directory?: string): boolean {
  const normalizedPath = trimTrailingSlash(normalizePath(path));
  const normalizedDirectory = trimTrailingSlash(normalizePath(directory));
  if (!normalizedPath || !normalizedDirectory) return false;
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

function isLikelyUserShareableArtifactPath(path: string, workspace?: string): boolean {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return false;
  if (isLikelyVisualAttachmentPath(normalizedPath)) return true;

  const normalizedWorkspace = normalizePath(workspace);
  if (normalizedWorkspace) {
    return !isPathWithinDirectory(normalizedPath, normalizedWorkspace);
  }

  return USER_SHAREABLE_ARTIFACT_DIR_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

function collectDialogMessagePreview(items: readonly string[] | undefined, limit = 3): string[] | undefined {
  if (!items?.length) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = String(item || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result.length > 0 ? result : undefined;
}

function getInteractionRequestKind(type: PendingInteractionType): DialogMessage["kind"] {
  switch (type) {
    case "clarification":
      return "clarification_request";
    case "approval":
      return "approval_request";
    default:
      return "agent_message";
  }
}

function getInteractionResponseKind(type: PendingInteractionType): DialogMessage["kind"] {
  switch (type) {
    case "clarification":
      return "clarification_response";
    case "approval":
      return "approval_response";
    default:
      return "user_input";
  }
}

const LOW_SIGNAL_COORDINATION_TEXTS = new Set([
  "收到",
  "已收到",
  "我已收到",
  "好的",
  "明白",
  "明白了",
  "了解",
  "确认",
  "收到感谢",
  "谢谢",
  "感谢",
  "待命",
  "等待指示",
  "任务完成",
  "任务已完成",
  "任务闭环",
]);

const LOW_SIGNAL_COORDINATION_PATTERNS = [
  /^(收到|已收到|我已收到|好的|明白了?|了解|确认|谢谢|感谢)([。！!.,，]*)$/u,
  /^(我(这边)?会配合|我已向.*发送确认|我已经.*保存).*$/u,
  /^(当前状态|任务状态|任务进展)[:：].*$/u,
  /等待.*(任务|指示|安排|分配)/u,
  /请问.*(下一步|需要我做什么|当前任务是什么)/u,
  /(任务已完成|任务闭环|无需重复操作)/u,
] as const;

function isLowSignalCoordinationMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  // 避免误杀长篇有效内容，只针对短协作回执做抑制
  if (trimmed.length > 220) return false;

  const compact = trimmed
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[!！。,.，:：;；?？~～`"'“”‘’]/g, "");

  if (LOW_SIGNAL_COORDINATION_TEXTS.has(compact)) {
    return true;
  }

  return LOW_SIGNAL_COORDINATION_PATTERNS.some((re) => re.test(trimmed));
}

const LOG_PREFIX = "[ActorSystem]";
const log = (..._args: unknown[]) => undefined;
const logWarn = (...args: unknown[]) => console.warn(LOG_PREFIX, ...args);

type SystemEventHandler = (event: ActorEvent | DialogMessage) => void;

// ── Hook System (对标 OpenClaw subagent hooks) ──

/** 扩展的 Hook 类型，匹配 OpenClaw 生命周期 */
export type HookType = 
  | "onSpawn"           // Agent 创建后
  | "beforeSpawn"       // Agent 创建前
  | "onEnd"             // Agent 任务完成
  | "beforeKill"        // Agent 终止前
  | "onKill"            // Agent 终止后
  | "onMessage"         // 消息接收/发送
  | "onTaskStart"       // 任务开始
  | "onTaskError"       // 任务错误
  | "onSpawnTask"       // 子任务派发
  | "onSpawnTaskEnd";   // 子任务完成

export interface HookContext {
  system: ActorSystem;
  actorId: string;
  actorName: string;
  timestamp: number;
}

export interface SpawnHookContext extends HookContext {
  config: ActorConfig;
}

export interface BeforeSpawnHookContext extends HookContext {
  config: ActorConfig;
  /** 如果返回 false，则取消 spawn */
  canContinue?: () => boolean;
}

export interface EndHookContext extends HookContext {
  taskId: string;
  result?: string;
  error?: string;
  elapsed: number;
}

export interface MessageHookContext extends HookContext {
  message: DialogMessage;
  direction: "inbound" | "outbound";
}

export interface TaskStartHookContext extends HookContext {
  taskId: string;
  query: string;
}

export interface TaskErrorHookContext extends HookContext {
  taskId: string;
  error: string;
}

export interface SpawnTaskHookContext extends HookContext {
  spawnerId: string;
  targetId: string;
  task: string;
  mode: "run" | "session";
  runId: string;
}

export interface SpawnTaskEndHookContext extends HookContext {
  spawnerId: string;
  targetId: string;
  task: string;
  runId: string;
  status: "completed" | "error" | "aborted";
  result?: string;
  error?: string;
}

export type HookHandler<T extends HookContext = HookContext> = (ctx: T) => void | Promise<void>;

/**
 * 修改型 Hook 返回结果
 * - modify: 返回修改后的上下文
 * - continue: 继续执行（不做修改）
 * - stop: 阻止操作执行
 */
export interface ModifyResult<T> {
  action: "modify" | "continue" | "stop";
  modified?: T;
  error?: string;
}

/**
 * 修改型 Hook 处理器
 * 可以拦截和修改传入的参数
 */
export type ModifyHookHandler<T extends HookContext = HookContext> = (ctx: T) => ModifyResult<T>;

// Hook 分类
export type VoidHookType = 
  | "onSpawn" | "onEnd" | "onKill" | "onMessage" 
  | "onTaskStart" | "onTaskError" | "onSpawnTask" | "onSpawnTaskEnd";

export type ModifyHookType = "beforeSpawn" | "beforeKill";

export const VOID_HOOKS: VoidHookType[] = [
  "onSpawn", "onEnd", "onKill", "onMessage", 
  "onTaskStart", "onTaskError", "onSpawnTask", "onSpawnTaskEnd"
];

export const MODIFY_HOOKS: ModifyHookType[] = ["beforeSpawn", "beforeKill"];

export interface ActorSystemOptions {
  askUser?: AskUserCallback;
  confirmDangerousAction?: ConfirmDangerousAction;
  defaultProductMode?: "dialog" | "review";
}

/**
 * ActorSystem — 全局 Actor 注册表和消息路由。
 *
 * 管理所有 AgentActor 的生命周期，提供：
 * - Actor 创建 / 销毁
 * - 消息路由（点对点、广播）
 * - 并发任务调度
 * - ask-and-wait 机制（Agent A 向 Agent B 提问并等待回复）
 */
export class ActorSystem {
  private actors = new Map<string, AgentActor>();
  private dialogHistory: DialogMessage[] = [];
  private eventHandlers: SystemEventHandler[] = [];
  private pendingReplies = new Map<string, PendingReply>();
  private pendingInteractions = new Map<string, PendingInteraction>();
  private spawnedTasks = new Map<string, SpawnedTaskRecord>();
  private artifactRecords = new Map<string, DialogArtifactRecord>();
  private sessionUploads = new Map<string, SessionUploadRecord>();
  private stagedResultMedia = new Map<string, Pick<DialogMessage, "images" | "attachments">>();
  private coordinatorActorId: string | null = null;
  private activeExecutionContract: ExecutionContract | null = null;
  private legacyDialogExecutionPlanRuntimeState: LegacyDialogExecutionPlanRuntimeState | null = null;
  private dialogRoomCompaction: DialogRoomCompactionState | null = null;
  private focusedSpawnedSessionRunId: string | null = null;
  private options: ActorSystemOptions;
  readonly sessionId: string;
  private hooks = new Map<HookType, Array<HookHandler<any>>>();
  private modifyHooks = new Map<ModifyHookType, Array<ModifyHookHandler<any>>>();
  private _cron: ActorCron;

  constructor(options: ActorSystemOptions = {}) {
    this.options = options;
    this.sessionId = generateId();
    this._cron = new ActorCron(this);
  }

  /** 定时任务调度器（对标 OpenClaw cron） */
  get cron(): ActorCron {
    return this._cron;
  }

  get defaultProductMode(): "dialog" | "review" {
    return this.options.defaultProductMode === "review" ? "review" : "dialog";
  }

  set defaultProductMode(mode: "dialog" | "review") {
    this.options.defaultProductMode = mode === "review" ? "review" : "dialog";
  }

  // ── Actor Lifecycle ──

  /** 创建并注册一个新的 Actor */
  spawn(config: ActorConfig): AgentActor {
    // 运行 beforeSpawn hooks（可以修改 config 或阻止 spawn）
    const beforeResult = this.runModifyHooks<BeforeSpawnHookContext>("beforeSpawn", {
      system: this,
      actorId: config.id,
      actorName: config.role.name,
      timestamp: Date.now(),
      config,
    });

    if (beforeResult.stopped) {
      throw new Error(beforeResult.error || `Spawn cancelled by beforeSpawn hook`);
    }

    const finalConfig = beforeResult.modified?.config ?? config;

    if (this.actors.has(finalConfig.id)) {
      throw new Error(`Actor ${finalConfig.id} already exists`);
    }

    const actor = new AgentActor(finalConfig, {
      askUser: this.options.askUser,
      confirmDangerousAction: this.options.confirmDangerousAction,
      actorSystem: this,
    });

    actor.on((event) => {
      this.emitEvent(event);
      if (event.type === "task_started") {
        this.markSpawnedSessionTaskStarted(event.actorId, event.timestamp);
      }
      if (event.type === "task_completed" || event.type === "task_error") {
        const detail = (event.detail ?? {}) as Record<string, unknown>;
        this.markSpawnedSessionTaskEnded(
          event.actorId,
          event.type === "task_completed" ? "completed" : (String(detail.error ?? "") === "Aborted" ? "aborted" : "error"),
          event.timestamp,
          {
            result: detail.result as string | undefined,
            error: detail.error as string | undefined,
          },
        );
        void this.runHooks<EndHookContext>("onEnd", {
          system: this,
          actorId: event.actorId,
          actorName: actor.role.name,
          timestamp: event.timestamp,
          taskId: String(detail.taskId ?? ""),
          result: detail.result as string | undefined,
          error: detail.error as string | undefined,
          elapsed: (detail.elapsed as number) ?? 0,
        });
      }
    });

    this.actors.set(finalConfig.id, actor);
    if (!this.coordinatorActorId) {
      this.coordinatorActorId = finalConfig.id;
    }
    this.ensureUniqueActorNames();
    log(`spawn: ${finalConfig.role.name} (${finalConfig.id}), model=${finalConfig.modelOverride ?? "default"}`);
    this.syncTranscriptActors();
    void this.runHooks<SpawnHookContext>("onSpawn", {
      system: this, actorId: finalConfig.id, actorName: finalConfig.role.name,
      timestamp: Date.now(), config: finalConfig,
    });
    // 返回带有正确 ID 的 actor
    return actor;
  }

  /** 停止并移除一个 Actor，级联 kill 它的所有 spawned tasks */
  kill(actorId: string): void {
    const actor = this.actors.get(actorId);
    if (!actor) return;
    void this.runHooks("onKill", {
      system: this, actorId, actorName: actor.role.name, timestamp: Date.now(),
    });
    this.cascadeAbortSpawns(actorId);
    actor.stop();
    for (const record of this.spawnedTasks.values()) {
      if (record.targetActorId === actorId || record.spawnerActorId === actorId) {
        this.closeSpawnedSessionRecord(record);
      }
    }
    this.actors.delete(actorId);
    this.removeActorFromExecutionContract(actorId);
    if (this.coordinatorActorId === actorId) {
      this.coordinatorActorId = this.getFirstActor()?.id ?? null;
    }
    this.syncTranscriptActors();
  }

  /** 停止并移除所有 Actor */
  killAll(): void {
    this._cron.cancelAll();
    for (const record of this.spawnedTasks.values()) {
      if (record.timeoutId) clearTimeout(record.timeoutId);
      this.closeSpawnedSessionRecord(record);
    }
    this.spawnedTasks.clear();
    this.artifactRecords.clear();
    this.sessionUploads.clear();
    this.focusedSpawnedSessionRunId = null;
    this.dialogRoomCompaction = null;
    for (const actor of this.actors.values()) {
      actor.stop();
    }
    this.actors.clear();
    this.coordinatorActorId = null;
    this.activeExecutionContract = null;
    this.legacyDialogExecutionPlanRuntimeState = null;
    this.dialogHistory = [];
    this.pendingReplies.clear();
  }

  /** 获取一个 Actor */
  get(actorId: string): AgentActor | undefined {
    return this.actors.get(actorId);
  }

  /** 获取所有 Actor */
  getAll(): AgentActor[] {
    return [...this.actors.values()];
  }

  /** 获取 Actor 数量 */
  get size(): number {
    return this.actors.size;
  }

  /**
   * 规范化 Actor 名称，避免 UI 中出现多个同名 Agent。
   * 对于同名的 Actor，从第二个开始追加 #2 / #3 后缀。
   */
  ensureUniqueActorNames(): void {
    const nameMap = new Map<string, AgentActor[]>();
    for (const actor of this.actors.values()) {
      const name = actor.role.name;
      const list = nameMap.get(name) ?? [];
      list.push(actor);
      nameMap.set(name, list);
    }

    for (const [name, list] of nameMap) {
      if (list.length <= 1) continue;
      list.forEach((actor, index) => {
        if (index === 0) return;
        const newName = `${name} #${index + 1}`;
        if (actor.role.name !== newName) {
          log(`ensureUniqueActorNames: rename ${actor.role.name} → ${newName}`);
          actor.role.name = newName;
        }
      });
    }
  }

  /** 获取第一个（按 spawn 顺序）满足条件的 Actor，默认返回第一个 */
  getFirstActor(filter?: (a: AgentActor) => boolean): AgentActor | undefined {
    for (const actor of this.actors.values()) {
      if (!filter || filter(actor)) return actor;
    }
    return undefined;
  }

  private getExecutionContractCoordinator(filter?: (a: AgentActor) => boolean): AgentActor | undefined {
    const coordinatorId = this.activeExecutionContract?.coordinatorActorId;
    if (!coordinatorId) return undefined;
    const coordinator = this.actors.get(coordinatorId);
    if (coordinator && (!filter || filter(coordinator))) {
      return coordinator;
    }
    return undefined;
  }

  getCoordinator(filter?: (a: AgentActor) => boolean): AgentActor | undefined {
    const planCoordinator = this.getExecutionContractCoordinator(filter);
    if (planCoordinator) {
      return planCoordinator;
    }

    const coordinator = this.coordinatorActorId ? this.actors.get(this.coordinatorActorId) : undefined;
    if (coordinator && (!filter || filter(coordinator))) {
      return coordinator;
    }
    return this.getFirstActor(filter);
  }

  getCoordinatorId(): string | null {
    return this.getCoordinator()?.id ?? null;
  }

  setCoordinator(actorId: string): void {
    if (!this.actors.has(actorId)) {
      throw new Error(`Coordinator ${actorId} not found`);
    }
    this.coordinatorActorId = actorId;
  }

  /**
   * 按指定 ID 顺序重排 actors Map。
   * Map 迭代顺序由插入顺序决定，此方法通过重建 Map 实现排序。
   */
  reorderActors(orderedIds: string[]): void {
    const reordered = new Map<string, AgentActor>();
    for (const id of orderedIds) {
      const actor = this.actors.get(id);
      if (actor) reordered.set(id, actor);
    }
    // 追加未出现在 orderedIds 中的 actor（防御性）
    for (const [id, actor] of this.actors) {
      if (!reordered.has(id)) reordered.set(id, actor);
    }
    this.actors = reordered;
    this.syncTranscriptActors();
  }

  private getExecutionContractSurface(): ExecutionContract["surface"] {
    return this.activeExecutionContract?.surface ?? "local_dialog";
  }

  private ensureRuntimeExecutionContract(): ExecutionContract | null {
    return this.activeExecutionContract;
  }

  private setLegacyDialogExecutionPlanRuntimeState(
    state?: LegacyDialogExecutionPlanRuntimeState | null,
  ): void {
    const activatedAt = typeof state?.activatedAt === "number" ? state.activatedAt : undefined;
    const sourceMessageId = state?.sourceMessageId?.trim() || undefined;
    this.legacyDialogExecutionPlanRuntimeState = activatedAt || sourceMessageId
      ? { activatedAt, sourceMessageId }
      : null;
  }

  getActiveExecutionContract(): ExecutionContract | null {
    return this.activeExecutionContract ? cloneExecutionContract(this.activeExecutionContract) : null;
  }

  /**
   * @deprecated 仅用于旧数据兼容与过渡期调试视图。
   * 新运行态应统一读取 `getActiveExecutionContract()`。
   */
  getDialogExecutionPlan(): DialogExecutionPlan | null {
    const contract = this.activeExecutionContract;
    if (contract) {
      return cloneLegacyDialogExecutionPlan(buildLegacyDialogExecutionPlanFromContract(contract, {
        runtimeState: this.legacyDialogExecutionPlanRuntimeState,
        hasActor: (actorId) => this.actors.has(actorId),
      }));
    }
    return null;
  }

  getDialogRoomCompaction(): DialogRoomCompactionState | null {
    return cloneDialogRoomCompaction(this.dialogRoomCompaction);
  }

  setDialogRoomCompaction(state: DialogRoomCompactionState | null): void {
    this.dialogRoomCompaction = cloneDialogRoomCompaction(state);
  }

  private dedupeActorPairs(
    edges: Array<{ fromActorId: string; toActorId: string }>,
  ): Array<{ fromActorId: string; toActorId: string }> {
    const seen = new Set<string>();
    const result: Array<{ fromActorId: string; toActorId: string }> = [];
    for (const edge of edges) {
      if (!edge.fromActorId || !edge.toActorId) continue;
      const key = `${edge.fromActorId}->${edge.toActorId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ fromActorId: edge.fromActorId, toActorId: edge.toActorId });
    }
    return result;
  }

  private attachDynamicActorToExecutionContract(parentActorId: string, childActorId: string): void {
    const contract = this.activeExecutionContract;
    if (!contract) return;
    if (!contract.participantActorIds.includes(parentActorId)) {
      throw new Error(`[execution_contract] ${parentActorId} 不在已批准协作范围内，不能创建新的子 Agent`);
    }
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      participantActorIds: [...new Set([...contract.participantActorIds, childActorId])],
      allowedMessagePairs: this.dedupeActorPairs([
        ...contract.allowedMessagePairs,
        { fromActorId: parentActorId, toActorId: childActorId },
        { fromActorId: childActorId, toActorId: parentActorId },
      ]),
      allowedSpawnPairs: this.dedupeActorPairs([
        ...contract.allowedSpawnPairs,
        { fromActorId: parentActorId, toActorId: childActorId },
      ]),
    };
  }

  private removeActorFromExecutionContract(actorId: string): void {
    const contract = this.activeExecutionContract;
    if (!contract) return;
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      initialRecipientActorIds: contract.initialRecipientActorIds.filter((id) => id !== actorId),
      participantActorIds: contract.participantActorIds.filter((id) => id !== actorId),
      coordinatorActorId: contract.coordinatorActorId === actorId
        ? undefined
        : contract.coordinatorActorId,
      allowedMessagePairs: contract.allowedMessagePairs.filter(
        (edge) => edge.fromActorId !== actorId && edge.toActorId !== actorId,
      ),
      allowedSpawnPairs: contract.allowedSpawnPairs.filter(
        (edge) => edge.fromActorId !== actorId && edge.toActorId !== actorId,
      ),
      plannedDelegations: contract.plannedDelegations.filter((spawn) => spawn.targetActorId !== actorId),
    };
  }

  private createEphemeralAgent(
    spawnerActorId: string,
    opts: {
      name: string;
      description?: string;
      capabilities?: AgentCapability[];
      roleBoundary?: SpawnedTaskRoleBoundary;
      workspace?: string;
      toolPolicy?: ToolPolicy;
      timeoutSeconds?: number;
      overrides?: import("./types").SpawnTaskOverrides;
    },
  ): AgentActor | { error: string } {
    const spawner = this.actors.get(spawnerActorId);
    if (!spawner) return { error: `Spawner ${spawnerActorId} not found` };

    const requestedName = opts.name.trim();
    if (!requestedName) {
      return { error: "临时 Agent 名称不能为空" };
    }

    const actorId = `spawned-${generateId()}`;
    const inferredBoundary = opts.roleBoundary
      ? buildEphemeralChildBoundary(opts.roleBoundary)
      : inferEphemeralChildBoundary({
          name: requestedName,
          description: opts.description,
          capabilities: opts.capabilities,
        });
    const explicitToolPolicy = opts.toolPolicy ?? opts.overrides?.toolPolicy;
    const resolvedChildSettings = resolveChildExecutionSettings({
      roleBoundary: inferredBoundary.role,
      parentToolPolicy: spawner.toolPolicyConfig,
      parentExecutionPolicy: spawner.executionPolicy,
      parentWorkspace: spawner.workspace,
      parentThinkingLevel: spawner.thinkingLevel,
      parentMiddlewareOverrides: spawner.middlewareOverrides,
      boundaryToolPolicy: inferredBoundary.toolPolicy,
      boundaryExecutionPolicy: inferredBoundary.executionPolicy,
      overrideToolPolicy: explicitToolPolicy,
      overrideExecutionPolicy: opts.overrides?.executionPolicy,
      overrideWorkspace: opts.workspace,
      overrideThinkingLevel: opts.overrides?.thinkingLevel,
      overrideMiddlewareOverrides: opts.overrides?.middlewareOverrides,
    });
    const spawnerBasePrompt = spawner.getSystemPromptOverride() ?? spawner.role.systemPrompt;
    const systemPromptBlocks = [
      spawnerBasePrompt || DIALOG_FULL_ROLE.systemPrompt,
      `你是由 ${spawner.role.name} 临时创建的专用子 Agent。`,
      opts.description ? `你的职责定位：${opts.description}` : "",
      opts.capabilities?.length ? `优先能力聚焦：${opts.capabilities.join("、")}` : "",
      inferredBoundary.systemPromptAppend ? `默认职责边界：${inferredBoundary.systemPromptAppend}` : "",
      opts.overrides?.systemPromptAppend ? `额外约束：${opts.overrides.systemPromptAppend}` : "",
    ].filter(Boolean);

    try {
      const actor = this.spawn({
        id: actorId,
        role: {
          ...DIALOG_FULL_ROLE,
          id: `dialog_agent_${actorId}`,
          name: requestedName,
        },
        persistent: false,
        modelOverride: opts.overrides?.model,
        maxIterations: opts.overrides?.maxIterations,
        systemPromptOverride: systemPromptBlocks.join("\n\n"),
        toolPolicy: resolvedChildSettings.toolPolicy,
        executionPolicy: resolvedChildSettings.executionPolicy,
        timeoutSeconds: opts.timeoutSeconds ?? spawner.timeoutSeconds,
        workspace: resolvedChildSettings.workspace,
        contextTokens: opts.overrides?.contextTokens ?? spawner.contextTokens,
        thinkingLevel: resolvedChildSettings.thinkingLevel,
        capabilities: opts.capabilities?.length
          ? { tags: opts.capabilities, description: opts.description }
          : spawner.capabilities,
        middlewareOverrides: resolvedChildSettings.middlewareOverrides,
      });

      try {
        this.attachDynamicActorToExecutionContract(spawnerActorId, actor.id);
      } catch (error) {
        this.kill(actor.id);
        return { error: error instanceof Error ? error.message : String(error) };
      }

      log(`[execution_contract] spawned ephemeral child agent ${actor.role.name} for ${spawner.role.name}`);
      return actor;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  armExecutionContract(contract: ExecutionContract): void {
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      state: "sealed",
    };
    this.setLegacyDialogExecutionPlanRuntimeState(null);
    log(`armExecutionContract: ${contract.summary}`);
  }

  restoreExecutionContract(contract: ExecutionContract): void {
    const shouldPreserveRuntimeState = this.activeExecutionContract?.contractId === contract.contractId;
    this.activeExecutionContract = cloneExecutionContract(contract);
    if (!shouldPreserveRuntimeState) {
      this.setLegacyDialogExecutionPlanRuntimeState(null);
    }
    log(`restoreExecutionContract: ${contract.summary}`);
  }

  clearExecutionContract(): void {
    const summary = this.activeExecutionContract?.summary;
    if (summary) {
      log(`clearExecutionContract: ${summary}`);
    }
    this.activeExecutionContract = null;
    this.legacyDialogExecutionPlanRuntimeState = null;
  }

  /**
   * @deprecated 仅用于旧测试与兼容迁移入口。
   * 新运行态应统一调用 `armExecutionContract()`。
   */
  armDialogExecutionPlan(plan: DialogExecutionPlan): void {
    const { contract } = buildExecutionContractFromLegacyDialogExecutionPlan({
      surface: this.getExecutionContractSurface(),
      plan,
      hasActor: (actorId) => this.actors.has(actorId),
    });
    this.armExecutionContract(contract);
  }

  /**
   * @deprecated 仅用于旧快照恢复与兼容迁移入口。
   * 新运行态应统一调用 `restoreExecutionContract()`。
   */
  restoreDialogExecutionPlan(plan: DialogExecutionPlan): void {
    const { contract, runtimeState } = buildExecutionContractFromLegacyDialogExecutionPlan({
      surface: this.getExecutionContractSurface(),
      plan,
      hasActor: (actorId) => this.actors.has(actorId),
    });
    this.restoreExecutionContract(contract);
    this.setLegacyDialogExecutionPlanRuntimeState(runtimeState);
  }

  /**
   * @deprecated 仅用于兼容旧调用方。
   * 新运行态应统一调用 `clearExecutionContract()`。
   */
  clearDialogExecutionPlan(): void {
    this.clearExecutionContract();
  }

  private activateExecutionContract(sourceMessageId: string): boolean {
    const contract = this.activeExecutionContract;
    if (!contract || contract.state !== "sealed") return false;
    const activatedAt = Date.now();
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      state: "active",
    };
    this.setLegacyDialogExecutionPlanRuntimeState({ activatedAt, sourceMessageId });
    log(`activateExecutionContract: sourceMessageId=${sourceMessageId}`);
    return true;
  }

  private tryFinalizeExecutionContract(): void {
    const contract = this.activeExecutionContract;
    if (!contract || contract.state !== "active") return;

    const allRunning = [...this.spawnedTasks.values()].filter((r) => r.status === "running");
    if (allRunning.length > 0) return;

    const recipientIds = contract.initialRecipientActorIds ?? [];
    const allIdle = recipientIds.every((id) => {
      const actor = this.actors.get(id);
      return !actor || actor.status === "idle";
    });
    if (!allIdle) return;

    const hasError = [...this.spawnedTasks.values()].some(
      (r) => r.status === "error" || r.status === "aborted",
    );
    const newState = hasError ? "failed" : "completed";
    this.activeExecutionContract = {
      ...cloneExecutionContract(contract),
      state: newState,
    };
    log(`tryFinalizeExecutionContract: contract → ${newState}`);
    this.emitEvent({
      // Keep the legacy event name for compatibility with existing listeners.
      type: "dialog_plan_finalized",
      actorId: this.coordinatorActorId ?? "",
      timestamp: Date.now(),
      detail: { state: newState, summary: contract.summary },
    });
  }

  private _sessionStallTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleExecutionContractProgressCheck(): void {
    if (this._sessionStallTimer) {
      clearTimeout(this._sessionStallTimer);
      this._sessionStallTimer = null;
    }
    const contract = this.ensureRuntimeExecutionContract();
    if (!contract || contract.state !== "active") return;

    this._sessionStallTimer = setTimeout(() => {
      this._sessionStallTimer = null;
      const running = [...this.spawnedTasks.values()].filter((r) => r.status === "running");
      if (running.length > 0) return;

      const busyActors = [...this.actors.values()].filter((a) => a.status !== "idle");
      if (busyActors.length > 0) return;

      if (this.ensureRuntimeExecutionContract()?.state === "active") {
        log("scheduleExecutionContractProgressCheck: session stall detected");
        this.emitEvent({
          type: "session_stalled",
          actorId: this.coordinatorActorId ?? "",
          timestamp: Date.now(),
          detail: { planSummary: contract.summary },
        });
      }
    }, 30_000);
  }

  private getSuggestedPlannedSpawn(
    spawnerActorId: string,
    params: {
      targetActorId?: string;
      plannedDelegationId?: string | null;
    },
  ): NonNullable<ExecutionContract["plannedDelegations"]>[number] | undefined {
    const plan = this.ensureRuntimeExecutionContract();
    if (!plan?.plannedDelegations?.length) return undefined;
    const coordinatorActorId = plan.coordinatorActorId ?? plan.initialRecipientActorIds[0];
    if (!coordinatorActorId || spawnerActorId !== coordinatorActorId) return undefined;
    const plannedDelegationId = params.plannedDelegationId?.trim();
    if (plannedDelegationId) {
      return plan.plannedDelegations.find((spawn) => spawn.id === plannedDelegationId);
    }
    const targetActorId = params.targetActorId?.trim();
    if (!targetActorId) return undefined;
    return plan.plannedDelegations.find((spawn) =>
      spawn.targetActorId === targetActorId
      || spawn.targetActorName === targetActorId,
    );
  }

  private isExecutionContractEdgeAllowed(
    pairs: ExecutionContract["allowedMessagePairs"] | ExecutionContract["allowedSpawnPairs"],
    fromActorId: string,
    toActorId: string,
  ): boolean {
    return pairs.some((edge) => edge.fromActorId === fromActorId && edge.toActorId === toActorId);
  }

  private assertUserDispatchMatchesContract(
    recipientActorIds: string[],
    mode: "send" | "broadcast" | "broadcastAndResolve",
  ): void {
    const contract = this.ensureRuntimeExecutionContract();
    if (!contract) return;

    const expected = new Set(contract.initialRecipientActorIds);
    const actual = new Set(recipientActorIds);
    const matches = expected.size === actual.size && [...expected].every((id) => actual.has(id));

    if (!matches) {
      const expectedLabel = [...expected].join(", ") || "none";
      const actualLabel = [...actual].join(", ") || "none";
      throw new Error(
        `[execution_contract] ${mode} 目标不在已批准计划内（expected=${expectedLabel}, actual=${actualLabel}）`,
      );
    }
  }

  private assertActorMessageAllowed(fromActorId: string, toActorId: string): void {
    const contract = this.ensureRuntimeExecutionContract();
    if (!contract) return;

    if (!contract.participantActorIds.includes(fromActorId) || !contract.participantActorIds.includes(toActorId)) {
      throw new Error(`[execution_contract] ${fromActorId} 或 ${toActorId} 不在已批准协作范围内`);
    }

    if (!this.isExecutionContractEdgeAllowed(contract.allowedMessagePairs, fromActorId, toActorId)) {
      throw new Error(`[execution_contract] ${fromActorId} -> ${toActorId} 的消息未在已批准计划中`);
    }
  }

  private assertActorSpawnAllowed(spawnerActorId: string, targetActorId: string): void {
    const contract = this.ensureRuntimeExecutionContract();
    if (!contract) return;

    if (!contract.participantActorIds.includes(spawnerActorId) || !contract.participantActorIds.includes(targetActorId)) {
      throw new Error(`[execution_contract] ${spawnerActorId} 或 ${targetActorId} 不在已批准协作范围内`);
    }

    if (!this.isExecutionContractEdgeAllowed(contract.allowedSpawnPairs, spawnerActorId, targetActorId)) {
      throw new Error(`[execution_contract] ${spawnerActorId} -> ${targetActorId} 的 spawn_task 未在已批准计划中`);
    }
  }

  private finalizeSpawnedTaskHistoryWindow(record: SpawnedTaskRecord, targetActor?: AgentActor): void {
    if (typeof record.sessionHistoryEndIndex === "number") return;
    const resolvedTarget = targetActor ?? this.actors.get(record.targetActorId);
    record.sessionHistoryEndIndex = resolvedTarget?.getSessionHistory().length ?? record.sessionHistoryStartIndex;
  }

  private getArtifactKey(path: string): string {
    return path.trim().replace(/\\/g, "/");
  }

  private getOpenSpawnedSessionByRunId(runId: string): SpawnedTaskRecord | undefined {
    const record = this.spawnedTasks.get(runId);
    if (!record || record.mode !== "session" || !record.sessionOpen) return undefined;
    return record;
  }

  private getOpenSpawnedSessionByTarget(targetActorId: string): SpawnedTaskRecord | undefined {
    return [...this.spawnedTasks.values()]
      .filter((record) => record.mode === "session" && record.sessionOpen && record.targetActorId === targetActorId)
      .sort((a, b) => (b.lastActiveAt ?? b.spawnedAt) - (a.lastActiveAt ?? a.spawnedAt))[0];
  }

  private getOwningSpawnedTaskForActor(actorId: string): SpawnedTaskRecord | undefined {
    return [...this.spawnedTasks.values()]
      .filter((record) =>
        record.targetActorId === actorId
        && (
          record.status === "running"
          || (record.mode === "session" && record.sessionOpen)
        ))
      .sort((a, b) => (b.lastActiveAt ?? b.spawnedAt) - (a.lastActiveAt ?? a.spawnedAt))[0];
  }

  private closeSpawnedSessionRecord(record: SpawnedTaskRecord, closedAt = Date.now()): void {
    if (!record.sessionOpen) return;
    record.sessionOpen = false;
    record.sessionClosedAt = closedAt;
    record.lastActiveAt = closedAt;
    const targetActor = this.actors.get(record.targetActorId);
    record.sessionHistoryEndIndex = targetActor?.getSessionHistory().length ?? record.sessionHistoryEndIndex;
    if (this.focusedSpawnedSessionRunId === record.runId) {
      this.focusedSpawnedSessionRunId = null;
    }
  }

  private markSpawnedSessionTaskStarted(actorId: string, timestamp: number): void {
    for (const record of this.spawnedTasks.values()) {
      if (record.mode !== "session" || !record.sessionOpen || record.targetActorId !== actorId) continue;
      record.status = "running";
      record.completedAt = undefined;
      record.error = undefined;
      record.lastActiveAt = timestamp;
      record.sessionHistoryEndIndex = undefined;
    }
  }

  private markSpawnedSessionTaskEnded(
    actorId: string,
    status: "completed" | "error" | "aborted",
    timestamp: number,
    detail?: { result?: string; error?: string },
  ): void {
    for (const record of this.spawnedTasks.values()) {
      if (record.mode !== "session" || !record.sessionOpen || record.targetActorId !== actorId) continue;
      record.status = status;
      record.completedAt = timestamp;
      record.result = detail?.result ?? record.result;
      record.error = detail?.error ?? (status !== "completed" ? record.error : undefined);
      record.lastActiveAt = timestamp;
      const targetActor = this.actors.get(record.targetActorId);
      record.sessionHistoryEndIndex = targetActor?.getSessionHistory().length ?? record.sessionHistoryEndIndex;
    }
  }

  // ── Messaging ──

  /**
   * 发送消息（用户 -> Agent 或 Agent -> Agent）。
   * 消息会被投递到目标 Actor 的 inbox，并记录到对话历史。
   */
  send(from: string, to: string, content: string, opts?: {
    expectReply?: boolean;
    replyTo?: string;
    priority?: "normal" | "urgent";
    _briefContent?: string;
    images?: string[];
    bypassPlanCheck?: boolean;
    relatedRunId?: string;
  }): DialogMessage {
    const target = this.actors.get(to);
    if (!target) throw new Error(`Actor ${to} not found`);

    if (!opts?.bypassPlanCheck && from === "user") {
      this.assertUserDispatchMatchesContract([to], "send");
    } else if (!opts?.bypassPlanCheck) {
      this.assertActorMessageAllowed(from, to);
    }

    const fromName = from === "user" ? "用户" : (this.actors.get(from)?.role.name ?? from);
    const toName = target.role.name;
    log(`send: ${fromName} → ${toName}, content="${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"${opts?.expectReply ? " [expectReply]" : ""}${opts?.replyTo ? ` [replyTo=${opts.replyTo}]` : ""}`);

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to,
      content,
      timestamp: Date.now(),
      priority: opts?.priority ?? "normal",
      expectReply: opts?.expectReply,
      replyTo: opts?.replyTo,
      _briefContent: opts?._briefContent,
      kind: from === "user" ? "user_input" : "agent_message",
      relatedRunId: opts?.relatedRunId,
      ...(from !== "user" ? this.buildDialogMessageRecallPatch(from) : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
    };

    target.receive(msg);
    if (from === "user" && !opts?.bypassPlanCheck) {
      this.activateExecutionContract(msg.id);
    }
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);

    void this.runHooks<MessageHookContext>("onMessage", {
      system: this, actorId: to, actorName: target.role.name,
      timestamp: Date.now(), message: msg, direction: "inbound",
    });

    if (msg.replyTo) {
      const pending = this.pendingReplies.get(msg.replyTo);
      if (pending && pending.fromActorId === to) {
        log(`send: resolved pending reply ${msg.replyTo} for ${toName}`);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        this.pendingReplies.delete(msg.replyTo);
        pending.resolve(msg);
      }
    }

    return msg;
  }

  /**
   * 广播消息给所有 Actor（来自用户或系统）。
   * - 来自用户：投递给所有 Agent（用于 UI 的“广播”路由模式）
   * - 来自 Agent：投递给除自己外的所有 Agent
   * 消息始终记录到 dialogHistory，UI 上全员可见。
   */
  broadcast(from: string, content: string, opts?: { _briefContent?: string; images?: string[] }): DialogMessage {
    const fromName = from === "user" ? "用户" : (this.actors.get(from)?.role.name ?? from);
    log(`broadcast: ${fromName} → all, content="${content.slice(0, 80)}"`);

    const recipientIds = [...this.actors.values()]
      .filter((actor) => from === "user" || actor.id !== from)
      .map((actor) => actor.id);

    if (from === "user") {
      this.assertUserDispatchMatchesContract(recipientIds, "broadcast");
    } else {
      for (const recipientId of recipientIds) {
        this.assertActorMessageAllowed(from, recipientId);
      }
    }

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      _briefContent: opts?._briefContent,
      kind: from === "user" ? "user_input" : "agent_message",
      ...(from !== "user" ? this.buildDialogMessageRecallPatch(from) : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    if (from === "user") {
      this.activateExecutionContract(msg.id);
    }

    for (const actor of this.actors.values()) {
      if (from !== "user" && actor.id === from) continue;
      actor.receive(msg);
    }
    return msg;
  }

  /**
   * 群聊模式：广播消息给协调者或所有 Agent。
   *
   * 协调者投递策略：
   * - 当存在待用户交互项时，不再隐式消费，避免将新消息错误绑定到旧交互
   * - 默认仅投递给协调者，其他 Agent 等待 spawn_task 激活
   * - 消息始终记录到 dialogHistory，UI 上所有人可见
   */
  broadcastAndResolve(
    from: string,
    content: string,
    opts?: {
      _briefContent?: string;
      images?: string[];
      externalChannelType?: DialogMessage["externalChannelType"];
      externalChannelId?: DialogMessage["externalChannelId"];
      externalConversationId?: DialogMessage["externalConversationId"];
      externalConversationType?: DialogMessage["externalConversationType"];
      externalSessionId?: DialogMessage["externalSessionId"];
      runtimeDisplayLabel?: string;
      runtimeDisplayDetail?: string;
    },
  ): DialogMessage {
    const fromName = from === "user" ? "用户" : (this.actors.get(from)?.role.name ?? from);
    log(`broadcastAndResolve: ${fromName} → all, content="${content.slice(0, 80)}", pendingInteractions=${this.pendingInteractions.size}`);

    const activeContract = this.ensureRuntimeExecutionContract();
    const planRecipientIds = from === "user" && activeContract?.initialRecipientActorIds.length
      ? [...activeContract.initialRecipientActorIds]
      : null;
    const activePending = from === "user"
      ? [...this.pendingInteractions.entries()].filter(([, p]) => p.status === "pending")
      : [];
    if (from === "user" && planRecipientIds) {
      this.assertUserDispatchMatchesContract(planRecipientIds, "broadcastAndResolve");
    }

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      _briefContent: opts?._briefContent,
      kind: from === "user" ? "user_input" : "agent_message",
      relatedRunId: activePending.length === 1
        ? this.dialogHistory.find((message) => message.id === activePending[0][0])?.relatedRunId
        : undefined,
      ...(opts?.externalChannelType ? { externalChannelType: opts.externalChannelType } : {}),
      ...(opts?.externalChannelId ? { externalChannelId: opts.externalChannelId } : {}),
      ...(opts?.externalConversationId ? { externalConversationId: opts.externalConversationId } : {}),
      ...(opts?.externalConversationType ? { externalConversationType: opts.externalConversationType } : {}),
      ...(opts?.externalSessionId ? { externalSessionId: opts.externalSessionId } : {}),
      ...(opts?.runtimeDisplayLabel ? { runtimeDisplayLabel: opts.runtimeDisplayLabel } : {}),
      ...(opts?.runtimeDisplayDetail ? { runtimeDisplayDetail: opts.runtimeDisplayDetail } : {}),
      ...(from !== "user" ? this.buildDialogMessageRecallPatch(from) : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);

    if (from === "user") {
      // 恰好 1 个待回复交互时，自动视为对该交互的回复（兼容 IM 等无法显式选择的入口）
      if (activePending.length === 1) {
        const [pendingMsgId, pending] = activePending[0];
        log(`broadcastAndResolve: auto-resolving single pending interaction (msgId=${pendingMsgId}, type=${pending.type})`);
        pending.status = "answered";
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        this.pendingInteractions.delete(pendingMsgId);
        this.updateDialogMessage(pendingMsgId, { interactionStatus: "answered" });
        pending.resolve({
          interactionId: pending.id,
          interactionType: pending.type,
          status: "answered",
          content,
          message: msg,
        });
      }

      if (planRecipientIds?.length) {
        const recipients = planRecipientIds
          .map((actorId) => this.actors.get(actorId))
          .filter((actor): actor is AgentActor => Boolean(actor));
        for (const recipient of recipients) {
          log(`broadcastAndResolve(plan): delivering to ${recipient.role.name}`);
          recipient.receive(msg);
        }
      } else {
        const agentsAwaitingReply = new Set(
          [...this.pendingInteractions.values()]
            .filter((p) => p.status === "pending")
            .map((p) => p.fromActorId),
        );
        const coordinator = this.getCoordinator((a) => !agentsAwaitingReply.has(a.id));
        if (coordinator) {
          log(`broadcastAndResolve(coordinator): delivering to coordinator ${coordinator.role.name}`);
          coordinator.receive(msg);
        } else {
          const fallbackCoordinator = this.getCoordinator();
          if (fallbackCoordinator) {
            log(
              `broadcastAndResolve(fallback): queueing to ${fallbackCoordinator.role.name} despite pending interactions/state=${fallbackCoordinator.status}`,
            );
            fallbackCoordinator.receive(msg);
          } else if (activePending.length > 0) {
            log(`broadcastAndResolve: no available coordinator, pending interactions resolved`);
          } else {
            log(`broadcastAndResolve: no available coordinator and no pending interactions`);
          }
        }
      }
      this.activateExecutionContract(msg.id);
    } else {
      const recipientIds = [...this.actors.values()]
        .filter((actor) => actor.id !== from)
        .map((actor) => actor.id);
      for (const recipientId of recipientIds) {
        this.assertActorMessageAllowed(from, recipientId);
      }
      for (const actor of this.actors.values()) {
        if (actor.id === from) continue;
        actor.receive(msg);
      }
    }

    this.emitEvent(msg);
    return msg;
  }

  /**
   * 向目标 Actor 提问并等待回复（Promise 阻塞直到回复或超时）。
   * 用于 Agent 间同步提问的实现。
   */
  askAndWait(
    fromActorId: string,
    toActorId: string,
    question: string,
    timeoutMs = ASK_AGENT_TIMEOUT_MS,
  ): Promise<InboxMessage> {
    const msg = this.send(fromActorId, toActorId, question, { expectReply: true });

    return new Promise<InboxMessage>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingReplies.delete(msg.id);
        reject(new Error(`等待 ${toActorId} 回复超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);

      this.pendingReplies.set(msg.id, {
        fromActorId,
        messageId: msg.id,
        resolve,
        timeoutId,
      });
    });
  }

  // ── Task Dispatch ──

  /** 给指定 Actor 分配任务（异步，不阻塞） */
  assignTask(actorId: string, query: string, images?: string[]) {
    const actor = this.actors.get(actorId);
    if (!actor) throw new Error(`Actor ${actorId} not found`);
    log(`assignTask: ${actor.role.name} (${actorId}), query="${query.slice(0, 60)}"`);
    return actor.assignTask(query, images);
  }

  /** 并发分配多个任务 */
  async assignTasks(
    assignments: { actorId: string; query: string; images?: string[] }[],
  ): Promise<Map<string, Awaited<ReturnType<AgentActor["assignTask"]>>>> {
    const results = await Promise.allSettled(
      assignments.map(({ actorId, query, images }) =>
        this.assignTask(actorId, query, images).then((task) => ({ actorId, task })),
      ),
    );

    const map = new Map<string, Awaited<ReturnType<AgentActor["assignTask"]>>>();
    for (const r of results) {
      if (r.status === "fulfilled") {
        map.set(r.value.actorId, r.value.task);
      }
    }
    return map;
  }

  /** 停止所有正在运行的 Actor */
  abortAll(): void {
    for (const actor of this.actors.values()) {
      actor.abort();
    }
  }

  // ── Spawn Registry (OpenClaw-style) ──

  /**
   * 派发子任务给目标 Agent（对标 OpenClaw sessions_spawn）。
   * 注册追踪 + 自动 Announce Flow（结果回送 spawner inbox）。
   */
  spawnTask(
    spawnerActorId: string,
    targetActorId: string,
    task: string,
    opts?: {
      label?: string;
      context?: string;
      timeoutSeconds?: number;
      attachments?: string[];
      images?: string[];
      /** Spawn 模式：run=一次性任务，session=保持会话 */
      mode?: "run" | "session";
      /** 清理策略：delete=完成后删除，keep=保持 */
      cleanup?: "delete" | "keep";
      /** 是否期望完成消息通知 */
      expectsCompletionMessage?: boolean;
      /** 本轮显式职责边界：执行 / 审查 / 验证 */
      roleBoundary?: SpawnedTaskRoleBoundary;
      /** 目标不存在时，是否自动创建一个临时子 Agent */
      createIfMissing?: boolean;
      /** 自动创建临时子 Agent 时的描述与能力提示 */
      createChildSpec?: {
        description?: string;
        capabilities?: AgentCapability[];
        workspace?: string;
      };
      /** Subagent 独立配置：动态覆盖目标 Agent 的运行参数 */
      overrides?: import("./types").SpawnTaskOverrides;
      /** 显式关联已批准的建议委派 */
      plannedDelegationId?: string;
    },
  ): SpawnedTaskRecord | { error: string } {
    const spawner = this.actors.get(spawnerActorId);
    if (!spawner) return { error: `Spawner ${spawnerActorId} not found` };
    const activeContract = this.ensureRuntimeExecutionContract();
    const requestedDelegationId = opts?.plannedDelegationId?.trim() || undefined;
    const explicitRoleBoundary = opts?.roleBoundary;
    let resolvedRoleBoundary: SpawnedTaskRoleBoundary = explicitRoleBoundary ?? "general";
    let resolvedTargetActorId = targetActorId.trim();
    const plannedSpawn = this.getSuggestedPlannedSpawn(spawnerActorId, {
      targetActorId: resolvedTargetActorId,
      plannedDelegationId: requestedDelegationId,
    });
    if (requestedDelegationId && !plannedSpawn) {
      return { error: `[execution_contract] 未找到已批准的建议委派 ${requestedDelegationId}` };
    }
    if (!resolvedTargetActorId) {
      resolvedTargetActorId = plannedSpawn?.targetActorId?.trim() ?? "";
    }
    const resolvedTask = task.trim() || plannedSpawn?.task?.trim();
    if (!resolvedTask) {
      return { error: "[sessions_spawn] task 不能为空" };
    }
    let target = this.actors.get(resolvedTargetActorId);
    if (!target) {
      const requestedTargetName = plannedSpawn?.targetActorName?.trim() || targetActorId.trim();
      const actorByName = this.getAll().find((actor) => actor.role.name === requestedTargetName);
      if (actorByName) {
        target = actorByName;
        resolvedTargetActorId = actorByName.id;
      }
    }
    if (!explicitRoleBoundary && resolvedRoleBoundary === "general" && plannedSpawn?.roleBoundary) {
      resolvedRoleBoundary = plannedSpawn.roleBoundary;
    }
    const resolvedCreateChildSpec = {
      description: opts?.createChildSpec?.description ?? plannedSpawn?.childDescription,
      capabilities: opts?.createChildSpec?.capabilities ?? plannedSpawn?.childCapabilities,
      workspace: opts?.createChildSpec?.workspace ?? plannedSpawn?.childWorkspace,
    };
    const resolvedOverrides = {
      ...(typeof plannedSpawn?.childMaxIterations === "number"
        ? { maxIterations: plannedSpawn.childMaxIterations }
        : {}),
      ...(opts?.overrides ?? {}),
    };
    if (!target && (opts?.createIfMissing || plannedSpawn?.createIfMissing)) {
      const childActorName = plannedSpawn?.targetActorName?.trim() || targetActorId.trim() || resolvedTargetActorId;
      if (resolvedRoleBoundary === "general") {
        resolvedRoleBoundary = inferEphemeralChildBoundary({
          name: childActorName,
          description: resolvedCreateChildSpec.description,
          capabilities: resolvedCreateChildSpec.capabilities,
        }).role;
      }
      const created = this.createEphemeralAgent(spawnerActorId, {
        name: childActorName,
        description: resolvedCreateChildSpec.description,
        capabilities: resolvedCreateChildSpec.capabilities,
        roleBoundary: resolvedRoleBoundary,
        workspace: resolvedCreateChildSpec.workspace,
        toolPolicy: resolvedOverrides.toolPolicy,
        timeoutSeconds: opts?.timeoutSeconds,
        overrides: resolvedOverrides,
      });
      if ("error" in created) {
        return { error: created.error };
      }
      target = created;
      resolvedTargetActorId = created.id;
    }
    if (!target) return { error: `Target ${targetActorId} not found` };
    if (resolvedRoleBoundary === "general" && target.persistent === false) {
      resolvedRoleBoundary = inferEphemeralChildBoundary({
        name: target.role.name,
        capabilities: target.capabilities?.tags,
        description: target.capabilities?.description,
      }).role;
    }
    try {
      this.assertActorSpawnAllowed(spawnerActorId, resolvedTargetActorId);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }

    if (Object.keys(resolvedOverrides).length > 0) {
      log(`spawnTask: prepared run overrides for ${target.role.name}`, JSON.stringify(resolvedOverrides).slice(0, 200));
    }

    const mode = opts?.mode ?? "run";
    const existingOpenSession = this.getOpenSpawnedSessionByTarget(resolvedTargetActorId);
    if (mode === "session" && existingOpenSession) {
      if (existingOpenSession.spawnerActorId !== spawnerActorId) {
        return {
          error: `[sessions_spawn] ${target.role.name} 已绑定到另一个子会话（runId=${existingOpenSession.runId}）`,
        };
      }
      if (
        plannedSpawn?.id
        && existingOpenSession.plannedDelegationId
        && existingOpenSession.plannedDelegationId !== plannedSpawn.id
      ) {
        return {
          error: `[sessions_spawn] ${target.role.name} 当前保留会话已绑定到另一条建议委派（runId=${existingOpenSession.runId}）`,
        };
      }
      existingOpenSession.contractId = activeContract?.contractId ?? existingOpenSession.contractId;
      existingOpenSession.plannedDelegationId = plannedSpawn?.id ?? existingOpenSession.plannedDelegationId;
      existingOpenSession.dispatchSource = plannedSpawn ? "contract_suggestion" : existingOpenSession.dispatchSource;
      return this.continueSpawnedSession(existingOpenSession.runId, spawnerActorId, resolvedTask, {
        label: opts?.label,
        context: opts?.context,
        attachments: opts?.attachments,
        images: opts?.images,
      });
    }

    if (mode === "run" && target.status === "running") {
      return { error: `[sessions_spawn] ${target.role.name} is already running a task (mode='run' requires idle target)` };
    }
    if (mode === "session" && target.status === "running") {
      return { error: `[sessions_spawn] ${target.role.name} 正在执行其他任务，请等待空闲后再创建新的子会话` };
    }

    const parentRecord = this.getOwningSpawnedTaskForActor(spawnerActorId);
    if (parentRecord) {
      return {
        error: "[sessions_spawn] 当前默认只允许顶层协调者创建子线程；请把新增分工建议回传给父 Agent，由父 Agent 继续派工。",
      };
    }

    const coordinatorId = this.getCoordinatorId();
    if (coordinatorId && spawnerActorId !== coordinatorId) {
      return {
        error: `[sessions_spawn] 当前默认只允许协调者 ${this.actors.get(coordinatorId)?.role.name ?? coordinatorId} 创建子线程`,
      };
    }

    const depth = this.getSpawnDepth(spawnerActorId);
    if (depth >= MAX_SPAWN_DEPTH) {
      return { error: `[sessions_spawn] spawn not allowed at this depth (current: ${depth}, max: ${MAX_SPAWN_DEPTH})` };
    }

    const activeChildren = this.getActiveSpawnedTasks(spawnerActorId).length;
    if (activeChildren >= MAX_CHILDREN_PER_AGENT) {
      return { error: `[sessions_spawn] max active children reached (${activeChildren}/${MAX_CHILDREN_PER_AGENT})` };
    }

    const runId = generateId();
    const spawnerName = spawner.role.name;
    const targetName = target.role.name;
    const label = opts?.label ?? plannedSpawn?.label ?? task.slice(0, 30);
    const timeoutMs = (opts?.timeoutSeconds ?? DEFAULT_SPAWN_TIMEOUT_MS / 1000) * 1000;
    const cleanup = opts?.cleanup ?? (opts?.createIfMissing && mode === "run" ? "delete" : "keep");
    const expectsCompletionMessage = opts?.expectsCompletionMessage ?? true;
    const rootRunId = parentRecord?.rootRunId ?? parentRecord?.runId ?? runId;
    const effectiveContext = opts?.context ?? plannedSpawn?.context;
    const roleBoundaryInstruction = buildSpawnTaskRoleBoundaryInstruction(resolvedRoleBoundary);
    const executionHint = buildSpawnTaskExecutionHint(resolvedTask);
    const fullTask = buildDelegatedTaskPrompt({
      spawnerName,
      task: resolvedTask,
      label,
      roleBoundaryInstruction,
      context: effectiveContext,
      attachments: opts?.attachments,
      executionHint,
    });

    const record: SpawnedTaskRecord = {
      runId,
      spawnerActorId,
      targetActorId: resolvedTargetActorId,
      contractId: activeContract?.contractId,
      plannedDelegationId: plannedSpawn?.id,
      dispatchSource: plannedSpawn ? "contract_suggestion" : "manual",
      parentRunId: parentRecord?.runId,
      rootRunId,
      roleBoundary: resolvedRoleBoundary,
      task: resolvedTask,
      label,
      images: opts?.images?.length ? [...new Set(opts.images)] : undefined,
      status: "running",
      spawnedAt: Date.now(),
      mode,
      expectsCompletionMessage,
      cleanup,
      sessionHistoryStartIndex: target.getSessionHistory().length,
      sessionOpen: mode === "session",
      lastActiveAt: Date.now(),
    };

    // 超时处理
    record.timeoutId = setTimeout(() => {
      if (record.status !== "running") return;
      cleanupRunningListener();
      const duration = Date.now() - record.spawnedAt;
      log(`⏱️ spawnTask TIMEOUT: ${targetName} (runId=${runId}), duration=${duration}ms, timeout=${timeoutMs}ms, targetStatus=${target.status}, aborting...`);
      record.status = "aborted";
      record.completedAt = Date.now();
      record.error = `Task timeout after ${timeoutMs / 1000}s`;
      target.abort();
      this.finalizeSpawnedTaskHistoryWindow(record, target);

      if (expectsCompletionMessage) {
        this.send(resolvedTargetActorId, spawnerActorId, `[Task timeout: ${label}]\n\n子任务超时未完成，已自动终止。`);
      }

      this.emitEvent({ type: "task_error", actorId: resolvedTargetActorId, timestamp: Date.now(), detail: { runId, reason: "timeout" } });
      this.emitEvent({
        type: "spawned_task_timeout",
        actorId: resolvedTargetActorId,
        timestamp: Date.now(),
        detail: {
          ...taskEventBase,
          status: "aborted" as const,
          elapsed: duration,
          error: record.error,
        } satisfies SpawnedTaskEventDetail,
      });

      // 超时时清理（如果需要，且目标非持久 Agent）
      if (cleanup === "delete" && mode !== "session" && !target.persistent) {
        this.kill(resolvedTargetActorId);
      } else if (cleanup === "delete" && mode !== "session" && target.persistent) {
        log(`spawnTask cleanup skipped on timeout: ${targetName} is persistent (runId=${runId})`);
      }
    }, timeoutMs);

    this.spawnedTasks.set(runId, record);
    appendSpawnEvent(this.sessionId, spawnerActorId, resolvedTargetActorId, resolvedTask, runId);

    // 同步到 TaskCenter（如果可用）
    try {
      const { getTaskQueue } = require("@/core/task-center/task-queue");
      const q = getTaskQueue();
      q.create({
        id: `spawn-${runId}`,
        title: label,
        description: resolvedTask.slice(0, 200),
        type: "agent_spawn",
        priority: "normal",
        params: { runId, spawnerActorId, targetActorId: resolvedTargetActorId },
        createdBy: spawnerName,
        assignee: targetName,
        timeoutSeconds: timeoutMs / 1000,
        tags: [mode, targetName],
      });
    } catch { /* TaskCenter not available */ }
    log(`🚀 spawnTask START: ${spawnerName} → ${targetName}, task="${resolvedTask.slice(0, 60)}", runId=${runId}, mode=${mode}, timeout=${timeoutMs / 1000}s, depth=${depth + 1}, targetStatus=${target.status}`);

    // Emit structured spawned_task_started event (deer-flow SSE pattern)
    const taskEventBase: Omit<SpawnedTaskEventDetail, "status" | "elapsed"> = {
      runId, spawnerActorId, targetActorId: resolvedTargetActorId,
      targetName, spawnerName, label, task: resolvedTask,
    };
    let detachRunningListener: (() => void) | undefined;
    const cleanupRunningListener = () => {
      if (!detachRunningListener) return;
      detachRunningListener();
      detachRunningListener = undefined;
    };
    this.emitEvent({
      type: "spawned_task_started",
      actorId: resolvedTargetActorId,
      timestamp: Date.now(),
      detail: { ...taskEventBase, status: "running" as const, elapsed: 0 },
    });

    detachRunningListener = target.on((event) => {
      if (record.status !== "running" || event.type !== "step") return;
      const step = (event.detail as { step?: { content?: string; type?: string; streaming?: boolean } } | undefined)?.step;
      if (!step || step.streaming) return;

      const message = typeof step.content === "string"
        ? step.content.slice(0, 240)
        : "";
      this.emitEvent({
        type: "spawned_task_running",
        actorId: resolvedTargetActorId,
        timestamp: event.timestamp,
        detail: {
          ...taskEventBase,
          status: "running" as const,
          elapsed: Date.now() - record.spawnedAt,
          message,
          stepType: step.type as SpawnedTaskEventDetail["stepType"],
        } satisfies SpawnedTaskEventDetail,
      });
    });

    // 触发 onSpawnTask 钩子
    void this.runHooks<SpawnTaskHookContext>("onSpawnTask", {
      system: this,
      actorId: resolvedTargetActorId,
      actorName: targetName,
      timestamp: Date.now(),
      spawnerId: spawnerActorId,
      targetId: resolvedTargetActorId,
      task: resolvedTask,
      mode,
      runId,
    });

    // 执行任务并设置 Announce Flow 回调（含重试机制）
    // 子任务结果仅通过 announce 回送给委派者，避免全局广播造成协作噪音。
    void target.assignTask(fullTask, opts?.images, {
      publishResult: false,
      runOverrides: Object.keys(resolvedOverrides).length > 0 ? resolvedOverrides : undefined,
    }).then((taskResult) => {
      cleanupRunningListener();
      if (record.status !== "running") return;
      if (record.timeoutId) clearTimeout(record.timeoutId);

      if (taskResult.status === "completed" && taskResult.result) {
        const validation = validateSpawnedTaskResult({
          task: record,
          result: taskResult.result,
          artifacts: this.getArtifactRecordsSnapshot(),
        });
        if (!validation.accepted) {
          record.status = "error";
          record.completedAt = Date.now();
          record.error = validation.reason ?? "子任务结果未通过有效性校验";
          this.finalizeSpawnedTaskHistoryWindow(record, target);
          log(
            `❌ spawnTask INVALID_RESULT: ${targetName}, error=${record.error}, runId=${runId}, duration=${Date.now() - record.spawnedAt}ms, resultPreview="${taskResult.result.slice(0, 120)}"`,
          );
          appendAnnounceEvent(this.sessionId, runId, "error", undefined, record.error);
          try { const { getTaskQueue } = require("@/core/task-center/task-queue"); getTaskQueue().fail(`spawn-${runId}`, record.error || "invalid result"); } catch { /* noop */ }

          if (expectsCompletionMessage) {
            this.announceWithRetry(resolvedTargetActorId, spawnerActorId, `[Task failed: ${label}]\n\nError: ${record.error}`, runId);
          }
          this.cancelPendingInteractionsForActor(resolvedTargetActorId);
        } else {
          record.status = "completed";
          record.completedAt = Date.now();
          record.result = taskResult.result;
          this.finalizeSpawnedTaskHistoryWindow(record, target);
          log(`✅ spawnTask COMPLETED: ${targetName} → announce to ${spawnerName}, runId=${runId}, duration=${Date.now() - record.spawnedAt}ms`);
          appendAnnounceEvent(this.sessionId, runId, "completed", taskResult.result);
          try { const { getTaskQueue } = require("@/core/task-center/task-queue"); getTaskQueue().complete(`spawn-${runId}`, taskResult.result?.slice(0, 500)); } catch { /* noop */ }

          if (expectsCompletionMessage) {
            const shortResult = taskResult.result && taskResult.result.length > 200
              ? `${taskResult.result.slice(0, 200)}...\n\n（💡 完整详细报告已在后台送达协调者）`
              : taskResult.result;
            this.announceWithRetry(resolvedTargetActorId, spawnerActorId, `[Task completed: ${label}]\n\n${shortResult}`, runId);
          }
        }
      } else {
        record.status = taskResult.status === "aborted" ? "aborted" : "error";
        record.completedAt = Date.now();
        record.error = taskResult.error ?? "unknown error";
        this.finalizeSpawnedTaskHistoryWindow(record, target);
        log(`❌ spawnTask FAILED: ${targetName}, status=${taskResult.status}, error=${record.error}, runId=${runId}, duration=${Date.now() - record.spawnedAt}ms`);
        appendAnnounceEvent(this.sessionId, runId, record.status, undefined, record.error);
        try { const { getTaskQueue } = require("@/core/task-center/task-queue"); getTaskQueue().fail(`spawn-${runId}`, record.error || "unknown"); } catch { /* noop */ }

        if (expectsCompletionMessage) {
          this.announceWithRetry(resolvedTargetActorId, spawnerActorId, `[Task failed: ${label}]\n\nError: ${record.error}`, runId);
        }
        this.cancelPendingInteractionsForActor(resolvedTargetActorId);
      }

      this.emitEvent({ type: "task_completed", actorId: resolvedTargetActorId, timestamp: Date.now(), detail: { runId } });

      // Emit structured spawned_task lifecycle event
      const elapsed = Date.now() - record.spawnedAt;
      if (record.status === "completed") {
        this.emitEvent({
          type: "spawned_task_completed",
          actorId: resolvedTargetActorId,
          timestamp: Date.now(),
          detail: {
            ...taskEventBase,
            status: "completed" as const,
            elapsed,
            result: record.result?.slice(0, 500),
          } satisfies SpawnedTaskEventDetail,
        });
      } else {
        this.emitEvent({
          type: "spawned_task_failed",
          actorId: resolvedTargetActorId,
          timestamp: Date.now(),
          detail: {
            ...taskEventBase,
            status: record.status,
            elapsed,
            error: record.error,
          } satisfies SpawnedTaskEventDetail,
        });
      }

      // 触发 onSpawnTaskEnd 钩子
      void this.runHooks<SpawnTaskEndHookContext>("onSpawnTaskEnd", {
        system: this,
        actorId: resolvedTargetActorId,
        actorName: targetName,
        timestamp: Date.now(),
        spawnerId: spawnerActorId,
        targetId: resolvedTargetActorId,
        task,
        runId,
        status: record.status,
        result: record.result,
        error: record.error,
      });

      // 根据 cleanup 策略决定是否删除子 agent（仅非持久 Agent 可删除）
      if (cleanup === "delete" && mode !== "session" && !target.persistent) {
        log(`spawnTask cleanup: deleting target ${targetName} (runId=${runId})`);
        this.kill(resolvedTargetActorId);
      } else if (cleanup === "delete" && mode !== "session" && target.persistent) {
        log(`spawnTask cleanup skipped: ${targetName} is persistent (runId=${runId})`);
      }

      this.tryFinalizeExecutionContract();
      this.scheduleExecutionContractProgressCheck();
    });

    return record;
  }

  /** 获取某个 Agent 派发的所有 spawned tasks */
  getSpawnedTasks(actorId: string): SpawnedTaskRecord[] {
    return [...this.spawnedTasks.values()].filter((r) => r.spawnerActorId === actorId);
  }

  /** 清理已完成的任务记录（可选调用） */
  pruneSpawnedTasks(): number {
    const before = this.spawnedTasks.size;
    for (const [runId, record] of this.spawnedTasks) {
      if (record.status !== "running") {
        this.spawnedTasks.delete(runId);
      }
    }
    const removed = before - this.spawnedTasks.size;
    if (removed > 0) {
      log(`pruneSpawnedTasks: removed ${removed} completed tasks`);
    }
    return removed;
  }

  /** 获取某个 Agent 的 running 状态 spawned tasks */
  getActiveSpawnedTasks(actorId: string): SpawnedTaskRecord[] {
    return [...this.spawnedTasks.values()].filter((r) => r.spawnerActorId === actorId && r.status === "running");
  }

  /** 获取所有 spawned tasks 快照 */
  getSpawnedTasksSnapshot(): SpawnedTaskRecord[] {
    return [...this.spawnedTasks.values()];
  }

  getSpawnedTask(runId: string): SpawnedTaskRecord | undefined {
    return this.spawnedTasks.get(runId);
  }

  getFocusedSpawnedSessionRunId(): string | null {
    return this.focusedSpawnedSessionRunId;
  }

  focusSpawnedSession(runId: string | null): void {
    if (runId === null) {
      this.focusedSpawnedSessionRunId = null;
      return;
    }
    const record = this.getOpenSpawnedSessionByRunId(runId);
    if (!record) {
      throw new Error(`Spawned session ${runId} 不存在或已关闭`);
    }
    this.focusedSpawnedSessionRunId = runId;
    record.lastActiveAt = Date.now();
  }

  closeSpawnedSession(runId: string): void {
    const record = this.getOpenSpawnedSessionByRunId(runId);
    if (!record) return;
    this.closeSpawnedSessionRecord(record);
  }

  abortSpawnedTask(runId: string, opts?: { error?: string }): void {
    const record = this.spawnedTasks.get(runId);
    if (!record) return;
    if (record.status !== "running" && !(record.mode === "session" && record.sessionOpen)) return;

    this.abortSpawnedTaskRecord(record, {
      error: opts?.error ?? "子会话已由用户终止",
    });
    this.tryFinalizeExecutionContract();
    this.scheduleExecutionContractProgressCheck();
  }

  continueSpawnedSession(
    runId: string,
    fromActorId: string,
    content: string,
    opts?: {
      label?: string;
      context?: string;
      attachments?: string[];
      images?: string[];
    },
  ): SpawnedTaskRecord | { error: string } {
    const record = this.getOpenSpawnedSessionByRunId(runId);
    if (!record) {
      return { error: `Spawned session ${runId} 不存在或已关闭` };
    }
    const spawner = this.actors.get(fromActorId);
    const target = this.actors.get(record.targetActorId);
    if (!spawner || !target) {
      return { error: `子会话参与方不存在（runId=${runId}）` };
    }
    if (record.spawnerActorId !== fromActorId) {
      return { error: `只有会话发起者 ${this.actors.get(record.spawnerActorId)?.role.name ?? record.spawnerActorId} 可以继续这个子会话` };
    }

    const chunks = [content];
    if (opts?.context) chunks.push(`补充上下文：${opts.context}`);
    if (opts?.attachments?.length) {
      chunks.push(`附件文件路径：\n${opts.attachments.map((filePath) => `- ${filePath}`).join("\n")}`);
    }
    const sessionMessage = chunks.filter(Boolean).join("\n\n");

    record.lastActiveAt = Date.now();
    record.status = "running";
    record.completedAt = undefined;
    record.error = undefined;
    if (opts?.label) {
      record.label = opts.label;
    }
    if (opts?.images?.length) {
      record.images = [...new Set([...(record.images ?? []), ...opts.images])];
    }

    this.send(fromActorId, record.targetActorId, sessionMessage, {
      images: opts?.images,
      bypassPlanCheck: true,
      relatedRunId: record.runId,
    });

    return record;
  }

  sendUserMessageToSpawnedSession(
    runId: string,
    content: string,
    opts?: { _briefContent?: string; images?: string[] },
  ): DialogMessage {
    const record = this.getOpenSpawnedSessionByRunId(runId);
    if (!record) {
      throw new Error(`Spawned session ${runId} 不存在或已关闭`);
    }
    record.lastActiveAt = Date.now();
    record.status = "running";
    record.completedAt = undefined;
    record.error = undefined;
    this.focusedSpawnedSessionRunId = runId;
    return this.send("user", record.targetActorId, content, {
      _briefContent: opts?._briefContent,
      images: opts?.images,
      bypassPlanCheck: true,
      relatedRunId: runId,
    });
  }

  recordArtifact(record: Omit<DialogArtifactRecord, "id" | "fileName" | "directory"> & { id?: string }): DialogArtifactRecord {
    const pathKey = this.getArtifactKey(record.path);
    const existing = this.artifactRecords.get(pathKey);
    const normalized: DialogArtifactRecord = {
      id: record.id ?? existing?.id ?? `artifact-${generateId()}`,
      actorId: record.actorId,
      path: pathKey,
      fileName: basename(pathKey),
      directory: dirname(pathKey),
      source: record.source,
      toolName: record.toolName,
      summary: record.summary,
      preview: record.preview ?? existing?.preview,
      fullContent: record.fullContent ?? existing?.fullContent,
      language: record.language ?? existing?.language ?? inferLanguageFromPath(pathKey),
      timestamp: record.timestamp,
      relatedRunId: record.relatedRunId ?? existing?.relatedRunId,
    };
    this.artifactRecords.set(pathKey, normalized);
    return normalized;
  }

  stageResultMedia(
    actorId: string,
    media: Pick<DialogMessage, "images" | "attachments">,
  ): Pick<DialogMessage, "images" | "attachments"> {
    const existing = this.stagedResultMedia.get(actorId);
    const nextImages = [...new Set([
      ...(existing?.images ?? []),
      ...(media.images ?? []),
    ].map((value) => normalizePath(value)).filter(Boolean))];
    const nextAttachments = new Map<string, { path: string; fileName?: string }>();
    for (const item of [...(existing?.attachments ?? []), ...(media.attachments ?? [])]) {
      const normalizedPath = normalizePath(item.path);
      if (!normalizedPath) continue;
      nextAttachments.set(normalizedPath, {
        path: normalizedPath,
        ...(item.fileName ? { fileName: item.fileName } : {}),
      });
    }

    const staged = {
      ...(nextImages.length ? { images: nextImages } : {}),
      ...(nextAttachments.size ? { attachments: [...nextAttachments.values()] } : {}),
    } satisfies Pick<DialogMessage, "images" | "attachments">;

    if (!staged.images?.length && !staged.attachments?.length) {
      this.stagedResultMedia.delete(actorId);
      return {};
    }

    this.stagedResultMedia.set(actorId, staged);
    return {
      ...(staged.images?.length ? { images: [...staged.images] } : {}),
      ...(staged.attachments?.length ? { attachments: staged.attachments.map((item) => ({ ...item })) } : {}),
    };
  }

  getStagedResultMediaSnapshot(
    actorId: string,
  ): Pick<DialogMessage, "images" | "attachments"> {
    const staged = this.stagedResultMedia.get(actorId);
    return {
      ...(staged?.images?.length ? { images: [...staged.images] } : {}),
      ...(staged?.attachments?.length ? { attachments: staged.attachments.map((item) => ({ ...item })) } : {}),
    };
  }

  private consumeStagedResultMedia(
    actorId: string,
  ): Pick<DialogMessage, "images" | "attachments"> {
    const staged = this.getStagedResultMediaSnapshot(actorId);
    this.stagedResultMedia.delete(actorId);
    return staged;
  }

  getArtifactRecordsSnapshot(): DialogArtifactRecord[] {
    return [...this.artifactRecords.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  restoreArtifactRecords(records: readonly DialogArtifactRecord[]): void {
    this.artifactRecords.clear();
    for (const record of records) {
      this.artifactRecords.set(this.getArtifactKey(record.path), { ...record });
    }
  }

  registerSessionUploads(
    records: readonly SessionUploadRecord[],
    opts?: {
      actorId?: string;
      relatedRunId?: string;
    },
  ): void {
    for (const record of records) {
      const key = record.path ? this.getArtifactKey(record.path) : `${record.type}:${record.name}`;
      this.sessionUploads.set(key, { ...record });
      if (!record.path) continue;

      const existingArtifact = this.artifactRecords.get(this.getArtifactKey(record.path));
      const summary = record.type === "image"
        ? `用户上传了图片：${record.name}`
        : `用户上传了文件：${record.name}`;
      this.recordArtifact({
        actorId: opts?.actorId ?? existingArtifact?.actorId ?? "user",
        path: record.path,
        source: "upload",
        summary,
        preview: record.preview ?? record.excerpt ?? existingArtifact?.preview,
        fullContent: record.excerpt ?? existingArtifact?.fullContent,
        language: record.originalExt
          ? record.originalExt.replace(/^\./, "").toLowerCase()
          : existingArtifact?.language,
        timestamp: record.addedAt,
        relatedRunId: opts?.relatedRunId ?? existingArtifact?.relatedRunId,
      });
    }
  }

  getSessionUploadsSnapshot(): SessionUploadRecord[] {
    return [...this.sessionUploads.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  restoreSessionUploads(records: readonly SessionUploadRecord[]): void {
    this.sessionUploads.clear();
    for (const record of records) {
      const key = record.path ? this.getArtifactKey(record.path) : `${record.type}:${record.name}`;
      this.sessionUploads.set(key, { ...record });
    }
  }

  private collectShareableResultMedia(
    actorId: string,
    relatedRunId?: string,
  ): Pick<DialogMessage, "images" | "attachments"> {
    const actorWorkspace = this.actors.get(actorId)?.workspace;
    const lastResultTimestamp = [...this.dialogHistory]
      .slice()
      .reverse()
      .find((message) =>
        message.kind === "agent_result"
        && message.from === actorId
        && message.relatedRunId === relatedRunId,
      )?.timestamp;

    const candidateArtifacts = this.getArtifactRecordsSnapshot()
      .filter((artifact) => {
        if (artifact.actorId !== actorId) return false;
        if (!RESULT_SHAREABLE_ARTIFACT_SOURCES.has(artifact.source)) return false;
        if (relatedRunId ? artifact.relatedRunId !== relatedRunId : Boolean(artifact.relatedRunId)) return false;
        if (typeof lastResultTimestamp === "number" && artifact.timestamp <= lastResultTimestamp) return false;
        return isLikelyUserShareableArtifactPath(artifact.path, actorWorkspace);
      })
      .sort((left, right) => left.timestamp - right.timestamp);

    const seenPaths = new Set<string>();
    const images: string[] = [];
    const attachments: Array<{ path: string; fileName?: string }> = [];

    for (const artifact of candidateArtifacts) {
      const normalizedPath = normalizePath(artifact.path);
      if (!normalizedPath || seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);

      if (isLikelyVisualAttachmentPath(normalizedPath)) {
        images.push(normalizedPath);
      } else {
        attachments.push({
          path: normalizedPath,
          fileName: artifact.fileName || basename(normalizedPath),
        });
      }
    }

    return {
      ...(images.length ? { images } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
  }

  /**
   * 获取某个 Agent 的完整后代任务树（含孙任务、曾孙任务...）。
   * 返回扁平列表，每个 record 带 depth 字段表示层级。
   */
  getDescendantTasks(actorId: string): Array<SpawnedTaskRecord & { depth: number }> {
    const result: Array<SpawnedTaskRecord & { depth: number }> = [];
    const visited = new Set<string>();
    const taskByParentRunId = new Map<string, SpawnedTaskRecord[]>();

    for (const record of this.spawnedTasks.values()) {
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
        const descendants = taskByParentRunId.get(child.runId) ?? [];
        collect(descendants, depth + 1);
      }
    };

    const roots = this.getSpawnedTasks(actorId).sort((a, b) => a.spawnedAt - b.spawnedAt);
    collect(roots, 1);
    return result;
  }

  /** 计算 spawn 链深度（通过 spawnedTasks 回溯 spawner 链） */
  private getSpawnDepth(actorId: string): number {
    let depth = 0;
    let currentRecord = this.getOwningSpawnedTaskForActor(actorId);
    const visited = new Set<string>();
    while (true) {
      if (!currentRecord) break;
      if (visited.has(currentRecord.runId)) break;
      visited.add(currentRecord.runId);
      depth++;
      currentRecord = currentRecord.parentRunId
        ? this.spawnedTasks.get(currentRecord.parentRunId)
        : undefined;
    }
    return depth;
  }

  /**
   * Steer：向运行中的 Agent 注入高优先级指令，Agent 在下一次 inboxDrain 时读取。
   * 对标 OpenClaw 的 steer 能力。
   */
  steer(actorId: string, directive: string, from = "user"): DialogMessage | { error: string } {
    const actor = this.actors.get(actorId);
    if (!actor) return { error: `Agent ${actorId} not found` };
    const actorName = actor.role.name;
    log(`steer: → ${actorName}, directive="${directive.slice(0, 60)}"`);

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to: actorId,
      content: `[STEER 指令] ${directive}`,
      timestamp: Date.now(),
      priority: "urgent",
      kind: "system_notice",
    };

    actor.receive(msg);
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    return msg;
  }

  /** 级联 abort 某个 Agent 的所有 running / open spawned tasks */
  private cascadeAbortSpawns(actorId: string, error = "父任务被终止"): void {
    const activeSpawns = [...this.spawnedTasks.values()].filter((record) =>
      record.spawnerActorId === actorId
      && (record.status === "running" || (record.mode === "session" && record.sessionOpen)),
    );
    for (const record of activeSpawns) {
      this.abortSpawnedTaskRecord(record, {
        error,
      });
      log(`cascadeAbort: ${record.targetActorId} (spawned by ${actorId}), runId=${record.runId}`);
    }
  }

  private abortSpawnedTaskRecord(
    record: SpawnedTaskRecord,
    options: {
      error: string;
    },
  ): void {
    if (record.timeoutId) {
      clearTimeout(record.timeoutId);
      record.timeoutId = undefined;
    }
    const abortedAt = Date.now();
    const targetActor = this.actors.get(record.targetActorId);
    record.status = "aborted";
    record.completedAt = abortedAt;
    record.error = options.error;
    record.lastActiveAt = abortedAt;

    if (targetActor) {
      targetActor.abort();
      this.finalizeSpawnedTaskHistoryWindow(record, targetActor);
      this.cascadeAbortSpawns(record.targetActorId, options.error);
    } else {
      this.finalizeSpawnedTaskHistoryWindow(record);
    }

    this.cancelPendingInteractionsForActor(record.targetActorId);
    if (record.mode === "session") {
      this.closeSpawnedSessionRecord(record, abortedAt);
    }

    this.emitEvent({
      type: "spawned_task_failed",
      actorId: record.targetActorId,
      timestamp: abortedAt,
      detail: {
        runId: record.runId,
        spawnerActorId: record.spawnerActorId,
        targetActorId: record.targetActorId,
        targetName: targetActor?.role.name ?? record.targetActorId,
        spawnerName: this.actors.get(record.spawnerActorId)?.role.name ?? record.spawnerActorId,
        task: record.task,
        status: "aborted" as const,
        error: options.error,
      } satisfies SpawnedTaskEventDetail,
    });
  }

  /**
   * Announce Flow 重试：向 spawner 发送结果，失败时按 5s/10s/20s 重试。
   * 对标 OpenClaw 的 runAnnounceDeliveryWithRetry。
   */
  private announceWithRetry(
    fromActorId: string,
    toActorId: string,
    content: string,
    runId: string,
    attempt = 0,
  ): void {
    const spawnedAt = this.spawnedTasks.get(runId)?.spawnedAt ?? Date.now();
    if (Date.now() - spawnedAt > ANNOUNCE_HARD_EXPIRY_MS) {
      logWarn(`announce HARD EXPIRY: runId=${runId}, skipping delivery after 30min`);
      this.emitEvent({
        type: "spawned_task_failed",
        actorId: fromActorId,
        timestamp: Date.now(),
        detail: { runId, error: "announce delivery expired after hard timeout" } as SpawnedTaskEventDetail,
      });
      return;
    }

    try {
      const spawner = this.actors.get(toActorId);
      if (!spawner) {
        if (attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
          const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
          log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: spawner gone, retrying in ${delay / 1000}s, runId=${runId}`);
          setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
          return;
        }
        logWarn(`announce FAILED: spawner ${toActorId} not found after ${attempt} retries, runId=${runId}`);
        this.emitEvent({
          type: "spawned_task_failed",
          actorId: fromActorId,
          timestamp: Date.now(),
          detail: { runId, error: "announce delivery failed: spawner not found after retries" } as SpawnedTaskEventDetail,
        });
        return;
      }
      this.send(fromActorId, toActorId, content);
    } catch (err) {
      const errSummary = summarizeError(err);

      if (isTransientAnnounceError(err) && attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
        const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
        log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: transient error="${errSummary}", retrying in ${delay / 1000}s, runId=${runId}`);
        setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
      } else if (!isTransientAnnounceError(err) && attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
        const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
        log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: unknown error="${errSummary}", retrying in ${delay / 1000}s, runId=${runId}`);
        setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
      } else {
        logWarn(`announce FAILED after ${attempt} retries (last error: "${errSummary}"), runId=${runId}`, err);
        this.emitEvent({
          type: "spawned_task_failed",
          actorId: fromActorId,
          timestamp: Date.now(),
          detail: { runId, error: `announce delivery failed after retries: ${errSummary}` } as SpawnedTaskEventDetail,
        });
      }
    }
  }

  // ── Result / Question Publishing ──

  /**
   * 将 Actor 的任务结果发布到对话历史。
   * 默认不投递到其他 Agent inbox；仅在显式开启 fanout 时才会分发。
   */
  publishResult(
    actorId: string,
    content: string,
    opts?: {
      fanoutToPeers?: boolean;
      suppressLowSignal?: boolean;
    },
  ): DialogMessage | null {
    const trimmed = content.trim();
    if (!trimmed) return null;
    const structuredReply = splitStructuredMediaReply(trimmed);
    const visibleContent = structuredReply.text.trim() || trimmed;

    const actor = this.actors.get(actorId);
    const actorName = actor?.role.name ?? actorId;
    const coordinatorId = this.getCoordinatorId();
    const fromNonCoordinator = coordinatorId ? actorId !== coordinatorId : false;
    const suppressLowSignal = opts?.suppressLowSignal ?? true;
    const relatedRunId = this.getOpenSpawnedSessionByTarget(actorId)?.runId;

    if (suppressLowSignal && fromNonCoordinator && isLowSignalCoordinationMessage(visibleContent)) {
      log(`publishResult: suppress low-signal message from ${actorName}`);
      return null;
    }

    const inferredResultMedia = this.collectShareableResultMedia(actorId, relatedRunId);
    const stagedResultMedia = this.consumeStagedResultMedia(actorId);
    const resultImages = [...new Set([
      ...(inferredResultMedia.images ?? []),
      ...(stagedResultMedia.images ?? []),
      ...(structuredReply.images ?? []),
    ])];
    const resultAttachments = new Map<string, { path: string; fileName?: string }>();
    for (const item of [
      ...(inferredResultMedia.attachments ?? []),
      ...(stagedResultMedia.attachments ?? []),
      ...(structuredReply.attachments ?? []),
    ]) {
      const normalizedPath = normalizePath(item.path);
      if (!normalizedPath) continue;
      resultAttachments.set(normalizedPath, {
        path: normalizedPath,
        ...(item.fileName ? { fileName: item.fileName } : {}),
      });
    }

    const msg: DialogMessage = {
      id: generateId(),
      from: actorId,
      to: undefined, // 广播模式
      content: visibleContent,
      timestamp: Date.now(),
      priority: "normal",
      kind: "agent_result",
      relatedRunId,
      ...this.buildDialogMessageRecallPatch(actorId),
      ...(resultImages.length ? { images: resultImages } : {}),
      ...(resultAttachments.size ? { attachments: [...resultAttachments.values()] } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);

    if (opts?.fanoutToPeers) {
      for (const other of this.actors.values()) {
        if (other.id === actorId) continue;
        log(`publishResult: delivering ${actorName}'s result to ${other.role.name}`);
        other.receive({
          id: msg.id,
          from: msg.from,
          content: msg.content,
          timestamp: msg.timestamp,
          priority: msg.priority,
          expectReply: msg.expectReply,
          replyTo: msg.replyTo,
          attachments: msg.attachments,
          images: msg.images,
        });
      }
    }

    return msg;
  }

  publishSystemNotice(
    content: string,
    opts?: {
      from?: string;
      relatedRunId?: string;
    },
  ): DialogMessage | null {
    const trimmed = content.trim();
    if (!trimmed) return null;

    const msg: DialogMessage = {
      id: generateId(),
      from: opts?.from?.trim() || "system",
      to: undefined,
      content: trimmed,
      timestamp: Date.now(),
      priority: "normal",
      kind: "system_notice",
      ...(opts?.relatedRunId ? { relatedRunId: opts.relatedRunId } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    return msg;
  }

  /**
   * Agent 在聊天流中向用户提问，并等待用户回复。
   * 用于替代 askUser 弹窗，让提问直接出现在对话流中。
   */
  askUserInChat(
    actorId: string,
    question: string,
    opts?: number | {
      timeoutMs?: number;
      interactionType?: PendingInteractionType;
      options?: string[];
      replyMode?: PendingInteractionReplyMode;
      approvalRequest?: ApprovalRequest;
    },
  ): Promise<PendingInteractionResult> {
    const actorName = this.actors.get(actorId)?.role.name ?? actorId;
    log(`askUserInChat: ${actorName} asks user, question="${question.slice(0, 60)}"`);
    const normalizedOpts = typeof opts === "number" ? { timeoutMs: opts } : (opts ?? {});
    const timeoutMs = normalizedOpts.timeoutMs ?? 300_000;
    const interactionType = normalizedOpts.interactionType ?? "question";
    const options = normalizedOpts.options;
    const replyMode = normalizedOpts.replyMode ?? "single";
    const approvalRequest = normalizedOpts.approvalRequest;
    const relatedRunId = this.getOpenSpawnedSessionByTarget(actorId)?.runId;
    if (approvalRequest?.targetPath) {
      this.recordArtifact({
        actorId,
        path: approvalRequest.targetPath,
        source: "approval",
        toolName: approvalRequest.toolName,
        summary: approvalRequest.summary ?? "待确认的文件写入",
        preview: approvalRequest.preview,
        fullContent: approvalRequest.fullContent,
        language: approvalRequest.previewLanguage,
        timestamp: Date.now(),
        relatedRunId,
      });
    }
    const msg: DialogMessage = {
      id: generateId(),
      from: actorId,
      to: "user",
      content: question,
      timestamp: Date.now(),
      priority: "normal",
      expectReply: true,
      kind: getInteractionRequestKind(interactionType),
      interactionType,
      interactionStatus: "pending",
      options,
      interactionId: generateId(),
      approvalRequest,
      relatedRunId,
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);

    return new Promise<PendingInteractionResult>((resolve) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pendingInteractions.get(msg.id);
        if (!pending) return;
        pending.status = "timed_out";
        this.pendingInteractions.delete(msg.id);
        this.updateDialogMessage(msg.id, { interactionStatus: "timed_out" });
        this.emitEvent(msg); // re-sync so UI clears the pending indicator
        resolve({
          interactionId: pending.id,
          interactionType: pending.type,
          status: "timed_out",
          content: "",
        });
      }, timeoutMs);

      this.pendingInteractions.set(msg.id, {
        id: msg.interactionId!,
        fromActorId: actorId,
        messageId: msg.id,
        question,
        type: interactionType,
        replyMode,
        status: "pending",
        createdAt: msg.timestamp,
        expiresAt: msg.timestamp + timeoutMs,
        options,
        approvalRequest,
        resolve,
        timeoutId,
      });

      // emit AFTER pendingReplies is populated so sync() sees it
      this.emitEvent(msg);
    });
  }

  /**
   * 用户回复某条 expectReply 消息。
   * 由 UI 调用，将回复路由到等待中的 pending reply。
   */
  replyToMessage(
    messageId: string,
    content: string,
    opts?: {
      _briefContent?: string;
      images?: string[];
    },
  ): DialogMessage {
    const pendingInteraction = this.pendingInteractions.get(messageId);
    const sourceMessage = this.dialogHistory.find((message) => message.id === messageId);
    const relatedRunId = sourceMessage?.relatedRunId
      ?? (pendingInteraction ? this.getOpenSpawnedSessionByTarget(pendingInteraction.fromActorId)?.runId : undefined);
    if (pendingInteraction) {
      const msg: DialogMessage = {
        id: generateId(),
        from: "user",
        to: pendingInteraction.fromActorId,
        content,
        timestamp: Date.now(),
        priority: "normal",
        replyTo: messageId,
        _briefContent: opts?._briefContent,
        kind: getInteractionResponseKind(pendingInteraction.type),
        interactionType: pendingInteraction.type,
        interactionId: pendingInteraction.id,
        interactionStatus: "answered",
        relatedRunId,
        ...(opts?.images?.length ? { images: opts.images } : {}),
      };
      this.dialogHistory.push(msg);
      appendDialogMessage(this.sessionId, msg);
      this.emitEvent(msg);

      pendingInteraction.status = "answered";
      if (pendingInteraction.timeoutId) clearTimeout(pendingInteraction.timeoutId);
      this.pendingInteractions.delete(messageId);
      this.updateDialogMessage(messageId, { interactionStatus: "answered" });
      pendingInteraction.resolve({
        interactionId: pendingInteraction.id,
        interactionType: pendingInteraction.type,
        status: "answered",
        content,
        message: msg,
      });
      return msg;
    }

    const pendingReply = this.pendingReplies.get(messageId);
    if (pendingReply) {
      const msg: DialogMessage = {
        id: generateId(),
        from: "user",
        to: pendingReply.fromActorId,
        content,
        timestamp: Date.now(),
        priority: "normal",
        replyTo: messageId,
        _briefContent: opts?._briefContent,
        kind: getInteractionResponseKind("question"),
        interactionType: "question",
        interactionStatus: "answered",
        relatedRunId,
        ...(opts?.images?.length ? { images: opts.images } : {}),
      };
      this.dialogHistory.push(msg);
      appendDialogMessage(this.sessionId, msg);
      this.emitEvent(msg);

      if (pendingReply.timeoutId) clearTimeout(pendingReply.timeoutId);
      this.pendingReplies.delete(messageId);
      pendingReply.resolve(msg);
      return msg;
    }

    const sourceInteractionType = sourceMessage?.interactionType
      ?? (sourceMessage?.kind === "approval_request"
        ? "approval"
        : sourceMessage?.kind === "clarification_request"
          ? "clarification"
          : sourceMessage?.expectReply
            ? "question"
            : undefined);
    const canResumePersistedInteraction = Boolean(
      sourceMessage
      && sourceMessage.from !== "user"
      && sourceMessage.expectReply
      && sourceMessage.interactionStatus === "pending"
      && sourceInteractionType
      && this.actors.has(sourceMessage.from),
    );

    if (canResumePersistedInteraction && sourceMessage && sourceInteractionType) {
      const msg: DialogMessage = {
        id: generateId(),
        from: "user",
        to: sourceMessage.from,
        content,
        timestamp: Date.now(),
        priority: "normal",
        replyTo: messageId,
        _briefContent: opts?._briefContent,
        kind: getInteractionResponseKind(sourceInteractionType),
        interactionType: sourceInteractionType,
        interactionId: sourceMessage.interactionId,
        interactionStatus: "answered",
        relatedRunId,
        ...(opts?.images?.length ? { images: opts.images } : {}),
      };
      this.dialogHistory.push(msg);
      appendDialogMessage(this.sessionId, msg);
      this.emitEvent(msg);
      this.updateDialogMessage(messageId, { interactionStatus: "answered" });
      return msg;
    }

    const fallbackActorId = sourceMessage?.from && sourceMessage.from !== "user" && this.actors.has(sourceMessage.from)
      ? sourceMessage.from
      : this.getCoordinator()?.id;

    if (fallbackActorId) {
      log(`replyToMessage: no pending interaction for ${messageId}, routing late reply to ${fallbackActorId} as a new user message`);
      return this.send("user", fallbackActorId, content, {
        _briefContent: opts?._briefContent,
        images: opts?.images,
        bypassPlanCheck: true,
        relatedRunId,
      });
    }

    const msg: DialogMessage = {
      id: generateId(),
      from: "user",
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      replyTo: messageId,
      _briefContent: opts?._briefContent,
      kind: "user_input",
      relatedRunId,
      ...(opts?.images?.length ? { images: opts.images } : {}),
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);
    return msg;
  }

  /** 获取所有等待用户回复的交互 */
  getPendingUserInteractions(): PendingInteraction[] {
    return [...this.pendingInteractions.values()]
      .filter((interaction) => interaction.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 获取待交互快照，避免上层直接持有内部引用 */
  getPendingInteractionsSnapshot(): PendingInteraction[] {
    return this.getPendingUserInteractions().map((interaction) => ({
      ...interaction,
      ...(interaction.options ? { options: [...interaction.options] } : {}),
      ...(interaction.approvalRequest
        ? {
            approvalRequest: {
              ...interaction.approvalRequest,
              ...(interaction.approvalRequest.details
                ? {
                    details: interaction.approvalRequest.details.map((detail) => ({ ...detail })),
                  }
                : {}),
              ...(interaction.approvalRequest.decisionOptions
                ? {
                    decisionOptions: interaction.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                  }
                : {}),
            },
          }
        : {}),
    }));
  }

  /** 取消某个 Actor 发起的所有待用户交互（用于任务 abort / actor stop） */
  cancelPendingInteractionsForActor(actorId: string): number {
    let cancelled = 0;

    for (const [messageId, pending] of [...this.pendingInteractions.entries()]) {
      if (pending.fromActorId !== actorId || pending.status !== "pending") continue;

      pending.status = "cancelled";
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pendingInteractions.delete(messageId);
      this.updateDialogMessage(messageId, { interactionStatus: "cancelled" });
      const updatedMessage = this.dialogHistory.find((message) => message.id === messageId);
      if (updatedMessage) {
        this.emitEvent(updatedMessage);
      }
      pending.resolve({
        interactionId: pending.id,
        interactionType: pending.type,
        status: "cancelled",
        content: "",
      });
      cancelled++;
    }

    return cancelled;
  }

  // ── Dialog History ──

  getDialogHistory(): readonly DialogMessage[] {
    return this.dialogHistory;
  }

  getDialogMessagesSnapshot(): DialogMessage[] {
    return this.dialogHistory.map((message) => ({
      ...message,
      ...(message.images ? { images: [...message.images] } : {}),
      ...(message.attachments ? { attachments: message.attachments.map((item) => ({ ...item })) } : {}),
      ...(message.options ? { options: [...message.options] } : {}),
      ...(message.appliedMemoryPreview ? { appliedMemoryPreview: [...message.appliedMemoryPreview] } : {}),
      ...(message.appliedTranscriptPreview ? { appliedTranscriptPreview: [...message.appliedTranscriptPreview] } : {}),
      ...(message.approvalRequest
        ? {
            approvalRequest: {
              ...message.approvalRequest,
              ...(message.approvalRequest.details
                ? {
                    details: message.approvalRequest.details.map((detail) => ({ ...detail })),
                  }
                : {}),
              ...(message.approvalRequest.decisionOptions
                ? {
                    decisionOptions: message.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                  }
                : {}),
            },
          }
        : {}),
    }));
  }

  getMessagesFrom(actorId: string): DialogMessage[] {
    return this.dialogHistory.filter((m) => m.from === actorId);
  }

  getMessagesBetween(a: string, b: string): DialogMessage[] {
    return this.dialogHistory.filter(
      (m) => (m.from === a && m.to === b) || (m.from === b && m.to === a),
    );
  }

  restoreDialogHistory(history: DialogMessage[]): void {
    this.dialogHistory = [...history];
    log("Restored", history.length, "dialog messages from persisted session");
  }

  /** 恢复子任务记录（用于 session 恢复后 UI 显示） */
  restoreSpawnedTasks(records: Array<Omit<SpawnedTaskRecord, "timeoutId">>): void {
    for (const record of records) {
      this.spawnedTasks.set(record.runId, {
        dispatchSource: "manual",
        ...record,
      });
    }
    log("Restored", records.length, "spawned task records");
  }

  /** 恢复指定 Actor 的会话记忆 */
  restoreActorSessionHistory(actorId: string, history: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>): void {
    const actor = this.actors.get(actorId);
    if (actor) {
      actor.loadSessionHistory(history);
      log(`Restored session history for actor ${actor.role.name}:`, history.length, "entries");
    }
  }

  clearHistory(): void {
    this.dialogHistory = [];
    this.dialogRoomCompaction = null;
  }

  /**
   * 重置 session：归档旧 transcript，清空对话历史，保留 Actor 配置。
   * 对标 OpenClaw 的 sessions.reset。
   */
  resetSession(summary?: string): string {
    const oldSessionId = this.sessionId;
    archiveSession(oldSessionId, summary);
    this.dialogHistory = [];
    (this as any).sessionId = generateId();
    this.artifactRecords.clear();
    this.sessionUploads.clear();
    this.focusedSpawnedSessionRunId = null;
    this.dialogRoomCompaction = null;

    // 清空每个 Agent 的会话记忆
    for (const actor of this.actors.values()) {
      actor.clearSessionHistory();
    }

    // 清理挂起的 pendingReplies（resolve 掉防 Promise 泄漏）
    for (const [id, pending] of this.pendingReplies) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pendingReplies.delete(id);
      pending.resolve({ id, from: "system", content: "", timestamp: Date.now(), priority: "normal" as const });
    }

    for (const [messageId, pending] of this.pendingInteractions) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pendingInteractions.delete(messageId);
      pending.resolve({
        interactionId: pending.id,
        interactionType: pending.type,
        status: "cancelled",
        content: "",
      });
    }

    // 清空 spawnedTasks
    for (const record of this.spawnedTasks.values()) {
      if (record.timeoutId) clearTimeout(record.timeoutId);
      this.closeSpawnedSessionRecord(record);
    }
    this.spawnedTasks.clear();
    this.activeExecutionContract = null;
    this.legacyDialogExecutionPlanRuntimeState = null;

    // 清空 transcript 内存缓存
    clearSessionCache();

    // 清理中间件状态
    clearSessionApprovals();
    clearAllTodos();
    resetTitleGeneration(oldSessionId);
    clearTelemetry();

    log(`resetSession: archived ${oldSessionId}, new session ${this.sessionId}`);
    this.syncTranscriptActors();
    this.emitEvent({
      type: "status_change",
      actorId: "system",
      timestamp: Date.now(),
      detail: { action: "session_reset", oldSessionId, newSessionId: this.sessionId },
    });
    return this.sessionId;
  }

  /**
   * 删除 session 并归档，对标 OpenClaw 的 sessions.delete。
   */
  deleteSession(sessionId?: string): void {
    const target = sessionId ?? this.sessionId;
    deleteTranscriptSession(target);
    if (target === this.sessionId) {
      this.dialogHistory = [];
    }
    log(`deleteSession: ${target}`);
  }

  /** 获取所有 Agent 的能力摘要（用于 UI 展示） */
  getCapabilitiesSummary(): Array<{ id: string; name: string; capabilities: AgentCapabilities | undefined }> {
    return this.getAll().map((a) => ({
      id: a.id,
      name: a.role.name,
      capabilities: a.capabilities,
    }));
  }

  /** 根据能力标签查找 Agent */
  findByCapability(capability: string): AgentActor[] {
    return this.getAll().filter((a) =>
      a.capabilities?.tags?.some((c: string) => c === capability || c.includes(capability) || capability.includes(c))
    );
  }

  /** 智能路由：根据任务内容自动选择最合适的 Agent（含负载感知） */
  routeTask(taskDescription: string, preferredCapabilities?: string[]): { agentId: string; reason: string }[] {
    const agents = this.getAll();
    if (agents.length === 0) return [];
    if (agents.length === 1) {
      return [{ agentId: agents[0].id, reason: "唯一可用 Agent" }];
    }

    const KEYWORD_MAP: Record<string, string[]> = {
      review: ["code_review", "security"], 审查: ["code_review", "security"],
      安全: ["security"], 漏洞: ["security", "debugging"],
      bug: ["debugging"], 调试: ["debugging"], 错误: ["debugging"],
      性能: ["performance"], 优化: ["performance"], 慢: ["performance"],
      写代码: ["code_write"], 编写: ["code_write"], 实现: ["code_write"], 开发: ["code_write"],
      分析: ["code_analysis"], 架构: ["architecture"], 设计: ["architecture"],
      重构: ["code_analysis", "code_write"],
      测试: ["testing"], 单元测试: ["testing"],
      部署: ["devops"], devops: ["devops"],
      文档: ["documentation"],
      调研: ["research"], 搜索: ["research"], 研究: ["research"],
      头脑风暴: ["creative"], 创意: ["creative"],
      数据: ["data_analysis"], 整合: ["synthesis"], 总结: ["synthesis"],
      coordinator: ["coordinator"], 协调: ["coordinator"], 分解任务: ["coordinator"],
    };

    const CAPABILITY_LABELS: Record<string, string> = {
      coordinator: "协调", code_review: "审查", code_write: "编写", code_analysis: "分析",
      security: "安全", performance: "性能", architecture: "架构", debugging: "调试",
      research: "调研", documentation: "文档", testing: "测试", devops: "DevOps",
      data_analysis: "数据", creative: "创意", synthesis: "整合",
    };

    const taskLower = taskDescription.toLowerCase();
    const matchedCaps = new Set<string>();
    for (const [kw, caps] of Object.entries(KEYWORD_MAP)) {
      if (taskLower.includes(kw.toLowerCase())) caps.forEach((c) => matchedCaps.add(c));
    }

    // 将 preferredCapabilities 也加入匹配集合
    if (preferredCapabilities?.length) {
      for (const cap of preferredCapabilities) {
        matchedCaps.add(cap);
      }
    }

    // Tokenize task for expertise matching
    const taskTokens = taskLower.split(/[\s,.:;!?，。：；！？\n]+/).filter((t) => t.length > 1);

    const coordinatorId = this.getCoordinatorId();

    const scored = agents.map((agent, idx) => {
      let score = 0;
      const agentCaps = agent.capabilities?.tags || [];
      const expertise = agent.capabilities?.expertise || [];
      const matchedLabels: string[] = [];
      const scoreBreakdown: string[] = [];

      // Capability match: +10 per matched capability
      for (const cap of matchedCaps) {
        if (agentCaps.includes(cap as any)) {
          score += 10;
          matchedLabels.push(CAPABILITY_LABELS[cap] ?? cap);
        }
      }
      if (matchedLabels.length) {
        scoreBreakdown.push(`能力匹配+${matchedLabels.length * 10}`);
      }

      // preferredCapabilities bonus: extra +5 for explicitly preferred
      if (preferredCapabilities?.length) {
        for (const pref of preferredCapabilities) {
          if (agentCaps.includes(pref as any)) {
            score += 5;
            scoreBreakdown.push(`偏好能力${CAPABILITY_LABELS[pref] ?? pref}+5`);
          }
        }
      }

      // Expertise keyword overlap: +5 per match
      let expertiseMatches = 0;
      for (const exp of expertise) {
        if (taskTokens.some((t) => t.includes(exp.toLowerCase()) || exp.toLowerCase().includes(t))) {
          score += 5;
          expertiseMatches++;
        }
      }
      if (expertiseMatches) {
        scoreBreakdown.push(`专长匹配+${expertiseMatches * 5}`);
      }

      // No capability match: prefer coordinator / synthesis
      if (matchedCaps.size === 0) {
        if (agentCaps.includes("coordinator")) {
          score += 8;
          scoreBreakdown.push("无明确能力匹配→协调者+8");
        } else if (agentCaps.includes("synthesis")) {
          score += 4;
          scoreBreakdown.push("无明确能力匹配→整合者+4");
        }
      }

      // Coordinator context affinity: if session has a coordinator,
      // prefer routing through coordinator for complex/ambiguous tasks
      if (coordinatorId === agent.id) {
        score += 3;
        scoreBreakdown.push("协调者上下文亲和+3");
      }

      // Load balancing: idle agents get bonus, running agents penalized
      if (agent.status === "idle") {
        score += 3;
        scoreBreakdown.push("空闲+3");
      } else if (agent.status === "running") {
        score -= 5;
        scoreBreakdown.push("忙碌-5");
      }

      // Inbox depth penalty: penalize agents with queued work
      if (agent.pendingInboxCount > 0) {
        const penalty = Math.min(agent.pendingInboxCount * 2, 6);
        score -= penalty;
        scoreBreakdown.push(`队列深度${agent.pendingInboxCount}→-${penalty}`);
      }

      // Tiebreaker: stable ordering by spawn position (no randomness)
      score += (agents.length - idx) * 0.01;

      const reason = matchedLabels.length > 0
        ? `擅长 ${matchedLabels.join("、")} [${scoreBreakdown.join(", ")}]`
        : scoreBreakdown.length > 0
          ? `${scoreBreakdown.join(", ")}`
          : agent.status === "idle" ? "空闲可用" : "默认选择";

      return { agentId: agent.id, reason, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map(({ agentId, reason }) => ({ agentId, reason }));
  }

  // ── Events ──

  onEvent(handler: SystemEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  emitEvent(event: ActorEvent | DialogMessage): void {
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch { /* non-critical */ }
    }
  }

  // ── Snapshot ──

  snapshot() {
    return {
      actors: this.getAll().map((a) => ({
        id: a.id,
        role: a.role,
        modelOverride: a.modelOverride,
        status: a.status,
        pendingInbox: a.pendingInboxCount,
        currentTask: a.currentTask,
      })),
      coordinatorActorId: this.getCoordinatorId(),
      executionContract: this.getActiveExecutionContract(),
      dialogHistory: [...this.dialogHistory],
      pendingReplies: this.pendingReplies.size + this.pendingInteractions.size,
      spawnedTasks: [...this.spawnedTasks.values()].map((r) => ({
        runId: r.runId,
        spawner: r.spawnerActorId,
        target: r.targetActorId,
        contractId: r.contractId,
        plannedDelegationId: r.plannedDelegationId,
        dispatchSource: r.dispatchSource,
        task: r.task,
        label: r.label,
        status: r.status,
        mode: r.mode,
        cleanup: r.cleanup,
        expectsCompletionMessage: r.expectsCompletionMessage,
      })),
    };
  }

  /** 获取 spawnedTasks Map 引用（用于持久化） */
  getSpawnedTasksMap(): Map<string, SpawnedTaskRecord> {
    return this.spawnedTasks;
  }

  // ── Hook System ──

  /**
   * 注册普通 Hook（无返回值）
   */
  registerHook<T extends HookContext>(type: VoidHookType, handler: HookHandler<T>): () => void {
    const handlers = this.hooks.get(type) ?? [];
    handlers.push(handler);
    this.hooks.set(type, handlers);
    return () => {
      const h = this.hooks.get(type);
      if (h) this.hooks.set(type, h.filter((fn) => fn !== handler));
    };
  }

  /**
   * 注册修改型 Hook（可以拦截和修改参数）
   */
  registerModifyHook<T extends HookContext>(type: ModifyHookType, handler: ModifyHookHandler<T>): () => void {
    const handlers = this.modifyHooks.get(type) ?? [];
    handlers.push(handler);
    this.modifyHooks.set(type, handlers);
    return () => {
      const h = this.modifyHooks.get(type);
      if (h) this.modifyHooks.set(type, h.filter((fn) => fn !== handler));
    };
  }

  /**
   * 运行普通 Hook
   */
  private async runHooks<T extends HookContext>(type: VoidHookType, ctx: T): Promise<void> {
    const handlers = this.hooks.get(type);
    if (!handlers?.length) return;
    for (const handler of handlers) {
      try { await handler(ctx); } catch (e) { logWarn(`hook ${type} error:`, e); }
    }
  }

  /**
   * 运行修改型 Hook（链式调用，返回最终修改后的上下文）
   * 每个 handler 都可以修改上下文，下一个 handler 看到的是修改后的值
   */
  runModifyHooks<T extends HookContext>(
    type: ModifyHookType,
    ctx: T,
  ): { modified: T; stopped: boolean; error?: string } {
    const handlers = this.modifyHooks.get(type);
    if (!handlers?.length) return { modified: ctx, stopped: false };

    let current = ctx;
    for (const handler of handlers) {
      try {
        const result = handler(current);
        if (result.action === "stop") {
          return { modified: current, stopped: true, error: result.error };
        }
        if (result.action === "modify" && result.modified) {
          current = result.modified;
        }
        // "continue" 不做修改，继续下一个 handler
      } catch (e) {
        logWarn(`modify hook ${type} error:`, e);
      }
    }
    return { modified: current, stopped: false };
  }

  private syncTranscriptActors(): void {
    updateTranscriptActors(
      this.sessionId,
      this.getAll().map((a) => ({ id: a.id, name: a.role.name, model: a.modelOverride })),
    );
  }

  private buildDialogMessageRecallPatch(actorId: string): Pick<
    DialogMessage,
    | "memoryRecallAttempted"
    | "appliedMemoryPreview"
    | "transcriptRecallAttempted"
    | "transcriptRecallHitCount"
    | "appliedTranscriptPreview"
  > {
    const actor = this.actors.get(actorId);
    if (!actor) {
      return {};
    }
    const memoryPreview = collectDialogMessagePreview(actor.lastMemoryRecallPreview);
    const transcriptPreview = collectDialogMessagePreview(actor.lastTranscriptRecallPreview);
    const transcriptHitCount = Math.max(0, actor.lastTranscriptRecallHitCount ?? 0);
    return {
      ...(actor.lastMemoryRecallAttempted ? { memoryRecallAttempted: true } : {}),
      ...(memoryPreview ? { appliedMemoryPreview: memoryPreview } : {}),
      ...(actor.lastTranscriptRecallAttempted ? { transcriptRecallAttempted: true } : {}),
      ...(transcriptHitCount > 0 ? { transcriptRecallHitCount: transcriptHitCount } : {}),
      ...(transcriptPreview ? { appliedTranscriptPreview: transcriptPreview } : {}),
    };
  }

  private updateDialogMessage(messageId: string, patch: Partial<DialogMessage>): void {
    const idx = this.dialogHistory.findIndex((message) => message.id === messageId);
    if (idx < 0) return;
    this.dialogHistory[idx] = { ...this.dialogHistory[idx], ...patch };
  }
}
