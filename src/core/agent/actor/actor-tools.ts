import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorSystem } from "./actor-system";
import type { AgentCapability, SpawnedTaskRoleBoundary } from "./types";
import type { AgentScheduledTask, AgentTaskOriginMode } from "@/core/ai/types";
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
  compactTranscript,
} from "./actor-transcript";

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

  const resolveTarget = (nameOrId: string): string => {
    const actor = system.get(nameOrId);
    if (actor) return nameOrId;
    const all = system.getAll();
    const found = all.find((a) => a.role.name === nameOrId);
    return found?.id ?? nameOrId;
  };

  const getActorName = (id: string): string => {
    const actor = system.get(id);
    return actor?.role.name ?? id;
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

  // ── spawn_task (对标 OpenClaw sessions_spawn) ──
  tools.push({
    name: "spawn_task",
    description:
      "将一个子任务派发给另一个 Agent 执行。系统会自动追踪任务进度，" +
      "目标 Agent 完成后结果会自动发送到你的收件箱。此操作是非阻塞的。" +
      "适用于将大任务分解为子任务分配给不同 Agent 并行执行。" +
      "当目标 Agent 不存在时，也可以按需创建临时子 Agent。",
    parameters: {
      target_agent: {
        type: "string",
        description: "目标 Agent 的名称；若不存在且 create_if_missing=true，则会创建同名临时子 Agent",
        required: true,
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
        description: "超时时间（秒），默认 120 秒。超时后子任务自动终止。",
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
        description: "当目标 Agent 不存在时，是否自动创建一个临时子 Agent（默认 false）",
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
      const targetInput = String(params.target_agent);
      const target = resolveTarget(targetInput);
      const task = String(params.task);
      const label = params.label ? String(params.label) : undefined;
      const context = params.context ? String(params.context) : undefined;
      const timeoutSeconds = params.timeout_seconds ? Number(params.timeout_seconds) : undefined;
      const attachments = params.attachments
        ? String(params.attachments).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const mode = params.mode === "session" ? "session" : "run";
      const createIfMissing = params.create_if_missing === true;
      const cleanup = params.cleanup === "delete"
        ? "delete"
        : (params.cleanup === "keep" ? "keep" : undefined);
      const expectsCompletionMessage = params.expects_completion !== false;
      const childCapabilities = parseCapabilities(params.agent_capabilities);
      const roleBoundary = parseRoleBoundary(params.role_boundary);

      // Subagent 独立配置
      const overrides: import("./types").SpawnTaskOverrides = {};
      if (params.override_model) overrides.model = String(params.override_model);
      if (params.override_max_iterations) overrides.maxIterations = Number(params.override_max_iterations);
      if (params.override_tools_allow || params.override_tools_deny) {
        overrides.toolPolicy = {};
        if (params.override_tools_allow) {
          overrides.toolPolicy.allow = String(params.override_tools_allow).split(",").map((s) => s.trim()).filter(Boolean);
        }
        if (params.override_tools_deny) {
          overrides.toolPolicy.deny = String(params.override_tools_deny).split(",").map((s) => s.trim()).filter(Boolean);
        }
      }
      if (params.override_system_prompt_append) {
        overrides.systemPromptAppend = String(params.override_system_prompt_append);
      }
      const hasOverrides = Object.keys(overrides).length > 0;

      const result = system.spawnTask(actorId, target, task, {
        label,
        context,
        timeoutSeconds,
        attachments,
        images: currentInheritedImages,
        mode,
        cleanup,
        expectsCompletionMessage,
        roleBoundary,
        createIfMissing,
        createChildSpec: createIfMissing
          ? {
              description: params.agent_description ? String(params.agent_description) : undefined,
              capabilities: childCapabilities,
              workspace: params.agent_workspace ? String(params.agent_workspace) : undefined,
            }
          : undefined,
        overrides: hasOverrides ? overrides : undefined,
      });

      if ("error" in result) {
        return { spawned: false, error: result.error };
      }
      return {
        spawned: true,
        runId: result.runId,
        mode: result.mode,
        to: getActorName(result.targetActorId),
        label: result.label,
        roleBoundary: result.roleBoundary,
        hint: `任务已派发（mode=${result.mode}），${result.mode === "run" ? "完成后结果会自动发送到你的收件箱" : "子 agent 会保持活跃状态"}。你可以继续做其他事，或用 agents(action='list') 查看进度。`,
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
      const descendants = system.getDescendantTasks(actorId);

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
            running: cron.list().filter((job) => job.status === "running").length,
            paused: cron.list().filter((job) => job.status === "paused").length,
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
