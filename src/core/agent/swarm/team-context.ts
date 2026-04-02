import type { AgentCapability, SpawnTaskOverrides, SpawnedTaskRoleBoundary } from "../actor/types";
import type { AgentBackendRegistry } from "../backends/registry";
import type { AgentBackendId } from "../backends/types";
import { TeamMailbox, type TeamMailboxEntry } from "./team-mailbox";
import { resolveTeammateRoute, type RoutingTeammate } from "./teammate-routing";

export interface TeamTeammate extends RoutingTeammate {
  backendId?: AgentBackendId;
  description?: string;
  capabilities?: AgentCapability[];
  workspace?: string;
}

export interface TeamSnapshot {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  createdByActorId: string;
  defaultBackendId: AgentBackendId;
  teammates: TeamTeammate[];
  mailboxSize: number;
}

export interface TeamMessageDispatchResult {
  sent: boolean;
  teamId: string;
  teamName: string;
  backendId: AgentBackendId;
  mailboxEntryId?: string;
  teammate?: TeamTeammate;
  messageId?: string;
  targetId?: string;
  targetName?: string;
  error?: string;
}

export interface TeamBroadcastDispatchResult {
  sent: boolean;
  teamId: string;
  teamName: string;
  total: number;
  sentCount: number;
  failedCount: number;
  results: TeamMessageDispatchResult[];
  error?: string;
}

export interface TeamTaskDispatchResult {
  dispatched: boolean;
  teamId: string;
  teamName: string;
  backendId: AgentBackendId;
  teammate?: TeamTeammate;
  taskId?: string;
  runId?: string;
  status?: "queued" | "running";
  externalTask?: boolean;
  outputPath?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

interface TeamContextRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  createdByActorId: string;
  defaultBackendId: AgentBackendId;
  teammates: TeamTeammate[];
}

interface TeamContextDependencies {
  backendRegistry: AgentBackendRegistry;
}

function cloneTeamTeammate(teammate: TeamTeammate): TeamTeammate {
  return {
    ...teammate,
    ...(teammate.aliases ? { aliases: [...teammate.aliases] } : {}),
    ...(teammate.capabilities ? { capabilities: [...teammate.capabilities] } : {}),
  };
}

function cloneTeamRecord(record: TeamContextRecord): TeamContextRecord {
  return {
    ...record,
    teammates: record.teammates.map((teammate) => cloneTeamTeammate(teammate)),
  };
}

export class TeamContext {
  private record: TeamContextRecord;
  private readonly mailbox = new TeamMailbox();
  private readonly deps: TeamContextDependencies;

  constructor(
    record: TeamContextRecord,
    deps: TeamContextDependencies,
  ) {
    this.record = cloneTeamRecord(record);
    this.deps = deps;
  }

  get id(): string {
    return this.record.id;
  }

  get name(): string {
    return this.record.name;
  }

  updateRecord(
    patch: Partial<Pick<TeamContextRecord, "description" | "defaultBackendId">>
    & { teammates?: TeamTeammate[] },
  ): void {
    this.record = {
      ...this.record,
      ...patch,
      updatedAt: Date.now(),
      teammates: patch.teammates
        ? patch.teammates.map((teammate) => cloneTeamTeammate(teammate))
        : this.record.teammates,
    };
  }

  snapshot(): TeamSnapshot {
    return {
      ...this.record,
      teammates: this.record.teammates.map((teammate) => cloneTeamTeammate(teammate)),
      mailboxSize: this.mailbox.size,
    };
  }

  getMailboxSnapshot(): TeamMailboxEntry[] {
    return this.mailbox.snapshot();
  }

  listTeammates(): TeamTeammate[] {
    return this.record.teammates.map((teammate) => cloneTeamTeammate(teammate));
  }

  canAccess(actorId: string): boolean {
    const normalizedActorId = actorId.trim();
    if (!normalizedActorId) return false;
    if (this.record.createdByActorId === normalizedActorId) return true;
    return this.record.teammates.some((teammate) => teammate.actorId === normalizedActorId);
  }

