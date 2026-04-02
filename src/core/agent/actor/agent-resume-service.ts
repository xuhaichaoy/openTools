import { getAgentTaskManager } from "@/core/task-center";
import {
  appendAgentTaskOutputFile,
  ensureAgentTaskOutputFile,
  readAgentTaskOutputFile,
} from "@/core/task-center/agent-task-output-file";
import { createLogger } from "@/core/logger";
import type { AgentActor } from "./agent-actor";
import type { ActorSystem } from "./actor-system";
import {
  persistTranscriptActorResumeMetadata,
  readSessionHistory,
  readTranscriptActorResumeMetadata,
  type TranscriptActorResumeMetadata,
} from "./actor-transcript";
import {
  getBackgroundAgentRegistry,
  type BackgroundAgentInfo,
} from "./background-agent-registry";
import type { ExecutionPolicy, ThinkingLevel, ToolPolicy } from "./types";
import type { ToolResultReplacementSnapshot } from "@/core/agent/runtime/tool-result-replacement";
import type { RuntimeTranscriptMessage } from "@/core/agent/runtime/transcript-messages";

const log = createLogger("AgentResumeService");

export interface ResumeContext {
  taskId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  createdAt: number;
  description?: string;
  subagentType?: string;
  parentActorId?: string;
  model?: string;
  originalPrompt?: string;
  lastMessage?: string;
  outputFile?: string;
  pendingMessages: string[];
  sessionHistory?: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
  transcriptMessages?: RuntimeTranscriptMessage[];
  systemPromptOverride?: string;
  workspace?: string;
  contextTokens?: number;
  thinkingLevel?: ThinkingLevel;
  toolResultReplacementSnapshot?: ToolResultReplacementSnapshot;
  maxIterations?: number;
  toolPolicy?: ToolPolicy;
  executionPolicy?: ExecutionPolicy;
  timeoutSeconds?: number;
  idleLeaseSeconds?: number;
}

export interface ResumeResult {
  taskId: string;
  agentId: string;
  agentName: string;
  outputFile: string;
  started: boolean;
}

export type ResumeSnapshotActor = Pick<
  AgentActor,
  | "configuredMaxIterations"
  | "contextTokens"
  | "executionPolicy"
  | "getSessionHistory"
  | "getSystemPromptOverride"
  | "getTranscriptMessages"
  | "getToolResultReplacementSnapshot"
  | "idleLeaseSeconds"
  | "persistedExecutionPolicy"
  | "persistedToolPolicyConfig"
  | "thinkingLevel"
  | "timeoutSeconds"
  | "workspace"
>;

function cloneSessionHistory(
  history?: readonly { role: "user" | "assistant"; content: string; timestamp: number }[] | null,
): Array<{ role: "user" | "assistant"; content: string; timestamp: number }> | undefined {
  if (!history?.length) return undefined;
  return history.map((entry) => ({ ...entry }));
}

