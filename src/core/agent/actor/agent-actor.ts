import { getMToolsAI } from "@/core/ai/mtools-ai";
import {
  ReActAgent,
  type AgentTool,
  type AgentStep,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import {
  type AskUserQuestion,
  type AskUserAnswers,
} from "@/plugins/builtin/SmartAgent/core/default-tools";
import type { AgentRole } from "@/core/agent/cluster/types";
import type { ActorSystem } from "./actor-system";
import { autoExtractMemories } from "./actor-memory";
import { appendToolCallSync as appendToolCall, appendToolResultSync as appendToolResult } from "./actor-transcript";
import type { ActorRunContext } from "./actor-middleware";
import { runMiddlewareChain } from "./actor-middleware";
import { ClarificationInterrupt, createDefaultMiddlewares } from "./middlewares";
import type {
  AgentCapabilities,
  ActorConfig,
  ActorEvent,
  ActorEventType,
  ActorRunOverrides,
  ActorStatus,
  ActorTask,
  InboxMessage,
  MiddlewareOverrides,
  ThinkingLevel,
  ToolPolicy,
} from "./types";

const generateId = () =>
  Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

import { estimateTokens } from "@/core/ai/token-utils";
import { createLogger } from "@/core/logger";
import { useAIStore } from "@/store/ai-store";

const _agentActorLogger = createLogger("AgentActor");
const actorLog = (name: string, ...args: unknown[]) => {
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  _agentActorLogger.info(`[${name}] ${message}`);
};

type ActorEventHandler = (event: ActorEvent) => void;
export type AskUserCallback = (questions: AskUserQuestion[]) => Promise<AskUserAnswers>;
type ConfirmDangerousAction = (toolName: string, params: Record<string, unknown>) => Promise<boolean>;

const ARTIFACT_TOOL_NAMES = new Set(["write_file", "str_replace_edit", "json_edit"]);
const INTERIM_SYNTHESIS_PATTERNS = [
  /(正在|继续|稍后|马上|随后).*(整理|汇总|整合|输出|总结)/u,
  /(先|我会|正在).*(看|检查|处理|拉齐)/u,
  /(working on it|pulling .* together|give me a few|let me compile|i'?ll gather)/i,
];

function basename(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function inferArtifactLanguage(path: string): string | undefined {
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
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return ext || undefined;
  }
}

function buildArtifactPayloadFromToolCall(
  actorId: string,
  actorSystem: ActorSystem,
  toolName: string,
  params: Record<string, unknown>,
): void {
  if (!ARTIFACT_TOOL_NAMES.has(toolName)) return;
  const path = typeof params.path === "string" ? params.path.trim() : "";
  if (!path) return;

  let summary = "生成文件产物";
  let preview: string | undefined;
  let fullContent: string | undefined;

  if (toolName === "write_file") {
    summary = "通过 write_file 生成文件";
    if (typeof params.content === "string") {
      fullContent = params.content;
      preview = params.content.slice(0, 1200);
    }
  } else if (toolName === "str_replace_edit") {
    summary = "通过 str_replace_edit 修改文件";
    if (typeof params.newText === "string") {
      fullContent = params.newText;
      preview = params.newText.slice(0, 1200);
    } else if (typeof params.oldText === "string") {
      preview = params.oldText.slice(0, 1200);
    }
  } else if (toolName === "json_edit") {
    summary = "通过 json_edit 修改结构化文件";
    preview = JSON.stringify(params, null, 2).slice(0, 1200);
  }

  const relatedRun = actorSystem
    .getSpawnedTasksSnapshot()
    .filter((record) => record.mode === "session" && record.sessionOpen && record.targetActorId === actorId)
    .sort((a, b) => (b.lastActiveAt ?? b.spawnedAt) - (a.lastActiveAt ?? a.spawnedAt))[0];

  actorSystem.recordArtifact({
    actorId,
    path,
    source: toolName === "write_file" ? "tool_write" : "tool_edit",
    toolName,
    summary,
    preview,
    fullContent,
    language: inferArtifactLanguage(path),
    timestamp: Date.now(),
    relatedRunId: relatedRun?.runId,
  });
}

function isLikelyInterimSynthesisReply(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return true;
  if (normalized.length > 220) return false;
  return INTERIM_SYNTHESIS_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Dialog 模式下每个 Agent 使用的全能角色（不做工具过滤） */
export const DIALOG_FULL_ROLE: AgentRole = {
  id: "dialog_agent",
  name: "Agent",
  systemPrompt: `你是一个始终在线的 AI 助手，拥有完整的工具能力（代码读写、Shell、网络搜索等）。你能记住之前的对话内容。

## 关键原则

- **禁止社交客套**。不要发"收到""好的""感谢"。收到任务直接行动。
- **不要重复别人的工作**。
- **直接输出结果**。不需要冗长的过渡语。
- **用名称而非 ID**。
- **用中文交流**。

## 可用工具

- \`spawn_task\`：派发子任务给另一个 Agent（自动追踪，结果自动回送）
- \`send_message\`：向指定 Agent 发送消息
- \`agents\`：查看所有 Agent 状态和子任务进度（action="list"）或终止 Agent（action="kill"）
- \`memory_search\`：搜索用户长期记忆（偏好、事实、约束），回答相关问题前先检索
- \`memory_save\`：保存用户偏好、约束等长期记忆`,
  capabilities: ["code_write", "code_analysis", "file_write", "shell_execute", "information_retrieval", "web_search", "code_review"],
  maxIterations: 20,
  temperature: 0.5,
};

/**
 * AgentActor — 一个独立运行的 Agent 实体（Actor 模型）。
 *
 * 每个 Actor 拥有：
 * - 独立的 inbox（收件箱），任何时候都可以接收消息
 * - 独立的任务队列和生命周期
 * - 可配置的 LLM 模型和角色
 * - 通过 inboxDrain 钩子在 ReAct 循环的每个 iteration 间隙处理消息
 */
export class AgentActor {
  readonly id: string;
  readonly role: AgentRole;
  readonly persistent: boolean;
  readonly modelOverride?: string;
  readonly capabilities?: AgentCapabilities;

  private _status: ActorStatus = "idle";
  private inbox: InboxMessage[] = [];
  private _draining = false;
  private tasks: ActorTask[] = [];
  private abortController: AbortController | null = null;
  private eventHandlers: ActorEventHandler[] = [];
  private extraTools: AgentTool[] = [];
  private askUser?: AskUserCallback;
  private confirmDangerousAction?: ConfirmDangerousAction;
  private maxIterations: number;
  private systemPromptOverride?: string;
  private actorSystem?: ActorSystem;
  private toolPolicy?: ToolPolicy;
  private _timeoutSeconds?: number;
  private _workspace?: string;
  private _contextTokens?: number;
  private _thinkingLevel?: ThinkingLevel;
  private _middlewareOverrides?: import("./types").MiddlewareOverrides;

  /** 会话记忆：跨任务保留对话上下文（对标 OpenClaw 持久会话） */
  private sessionHistory: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [];

  /** inboxDrain 捕获的真实用户消息（用于替代 "[inbox]" 占位符写入 sessionHistory） */
  private _capturedInboxUserQuery?: string;

  constructor(config: ActorConfig, opts?: {
    askUser?: AskUserCallback;
    confirmDangerousAction?: ConfirmDangerousAction;
    actorSystem?: ActorSystem;
  }) {
    this.id = config.id;
    this.role = config.role;
    this.persistent = config.persistent !== false;
    this.modelOverride = config.modelOverride;
    this.capabilities = config.capabilities;
    this.maxIterations = config.maxIterations ?? config.role.maxIterations ?? 15;
    this.systemPromptOverride = config.systemPromptOverride;
    this.toolPolicy = config.toolPolicy;
    this._timeoutSeconds = config.timeoutSeconds;
    this._workspace = config.workspace;
    this._contextTokens = config.contextTokens;
    this._thinkingLevel = config.thinkingLevel;
    this._middlewareOverrides = config.middlewareOverrides;
    this.confirmDangerousAction = opts?.confirmDangerousAction;
    this.actorSystem = opts?.actorSystem;

    if (opts?.askUser) {
      this.askUser = opts.askUser;
    } else if (this.actorSystem) {
      this.askUser = this.createChatAskUser();
    }
  }

  /**
   * 创建基于聊天流的 askUser 回调。
   * Agent 调用 ask_user 时，问题直接发到对话流，用户在输入框回复。
   */
  private createChatAskUser(): AskUserCallback {
    return async (questions) => {
      if (!this.actorSystem) throw new Error("No ActorSystem");
      actorLog(this.role.name, `askUser: ${questions.length} questions, awaiting user reply...`);
      let questionText = questions.map((q, i) => {
        let line = `**问题${questions.length > 1 ? ` ${i + 1}` : ""}**: ${q.question}`;
        if (q.options?.length) {
          line += `\n选项: ${q.options.join(" / ")}`;
        }
        return line;
      }).join("\n\n");
      if (questions.length > 1) {
        questionText += `\n\n请按以下格式逐行回答：\n${questions
          .map((_, i) => `q${i + 1}: ...`)
          .join("\n")}`;
      }
      const interaction = await this.actorSystem.askUserInChat(this.id, questionText, {
        interactionType: "question",
      });
      if (interaction.status !== "answered") {
        throw new Error(interaction.status === "timed_out" ? "用户未回复" : "交互已取消");
      }
      const reply = interaction.content;
      actorLog(this.role.name, `askUser: got reply="${reply.slice(0, 60)}"`);

      const parseReplies = (): string[] => {
        const keyed = new Map<number, string>();
        for (const line of reply.split(/\r?\n/)) {
          const match = line.match(/^\s*(?:q(\d+)|问题\s*(\d+))\s*[:：=]\s*(.+)\s*$/i);
          if (!match) continue;
          const index = Number(match[1] ?? match[2]) - 1;
          if (Number.isNaN(index) || index < 0 || index >= questions.length) continue;
          keyed.set(index, match[3].trim());
        }
        if (keyed.size > 0) {
          return questions.map((_, i) => keyed.get(i) ?? "");
        }

        const byLine = reply.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (byLine.length === questions.length) return byLine;

        const bySemicolon = reply.split(/[；;]+/).map((s) => s.trim()).filter(Boolean);
        if (bySemicolon.length === questions.length) return bySemicolon;

        return questions.map((_, i) => (i === 0 ? reply : ""));
      };

      const parsedReplies = parseReplies();
      const answers: AskUserAnswers = {};
      questions.forEach((q, i) => {
        answers[q.question] = parsedReplies[i] ?? "";
      });
      return answers;
    };
  }

  // ── Public API ──

  get status(): ActorStatus {
    return this._status;
  }

  get currentTask(): ActorTask | undefined {
    return this.tasks.find((t) => t.status === "running");
  }

  get allTasks(): readonly ActorTask[] {
    return this.tasks;
  }

  get pendingInboxCount(): number {
    return this.inbox.length;
  }

  get workspace(): string | undefined {
    return this._workspace;
  }

  get timeoutSeconds(): number | undefined {
    return this._timeoutSeconds;
  }

  get contextTokens(): number | undefined {
    return this._contextTokens;
  }

  get thinkingLevel(): ThinkingLevel | undefined {
    return this._thinkingLevel;
  }

  get toolPolicyConfig(): ToolPolicy | undefined {
    if (!this.toolPolicy) return undefined;
    return {
      allow: this.toolPolicy.allow ? [...this.toolPolicy.allow] : undefined,
      deny: this.toolPolicy.deny ? [...this.toolPolicy.deny] : undefined,
    };
  }

  get middlewareOverrides(): MiddlewareOverrides | undefined {
    if (!this._middlewareOverrides) return undefined;
    return {
      disable: this._middlewareOverrides.disable ? [...this._middlewareOverrides.disable] : undefined,
      approvalLevel: this._middlewareOverrides.approvalLevel,
    };
  }

  /** 注入额外的 AgentTool（如 spawn_task / send_message / agents 等通信工具） */
  setExtraTools(tools: AgentTool[]): void {
    this.extraTools = tools;
  }

  /** 接收消息（线程安全——JS 单线程，任何时候都可调用） */
  receive(message: InboxMessage): void {
    const senderName = message.from === "user" ? "用户" : (this.actorSystem?.get(message.from)?.role.name ?? message.from);
    actorLog(this.role.name, `receive: from=${senderName}, status=${this._status}, inboxSize=${this.inbox.length + 1}, content="${String(message.content).slice(0, 60)}"`);
    this.inbox.push(message);
    this.emit("message_received", { message });

    if (this._status === "idle") {
      actorLog(this.role.name, "receive: idle → triggering wakeUpForInbox");
      this.wakeUpForInbox();
    }
  }

  /**
   * 空闲时收到消息，自动启动一个轻量任务来处理 inbox。
   * 使用 queueMicrotask 延迟，让同一 tick 内的多条消息合并处理。
   * 预先 drain inbox 并将真实用户内容作为 query，避免 "[inbox]" 占位符误导 Agent。
   * 执行期间新到达的消息仍通过 inboxDrain 钩子正常注入。
   */
  private _wakeUpScheduled = false;
  private wakeUpForInbox(): void {
    if (this._wakeUpScheduled) return;
    this._wakeUpScheduled = true;
    queueMicrotask(() => {
      this._wakeUpScheduled = false;
      if (this._status !== "idle" || this.inbox.length === 0) {
        actorLog(this.role.name, `wakeUpForInbox: skipped (status=${this._status}, inbox=${this.inbox.length})`);
        return;
      }

      const messages = this.drainInbox();
      actorLog(this.role.name, `wakeUpForInbox: drained ${messages.length} messages`);

      const userMsgs = messages.filter((m) => m.from === "user");
      let query: string;
      if (userMsgs.length === 1 && messages.length === 1) {
        query = userMsgs[0].content;
      } else if (userMsgs.length > 0 && messages.length === userMsgs.length) {
        query = userMsgs.map((m) => m.content).join("\n\n");
      } else {
        query = messages.map((m) => {
          const sender = m.from === "user" ? "用户"
            : (this.actorSystem?.get(m.from)?.role.name ?? m.from);
          return `[${sender}]: ${m.content}`;
        }).join("\n\n");
      }

      const allImages = messages.flatMap((m) => m.images ?? []);
      void this.assignTask(query, allImages.length > 0 ? allImages : undefined);
    });
  }

  /** 手动读取并清空 inbox（带重入保护，防止并发 drain 丢消息） */
  drainInbox(): InboxMessage[] {
    if (this._draining) {
      actorLog(this.role.name, `drainInbox: re-entrant call blocked`);
      return [];
    }
    this._draining = true;
    try {
      const messages = this.inbox.splice(0);
      return messages;
    } finally {
      this._draining = false;
    }
  }

  /**
   * 分配任务并异步执行。
   * 包含会话记忆（上下文连续）和等待循环（等待 spawned tasks 完成后整合）。
   */
  async assignTask(
    query: string,
    images?: string[],
    opts?: { publishResult?: boolean; runOverrides?: ActorRunOverrides },
  ): Promise<ActorTask> {
    actorLog(this.role.name, `📋 assignTask START: query="${query.slice(0, 80)}", status=${this._status}, publishResult=${opts?.publishResult !== false}, inbox=${this.inbox.length}`);
    const task: ActorTask = {
      id: generateId(),
      query,
      status: "pending",
      steps: [],
    };
    this.tasks.push(task);

    let globalTimeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      task.status = "running";
      task.startedAt = Date.now();
      this.setStatus("running");
      actorLog(this.role.name, `📋 assignTask RUNNING: taskId=${task.id}, status changed to running`);
      this.emit("task_started", { taskId: task.id, query });
      const emitTaskStep = (step: AgentStep) => {
        task.steps.push(step);
        this.emit("step", { taskId: task.id, step });
      };

      if (this._timeoutSeconds && this._timeoutSeconds > 0) {
        globalTimeoutId = setTimeout(() => {
          actorLog(this.role.name, `assignTask: GLOBAL TIMEOUT after ${this._timeoutSeconds}s, aborting task ${task.id}`);
          this.abort();
        }, this._timeoutSeconds * 1000);
      }

      actorLog(this.role.name, `📝 assignTask: executing with sessionHistory=${this.sessionHistory.length} entries, inbox=${this.inbox.length}`);
      this._capturedInboxUserQuery = undefined;
      let { result, finalQuery: executedQuery } = await this.runWithClarifications(
        query,
        images,
        emitTaskStep,
        opts?.runOverrides,
      );
      const historyQuery = this._capturedInboxUserQuery || executedQuery;
      this._capturedInboxUserQuery = undefined;
      this.appendSessionHistory("user", historyQuery);
      this.appendSessionHistory("assistant", result ?? "");

      // 等待循环：如果有未完成的 spawned tasks，保持运行等待结果回送
      const WAIT_POLL_MS = 5_000;
      const MAX_WAIT_ROUNDS = 60; // 最多等 5 分钟
      let waitRound = 0;
      let processedSpawnFollowUps = 0;
      while (
        this.actorSystem?.getActiveSpawnedTasks(this.id).length &&
        waitRound < MAX_WAIT_ROUNDS
      ) {
        const activeCount = this.actorSystem.getActiveSpawnedTasks(this.id).length;
        actorLog(this.role.name, `assignTask: waiting for ${activeCount} spawned tasks (round ${waitRound + 1})...`);
        await this.waitForInbox(WAIT_POLL_MS);
        if (this.inbox.length > 0) {
          const drainedMessages = this.drainInbox();
          const followUpQuery = this.buildFollowUpFromMessages(drainedMessages);
          actorLog(this.role.name, `assignTask: processing ${drainedMessages.length} inbox messages in follow-up run`);
          const { result: followUpResult, finalQuery: followUpHistoryQuery } = await this.runWithClarifications(
            followUpQuery,
            undefined,
            emitTaskStep,
            opts?.runOverrides,
          );
          this.appendSessionHistory("user", followUpHistoryQuery);
          this.appendSessionHistory("assistant", followUpResult ?? "");
          result = followUpResult ?? result;
          processedSpawnFollowUps++;
        }
        waitRound++;
      }

      if (
        processedSpawnFollowUps > 0 &&
        isLikelyInterimSynthesisReply(String(result ?? ""))
      ) {
        emitTaskStep({
          type: "observation",
          content: "所有子任务已结束，正在触发一次最终综合，避免停留在中间态回复。",
          timestamp: Date.now(),
        });
        const finalSynthesisPrompt = [
          "你派发的子任务现在都已经结束。",
          "请基于当前会话中的已有结果和刚收到的子任务反馈，输出给上游的最终综合答复。",
          "要求：",
          "1. 直接给结论，不要再说“稍后整理”“继续汇总”之类的中间态话术。",
          "2. 明确列出已经完成的部分与最终判断。",
          "3. 如果仍有缺口，只说明真实缺口，不要重复之前已经完成的工作。",
        ].join("\n");
        const { result: finalSynthesisResult, finalQuery: finalSynthesisQuery } = await this.runWithClarifications(
          finalSynthesisPrompt,
          undefined,
          emitTaskStep,
          opts?.runOverrides,
        );
        this.appendSessionHistory("user", finalSynthesisQuery);
        this.appendSessionHistory("assistant", finalSynthesisResult ?? "");
        result = finalSynthesisResult ?? result;
      }

      if (globalTimeoutId) clearTimeout(globalTimeoutId);

      task.status = "completed";
      task.result = result;
      task.finishedAt = Date.now();
      const elapsed = task.finishedAt - (task.startedAt ?? task.finishedAt);
      actorLog(this.role.name, `✅ assignTask COMPLETED: taskId=${task.id}, elapsed=${elapsed}ms, result="${(result ?? "").slice(0, 80)}"`);
      this.setStatus("idle");

      // 自动提取记忆（对标 OpenClaw session-memory hook）
      const memContent = `${query}\n${result ?? ""}`;
      autoExtractMemories(memContent, task.id, {
        sourceMode: "dialog",
        workspaceId: this._workspace,
      }).catch((err) => {
        actorLog(this.role.name, `autoExtractMemories failed (non-blocking):`, err instanceof Error ? err.message : err);
      });
      if (this.actorSystem && opts?.publishResult !== false) {
        const output = String(result ?? "").trim() || "（任务已完成，但未生成可展示的文本结果）";
        this.actorSystem.publishResult(this.id, output, { suppressLowSignal: false });
      }
      this.emit("task_completed", { taskId: task.id, result, elapsed });
      return task;
    } catch (e) {
      if (globalTimeoutId) clearTimeout(globalTimeoutId);

      const error = e instanceof Error ? e.message : String(e);
      task.status = error === "Aborted" ? "aborted" : "error";
      task.error = error;
      task.finishedAt = Date.now();
      const errorElapsed = task.finishedAt - (task.startedAt ?? task.finishedAt);
      actorLog(this.role.name, `assignTask: ERROR - ${error}`);
      this.setStatus("idle");
      if (this.actorSystem && opts?.publishResult !== false) {
        this.actorSystem.publishResult(
          this.id,
          `任务执行失败：${error}`,
          { suppressLowSignal: false },
        );
      }
      this.emit("task_error", { taskId: task.id, error, elapsed: errorElapsed });
      return task;
    }
  }

  /** Build context messages from session history within token budget */
  private buildContextMessages(): Array<{ role: "user" | "assistant"; content: string }> {
    if (this.sessionHistory.length === 0) return [];
    const budget = this._contextTokens ?? 8000;
    let used = 0;
    const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = this.sessionHistory.length - 1; i >= 0; i--) {
      const entry = this.sessionHistory[i];
      const tokens = estimateTokens(entry.content);
      if (used + tokens > budget) break;
      selected.unshift({ role: entry.role, content: entry.content });
      used += tokens;
    }
    return selected;
  }

  /** 导出 sessionHistory（用于持久化） */
  getSessionHistory(): Array<{ role: "user" | "assistant"; content: string; timestamp: number }> {
    return [...this.sessionHistory];
  }

  /** 导入 sessionHistory（用于恢复） */
  loadSessionHistory(history: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>): void {
    this.sessionHistory = history.slice(-50); // 限制大小
  }

  /** 清空 sessionHistory（重置 session 时调用） */
  clearSessionHistory(): void {
    this.sessionHistory = [];
  }

  /** 获取 systemPromptOverride（用于快照） */
  getSystemPromptOverride(): string | undefined {
    return this.systemPromptOverride;
  }

  /** 追加到会话记忆 */
  private appendSessionHistory(role: "user" | "assistant", content: string): void {
    this.sessionHistory.push({ role, content, timestamp: Date.now() });
    const MAX_TOTAL = 50;
    if (this.sessionHistory.length > MAX_TOTAL) {
      this.sessionHistory = this.sessionHistory.slice(-MAX_TOTAL);
    }
  }

  /** 从已 drain 的消息构建后续查询（用于等待循环） */
  private buildFollowUpFromMessages(drained: InboxMessage[]): string {
    const messages = drained.map((m) => {
      const sender = m.from === "user" ? "用户" : (this.actorSystem?.get(m.from)?.role.name ?? m.from);
      return `[${sender}]: ${m.content.slice(0, 300)}`;
    });
    return `你收到了新消息：\n${messages.join("\n")}\n\n请处理这些消息。如果所有子任务已完成，请整合结果并输出最终成果。`;
  }

  /** 等待 inbox 有消息或超时 */
  private waitForInbox(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.inbox.length > 0) { resolve(); return; }
      const timer = setTimeout(resolve, timeoutMs);
      const check = setInterval(() => {
        if (this.inbox.length > 0) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 500);
      setTimeout(() => clearInterval(check), timeoutMs + 100);
    });
  }

  /** 停止当前任务 */
  abort(): void {
    this.actorSystem?.cancelPendingInteractionsForActor(this.id);
    this.abortController?.abort();
  }

  private async runWithClarifications(
    query: string,
    images?: string[],
    onStep?: (step: AgentStep) => void,
    runOverrides?: ActorRunOverrides,
  ): Promise<{ result: string; finalQuery: string }> {
    let currentQuery = query;
    let currentImages = images;

    while (true) {
      try {
        const result = await this.runWithInbox(currentQuery, currentImages, onStep, runOverrides);
        return { result, finalQuery: currentQuery };
      } catch (error) {
        if (!(error instanceof ClarificationInterrupt)) {
          throw error;
        }

        const resolution = await this.waitForClarification(error, onStep);
        currentQuery = this.buildClarificationResumeQuery(currentQuery, error, resolution);
        if (resolution.images?.length) {
          currentImages = [...new Set([...(currentImages ?? []), ...resolution.images])];
        }
      }
    }
  }

  private async waitForClarification(
    interrupt: ClarificationInterrupt,
    onStep?: (step: AgentStep) => void,
  ): Promise<{
    status: "answered" | "timed_out" | "cancelled";
    answer: string;
    rawInput?: string;
    wasOptionSelection?: boolean;
    images?: string[];
  }> {
    const question = interrupt.question.trim();
    onStep?.({
      type: "observation",
      content: `等待用户澄清：${question}`,
      toolName: "ask_clarification",
      timestamp: Date.now(),
    });

    if (!interrupt.waitForReply) {
      return { status: "timed_out", answer: "" };
    }

    this.setStatus("waiting");
    const waitingAbort = new AbortController();
    this.abortController = waitingAbort;

    try {
      const resolution = await Promise.race([
        interrupt.waitForReply(),
        new Promise<never>((_, reject) => {
          waitingAbort.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        }),
      ]);

      if (resolution.status === "answered") {
        onStep?.({
          type: "observation",
          content: resolution.images?.length
            ? `用户澄清：${resolution.answer}（附带 ${resolution.images.length} 张图片）`
            : `用户澄清：${resolution.answer}`,
          toolName: "ask_clarification",
          timestamp: Date.now(),
        });
      } else {
        onStep?.({
          type: "observation",
          content: resolution.status === "timed_out"
            ? "用户未在规定时间内回答澄清问题，将基于已有信息继续执行。"
            : "澄清交互已取消，将基于已有信息继续执行。",
          toolName: "ask_clarification",
          timestamp: Date.now(),
        });
      }

      return resolution;
    } finally {
      if (this.abortController === waitingAbort) {
        this.abortController = null;
      }
      if (!waitingAbort.signal.aborted && this._status !== "stopped") {
        this.setStatus("running");
      }
    }
  }

  private buildClarificationResumeQuery(
    baseQuery: string,
    interrupt: ClarificationInterrupt,
    resolution: {
      status: "answered" | "timed_out" | "cancelled";
      answer: string;
      rawInput?: string;
      wasOptionSelection?: boolean;
      images?: string[];
    },
  ): string {
    const clarificationBlock = resolution.status === "answered"
      ? [
          "[用户澄清补充]",
          `问题：${interrupt.question}`,
          `回答：${resolution.answer}`,
          resolution.images?.length ? `附带图片：\n${resolution.images.map((image) => `- ${image}`).join("\n")}` : "",
          resolution.wasOptionSelection ? `原始输入：${resolution.rawInput ?? resolution.answer}` : "",
          "请基于这个澄清继续原任务，不要重复之前已经完成的工作。",
        ].filter(Boolean).join("\n")
      : [
          "[澄清未完成]",
          `问题：${interrupt.question}`,
          resolution.status === "timed_out"
            ? "用户暂未回复，请基于已有信息继续执行，并在结果中明确你的假设。"
            : "本次澄清已取消，请基于已有信息继续执行，并在结果中明确你的假设。",
        ].join("\n");

    return `${baseQuery}\n\n${clarificationBlock}`;
  }

  /** 完全停止 Actor */
  stop(): void {
    this.abort();
    this.setStatus("stopped");
    this.inbox = [];
  }

  // ── Events ──

  on(handler: ActorEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  // ── Internal ──

  private setStatus(status: ActorStatus): void {
    if (this._status === status) return;
    const prev = this._status;
    this._status = status;
    this.emit("status_change", { prev, next: status });
  }

  private emit(type: ActorEventType, detail?: unknown): void {
    const event: ActorEvent = {
      type,
      actorId: this.id,
      timestamp: Date.now(),
      detail,
    };
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch { /* non-critical */ }
    }
  }

  /**
   * Build the ActorRunContext from current actor state, run the middleware chain,
   * then create and execute the ReActAgent.
   */
  private async runWithInbox(
    query: string,
    images?: string[],
    onStep?: (step: AgentStep) => void,
    runOverrides?: ActorRunOverrides,
  ): Promise<string> {
    const effectiveModelOverride = runOverrides?.model ?? this.modelOverride;
    const globalMaxIterations = Math.max(
      5,
      Math.min(50, useAIStore.getState().config.agent_max_iterations ?? 25),
    );
    const effectiveMaxIterations = Math.max(
      1,
      Math.min(runOverrides?.maxIterations ?? this.maxIterations, globalMaxIterations),
    );
    const effectiveSystemPromptOverride = runOverrides?.systemPromptAppend
      ? [this.systemPromptOverride ?? this.role.systemPrompt, runOverrides.systemPromptAppend]
        .filter(Boolean)
        .join("\n\n")
      : this.systemPromptOverride;
    const effectiveContextTokens = runOverrides?.contextTokens ?? this._contextTokens;
    const effectiveToolPolicy = runOverrides?.toolPolicy ?? this.toolPolicy;
    const effectiveMiddlewareOverrides = runOverrides?.middlewareOverrides ?? this._middlewareOverrides;
    const effectiveTemperature = runOverrides?.temperature
      ?? this.role.temperature
      ?? useAIStore.getState().config.temperature
      ?? 0.7;

    actorLog(this.role.name, `runWithInbox: model=${effectiveModelOverride ?? "default"}, maxIter=${effectiveMaxIterations}, inboxSize=${this.inbox.length}`);

    const ctx: ActorRunContext = {
      query,
      images,
      onStep,
      actorId: this.id,
      role: this.role,
      modelOverride: effectiveModelOverride,
      maxIterations: effectiveMaxIterations,
      systemPromptOverride: effectiveSystemPromptOverride,
      workspace: this._workspace,
      contextTokens: effectiveContextTokens,
      toolPolicy: effectiveToolPolicy,
      actorSystem: this.actorSystem,
      askUser: this.askUser,
      confirmDangerousAction: this.confirmDangerousAction,
      extraTools: this.extraTools,
      middlewareOverrides: effectiveMiddlewareOverrides,
      tools: [],
      rolePrompt: "",
      hasCodingWorkflowSkill: false,
      fcCompatibilityKey: "",
      contextMessages: this.buildContextMessages(),
    };

    await runMiddlewareChain(createDefaultMiddlewares(), ctx);

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const ai = getMToolsAI();

    const agent = new ReActAgent(
      ai,
      ctx.tools,
      {
        maxIterations: effectiveMaxIterations,
        verbose: true,
        fcCompatibilityKey: ctx.fcCompatibilityKey,
        temperature: effectiveTemperature,
        initialMode: "execute",
        userMemoryPrompt: ctx.userMemoryPrompt,
        skillsPrompt: ctx.skillsPrompt,
        skipInternalCodingBlock: ctx.hasCodingWorkflowSkill,
        roleOverride: ctx.rolePrompt || undefined,
        dangerousToolPatterns: ["write_file", "run_shell_command", "native_"],
        confirmDangerousAction: this.confirmDangerousAction,
        onToolExecuted: ctx.notifyToolCalled,
        modelOverride: effectiveModelOverride,
        contextBudget: effectiveContextTokens,
        contextMessages: ctx.contextMessages,
        inboxDrain: () => {
          const drained = this.drainInbox();
          if (drained.length > 0) {
            actorLog(this.role.name, `inboxDrain: ${drained.length} messages drained`);
            if (!this._capturedInboxUserQuery) {
              const userMsgs = drained.filter((m) => m.from === "user");
              if (userMsgs.length > 0) {
                this._capturedInboxUserQuery = userMsgs.map((m) => m.content).join("\n\n");
              }
            }
          }
          return drained.map((m) => ({
            ...m,
            from: (m.from === "user") ? "用户" : (this.actorSystem?.get(m.from)?.role.name ?? m.from),
          }));
        },
      },
      (step) => {
        onStep?.(step);
        if (this.actorSystem && step.toolName) {
          if (step.type === "action" && step.toolInput) {
            appendToolCall(this.actorSystem.sessionId, this.id, step.toolName, step.toolInput);
            buildArtifactPayloadFromToolCall(this.id, this.actorSystem, step.toolName, step.toolInput);
          } else if (step.type === "observation" && step.toolOutput !== undefined) {
            appendToolResult(this.actorSystem.sessionId, this.id, step.toolName, step.toolOutput);
          }
        }
      },
    );

    try {
      if (ctx.withRetry && ctx.retryConfig) {
        const retryConf = ctx.retryConfig as Required<typeof ctx.retryConfig>;
        const answer = await ctx.withRetry(() => agent.run(query, signal, images), retryConf, `LLM call for ${this.role.name}`);
        return answer;
      }
      const answer = await agent.run(query, signal, images);
      return answer;
    } finally {
      this.abortController = null;
    }
  }
}