  private resolveTeammate(query: string): TeamTeammate | { error: string } {
    const result = resolveTeammateRoute(this.record.teammates, query);
    if ("error" in result) {
      return {
        error: result.candidates?.length
          ? `${result.error}。可选成员：${result.candidates.join("、")}`
          : result.error,
      };
    }
    return cloneTeamTeammate(result.teammate);
  }

  async sendMessage(params: {
    senderActorId: string;
    teammate: string;
    content: string;
    replyTo?: string;
    relatedRunId?: string;
    kind?: "direct" | "broadcast";
  }): Promise<TeamMessageDispatchResult> {
    const normalizedSender = params.senderActorId.trim();
    if (!this.canAccess(normalizedSender)) {
      return {
        sent: false,
        teamId: this.record.id,
        teamName: this.record.name,
        backendId: this.record.defaultBackendId,
        error: "当前 actor 不是该 team 的 owner 或 teammate，不能发送 team message。",
      };
    }

    const resolvedTeammate = this.resolveTeammate(params.teammate);
    if ("error" in resolvedTeammate) {
      return {
        sent: false,
        teamId: this.record.id,
        teamName: this.record.name,
        backendId: this.record.defaultBackendId,
        error: resolvedTeammate.error,
      };
    }

    const backendId = resolvedTeammate.backendId ?? this.record.defaultBackendId;
    const mailboxEntry = this.mailbox.append({
      teamId: this.record.id,
      kind: params.kind ?? "direct",
      senderActorId: normalizedSender,
      recipientTeammateId: resolvedTeammate.id,
      recipientName: resolvedTeammate.name,
      backendId,
      content: params.content,
      status: "queued",
    });

    const result = await this.deps.backendRegistry.sendMessage({
      backendId,
      senderActorId: normalizedSender,
      teamId: this.record.id,
      target: {
        actorId: resolvedTeammate.actorId,
        actorName: resolvedTeammate.actorName,
        name: resolvedTeammate.name,
        description: resolvedTeammate.description,
        capabilities: resolvedTeammate.capabilities,
        workspace: resolvedTeammate.workspace,
      },
      content: params.content,
      replyTo: params.replyTo,
      relatedRunId: params.relatedRunId,
    });

    this.mailbox.update(mailboxEntry.id, result.sent
      ? {
          status: "sent",
          messageId: result.messageId,
        }
      : {
          status: "failed",
          error: result.error,
        });

    return {
      sent: result.sent,
      teamId: this.record.id,
      teamName: this.record.name,
      backendId,
      mailboxEntryId: mailboxEntry.id,
      teammate: resolvedTeammate,
      messageId: result.messageId,
      targetId: result.targetId,
      targetName: result.targetName,
      error: result.error,
    };
  }

  async broadcastMessage(params: {
    senderActorId: string;
    content: string;
    replyTo?: string;
    relatedRunId?: string;
  }): Promise<TeamBroadcastDispatchResult> {
    const normalizedSender = params.senderActorId.trim();
    if (!this.canAccess(normalizedSender)) {
      return {
        sent: false,
        teamId: this.record.id,
        teamName: this.record.name,
        total: 0,
        sentCount: 0,
        failedCount: 0,
        results: [],
        error: "当前 actor 不是该 team 的 owner 或 teammate，不能广播 team message。",
      };
    }

    const recipients = this.record.teammates.filter((teammate) => teammate.actorId !== normalizedSender);
    if (recipients.length === 0) {
      return {
        sent: false,
        teamId: this.record.id,
        teamName: this.record.name,
        total: 0,
        sentCount: 0,
        failedCount: 0,
        results: [],
        error: "当前 team 没有可广播的 teammate。",
      };
    }

    const results = await Promise.all(
      recipients.map((teammate) =>
        this.sendMessage({
          senderActorId: normalizedSender,
          teammate: teammate.id,
          content: params.content,
          replyTo: params.replyTo,
          relatedRunId: params.relatedRunId,
          kind: "broadcast",
        })),
    );

    const sentCount = results.filter((item) => item.sent).length;
    const failedCount = results.length - sentCount;
    return {
      sent: sentCount > 0,
      teamId: this.record.id,
      teamName: this.record.name,
      total: recipients.length,
      sentCount,
      failedCount,
      results,
      ...(failedCount > 0 && sentCount === 0
        ? { error: results.find((item) => item.error)?.error ?? "team broadcast 全部失败" }
        : {}),
    };
  }