function cloneTranscriptMessages(
  messages?: readonly RuntimeTranscriptMessage[] | null,
): RuntimeTranscriptMessage[] | undefined {
  if (!messages?.length) return undefined;
  return messages.map((message) => ({
    role: message.role,
    content: message.content == null ? null : String(message.content),
    ...(message.images?.length ? { images: [...message.images] } : {}),
    ...(message.tool_calls?.length
      ? {
          tool_calls: message.tool_calls.map((toolCall) => ({
            ...toolCall,
            function: {
              ...toolCall.function,
            },
          })),
        }
      : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
  }));
}

function cloneToolPolicy(policy?: ToolPolicy): ToolPolicy | undefined {
  if (!policy) return undefined;
  return {
    ...(policy.allow ? { allow: [...policy.allow] } : {}),
    ...(policy.deny ? { deny: [...policy.deny] } : {}),
  };
}

function cloneExecutionPolicy(policy?: ExecutionPolicy): ExecutionPolicy | undefined {
  if (!policy) return undefined;
  return {
    ...(policy.accessMode ? { accessMode: policy.accessMode } : {}),
    ...(policy.approvalMode ? { approvalMode: policy.approvalMode } : {}),
  };
}

export function enrichContextWithActorSnapshot(
  context: ResumeContext,
  actor?: Partial<ResumeSnapshotActor> | null,
): ResumeContext {
  if (!actor) return context;
  const sessionHistory = typeof actor.getSessionHistory === "function"
    ? cloneSessionHistory(actor.getSessionHistory())
    : undefined;
  const systemPromptOverride = typeof actor.getSystemPromptOverride === "function"
    ? actor.getSystemPromptOverride()
    : undefined;
  const transcriptMessages = typeof actor.getTranscriptMessages === "function"
    ? cloneTranscriptMessages(actor.getTranscriptMessages())
    : undefined;
  return {
    ...context,
    sessionHistory: sessionHistory ?? context.sessionHistory,
    transcriptMessages: transcriptMessages ?? context.transcriptMessages,
    systemPromptOverride: systemPromptOverride ?? context.systemPromptOverride,
    workspace: actor.workspace ?? context.workspace,
    contextTokens: actor.contextTokens ?? context.contextTokens,
    thinkingLevel: actor.thinkingLevel ?? context.thinkingLevel,
    toolResultReplacementSnapshot: typeof actor.getToolResultReplacementSnapshot === "function"
      ? actor.getToolResultReplacementSnapshot() ?? context.toolResultReplacementSnapshot
      : context.toolResultReplacementSnapshot,
    maxIterations: actor.configuredMaxIterations ?? context.maxIterations,
    toolPolicy: cloneToolPolicy(actor.persistedToolPolicyConfig) ?? context.toolPolicy,
    executionPolicy: cloneExecutionPolicy(actor.persistedExecutionPolicy ?? actor.executionPolicy) ?? context.executionPolicy,
    timeoutSeconds: actor.timeoutSeconds ?? context.timeoutSeconds,
    idleLeaseSeconds: actor.idleLeaseSeconds ?? context.idleLeaseSeconds,
  };
}

export function buildResumeMetadata(context: ResumeContext): TranscriptActorResumeMetadata {
  return {
    taskId: context.taskId,
    sessionId: context.sessionId,
    agentId: context.agentId,
    agentName: context.agentName,
    createdAt: context.createdAt,
    updatedAt: Date.now(),
    description: context.description,
    subagentType: context.subagentType,
    parentActorId: context.parentActorId,
    model: context.model,
    originalPrompt: context.originalPrompt,
    lastMessage: context.lastMessage,
    outputFile: context.outputFile,
    pendingMessages: [...context.pendingMessages],
    ...(context.sessionHistory?.length ? { sessionHistory: cloneSessionHistory(context.sessionHistory) } : {}),
    ...(context.transcriptMessages?.length ? { transcriptMessages: cloneTranscriptMessages(context.transcriptMessages) } : {}),
    ...(context.systemPromptOverride ? { systemPromptOverride: context.systemPromptOverride } : {}),
    ...(context.workspace ? { workspace: context.workspace } : {}),
    ...(context.contextTokens !== undefined ? { contextTokens: context.contextTokens } : {}),
    ...(context.thinkingLevel ? { thinkingLevel: context.thinkingLevel } : {}),
    ...(context.toolResultReplacementSnapshot
      ? { toolResultReplacementSnapshot: context.toolResultReplacementSnapshot }
      : {}),
    ...(context.maxIterations !== undefined ? { maxIterations: context.maxIterations } : {}),
    ...(context.toolPolicy ? { toolPolicy: cloneToolPolicy(context.toolPolicy) } : {}),
    ...(context.executionPolicy ? { executionPolicy: cloneExecutionPolicy(context.executionPolicy) } : {}),
    ...(context.timeoutSeconds !== undefined ? { timeoutSeconds: context.timeoutSeconds } : {}),
    ...(context.idleLeaseSeconds !== undefined ? { idleLeaseSeconds: context.idleLeaseSeconds } : {}),
  };
}

type ResumeHistoryEntry = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

function formatReplayHistoryEntry(
  entry: Awaited<ReturnType<typeof readSessionHistory>>[number],
  agentId: string,
): ResumeHistoryEntry | null {
  const data = entry.data ?? {};
  switch (entry.type) {
    case "message": {
      const content = String(data.content ?? "").trim();
      if (!content) return null;
      const from = String(data.from ?? "");
      const role = from === agentId ? "assistant" : "user";
      const prefix = role === "assistant"
        ? ""
        : from && from !== "user" && from !== "用户"
          ? `[来自 ${from}] `
          : "";
      return {
        role,
        content: `${prefix}${content}`.trim(),
        timestamp: entry.timestamp,
      };
    }
    case "tool_call": {
      const toolName = String(data.toolName ?? "unknown_tool");
      const params = previewText(JSON.stringify(data.params ?? {}), 260);
      return {
        role: "assistant",
        content: params
          ? `[工具调用] ${toolName}\n参数：${params}`
          : `[工具调用] ${toolName}`,
        timestamp: entry.timestamp,
      };
    }
    case "tool_result": {
      const toolName = String(data.toolName ?? "unknown_tool");
      const result = previewText(data.result, 420);
      return {
        role: "assistant",
        content: result
          ? `[工具结果] ${toolName}\n${result}`
          : `[工具结果] ${toolName}`,
        timestamp: entry.timestamp,
      };
    }
    case "spawn": {
      const targetActorId = String(data.targetActorId ?? "unknown");
      const task = previewText(data.task, 240);
      return {
        role: "assistant",
        content: task
          ? `[派发子任务] ${targetActorId}\n${task}`
          : `[派发子任务] ${targetActorId}`,
        timestamp: entry.timestamp,
      };
    }
    case "announce": {
      const status = String(data.status ?? "unknown");
      const result = previewText(data.result ?? data.error, 240);
      return {
        role: "assistant",
        content: result
          ? `[子任务状态] ${status}\n${result}`
          : `[子任务状态] ${status}`,
        timestamp: entry.timestamp,
      };
    }
    default:
      return null;
  }
}

async function buildRestoredSessionHistory(
  context: ResumeContext,
): Promise<ResumeHistoryEntry[]> {
  const base = cloneSessionHistory(context.sessionHistory) ?? [];
  const transcriptEntries = await readSessionHistory(context.sessionId, {
    actorId: context.agentId,
    limit: 40,
  }).catch(() => []);
  const replayEntries = transcriptEntries
    .map((entry) => formatReplayHistoryEntry(entry, context.agentId))
    .filter((entry): entry is ResumeHistoryEntry => Boolean(entry));

  if (base.length === 0 && replayEntries.length === 0) return [];
  if (replayEntries.length === 0) return base.slice(-50);

  const merged = [...base, ...replayEntries]
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((entry) => entry.content.trim())
    .reduce<ResumeHistoryEntry[]>((acc, entry) => {
      const last = acc[acc.length - 1];
      if (last && last.role === entry.role && last.content === entry.content) {
        return acc;
      }
      acc.push({
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
      });
      return acc;
    }, []);

  return merged.slice(-50);
}

async function restoreActorSnapshot(
  actor: AgentActor,
  context: ResumeContext,
): Promise<{ historyCount: number; transcriptCount: number }> {
  const transcriptCount = typeof actor.loadTranscriptMessages === "function" && context.transcriptMessages?.length
    ? (actor.loadTranscriptMessages(context.transcriptMessages), context.transcriptMessages.length)
    : 0;
  if (typeof actor.loadSessionHistory !== "function") {
    return { historyCount: 0, transcriptCount };
  }
  const restoredHistory = await buildRestoredSessionHistory(context);
  if (restoredHistory.length > 0) {
    actor.loadSessionHistory(restoredHistory);
  }
  return {
    historyCount: restoredHistory.length,
    transcriptCount,
  };
}

function previewText(value: unknown, maxLength = 1_200): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function formatTranscriptEntry(entry: Awaited<ReturnType<typeof readSessionHistory>>[number]): string | undefined {
  const data = entry.data ?? {};
  switch (entry.type) {
    case "message": {
      const from = String(data.from ?? "unknown");
      const to = String(data.to ?? "unknown");
      const content = previewText(data.content, 240);
      return content ? `[message] ${from} -> ${to}: ${content}` : undefined;
    }
    case "tool_call": {
      const toolName = String(data.toolName ?? "unknown_tool");
      const params = previewText(JSON.stringify(data.params ?? {}), 220);
      return params ? `[tool_call] ${toolName}: ${params}` : `[tool_call] ${toolName}`;
    }
    case "tool_result": {
      const toolName = String(data.toolName ?? "unknown_tool");
      const result = previewText(data.result, 220);
      return result ? `[tool_result] ${toolName}: ${result}` : `[tool_result] ${toolName}`;
    }
    case "spawn": {
      const task = previewText(data.task, 220);
      const targetActorId = String(data.targetActorId ?? "unknown");
      return task ? `[spawn] ${targetActorId}: ${task}` : `[spawn] ${targetActorId}`;
    }
    case "announce": {
      const status = String(data.status ?? "unknown");
      const result = previewText(data.result ?? data.error, 220);
      return result ? `[announce] ${status}: ${result}` : `[announce] ${status}`;
    }
    default:
      return undefined;
  }
}

async function buildResumePrompt(params: {
  context: ResumeContext;
  message: string;
}): Promise<string> {
  const transcriptEntries = await readSessionHistory(params.context.sessionId, {
    actorId: params.context.agentId,
    limit: 24,
  }).catch(() => []);

  const transcriptExcerpt = transcriptEntries
    .map((entry) => formatTranscriptEntry(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(-12)
    .join("\n");

  const outputExcerpt = params.context.outputFile
    ? previewText(await readAgentTaskOutputFile(params.context.outputFile).catch(() => undefined), 1_800)
    : undefined;

  const sections = [
    "你是同一个子 Agent 的恢复实例，需要在之前工作基础上继续执行。",
    "不要从头重新开始，不要重复已经成功的工具调用，不要重新生成已经完成的内容。",
    params.context.description ? `职责：${params.context.description}` : "",
    params.context.originalPrompt ? `原始任务：\n${params.context.originalPrompt}` : "",
    outputExcerpt ? `此前输出摘录：\n${outputExcerpt}` : "",
    transcriptExcerpt ? `此前 transcript 摘录：\n${transcriptExcerpt}` : "",
    `新的续消息：\n${params.message}`,
    "请严格基于上面上下文继续推进，优先补完剩余部分，并在最终结果中自然衔接已有工作。",
  ].filter(Boolean);

  return sections.join("\n\n");
}

class AgentResumeService {
  private contexts = new Map<string, ResumeContext>();
  private taskIdByAgentId = new Map<string, string>();
  private taskIdsByName = new Map<string, Set<string>>();
  private inFlight = new Map<string, Promise<void>>();

  private normalizeIdentifier(value: string): string {
    return value.trim().toLowerCase();
  }

  private unindex(context: ResumeContext | undefined): void {
    if (!context) return;
    this.taskIdByAgentId.delete(context.agentId);
    const normalizedName = this.normalizeIdentifier(context.agentName);
    const taskIds = this.taskIdsByName.get(normalizedName);
    if (!taskIds) return;
    taskIds.delete(context.taskId);
    if (taskIds.size === 0) {
      this.taskIdsByName.delete(normalizedName);
    }
  }

  private index(context: ResumeContext): void {
    this.taskIdByAgentId.set(context.agentId, context.taskId);
    const normalizedName = this.normalizeIdentifier(context.agentName);
    const taskIds = this.taskIdsByName.get(normalizedName) ?? new Set<string>();
    taskIds.add(context.taskId);
    this.taskIdsByName.set(normalizedName, taskIds);
  }

  private buildRegistryInfo(context: ResumeContext, status: BackgroundAgentInfo["status"]): BackgroundAgentInfo {
    return {
      taskId: context.taskId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      agentName: context.agentName,
      description: context.description,
      prompt: context.originalPrompt,
      subagentType: context.subagentType,
      parentActorId: context.parentActorId,
      model: context.model,
      status,
      startedAt: context.createdAt,
      lastActiveAt: Date.now(),
      outputFile: context.outputFile,
    };
  }

  private hydrateContextFromTask(identifier: string): ResumeContext | undefined {
    const normalized = identifier.trim();
    if (!normalized) return undefined;

    const task = getAgentTaskManager()
      .list()
      .find((item) => {
        if (item.resumable === false) return false;
        return item.taskId === normalized
          || item.targetActorId === normalized
          || item.targetName === normalized;
      });

    if (!task) return undefined;

    const metadata = task.metadata ?? {};
    const agentId = typeof metadata.agentId === "string"
      ? metadata.agentId
      : task.targetActorId;
    if (!agentId) return undefined;

    const context: ResumeContext = {
      taskId: task.taskId,
      sessionId: task.sessionId,
      agentId,
      agentName: task.targetName || String(metadata.subagentType ?? agentId),
      createdAt: task.createdAt,
      description: typeof metadata.description === "string" ? metadata.description : task.title,
      subagentType: typeof metadata.subagentType === "string" ? metadata.subagentType : undefined,
      parentActorId: task.spawnerActorId,
      model: typeof metadata.model === "string" ? metadata.model : undefined,
      originalPrompt: typeof metadata.prompt === "string" ? metadata.prompt : task.description,
      lastMessage: undefined,
      outputFile: task.outputFile,
      pendingMessages: [],
      sessionHistory: Array.isArray(metadata.sessionHistory)
        ? cloneSessionHistory(metadata.sessionHistory as ResumeContext["sessionHistory"])
        : undefined,
      transcriptMessages: Array.isArray(metadata.transcriptMessages)
        ? cloneTranscriptMessages(metadata.transcriptMessages as ResumeContext["transcriptMessages"])
        : undefined,
      systemPromptOverride: typeof metadata.systemPromptOverride === "string"
        ? metadata.systemPromptOverride
        : undefined,
      workspace: typeof metadata.workspace === "string" ? metadata.workspace : undefined,
      contextTokens: typeof metadata.contextTokens === "number" ? metadata.contextTokens : undefined,
      thinkingLevel: typeof metadata.thinkingLevel === "string"
        ? metadata.thinkingLevel as ThinkingLevel
        : undefined,
      toolResultReplacementSnapshot: metadata.toolResultReplacementSnapshot
        && typeof metadata.toolResultReplacementSnapshot === "object"
        ? metadata.toolResultReplacementSnapshot as ToolResultReplacementSnapshot
        : undefined,
      maxIterations: typeof metadata.maxIterations === "number" ? metadata.maxIterations : undefined,
      toolPolicy: metadata.toolPolicy && typeof metadata.toolPolicy === "object"
        ? cloneToolPolicy(metadata.toolPolicy as ToolPolicy)
        : undefined,
      executionPolicy: metadata.executionPolicy && typeof metadata.executionPolicy === "object"
        ? cloneExecutionPolicy(metadata.executionPolicy as ExecutionPolicy)
        : undefined,
      timeoutSeconds: typeof metadata.timeoutSeconds === "number" ? metadata.timeoutSeconds : undefined,
      idleLeaseSeconds: typeof metadata.idleLeaseSeconds === "number" ? metadata.idleLeaseSeconds : undefined,
    };

    this.saveContext(context);
    return context;
  }

  private async hydrateContextFromTranscript(
    sessionId: string,
    identifier: string,
  ): Promise<ResumeContext | undefined> {
    const metadata = await readTranscriptActorResumeMetadata(sessionId, identifier).catch(() => null);
    if (!metadata) return undefined;

    const context: ResumeContext = {
      taskId: metadata.taskId,
      sessionId: metadata.sessionId || sessionId,
      agentId: metadata.agentId,
      agentName: metadata.agentName || metadata.agentId,
      createdAt: metadata.createdAt,
      description: metadata.description,
      subagentType: metadata.subagentType,
      parentActorId: metadata.parentActorId,
      model: metadata.model,
      originalPrompt: metadata.originalPrompt,
      lastMessage: metadata.lastMessage,
      outputFile: metadata.outputFile,
      pendingMessages: [...(metadata.pendingMessages ?? [])],
      sessionHistory: cloneSessionHistory(metadata.sessionHistory),
      transcriptMessages: cloneTranscriptMessages(metadata.transcriptMessages),
      systemPromptOverride: metadata.systemPromptOverride,
      workspace: metadata.workspace,
      contextTokens: metadata.contextTokens,
      thinkingLevel: metadata.thinkingLevel,
      toolResultReplacementSnapshot: metadata.toolResultReplacementSnapshot,
      maxIterations: metadata.maxIterations,
      toolPolicy: cloneToolPolicy(metadata.toolPolicy),
      executionPolicy: cloneExecutionPolicy(metadata.executionPolicy),
      timeoutSeconds: metadata.timeoutSeconds,
      idleLeaseSeconds: metadata.idleLeaseSeconds,
    };

    this.saveContext(context);
    log.info(`Hydrated resume context from transcript for: ${identifier}`);
    return context;
  }

  private ensureTaskRecord(context: ResumeContext): void {
    const taskManager = getAgentTaskManager();
    const existing = taskManager.get(context.taskId);
    if (existing) {
      taskManager.updateTask(context.taskId, {
        outputFile: context.outputFile,
        resumable: true,
        metadata: {
          agentId: context.agentId,
          subagentType: context.subagentType,
          description: context.description,
          prompt: context.originalPrompt,
          model: context.model,
          sessionHistory: cloneSessionHistory(context.sessionHistory),
          transcriptMessages: cloneTranscriptMessages(context.transcriptMessages),
          systemPromptOverride: context.systemPromptOverride,
          workspace: context.workspace,
          contextTokens: context.contextTokens,
          thinkingLevel: context.thinkingLevel,
          toolResultReplacementSnapshot: context.toolResultReplacementSnapshot,
          maxIterations: context.maxIterations,
          toolPolicy: cloneToolPolicy(context.toolPolicy),
          executionPolicy: cloneExecutionPolicy(context.executionPolicy),
          timeoutSeconds: context.timeoutSeconds,
          idleLeaseSeconds: context.idleLeaseSeconds,
        },
      });
      return;
    }

    taskManager.upsertTask({
      taskId: context.taskId,
      sessionId: context.sessionId,
      source: "background",
      backend: "in_process",
      status: "queued",
      title: context.description || context.agentName,
      description: context.originalPrompt || context.description || context.agentName,
      createdAt: context.createdAt,
      lastActiveAt: Date.now(),
      spawnerActorId: context.parentActorId,
      targetActorId: context.agentId,
      targetName: context.agentName,
      recentActivity: [],
      recentActivitySummary: "Agent 可恢复，等待续跑",
      pendingMessageCount: context.pendingMessages.length,
      resumable: true,
      outputFile: context.outputFile,
      metadata: {
        agentId: context.agentId,
        subagentType: context.subagentType,
        description: context.description,
        prompt: context.originalPrompt,
        model: context.model,
        sessionHistory: cloneSessionHistory(context.sessionHistory),
        transcriptMessages: cloneTranscriptMessages(context.transcriptMessages),
        systemPromptOverride: context.systemPromptOverride,
        workspace: context.workspace,
        contextTokens: context.contextTokens,
        thinkingLevel: context.thinkingLevel,
        toolResultReplacementSnapshot: context.toolResultReplacementSnapshot,
        maxIterations: context.maxIterations,
        toolPolicy: cloneToolPolicy(context.toolPolicy),
        executionPolicy: cloneExecutionPolicy(context.executionPolicy),
        timeoutSeconds: context.timeoutSeconds,
        idleLeaseSeconds: context.idleLeaseSeconds,
      },
    });
  }

  private async persistContextToTranscript(context: ResumeContext): Promise<void> {
    await persistTranscriptActorResumeMetadata(
      context.sessionId,
      context.agentId,
      buildResumeMetadata(context),
    ).catch((error) => {
      log.warn("persist resume metadata failed", error);
    });
  }

  saveContext(context: ResumeContext): void {
    const next: ResumeContext = {
      ...context,
      agentName: context.agentName || context.agentId,
      pendingMessages: context.pendingMessages ?? [],
      ...(context.sessionHistory ? { sessionHistory: cloneSessionHistory(context.sessionHistory) } : {}),
      ...(context.toolPolicy ? { toolPolicy: cloneToolPolicy(context.toolPolicy) } : {}),
      ...(context.executionPolicy ? { executionPolicy: cloneExecutionPolicy(context.executionPolicy) } : {}),
    };
    this.unindex(this.contexts.get(next.taskId));
    this.contexts.set(next.taskId, next);
    this.index(next);
    this.ensureTaskRecord(next);
    getBackgroundAgentRegistry().register(this.buildRegistryInfo(next, "queued"));
    log.info(`Saved resume context for task: ${next.taskId}`);
  }

  getContext(identifier: string): ResumeContext | undefined {
    const normalized = identifier.trim();
    if (!normalized) return undefined;

    return this.contexts.get(normalized)
      ?? (() => {
        const taskId = this.taskIdByAgentId.get(normalized);
        return taskId ? this.contexts.get(taskId) : undefined;
      })()
      ?? (() => {
        const taskIds = this.taskIdsByName.get(this.normalizeIdentifier(normalized));
        if (!taskIds || taskIds.size === 0) return undefined;
        return [...taskIds]
          .map((taskId) => this.contexts.get(taskId))
          .filter((item): item is ResumeContext => Boolean(item))
          .sort((left, right) => {
            const leftTask = getAgentTaskManager().get(left.taskId);
            const rightTask = getAgentTaskManager().get(right.taskId);
            const leftAt = leftTask?.lastActiveAt ?? leftTask?.completedAt ?? left.createdAt;
            const rightAt = rightTask?.lastActiveAt ?? rightTask?.completedAt ?? right.createdAt;
            return rightAt - leftAt;
          })[0];
      })()
      ?? this.hydrateContextFromTask(normalized);
  }

  async resume(params: {
    actorSystem: ActorSystem;
    identifier: string;
    message: string;
  }): Promise<ResumeResult> {
    const context = this.getContext(params.identifier)
      ?? await this.hydrateContextFromTranscript(params.actorSystem.sessionId, params.identifier);
    if (!context) {
      log.warn(`No resume context found for: ${params.identifier}`);
      throw new Error(`未找到可恢复的 agent：${params.identifier}`);
    }

    const message = String(params.message ?? "").trim();
    if (message) {
      context.pendingMessages.push(message);
      context.lastMessage = message;
    }

    context.outputFile = context.outputFile ?? await ensureAgentTaskOutputFile({
      sessionId: context.sessionId,
      taskId: context.taskId,
      agentName: context.agentName,
      title: context.description || context.agentName,
      description: context.description,
      prompt: context.originalPrompt,
    });
    const liveActor = typeof params.actorSystem.get === "function"
      ? params.actorSystem.get(context.agentId)
      : undefined;
    if (liveActor) {
      Object.assign(context, enrichContextWithActorSnapshot(context, liveActor));
    }
    this.saveContext(context);
    await this.persistContextToTranscript(context);

    const taskManager = getAgentTaskManager();
    taskManager.updateTask(context.taskId, {
      status: "running",
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      recentActivitySummary: "Agent 已在后台恢复，等待处理续消息",
      pendingMessageCount: context.pendingMessages.length,
      outputFile: context.outputFile,
      resumable: true,
    });
    getBackgroundAgentRegistry().register({
      ...this.buildRegistryInfo(context, this.inFlight.has(context.taskId) ? "running" : "resuming"),
      outputFile: context.outputFile,
    });

    const alreadyRunning = this.inFlight.has(context.taskId);
    if (!alreadyRunning) {
      const runner = this.runResumeLoop(context.taskId, params.actorSystem)
        .catch((error) => {
          log.warn("resume loop failed", error);
        })
        .finally(() => {
          this.inFlight.delete(context.taskId);
        });
      this.inFlight.set(context.taskId, runner);
    }

    return {
      taskId: context.taskId,
      agentId: context.agentId,
      agentName: context.agentName,
      outputFile: context.outputFile,
      started: !alreadyRunning,
    };
  }

  private async runResumeLoop(taskId: string, actorSystem: ActorSystem): Promise<void> {
    while (true) {
      const context = this.contexts.get(taskId);
      if (!context) return;

      const batch = [...context.pendingMessages];
      const outputFile = context.outputFile ?? await ensureAgentTaskOutputFile({
        sessionId: context.sessionId,
        taskId: context.taskId,
        agentName: context.agentName,
        title: context.description || context.agentName,
        description: context.description,
        prompt: context.originalPrompt,
      });
      context.outputFile = outputFile;
      this.ensureTaskRecord(context);

      if (batch.length === 0) {
        getAgentTaskManager().updateTask(context.taskId, {
          pendingMessageCount: 0,
          outputFile,
        });
        getBackgroundAgentRegistry().update(context.taskId, {
          status: "completed",
          outputFile,
        });
        await this.persistContextToTranscript(context);
        return;
      }

      const taskManager = getAgentTaskManager();
      taskManager.updateTask(context.taskId, {
        status: "running",
        lastActiveAt: Date.now(),
        recentActivitySummary: `Agent 正在处理 ${batch.length} 条续消息`,
        pendingMessageCount: context.pendingMessages.length,
        outputFile,
        resumable: true,
      });
      getBackgroundAgentRegistry().register({
        ...this.buildRegistryInfo(context, "running"),
        outputFile,
      });

      try {
        const existingActor = typeof actorSystem.get === "function"
          ? actorSystem.get(context.agentId)
          : undefined;
        const agent = await actorSystem.spawnAgent({
          agentId: context.agentId,
          agentName: context.agentName,
          initialPrompt: context.originalPrompt,
          parentActorId: context.parentActorId,
          subagentType: context.subagentType,
          description: context.description,
          model: context.model,
          maxIterations: context.maxIterations,
          systemPromptOverride: context.systemPromptOverride,
          toolPolicy: cloneToolPolicy(context.toolPolicy),
          executionPolicy: cloneExecutionPolicy(context.executionPolicy),
          timeoutSeconds: context.timeoutSeconds,
          idleLeaseSeconds: context.idleLeaseSeconds,
          workspace: context.workspace,
          contextTokens: context.contextTokens,
          thinkingLevel: context.thinkingLevel,
          toolResultReplacementSnapshot: context.toolResultReplacementSnapshot,
        });
        const restoredSnapshot = !existingActor
          ? await restoreActorSnapshot(agent.actor, context)
          : { historyCount: 0, transcriptCount: 0 };
        const shouldUseSummaryPrompt = !existingActor
          && restoredSnapshot.historyCount === 0
          && restoredSnapshot.transcriptCount === 0;

        for (let index = 0; index < batch.length; index += 1) {
          const rawPrompt = batch[index];
          context.lastMessage = rawPrompt;
          const prompt = shouldUseSummaryPrompt && index === 0
            ? await buildResumePrompt({
                context,
                message: rawPrompt,
              })
            : rawPrompt;
          try {
            const result = await agent.continueWithMessage(prompt);
            if (context.pendingMessages.length > 0) {
              context.pendingMessages.shift();
            }
            const snapshot = enrichContextWithActorSnapshot(context, agent.actor);
            Object.assign(context, snapshot);
            await appendAgentTaskOutputFile({
              outputFile,
              prompt: rawPrompt,
              status: "completed",
              result,
              timestamp: Date.now(),
            });
            await this.persistContextToTranscript(context);
            const pendingMessageCount = context.pendingMessages.length;
            taskManager.updateTask(context.taskId, {
              status: pendingMessageCount > 0 ? "running" : "completed",
              result,
              lastActiveAt: Date.now(),
              ...(pendingMessageCount === 0 ? { completedAt: Date.now() } : {}),
              recentActivitySummary: pendingMessageCount > 0
                ? `Agent 已完成一条续消息，剩余 ${pendingMessageCount} 条`
                : "Agent 已完成续跑消息",
              pendingMessageCount,
              outputFile,
              resumable: true,
            });
            if (pendingMessageCount > 0) {
              getBackgroundAgentRegistry().update(context.taskId, {
                status: "running",
                lastActiveAt: Date.now(),
                outputFile,
              });
            } else {
              getBackgroundAgentRegistry().complete(context.taskId, outputFile);
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const snapshot = enrichContextWithActorSnapshot(context, agent.actor);
            Object.assign(context, snapshot);
            await appendAgentTaskOutputFile({
              outputFile,
              prompt: rawPrompt,
              status: "failed",
              error: errorMessage,
              timestamp: Date.now(),
            });
            await this.persistContextToTranscript(context);
            taskManager.updateTask(context.taskId, {
              status: "failed",
              error: errorMessage,
              completedAt: Date.now(),
              lastActiveAt: Date.now(),
              recentActivitySummary: "Agent 续跑失败",
              pendingMessageCount: context.pendingMessages.length,
              outputFile,
              resumable: true,
            });
            getBackgroundAgentRegistry().fail(context.taskId, errorMessage);
            return;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendAgentTaskOutputFile({
          outputFile,
          prompt: context.lastMessage,
          status: "failed",
          error: errorMessage,
          timestamp: Date.now(),
        });
        await this.persistContextToTranscript(context);
        taskManager.updateTask(context.taskId, {
          status: "failed",
          error: errorMessage,
          completedAt: Date.now(),
          lastActiveAt: Date.now(),
          recentActivitySummary: "Agent 恢复启动失败",
          pendingMessageCount: context.pendingMessages.length,
          outputFile,
          resumable: true,
        });
        getBackgroundAgentRegistry().fail(context.taskId, errorMessage);
        return;
      }
    }
  }

  clearContext(taskId: string): void {
    const existing = this.contexts.get(taskId);
    this.unindex(existing);
    this.contexts.delete(taskId);
  }

  reset(): void {
    this.contexts.clear();
    this.taskIdByAgentId.clear();
    this.taskIdsByName.clear();
    this.inFlight.clear();
  }
}

const service = new AgentResumeService();
export function getAgentResumeService(): AgentResumeService {
  return service;
}

export function resetAgentResumeService(): void {
  service.reset();
}
