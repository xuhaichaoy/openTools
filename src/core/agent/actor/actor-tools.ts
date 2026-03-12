import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorSystem } from "./actor-system";
import {
  readSessionHistory,
  getSessionSummary,
  listTranscriptSessionIds,
  compactTranscript,
} from "./actor-transcript";

/**
 * 创建 Actor 间通信工具集（对标 OpenClaw sessions_spawn / subagents / sessions_send）。
 * 每个 AgentActor 实例获得一组绑定了自身 id 的工具。
 */
export function createActorCommunicationTools(
  actorId: string,
  system: ActorSystem,
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

  // ── spawn_task (对标 OpenClaw sessions_spawn) ──
  tools.push({
    name: "spawn_task",
    description:
      "将一个子任务派发给另一个 Agent 执行。系统会自动追踪任务进度，" +
      "目标 Agent 完成后结果会自动发送到你的收件箱。此操作是非阻塞的。" +
      "适用于将大任务分解为子任务分配给不同 Agent 并行执行。",
    parameters: {
      target_agent: {
        type: "string",
        description: "目标 Agent 的名称",
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
      const cleanup = params.cleanup === "delete" ? "delete" : "keep";
      const expectsCompletionMessage = params.expects_completion !== false;

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
        mode,
        cleanup,
        expectsCompletionMessage,
        overrides: hasOverrides ? overrides : undefined,
      });

      if ("error" in result) {
        return { spawned: false, error: result.error };
      }
      return {
        spawned: true,
        runId: result.runId,
        mode: result.mode,
        to: getActorName(target),
        label: result.label,
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
            status: a.status,
            currentTask: a.currentTask?.query?.slice(0, 100) ?? null,
            model: a.modelOverride ?? "(default)",
          })),
        self: {
          name: selfActor?.role.name ?? actorId,
        },
        task_tree: descendants.map((r) => ({
          runId: r.runId,
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
      const targetInput = String(params.target_agent);
      const target = resolveTarget(targetInput);
      const task = String(params.task);
      const delaySec = Number(params.delay_seconds);
      const type = params.type ? String(params.type) : "once";
      const maxRuns = params.max_runs ? Number(params.max_runs) : undefined;
      const cron = system.cron;

      if (isNaN(delaySec) || delaySec <= 0) {
        return { error: "delay_seconds 必须是正数" };
      }

      const delayMs = delaySec * 1000;
      let result;
      if (type === "interval") {
        result = cron.scheduleInterval(target, task, delayMs, maxRuns);
      } else {
        result = cron.scheduleOnce(target, task, delayMs);
      }

      if ("error" in result) return result;

      return {
        scheduled: true,
        jobId: result.id,
        target: getActorName(target),
        type: result.type,
        delaySeconds: result.delayMs / 1000,
        nextRunAt: new Date(result.nextRunAt).toLocaleTimeString("zh-CN"),
        maxRuns: result.maxRuns ?? "无限",
      };
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
      const cron = system.cron;
      const activeOnly = String(params.active_only) === "true";
      const jobs = activeOnly ? cron.listActive() : cron.list();

      return {
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
        })),
      };
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
      const cancelled = system.cron.cancel(jobId);
      return cancelled
        ? { cancelled: true, jobId }
        : { cancelled: false, error: `任务 ${jobId} 不存在或已结束` };
    },
  });

  return tools;
}
