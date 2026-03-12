import { AgentActor, type AskUserCallback } from "./agent-actor";
import type {
  AgentCapabilities,
  ActorConfig,
  ActorEvent,
  DialogMessage,
  InboxMessage,
  PendingReply,
  SpawnedTaskRecord,
  SpawnedTaskEventDetail,
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

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message || "error";
  if (typeof error === "string") return error;
  return "unknown error";
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
const log = (...args: unknown[]) => console.log(LOG_PREFIX, ...args);
const logWarn = (...args: unknown[]) => console.warn(LOG_PREFIX, ...args);

type SystemEventHandler = (event: ActorEvent | DialogMessage) => void;
type ConfirmDangerousAction = (toolName: string, params: Record<string, unknown>) => Promise<boolean>;

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
  private spawnedTasks = new Map<string, SpawnedTaskRecord>();
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
      if (event.type === "task_completed" || event.type === "task_error") {
        const detail = (event.detail ?? {}) as Record<string, unknown>;
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
    this.actors.delete(actorId);
    this.syncTranscriptActors();
  }

  /** 停止并移除所有 Actor */
  killAll(): void {
    this._cron.cancelAll();
    for (const record of this.spawnedTasks.values()) {
      if (record.timeoutId) clearTimeout(record.timeoutId);
    }
    this.spawnedTasks.clear();
    for (const actor of this.actors.values()) {
      actor.stop();
    }
    this.actors.clear();
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
  }): DialogMessage {
    const target = this.actors.get(to);
    if (!target) throw new Error(`Actor ${to} not found`);

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
    };

    target.receive(msg);
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
  broadcast(from: string, content: string, opts?: { _briefContent?: string }): DialogMessage {
    const fromName = from === "user" ? "用户" : (this.actors.get(from)?.role.name ?? from);
    log(`broadcast: ${fromName} → all, content="${content.slice(0, 80)}"`);

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      _briefContent: opts?._briefContent,
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);
    this.emitEvent(msg);

    for (const actor of this.actors.values()) {
      if (from !== "user" && actor.id === from) continue;
      actor.receive(msg);
    }
    return msg;
  }

  /**
   * 群聊模式：广播消息并 resolve 所有等待用户回复的 pending replies。
   *
   * 协调者投递策略：
   * - 如果有 Agent 在等待用户回复（pendingReplies），resolve 它们，不额外投递
   * - 否则，仅投递给第一个 Agent（协调者），其他 Agent 等待 spawn_task 激活
   * - 消息始终记录到 dialogHistory，UI 上所有人可见
   */
  broadcastAndResolve(from: string, content: string, opts?: { _briefContent?: string }): DialogMessage {
    const fromName = from === "user" ? "用户" : (this.actors.get(from)?.role.name ?? from);
    log(`broadcastAndResolve: ${fromName} → all, content="${content.slice(0, 80)}", pendingReplies=${this.pendingReplies.size}`);

    const msg: DialogMessage = {
      id: generateId(),
      from,
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      _briefContent: opts?._briefContent,
    };
    this.dialogHistory.push(msg);
    appendDialogMessage(this.sessionId, msg);

    // resolve 所有等待用户回复的 pending replies
    const agentsAwaitingReply = new Set<string>();
    let resolved = 0;
    for (const [id, pending] of this.pendingReplies) {
      if (pending.fromActorId === "user") {
        const qMsg = this.dialogHistory.find((m) => m.id === id);
        if (qMsg) agentsAwaitingReply.add(qMsg.from);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        this.pendingReplies.delete(id);
        pending.resolve(msg);
        resolved++;
      }
    }
    if (resolved > 0) {
      log(`broadcastAndResolve: resolved ${resolved} pending user replies`);
    }

    // 仅将消息投递给协调者（第一个非等待中的 Agent）
    if (from === "user") {
      const first = this.getFirstActor((a) => !agentsAwaitingReply.has(a.id));
      if (first) {
        log(`broadcastAndResolve(coordinator): delivering only to coordinator ${first.role.name}`);
        first.receive(msg);
      } else {
        log(`broadcastAndResolve: no available coordinator (all agents awaiting reply, reply resolved)`);
      }
    } else {
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
      /** Spawn 模式：run=一次性任务，session=保持会话 */
      mode?: "run" | "session";
      /** 清理策略：delete=完成后删除，keep=保持 */
      cleanup?: "delete" | "keep";
      /** 是否期望完成消息通知 */
      expectsCompletionMessage?: boolean;
      /** Subagent 独立配置：动态覆盖目标 Agent 的运行参数 */
      overrides?: import("./types").SpawnTaskOverrides;
    },
  ): SpawnedTaskRecord | { error: string } {
    const spawner = this.actors.get(spawnerActorId);
    const target = this.actors.get(targetActorId);
    if (!spawner) return { error: `Spawner ${spawnerActorId} not found` };
    if (!target) return { error: `Target ${targetActorId} not found` };

    // Subagent 独立配置：在 spawn 时动态覆盖 target 的运行参数
    if (opts?.overrides) {
      const ov = opts.overrides;
      if (ov.model) target.applySpawnOverride("model", ov.model);
      if (ov.maxIterations) target.applySpawnOverride("maxIterations", ov.maxIterations);
      if (ov.toolPolicy) target.applySpawnOverride("toolPolicy", ov.toolPolicy);
      if (ov.contextTokens) target.applySpawnOverride("contextTokens", ov.contextTokens);
      if (ov.thinkingLevel) target.applySpawnOverride("thinkingLevel", ov.thinkingLevel);
      if (ov.systemPromptAppend) target.applySpawnOverride("systemPromptAppend", ov.systemPromptAppend);
      if (ov.middlewareOverrides) target.applySpawnOverride("middlewareOverrides", ov.middlewareOverrides);
      if (ov.temperature != null) target.applySpawnOverride("temperature", ov.temperature);
      log(`spawnTask: applied overrides to ${target.role.name}`, JSON.stringify(ov).slice(0, 200));
    }

    // session 模式下允许 target 处于 running 状态（保持会话）
    const mode = opts?.mode ?? "run";
    if (mode === "run" && target.status === "running") {
      return { error: `[sessions_spawn] ${target.role.name} is already running a task (mode='run' requires idle target)` };
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
    const label = opts?.label ?? task.slice(0, 30);
    const timeoutMs = (opts?.timeoutSeconds ?? DEFAULT_SPAWN_TIMEOUT_MS / 1000) * 1000;
    const cleanup = opts?.cleanup ?? "keep";
    const expectsCompletionMessage = opts?.expectsCompletionMessage ?? true;

    let fullTask = `[由 ${spawnerName} 委派的任务]\n\n${task}`;
    if (opts?.context) fullTask += `\n\n补充上下文：${opts.context}`;
    if (opts?.attachments?.length) {
      fullTask += `\n\n附件文件路径：\n${opts.attachments.map((f) => `- ${f}`).join("\n")}`;
    }

    const record: SpawnedTaskRecord = {
      runId,
      spawnerActorId,
      targetActorId,
      task,
      label,
      status: "running",
      spawnedAt: Date.now(),
      mode,
      expectsCompletionMessage,
      cleanup,
    };

    // 超时处理
    record.timeoutId = setTimeout(() => {
      if (record.status !== "running") return;
      const duration = Date.now() - record.spawnedAt;
      log(`⏱️ spawnTask TIMEOUT: ${targetName} (runId=${runId}), duration=${duration}ms, timeout=${timeoutMs}ms, targetStatus=${target.status}, aborting...`);
      record.status = "aborted";
      record.completedAt = Date.now();
      record.error = `Task timeout after ${timeoutMs / 1000}s`;
      target.abort();

      if (expectsCompletionMessage) {
        this.send(targetActorId, spawnerActorId, `[Task timeout: ${label}]\n\n子任务超时未完成，已自动终止。`);
      }

      this.emitEvent({ type: "task_error", actorId: targetActorId, timestamp: Date.now(), detail: { runId, reason: "timeout" } });
      this.emitEvent({
        type: "spawned_task_timeout",
        actorId: targetActorId,
        timestamp: Date.now(),
        detail: {
          ...taskEventBase,
          status: "aborted" as const,
          elapsed: duration,
          error: record.error,
        } satisfies SpawnedTaskEventDetail,
      });

      // 超时时清理（如果需要，且目标非持久 Agent）
      if (cleanup === "delete" && !target.persistent) {
        this.kill(targetActorId);
      } else if (cleanup === "delete" && target.persistent) {
        log(`spawnTask cleanup skipped on timeout: ${targetName} is persistent (runId=${runId})`);
      }
    }, timeoutMs);

    this.spawnedTasks.set(runId, record);
    appendSpawnEvent(this.sessionId, spawnerActorId, targetActorId, task, runId);

    // 同步到 TaskCenter（如果可用）
    try {
      const { getTaskQueue } = require("@/core/task-center/task-queue");
      const q = getTaskQueue();
      q.create({
        id: `spawn-${runId}`,
        title: label,
        description: task.slice(0, 200),
        type: "agent_spawn",
        priority: "normal",
        params: { runId, spawnerActorId, targetActorId },
        createdBy: spawnerName,
        assignee: targetName,
        timeoutSeconds: timeoutMs / 1000,
        tags: [mode, targetName],
      });
    } catch { /* TaskCenter not available */ }
    log(`🚀 spawnTask START: ${spawnerName} → ${targetName}, task="${task.slice(0, 60)}", runId=${runId}, mode=${mode}, timeout=${timeoutMs / 1000}s, depth=${depth + 1}, targetStatus=${target.status}`);

    // Emit structured spawned_task_started event (deer-flow SSE pattern)
    const taskEventBase: Omit<SpawnedTaskEventDetail, "status" | "elapsed"> = {
      runId, spawnerActorId, targetActorId,
      targetName, spawnerName, label, task,
    };
    this.emitEvent({
      type: "spawned_task_started",
      actorId: targetActorId,
      timestamp: Date.now(),
      detail: { ...taskEventBase, status: "running" as const, elapsed: 0 },
    });

    // 触发 onSpawnTask 钩子
    void this.runHooks<SpawnTaskHookContext>("onSpawnTask", {
      system: this,
      actorId: targetActorId,
      actorName: targetName,
      timestamp: Date.now(),
      spawnerId: spawnerActorId,
      targetId: targetActorId,
      task,
      mode,
      runId,
    });

    // 执行任务并设置 Announce Flow 回调（含重试机制）
    // 子任务结果仅通过 announce 回送给委派者，避免全局广播造成协作噪音。
    void target.assignTask(fullTask, undefined, { publishResult: false }).then((taskResult) => {
      if (record.status !== "running") return;
      if (record.timeoutId) clearTimeout(record.timeoutId);

      if (taskResult.status === "completed" && taskResult.result) {
        record.status = "completed";
        record.completedAt = Date.now();
        record.result = taskResult.result;
        log(`✅ spawnTask COMPLETED: ${targetName} → announce to ${spawnerName}, runId=${runId}, duration=${Date.now() - record.spawnedAt}ms`);
        appendAnnounceEvent(this.sessionId, runId, "completed", taskResult.result);
        try { const { getTaskQueue } = require("@/core/task-center/task-queue"); getTaskQueue().complete(`spawn-${runId}`, taskResult.result?.slice(0, 500)); } catch { /* noop */ }

        if (expectsCompletionMessage) {
          this.announceWithRetry(targetActorId, spawnerActorId, `[Task completed: ${label}]\n\n${taskResult.result}`, runId);
        }
      } else {
        record.status = taskResult.status === "aborted" ? "aborted" : "error";
        record.completedAt = Date.now();
        record.error = taskResult.error ?? "unknown error";
        log(`❌ spawnTask FAILED: ${targetName}, status=${taskResult.status}, error=${record.error}, runId=${runId}, duration=${Date.now() - record.spawnedAt}ms`);
        appendAnnounceEvent(this.sessionId, runId, record.status, undefined, record.error);
        try { const { getTaskQueue } = require("@/core/task-center/task-queue"); getTaskQueue().fail(`spawn-${runId}`, record.error || "unknown"); } catch { /* noop */ }

        if (expectsCompletionMessage) {
          this.announceWithRetry(targetActorId, spawnerActorId, `[Task failed: ${label}]\n\nError: ${record.error}`, runId);
        }
      }

      this.emitEvent({ type: "task_completed", actorId: targetActorId, timestamp: Date.now(), detail: { runId } });

      // Emit structured spawned_task lifecycle event
      const elapsed = Date.now() - record.spawnedAt;
      if (record.status === "completed") {
        this.emitEvent({
          type: "spawned_task_completed",
          actorId: targetActorId,
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
          actorId: targetActorId,
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
        actorId: targetActorId,
        actorName: targetName,
        timestamp: Date.now(),
        spawnerId: spawnerActorId,
        targetId: targetActorId,
        task,
        runId,
        status: record.status,
        result: record.result,
        error: record.error,
      });

      // 根据 cleanup 策略决定是否删除子 agent（仅非持久 Agent 可删除）
      if (cleanup === "delete" && !target.persistent) {
        log(`spawnTask cleanup: deleting target ${targetName} (runId=${runId})`);
        this.kill(targetActorId);
      } else if (cleanup === "delete" && target.persistent) {
        log(`spawnTask cleanup skipped: ${targetName} is persistent (runId=${runId})`);
      }
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

  /**
   * 获取某个 Agent 的完整后代任务树（含孙任务、曾孙任务...）。
   * 返回扁平列表，每个 record 带 depth 字段表示层级。
   */
  getDescendantTasks(actorId: string): Array<SpawnedTaskRecord & { depth: number }> {
    const result: Array<SpawnedTaskRecord & { depth: number }> = [];
    const visited = new Set<string>();

    const collect = (parentId: string, depth: number) => {
      const children = this.getSpawnedTasks(parentId);
      for (const child of children) {
        if (visited.has(child.runId)) continue;
        visited.add(child.runId);
        result.push({ ...child, depth });
        collect(child.targetActorId, depth + 1);
      }
    };

    collect(actorId, 1);
    return result;
  }

  /** 计算 spawn 链深度（通过 spawnedTasks 回溯 spawner 链） */
  private getSpawnDepth(actorId: string): number {
    let depth = 0;
    let current = actorId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(current)) break;
      visited.add(current);
      const parentRecord = [...this.spawnedTasks.values()].find(
        (r) => r.targetActorId === current && r.status === "running",
      );
      if (!parentRecord) break;
      depth++;
      current = parentRecord.spawnerActorId;
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
    };

    actor.receive(msg);
    this.dialogHistory.push(msg);
    this.emitEvent(msg);
    return msg;
  }

  /** 级联 abort 某个 Agent 的所有 running spawned tasks */
  private cascadeAbortSpawns(actorId: string): void {
    const activeSpawns = this.getActiveSpawnedTasks(actorId);
    for (const record of activeSpawns) {
      if (record.timeoutId) clearTimeout(record.timeoutId);
      record.status = "aborted";
      record.completedAt = Date.now();
      record.error = "父任务被终止";
      const targetActor = this.actors.get(record.targetActorId);
      if (targetActor) {
        targetActor.abort();
        this.cascadeAbortSpawns(record.targetActorId);
      }
      log(`cascadeAbort: ${record.targetActorId} (spawned by ${actorId}), runId=${record.runId}`);
    }
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
      return;
    }

    try {
      const spawner = this.actors.get(toActorId);
      if (!spawner) {
        // spawner 不存在是 transient 错误，可以重试
        if (attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
          const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
          log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: spawner gone, retrying in ${delay / 1000}s, runId=${runId}`);
          setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
          return;
        }
        logWarn(`announce FAILED: spawner ${toActorId} not found after ${attempt} retries, runId=${runId}`);
        return;
      }
      this.send(fromActorId, toActorId, content);
    } catch (err) {
      const errSummary = summarizeError(err);

      // 只有 transient 错误才重试，permanent 错误直接失败
      if (isTransientAnnounceError(err) && attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
        const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
        log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: transient error="${errSummary}", retrying in ${delay / 1000}s, runId=${runId}`);
        setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
      } else if (!isTransientAnnounceError(err) && attempt < ANNOUNCE_RETRY_DELAYS_MS.length) {
        // permanent 错误也重试一次（可能是未知错误）
        const delay = ANNOUNCE_RETRY_DELAYS_MS[attempt];
        log(`announce RETRY ${attempt + 1}/${ANNOUNCE_RETRY_DELAYS_MS.length}: unknown error="${errSummary}", retrying in ${delay / 1000}s, runId=${runId}`);
        setTimeout(() => this.announceWithRetry(fromActorId, toActorId, content, runId, attempt + 1), delay);
      } else {
        logWarn(`announce FAILED after ${attempt} retries (last error: "${errSummary}"), runId=${runId}`, err);
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

    const actor = this.actors.get(actorId);
    const actorName = actor?.role.name ?? actorId;
    const coordinatorId = this.getFirstActor()?.id;
    const fromNonCoordinator = coordinatorId ? actorId !== coordinatorId : false;
    const suppressLowSignal = opts?.suppressLowSignal ?? true;

    if (suppressLowSignal && fromNonCoordinator && isLowSignalCoordinationMessage(trimmed)) {
      log(`publishResult: suppress low-signal message from ${actorName}`);
      return null;
    }

    const msg: DialogMessage = {
      id: generateId(),
      from: actorId,
      to: undefined, // 广播模式
      content: trimmed,
      timestamp: Date.now(),
      priority: "normal",
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
        });
      }
    }

    return msg;
  }

  /**
   * Agent 在聊天流中向用户提问，并等待用户回复。
   * 用于替代 askUser 弹窗，让提问直接出现在对话流中。
   */
  askUserInChat(
    actorId: string,
    question: string,
    timeoutMs = 300_000,
  ): Promise<string> {
    const actorName = this.actors.get(actorId)?.role.name ?? actorId;
    log(`askUserInChat: ${actorName} asks user, question="${question.slice(0, 60)}"`);
    const msg: DialogMessage = {
      id: generateId(),
      from: actorId,
      to: "user",
      content: question,
      timestamp: Date.now(),
      priority: "normal",
      expectReply: true,
    };
    this.dialogHistory.push(msg);

    return new Promise<string>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingReplies.delete(msg.id);
        this.emitEvent(msg); // re-sync so UI clears the pending indicator
        resolve("（用户未回复，请根据已有信息继续执行）");
      }, timeoutMs);

      this.pendingReplies.set(msg.id, {
        fromActorId: "user",
        messageId: msg.id,
        resolve: (reply) => resolve(reply.content),
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
  replyToMessage(messageId: string, content: string): DialogMessage {
    const msg: DialogMessage = {
      id: generateId(),
      from: "user",
      to: undefined,
      content,
      timestamp: Date.now(),
      priority: "normal",
      replyTo: messageId,
    };
    this.dialogHistory.push(msg);
    this.emitEvent(msg);

    const pending = this.pendingReplies.get(messageId);
    if (pending) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pendingReplies.delete(messageId);
      pending.resolve(msg);
    }

    return msg;
  }

  /** 获取所有等待用户回复的消息 ID */
  getPendingUserReplies(): string[] {
    return [...this.pendingReplies.entries()]
      .filter(([, p]) => p.fromActorId === "user")
      .map(([id]) => id);
  }

  // ── Dialog History ──

  getDialogHistory(): readonly DialogMessage[] {
    return this.dialogHistory;
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

    // 清空 spawnedTasks
    for (const record of this.spawnedTasks.values()) {
      if (record.timeoutId) clearTimeout(record.timeoutId);
    }
    this.spawnedTasks.clear();

    // 清空 transcript 内存缓存
    clearSessionCache();

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
  routeTask(taskDescription: string, _preferredCapabilities?: string[]): { agentId: string; reason: string }[] {
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

    // Tokenize task for expertise matching
    const taskTokens = taskLower.split(/[\s,.:;!?，。：；！？\n]+/).filter((t) => t.length > 1);

    const scored = agents.map((agent, idx) => {
      let score = 0;
      const agentCaps = agent.capabilities?.tags || [];
      const expertise = agent.capabilities?.expertise || [];
      const matchedLabels: string[] = [];

      // Capability match: +10 per matched capability
      for (const cap of matchedCaps) {
        if (agentCaps.includes(cap as any)) {
          score += 10;
          matchedLabels.push(CAPABILITY_LABELS[cap] ?? cap);
        }
      }

      // Expertise keyword overlap: +5 per match
      for (const exp of expertise) {
        if (taskTokens.some((t) => t.includes(exp.toLowerCase()) || exp.toLowerCase().includes(t))) {
          score += 5;
        }
      }

      // No capability match: prefer coordinator / synthesis
      if (matchedCaps.size === 0) {
        if (agentCaps.includes("coordinator")) score += 8;
        else if (agentCaps.includes("synthesis")) score += 4;
      }

      // Coordinator bonus (task decomposition ability)
      if (agentCaps.includes("coordinator")) score += 2;

      // Load balancing: idle agents get bonus, running agents penalized
      if (agent.status === "idle") score += 3;
      else if (agent.status === "running") score -= 5;

      // Tiebreaker: stable ordering by spawn position (no randomness)
      score += (agents.length - idx) * 0.01;

      const reason = matchedLabels.length > 0
        ? `擅长 ${matchedLabels.join("、")}`
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

  private emitEvent(event: ActorEvent | DialogMessage): void {
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
      dialogHistory: [...this.dialogHistory],
      pendingReplies: this.pendingReplies.size,
      spawnedTasks: [...this.spawnedTasks.values()].map((r) => ({
        runId: r.runId,
        spawner: r.spawnerActorId,
        target: r.targetActorId,
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
}
