import { invoke } from "@tauri-apps/api/core";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import type {
  AgentScheduledTask,
  AgentTaskStatusPatch,
  AgentTaskStatus,
} from "@/core/ai/types";
import { handleError, ErrorLevel } from "@/core/errors";
import { registry } from "@/core/plugin-system/registry";
import { useAIStore } from "@/store/ai-store";
import { useAgentStore } from "@/store/agent-store";
import { getResolvedAIConfigForMode } from "@/core/ai/resolved-ai-config-store";
import { agentRuntimeManager } from "@/core/agent/runtime";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import {
  ReActAgent,
  pluginActionToTool,
  type AgentStep,
  type AgentTool,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import { applyIncomingAgentStep } from "@/plugins/builtin/SmartAgent/core/agent-task-state";
import { loadAndResolveSkills } from "@/store/skill-store";
import { applySkillToolFilter } from "@/core/agent/skills/skill-resolver";
import { useActorSystemStore } from "@/store/actor-system-store";
import { getChannelManager } from "@/core/channels";
import {
  inferDirectScheduledDelivery,
  parsePersistentScheduledQuery,
} from "@/core/agent/scheduled-task-utils";
import {
  buildAssistantSupplementalPrompt,
  filterAssistantToolsByConfig,
  shouldAutoSaveAssistantMemory,
  shouldRecallAssistantMemory,
} from "@/core/ai/assistant-config";
import { useAgentMemoryStore } from "@/store/agent-memory-store";
import {
  autoExtractMemories,
  createMemoryTools,
} from "@/core/agent/actor/actor-memory";
import { buildKnowledgeContextMessages } from "@/core/agent/actor/middlewares/knowledge-base-middleware";
import {
  assembleAgentExecutionContext,
  buildAgentExecutionContextPlan,
} from "@/core/agent/context-runtime";

type QueueItem = {
  task: AgentScheduledTask;
  attempt: number;
};

export interface AgentRunnerServiceOptions {
  executeTask?: (task: AgentScheduledTask, attempt: number) => Promise<void>;
  setTimeoutFn?: typeof setTimeout;
}

function buildRunnerTools(): AgentTool[] {
  const ai = getMToolsAI("agent");
  const allActions = registry.getAllActions();
  const tools: AgentTool[] = allActions.map(({ pluginId, pluginName, action }) =>
    pluginActionToTool(pluginId, pluginName, action, ai),
  );

  tools.push({
    name: "get_current_time",
    description: "获取当前时间",
    execute: async () => ({
      time: new Date().toLocaleString("zh-CN"),
      timestamp: Date.now(),
    }),
  });

  tools.push({
    name: "calculate",
    description: "执行数学计算",
    parameters: {
      expression: { type: "string", description: "数学表达式（如 2+3*4）" },
    },
    execute: async (params) => {
      try {
        const expr = String(params.expression).replace(/[^0-9+\-*/().%\s]/g, "");
        if (!expr.trim()) return { error: "无效表达式" };
        const result = Function('"use strict"; return (' + expr + ")")();
        if (typeof result !== "number" || !isFinite(result)) {
          return { error: `计算结果无效: ${result}` };
        }
        return { expression: params.expression, result };
      } catch (e) {
        return { error: `计算失败: ${e}` };
      }
    },
  });

  tools.push(
    ...createMemoryTools({
      sourceMode: "agent",
      saveReason: "定时任务执行链建议记录这条长期记忆候选",
    }),
  );

  const runtimeOptions = { allowUnattendedHostFallback: true };

  // 与 SmartAgent 保持一致，编排任务也支持代码读写/检索能力
  tools.push({
    name: "list_directory",
    description: "列出目录下的文件和子目录（用于定位项目结构）",
    parameters: {
      path: { type: "string", description: "目录路径（建议绝对路径）" },
    },
    execute: async (params) => {
      const path = String(params.path || ".");
      return invoke("list_directory", { path });
    },
  });

  tools.push({
    name: "read_file",
    description: "读取本地文本文件（代码、配置、日志等）",
    parameters: {
      path: { type: "string", description: "文件路径（建议绝对路径）" },
    },
    execute: async (params) => {
      const path = String(params.path || "");
      if (!path.trim()) return { error: "path 不能为空" };
      return invoke("read_text_file", { path });
    },
  });

  tools.push({
    name: "read_file_range",
    description: "按行读取代码文件，返回行号，适合定位函数和分析上下文",
    parameters: {
      path: { type: "string", description: "文件路径（建议绝对路径）" },
      start_line: {
        type: "integer",
        description: "起始行（可选，默认 1）",
        required: false,
      },
      end_line: {
        type: "integer",
        description: "结束行（可选）",
        required: false,
      },
      max_lines: {
        type: "integer",
        description: "最多返回行数（可选）",
        required: false,
      },
    },
    execute: async (params) => {
      const path = String(params.path || "");
      if (!path.trim()) return { error: "path 不能为空" };
      const start_line =
        typeof params.start_line === "number"
          ? Math.floor(params.start_line)
          : undefined;
      const end_line =
        typeof params.end_line === "number" ? Math.floor(params.end_line) : undefined;
      const max_lines =
        typeof params.max_lines === "number" ? Math.floor(params.max_lines) : undefined;
      return invoke("read_text_file_range", {
        path,
        start_line,
        end_line,
        max_lines,
      });
    },
  });

  tools.push({
    name: "search_in_files",
    description: "递归搜索项目中的文本，返回匹配文件和行号",
    parameters: {
      path: { type: "string", description: "目录路径（建议绝对路径）" },
      query: { type: "string", description: "要搜索的关键词" },
      case_sensitive: {
        type: "boolean",
        description: "是否区分大小写（可选）",
        required: false,
      },
      max_results: {
        type: "integer",
        description: "最大结果数量（可选）",
        required: false,
      },
      file_pattern: {
        type: "string",
        description: "文件过滤模式，如 *.ts、*.rs（可选）",
        required: false,
      },
    },
    execute: async (params) => {
      const path = String(params.path || "");
      const query = String(params.query || "");
      if (!path.trim()) return { error: "path 不能为空" };
      if (!query.trim()) return { error: "query 不能为空" };
      const case_sensitive =
        typeof params.case_sensitive === "boolean" ? params.case_sensitive : undefined;
      const max_results =
        typeof params.max_results === "number"
          ? Math.floor(params.max_results)
          : undefined;
      const file_pattern =
        typeof params.file_pattern === "string" ? params.file_pattern : undefined;
      return invoke("search_in_files", {
        path,
        query,
        case_sensitive,
        max_results,
        file_pattern,
      });
    },
  });

  tools.push({
    name: "write_file",
    description: "写入本地文本文件（会覆盖目标文件）",
    parameters: {
      path: { type: "string", description: "文件路径（建议绝对路径）" },
      content: { type: "string", description: "要写入的文本内容" },
    },
    dangerous: true,
    execute: async (params) => {
      const path = String(params.path || "");
      if (!path.trim()) return { error: "path 不能为空" };
      const content = String(params.content || "");
      return agentRuntimeManager.writeTextFile(path, content, runtimeOptions);
    },
  });

  tools.push({
    name: "run_shell_command",
    description: "执行终端命令（用于构建、测试、格式化、搜索等）",
    parameters: {
      command: { type: "string", description: "命令行指令" },
    },
    dangerous: true,
    execute: async (params) => {
      const command = String(params.command || "").trim();
      if (!command) return { error: "command 不能为空" };
      return agentRuntimeManager.runShellCommand(command, runtimeOptions);
    },
  });

  return tools;
}

export class AgentRunnerService {
  private queue: QueueItem[] = [];

  private queuedTaskIds = new Set<string>();

  private runningTaskIds = new Set<string>();

  private running = 0;

  private executeTask: (task: AgentScheduledTask, attempt: number) => Promise<void>;

  private readonly setTimeoutFn: typeof setTimeout;

  constructor(options: AgentRunnerServiceOptions = {}) {
    this.executeTask =
      options.executeTask ||
      ((task, attempt) => this.executeTaskInternal(task, attempt));
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
  }

  enqueue(task: AgentScheduledTask, attempt = 0) {
    if (this.queuedTaskIds.has(task.id) || this.runningTaskIds.has(task.id)) {
      return;
    }
    this.queue.push({ task, attempt });
    this.queuedTaskIds.add(task.id);
    this.drain();
  }

  private getConcurrency() {
    return Math.max(1, Math.min(8, useAIStore.getState().config.agent_max_concurrency ?? 2));
  }

  private getRetryMax() {
    return Math.max(0, Math.min(10, useAIStore.getState().config.agent_retry_max ?? 3));
  }

  private getRetryBackoffMs() {
    return Math.max(500, Math.min(60000, useAIStore.getState().config.agent_retry_backoff_ms ?? 5000));
  }

  private drain() {
    const maxConcurrency = this.getConcurrency();
    while (this.running < maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) return;
      this.queuedTaskIds.delete(item.task.id);
      if (this.runningTaskIds.has(item.task.id)) {
        continue;
      }
      this.runningTaskIds.add(item.task.id);
      this.running += 1;
      void this.process(item).finally(() => {
        this.runningTaskIds.delete(item.task.id);
        this.running -= 1;
        this.drain();
      });
    }
  }

  private async process(item: QueueItem) {
    const { task, attempt } = item;
    const startedAt = Date.now();
    await this.patchStatus(task.id, "running", {
      retryCount: attempt,
      nextRunAt: task.next_run_at,
      lastError: undefined,
      lastStartedAt: startedAt,
    });

    try {
      await this.executeTask(task, attempt);
      const finishedAt = Date.now();
      await this.patchStatus(task.id, "success", {
        retryCount: attempt,
        nextRunAt: task.next_run_at,
        lastError: undefined,
        lastFinishedAt: finishedAt,
        lastDurationMs: finishedAt - startedAt,
        lastResultStatus: "success",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const retryMax = this.getRetryMax();
      if (attempt < retryMax) {
        const nextAttempt = attempt + 1;
        const delay = this.getRetryBackoffMs() * 2 ** attempt;
        const nextRunAt = Date.now() + delay;
        task.next_run_at = nextRunAt;

        const patch = await this.patchStatus(task.id, "pending", {
          retryCount: nextAttempt,
          nextRunAt,
          lastError: message,
          lastFinishedAt: Date.now(),
          lastDurationMs: Date.now() - startedAt,
          lastResultStatus: "error",
        });

        if (patch?.status === "paused" || patch?.status === "cancelled") {
          return;
        }

        this.setTimeoutFn(() => {
          this.enqueue(task, nextAttempt);
        }, delay);
        return;
      }

      await this.patchStatus(task.id, "error", {
        retryCount: attempt,
        nextRunAt: task.next_run_at,
        lastError: message,
        lastFinishedAt: Date.now(),
        lastDurationMs: Date.now() - startedAt,
        lastResultStatus: "error",
      });
    }
  }

  private async executeTaskInternal(task: AgentScheduledTask, attempt: number) {
    const shouldDeliverDirectly = task.trigger_action === "deliver_message"
      || (!task.trigger_action && (!!task.delivery_text?.trim() || !!inferDirectScheduledDelivery(task.query)));
    if (shouldDeliverDirectly) {
      await this.executeDirectDeliveryTask(task);
      return;
    }

    const ai = getMToolsAI("agent");
    const aiConfig = useAIStore.getState().config;
    const availableTools = filterAssistantToolsByConfig(buildRunnerTools(), aiConfig);

    const store = useAgentStore.getState();
    let sessionId = task.session_id || store.currentSessionId;
    let taskId = "";
    const historySteps: AgentStep[] = [];
    let session = sessionId
      ? store.sessions.find((s) => s.id === sessionId)
      : undefined;

    if (!sessionId || !session) {
      sessionId = store.createSession(task.query);
      const created = useAgentStore
        .getState()
        .sessions.find((s) => s.id === sessionId);
      taskId = created?.tasks[0]?.id || "";
      session = created;
    } else {
      if (session) {
        for (const t of session.tasks) {
          historySteps.push(...t.steps);
          if (t.answer) {
            historySteps.push({
              type: "answer",
              content: t.answer,
              timestamp: session.createdAt,
            });
          }
        }
      }
      taskId = store.addTask(sessionId, task.query);
      session = useAgentStore.getState().sessions.find((s) => s.id === sessionId) ?? session;
    }

    if (!taskId) {
      throw new Error("无法创建执行任务");
    }

    const startedAt = Date.now();
    const fcCompatibilityKey = buildAgentFCCompatibilityKey(
      getResolvedAIConfigForMode("agent"),
    );
    store.updateTask(sessionId, taskId, {
      status: "running",
      retry_count: attempt,
      last_error: undefined,
      next_run_at: task.next_run_at,
      last_started_at: startedAt,
    });

    const skillCtx = await loadAndResolveSkills(task.query);
    const skillsPrompt = skillCtx.mergedSystemPrompt || undefined;
    const hasCodingWorkflowSkill = skillCtx.visibleSkillIds.includes("builtin-coding-workflow");
    const toolsForRun = applySkillToolFilter(availableTools, skillCtx.mergedToolFilter);
    let userMemoryPrompt: string | undefined;
    if (shouldRecallAssistantMemory(aiConfig)) {
      let memorySnap = useAgentMemoryStore.getState();
      if (!memorySnap.loaded) {
        try {
          await memorySnap.load();
          memorySnap = useAgentMemoryStore.getState();
        } catch {
          memorySnap = useAgentMemoryStore.getState();
        }
      }
      userMemoryPrompt = await memorySnap.getMemoriesForQueryPromptAsync(task.query, {
        topK: 6,
        conversationId: sessionId,
        workspaceId: session?.workspaceRoot,
        preferSemantic: true,
      }) || undefined;
    }
    const knowledgeContextMessages = await buildKnowledgeContextMessages(task.query);
    const executionContextPlan = await buildAgentExecutionContextPlan({
      query: task.query,
      currentSession: session,
    });
    store.updateSession(sessionId, {
      ...(executionContextPlan.workspaceRootToPersist
        ? { workspaceRoot: executionContextPlan.workspaceRootToPersist }
        : {}),
      lastContinuityStrategy: executionContextPlan.continuity.strategy,
      lastContinuityReason: executionContextPlan.continuity.reason,
      lastContextResetAt: executionContextPlan.shouldResetInheritedContext
        ? Date.now()
        : undefined,
    });
    session = useAgentStore.getState().sessions.find((s) => s.id === sessionId) ?? session;
    const assembledContext = await assembleAgentExecutionContext({
      session,
      query: task.query,
      executionContextPlan,
      userMemoryPrompt,
      skillsPrompt,
      supplementalSystemPrompt: buildAssistantSupplementalPrompt(aiConfig.system_prompt),
      knowledgeContextMessageCount: knowledgeContextMessages.length,
    });

    const collectedSteps: AgentStep[] = [];
    const agent = new ReActAgent(
      ai,
      toolsForRun,
      {
        maxIterations: Math.max(5, Math.min(50, aiConfig.agent_max_iterations ?? 25)),
        verbose: true,
        fcCompatibilityKey,
        temperature: aiConfig.temperature ?? 0.7,
        userMemoryPrompt,
        skillsPrompt,
        extraSystemPrompt: assembledContext.extraSystemPrompt,
        skipInternalCodingBlock: hasCodingWorkflowSkill,
        contextMessages: [
          ...assembledContext.sessionContextMessages,
          ...knowledgeContextMessages,
        ],
      },
      (step) => {
        const nextSteps = applyIncomingAgentStep(collectedSteps, step);
        collectedSteps.splice(0, collectedSteps.length, ...nextSteps);

        useAgentStore.getState().updateTask(sessionId!, taskId, {
          steps: [...collectedSteps],
        });
      },
      historySteps,
    );

    const result = await agent.run(task.query);
    if (shouldAutoSaveAssistantMemory(aiConfig)) {
      void autoExtractMemories(`${task.query}\n${result}`, task.id, {
        sourceMode: "agent",
      }).catch(() => undefined);
    }

    const finishedAt = Date.now();
    useAgentStore.getState().updateTask(sessionId, taskId, {
      answer: result,
      status: "success",
      retry_count: attempt,
      last_error: undefined,
      next_run_at: task.next_run_at,
      last_finished_at: finishedAt,
      last_duration_ms: finishedAt - startedAt,
      last_result_status: "success",
    });
  }

  private async executeDirectDeliveryTask(task: AgentScheduledTask): Promise<void> {
    const parsed = parsePersistentScheduledQuery(task.query);
    const inferred = inferDirectScheduledDelivery(task.query);
    const deliveryText =
      task.delivery_text?.trim()
      || inferred?.text
      || (parsed.title.trim() ? `提醒：${parsed.title.trim()}` : "提醒时间到了。");

    try {
      await invoke("agent_show_notification", {
        title: "51ToolBox 提醒",
        body: deliveryText,
      });
    } catch (error) {
      handleError(error, {
        context: `发送系统通知失败(${task.id})`,
        level: ErrorLevel.Warning,
        silent: true,
      });
    }

    if (task.origin_channel_id?.trim() && task.origin_conversation_id?.trim()) {
      try {
        await getChannelManager().sendScheduledReminder(task, deliveryText);
      } catch (error) {
        handleError(error, {
          context: `发送渠道提醒失败(${task.id})`,
          level: ErrorLevel.Warning,
          silent: true,
        });
      }
    }

    const system = useActorSystemStore.getState().getSystem();
    if (system && task.origin_session_id === system.sessionId) {
      system.publishSystemNotice(deliveryText, { from: "scheduler" });
      useActorSystemStore.getState().sync();
    }

    useAgentStore.getState().upsertScheduledTask({
      ...task,
      delivery_text: deliveryText,
    });
  }

  private async patchStatus(
    taskId: string,
    status: AgentTaskStatus,
    extra: {
      retryCount: number;
      nextRunAt?: number;
      lastError?: string;
      lastStartedAt?: number;
      lastFinishedAt?: number;
      lastDurationMs?: number;
      lastResultStatus?: "success" | "error" | "skipped";
    },
  ): Promise<AgentTaskStatusPatch | null> {
    try {
      const patch = await invoke<AgentTaskStatusPatch>("agent_task_set_status", {
        taskId,
        status,
        retryCount: extra.retryCount,
        nextRunAt: extra.nextRunAt ?? null,
        lastError: extra.lastError ?? null,
        lastStartedAt: extra.lastStartedAt ?? null,
        lastFinishedAt: extra.lastFinishedAt ?? null,
        lastDurationMs: extra.lastDurationMs ?? null,
        lastResultStatus: extra.lastResultStatus ?? null,
      });
      useAgentStore.getState().applyScheduledTaskPatch(patch);
      return patch;
    } catch (e) {
      handleError(e, {
        context: `更新 Agent 任务状态(${taskId})`,
        level: ErrorLevel.Warning,
        silent: true,
      });
      return null;
    }
  }
}

export const agentRunnerService = new AgentRunnerService();