  async dispatchTask(params: {
    senderActorId: string;
    teammate: string;
    task: string;
    label?: string;
    context?: string;
    attachments?: string[];
    images?: string[];
    mode?: "run" | "session";
    cleanup?: "delete" | "keep";
    expectsCompletionMessage?: boolean;
    roleBoundary?: SpawnedTaskRoleBoundary;
    overrides?: SpawnTaskOverrides;
    plannedDelegationId?: string;
    createIfMissing?: boolean;
    targetDescription?: string;
    targetCapabilities?: AgentCapability[];
    targetWorkspace?: string;
  }): Promise<TeamTaskDispatchResult> {
    const normalizedSender = params.senderActorId.trim();
    if (!this.canAccess(normalizedSender)) {
      return {
        dispatched: false,
        teamId: this.record.id,
        teamName: this.record.name,
        backendId: this.record.defaultBackendId,
        error: "当前 actor 不是该 team 的 owner 或 teammate，不能派发 team task。",
      };
    }

    const resolvedTeammate = this.resolveTeammate(params.teammate);
    if ("error" in resolvedTeammate) {
      return {
        dispatched: false,
        teamId: this.record.id,
        teamName: this.record.name,
        backendId: this.record.defaultBackendId,
        error: resolvedTeammate.error,
      };
    }

    const backendId = resolvedTeammate.backendId ?? this.record.defaultBackendId;
    const result = await this.deps.backendRegistry.dispatchTask({
      backendId,
      senderActorId: normalizedSender,
      teamId: this.record.id,
      target: {
        actorId: resolvedTeammate.actorId,
        actorName: resolvedTeammate.actorName,
        name: resolvedTeammate.name,
        description: params.targetDescription ?? resolvedTeammate.description,
        capabilities: params.targetCapabilities ?? resolvedTeammate.capabilities,
        workspace: params.targetWorkspace ?? resolvedTeammate.workspace,
        createIfMissing: params.createIfMissing,
      },
      task: params.task,
      label: params.label,
      context: params.context,
      attachments: params.attachments,
      images: params.images,
      mode: params.mode,
      cleanup: params.cleanup,
      expectsCompletionMessage: params.expectsCompletionMessage,
      roleBoundary: params.roleBoundary,
      overrides: params.overrides,
      plannedDelegationId: params.plannedDelegationId,
    });

    if ("error" in result) {
      return {
        dispatched: false,
        teamId: this.record.id,
        teamName: this.record.name,
        backendId,
        teammate: resolvedTeammate,
        error: result.error,
      };
    }

    const isInProcessRecord = "spawnerActorId" in result && "targetActorId" in result;
    if (!isInProcessRecord) {
      return {
        dispatched: true,
        teamId: this.record.id,
        teamName: this.record.name,
        backendId,
        teammate: resolvedTeammate,
        taskId: result.taskId,
        runId: result.runId,
        status: result.status ?? "running",
        externalTask: true,
        outputPath: result.outputPath,
        summary: result.summary,
        metadata: result.metadata,
      };
    }

    return {
      dispatched: true,
      teamId: this.record.id,
      teamName: this.record.name,
      backendId,
      teammate: resolvedTeammate,
      taskId: result.runId,
      runId: result.runId,
    };
  }
}
