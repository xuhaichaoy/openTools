import { getMToolsAI } from "@/core/ai/mtools-ai";
import { useAIStore } from "@/store/ai-store";
import { useAgentMemoryStore } from "@/store/agent-memory-store";
import { loadAndResolveSkills } from "@/store/skill-store";
import { applySkillToolFilter } from "@/core/agent/skills/skill-resolver";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import { registry } from "@/core/plugin-system/registry";
import {
  ReActAgent,
  pluginActionToTool,
  type AgentTool,
  type AgentStep,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import {
  createBuiltinAgentTools,
  type AskUserQuestion,
  type AskUserAnswers,
} from "@/plugins/builtin/SmartAgent/core/default-tools";
import type { AgentRole } from "@/core/agent/cluster/types";
import type { ActorSystem } from "./actor-system";
import { createActorCommunicationTools } from "./actor-tools";
import { createActorMemoryTools, autoExtractMemories } from "./actor-memory";
import { appendToolCallSync as appendToolCall, appendToolResultSync as appendToolResult } from "./actor-transcript";
import type {
  AgentCapabilities,
  ActorConfig,
  ActorEvent,
  ActorEventType,
  ActorStatus,
  ActorTask,
  InboxMessage,
  ThinkingLevel,
  ToolPolicy,
} from "./types";

const generateId = () =>
  Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

const actorLog = (name: string, ...args: unknown[]) => console.log(`[AgentActor:${name}]`, ...args);

/** Rough token estimate (~4 chars per token for mixed CJK/English) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

type ActorEventHandler = (event: ActorEvent) => void;
export type AskUserCallback = (questions: AskUserQuestion[]) => Promise<AskUserAnswers>;
type ConfirmDangerousAction = (toolName: string, params: Record<string, unknown>) => Promise<boolean>;

// ── Tool builders (shared with local-agent-bridge) ──

function getPluginTools(): AgentTool[] {
  const ai = getMToolsAI();
  return registry.getAllActions().map(({ pluginId, pluginName, action }) =>
    pluginActionToTool(pluginId, pluginName, action, ai),
  );
}

function getBuiltinTools(askUser?: AskUserCallback) {
  const confirmHostFallback = async () => true;
  return createBuiltinAgentTools(confirmHostFallback, askUser);
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

  /** 会话记忆：跨任务保留对话上下文（对标 OpenClaw 持久会话） */
  private sessionHistory: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [];

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
      const reply = await this.actorSystem.askUserInChat(this.id, questionText);
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
   * 注意：不在此处清空 inbox，让 inboxDrain 钩子在 ReAct 循环首次迭代时获取消息（保留 ID 等元数据）。
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
      actorLog(this.role.name, `wakeUpForInbox: starting task, inboxSize=${this.inbox.length}`);
      // Minimal trigger — full messages (with id, priority, replyTo, etc.)
      // will be delivered via the inboxDrain hook on the first ReAct iteration
      void this.assignTask("[inbox] 处理收件箱中的新消息");
    });
  }

  /** 手动读取并清空 inbox */
  drainInbox(): InboxMessage[] {
    const messages = this.inbox.splice(0);
    return messages;
  }

  /**
   * 分配任务并异步执行。
   * 包含会话记忆（上下文连续）和等待循环（等待 spawned tasks 完成后整合）。
   */
  async assignTask(query: string, images?: string[], opts?: { publishResult?: boolean }): Promise<ActorTask> {
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

      if (this._timeoutSeconds && this._timeoutSeconds > 0) {
        globalTimeoutId = setTimeout(() => {
          actorLog(this.role.name, `assignTask: GLOBAL TIMEOUT after ${this._timeoutSeconds}s, aborting task ${task.id}`);
          this.abort();
        }, this._timeoutSeconds * 1000);
      }

      actorLog(this.role.name, `📝 assignTask: executing with sessionHistory=${this.sessionHistory.length} entries, inbox=${this.inbox.length}`);
      let result = await this.runWithInbox(query, images, (step) => {
        task.steps.push(step);
        this.emit("step", { taskId: task.id, step });
      });
      this.appendSessionHistory("user", query);
      this.appendSessionHistory("assistant", result ?? "");

      // 等待循环：如果有未完成的 spawned tasks，保持运行等待结果回送
      const WAIT_POLL_MS = 5_000;
      const MAX_WAIT_ROUNDS = 60; // 最多等 5 分钟
      let waitRound = 0;
      while (
        this.actorSystem?.getActiveSpawnedTasks(this.id).length &&
        waitRound < MAX_WAIT_ROUNDS
      ) {
        const activeCount = this.actorSystem.getActiveSpawnedTasks(this.id).length;
        actorLog(this.role.name, `assignTask: waiting for ${activeCount} spawned tasks (round ${waitRound + 1})...`);
        await this.waitForInbox(WAIT_POLL_MS);
        if (this.inbox.length > 0) {
          const followUpQuery = this.buildFollowUpFromInbox();
          actorLog(this.role.name, `assignTask: processing ${this.inbox.length} inbox messages in follow-up run`);
          const followUpResult = await this.runWithInbox(
            followUpQuery,
            undefined,
            (step) => { task.steps.push(step); this.emit("step", { taskId: task.id, step }); },
          );
          this.appendSessionHistory("user", followUpQuery);
          this.appendSessionHistory("assistant", followUpResult ?? "");
          result = followUpResult ?? result;
        }
        waitRound++;
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
      autoExtractMemories(memContent, task.id).catch(() => {});
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

  /** 从 inbox 中构建后续查询（用于等待循环） */
  private buildFollowUpFromInbox(): string {
    const messages = this.inbox.map((m) => {
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
    this.abortController?.abort();
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
   * 核心执行方法：构建 ReActAgent，注入 inboxDrain 钩子。
   * Agent 在每个 iteration 间隙会检查 inbox 中是否有新消息。
   */
  private async runWithInbox(
    query: string,
    images?: string[],
    onStep?: (step: AgentStep) => void,
  ): Promise<string> {
    actorLog(this.role.name, `runWithInbox: model=${this.modelOverride ?? "default"}, maxIter=${this.maxIterations}, inboxSize=${this.inbox.length}`);
    const ai = getMToolsAI();
    const builtinResult = getBuiltinTools(this.askUser);
    builtinResult.resetPerRunState();
    const { notifyToolCalled } = builtinResult;
    const commTools = this.actorSystem
      ? createActorCommunicationTools(this.id, this.actorSystem)
      : [];
    const memoryTools = createActorMemoryTools(this.id);
    const allTools = [...getPluginTools(), ...builtinResult.tools, ...this.extraTools, ...commTools, ...memoryTools];

    const fcCompatibilityKey = buildAgentFCCompatibilityKey(
      useAIStore.getState().config,
    );

    let memorySnap = useAgentMemoryStore.getState();
    if (!memorySnap.loaded) {
      try { await memorySnap.load(); memorySnap = useAgentMemoryStore.getState(); } catch { /* ignore */ }
    }
    const userMemory = memorySnap.getMemoriesForPrompt();
    const userMemoryPrompt = userMemory ? `\n\n## 用户偏好\n${userMemory}` : undefined;

    const skillCtx = await loadAndResolveSkills(query, this.role.id);
    const skillsPrompt = skillCtx.mergedSystemPrompt || undefined;
    const hasCodingWorkflowSkill = skillCtx.activeSkillIds.includes("builtin-coding-workflow");
    let toolsAfterSkills = applySkillToolFilter(allTools, skillCtx.mergedToolFilter);
    toolsAfterSkills = this.applyToolPolicy(toolsAfterSkills);

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let rolePrompt = this.systemPromptOverride ?? this.role.systemPrompt ?? "";
    if (this._workspace) {
      rolePrompt += `\n\n## 工作目录\n你的工作目录为: ${this._workspace}\n执行 shell 命令和文件操作时，请在此目录下进行。`;
    }
    // 多 Agent 时提示协作（派活 + 讨论）
    if (this.actorSystem && this.actorSystem.size >= 2) {
      const otherAgents = this.actorSystem.getAll().filter((a) => a.id !== this.id);
      const agentNames = otherAgents.map((a) => a.role.name).join("、");
      const coordinator = this.actorSystem.getFirstActor();
      const isCoordinator = coordinator?.id === this.id;
      rolePrompt += `\n\n## 多 Agent 协作（重要！）
当前会话中有 ${this.actorSystem.size} 个 Agent：${agentNames}

你有两种方式与其他 Agent 协作：

1. **派发子任务**：用 \`spawn_task\` 派发给其他 Agent 执行（如 @${agentNames}），结果会自动回送
2. **发起讨论**：用 \`send_message\` 向其他 Agent 发送消息、分享发现、提出问题、请求建议

**典型场景**：
- 需要别人帮你完成部分工作时 → 用 \`spawn_task\` 派发任务
- 想和别人讨论一个问题时 → 用 \`send_message\` 发起对话
- 遇到难题时 → 可以先 \`send_message\` 询问其他 Agent 的看法，再决定是否派发任务

**不要独自完成所有工作！主动与其他 Agent 讨论和协作，你能更快更好地完成复杂任务。**`;
      if (!isCoordinator) {
        rolePrompt += `\n\n## 当前角色：执行者（非协调者）
- 你当前不是协调者，默认不要向用户发“收到/待命/请分配任务”这类回执消息。
- 除非被明确要求，不要安排其他 Agent，不要重复分工，不要宣称“我来协调”。
- 你的职责是执行被分配的任务，并输出可直接使用的结果。`;
      }
    }

    const agent = new ReActAgent(
      ai,
      toolsAfterSkills,
      {
        maxIterations: this.maxIterations,
        verbose: true,
        fcCompatibilityKey,
        temperature: this.role.temperature,
        initialMode: "execute",
        userMemoryPrompt,
        skillsPrompt,
        skipInternalCodingBlock: hasCodingWorkflowSkill,
        roleOverride: rolePrompt || undefined,
        dangerousToolPatterns: ["write_file", "run_shell_command", "native_"],
        confirmDangerousAction: this.confirmDangerousAction,
        onToolExecuted: notifyToolCalled,
        modelOverride: this.modelOverride,
        contextBudget: this._contextTokens,
        contextMessages: this.buildContextMessages(),
        inboxDrain: () => {
          const drained = this.drainInbox();
          if (drained.length > 0) {
            actorLog(this.role.name, `inboxDrain: ${drained.length} messages drained`);
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
          } else if (step.type === "observation" && step.toolOutput !== undefined) {
            appendToolResult(this.actorSystem.sessionId, this.id, step.toolName, step.toolOutput);
          }
        }
      },
    );

    try {
      const answer = await agent.run(query, signal, images);
      return answer;
    } finally {
      this.abortController = null;
    }
  }

  /**
   * 根据 toolPolicy 过滤工具列表。
   * 通信工具（spawn_task, send_message, agents 等）始终保留。
   */
  private applyToolPolicy(tools: AgentTool[]): AgentTool[] {
    if (!this.toolPolicy) return tools;
    const { allow, deny } = this.toolPolicy;
    const commToolNames = new Set([
      "spawn_task", "send_message", "agents",
      "memory_search", "memory_save",
      "session_history", "session_list",
    ]);

    return tools.filter((t) => {
      if (commToolNames.has(t.name)) return true;
      if (deny?.length && matchesGlob(t.name, deny)) return false;
      if (allow?.length && !matchesGlob(t.name, allow)) return false;
      return true;
    });
  }
}

function matchesGlob(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
    if (p.startsWith("*")) return name.endsWith(p.slice(1));
    return name === p;
  });
}
