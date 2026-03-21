import type {
  DialogExecutionPlan,
  DialogMessage,
  PendingInteraction,
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import {
  buildCollaborationChildSessions,
  buildCollaborationContractDelegations,
} from "./child-session";
import {
  buildExecutionContractFromDialogPlan,
  cloneExecutionContract,
  doesExecutionContractMatchActorRoster,
  toDialogExecutionPlan,
} from "./execution-contract";
import {
  cloneCollaborationSnapshot,
  cloneQueuedFollowUp,
  createEmptyCollaborationSnapshot,
  sanitizeCollaborationSnapshot,
} from "./persistence";
import { buildCollaborationPresentationState } from "./presentation";
import type {
  CollaborationActorRosterEntry,
  CollaborationChildSession,
  CollaborationDispatchInput,
  CollaborationDispatchOptions,
  CollaborationDispatchResult,
  CollaborationQueuedFollowUp,
  CollaborationSessionSnapshot,
  CollaborationSurface,
  ExecutionContract,
  FollowUpPolicy,
} from "./types";

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function summarizeText(value?: string, maxLength = 140): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function normalizeDispatchInput(
  input: CollaborationDispatchInput | string,
): CollaborationDispatchInput {
  if (typeof input === "string") {
    return { content: input };
  }
  return {
    ...input,
    ...(input.images ? { images: [...input.images] } : {}),
    ...(input.attachmentPaths ? { attachmentPaths: [...input.attachmentPaths] } : {}),
    ...(input.uploadRecords ? { uploadRecords: input.uploadRecords.map((record) => ({ ...record })) } : {}),
  };
}

function clonePendingInteraction(interaction: PendingInteraction): PendingInteraction {
  return {
    ...interaction,
    ...(interaction.options ? { options: [...interaction.options] } : {}),
    ...(interaction.approvalRequest
      ? {
          approvalRequest: {
            ...interaction.approvalRequest,
            ...(interaction.approvalRequest.details
              ? { details: interaction.approvalRequest.details.map((detail) => ({ ...detail })) }
              : {}),
            ...(interaction.approvalRequest.decisionOptions
              ? {
                  decisionOptions: interaction.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                }
              : {}),
          },
        }
      : {}),
  };
}

function recoverPendingInteractions(
  dialogMessages: readonly DialogMessage[],
  livePendingInteractions: readonly PendingInteraction[],
): PendingInteraction[] {
  const pendingByMessageId = new Map<string, PendingInteraction>();
  livePendingInteractions.forEach((interaction) => {
    if (interaction.status === "pending") {
      pendingByMessageId.set(interaction.messageId, clonePendingInteraction(interaction));
    }
  });

  for (const message of dialogMessages) {
    if (!message.expectReply || message.from === "user" || message.interactionStatus !== "pending") {
      continue;
    }
    if (pendingByMessageId.has(message.id)) continue;
    const interactionType = message.interactionType
      ?? (message.kind === "approval_request"
        ? "approval"
        : message.kind === "clarification_request"
          ? "clarification"
          : "question");
    pendingByMessageId.set(message.id, {
      id: message.interactionId ?? `restored-${message.id}`,
      fromActorId: message.from,
      messageId: message.id,
      question: message.content,
      type: interactionType,
      replyMode: "single",
      status: "pending",
      createdAt: message.timestamp,
      options: message.options ? [...message.options] : undefined,
      approvalRequest: message.approvalRequest
        ? {
            ...message.approvalRequest,
            ...(message.approvalRequest.details
              ? { details: message.approvalRequest.details.map((detail) => ({ ...detail })) }
              : {}),
            ...(message.approvalRequest.decisionOptions
              ? {
                  decisionOptions: message.approvalRequest.decisionOptions.map((option) => ({ ...option })),
                }
              : {}),
          }
        : undefined,
      resolve: () => {},
    });
  }

  return [...pendingByMessageId.values()].sort((left, right) => left.createdAt - right.createdAt);
}

function getRelatedRunIdByMessageId(
  dialogMessages: readonly DialogMessage[],
  messageId?: string | null,
): string | undefined {
  if (!messageId) return undefined;
  return dialogMessages.find((message) => message.id === messageId)?.relatedRunId;
}

function cloneUploadRecords(
  records?: readonly SessionUploadRecord[],
): SessionUploadRecord[] | undefined {
  return records?.map((record) => ({ ...record }));
}

export interface CollaborationSessionControllerSystemAdapter {
  sessionId?: string;
  getPendingInteractionsSnapshot?(): PendingInteraction[];
  getPendingUserInteractions?(): PendingInteraction[];
  getSpawnedTasksSnapshot?(): SpawnedTaskRecord[];
  getFocusedSpawnedSessionRunId?(): string | null;
  focusSpawnedSession?(runId: string | null): void;
  getActiveExecutionContract?(): ExecutionContract | null;
  getDialogExecutionPlan?(): DialogExecutionPlan | null;
  armExecutionContract?(contract: ExecutionContract): void;
  restoreExecutionContract?(contract: ExecutionContract): void;
  clearExecutionContract?(): void;
  getDialogMessagesSnapshot?(): DialogMessage[];
  getDialogHistory?(): readonly DialogMessage[];
  armDialogExecutionPlan?(plan: ReturnType<typeof toDialogExecutionPlan>): void;
  restoreDialogExecutionPlan?(plan: ReturnType<typeof toDialogExecutionPlan>): void;
  clearDialogExecutionPlan?(): void;
  send?(
    from: string,
    to: string,
    content: string,
    opts?: { _briefContent?: string; images?: string[]; relatedRunId?: string },
  ): DialogMessage;
  broadcast?(
    from: string,
    content: string,
    opts?: { _briefContent?: string; images?: string[] },
  ): DialogMessage;
  broadcastAndResolve?(
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
      runtimeDisplayLabel?: DialogMessage["runtimeDisplayLabel"];
      runtimeDisplayDetail?: DialogMessage["runtimeDisplayDetail"];
    },
  ): DialogMessage;
  replyToMessage?(
    messageId: string,
    content: string,
    opts?: { _briefContent?: string; images?: string[] },
  ): DialogMessage;
  sendUserMessageToSpawnedSession?(
    runId: string,
    content: string,
    opts?: { _briefContent?: string; images?: string[] },
  ): DialogMessage;
  steer?(actorId: string, directive: string): DialogMessage | { error: string };
  registerSessionUploads?(
    records: readonly SessionUploadRecord[],
    opts?: { actorId?: string; relatedRunId?: string },
  ): void;
}

export interface CollaborationSessionControllerOptions {
  surface?: CollaborationSurface;
  actorRosterProvider?: () => readonly CollaborationActorRosterEntry[];
}

export class CollaborationSessionController {
  private readonly system: CollaborationSessionControllerSystemAdapter;
  private readonly surface: CollaborationSurface;
  private readonly actorRosterProvider?: () => readonly CollaborationActorRosterEntry[];
  private activeContract: ExecutionContract | null = null;
  private queuedFollowUps: CollaborationQueuedFollowUp[] = [];
  private focusedChildSessionId: string | null = null;
  private currentSnapshot: CollaborationSessionSnapshot;

  constructor(
    system: CollaborationSessionControllerSystemAdapter,
    options?: CollaborationSessionControllerOptions | CollaborationSurface,
  ) {
    this.system = system;
    if (typeof options === "string") {
      this.surface = options;
      this.actorRosterProvider = undefined;
    } else {
      this.surface = options?.surface ?? "local_dialog";
      this.actorRosterProvider = options?.actorRosterProvider;
    }
    this.currentSnapshot = createEmptyCollaborationSnapshot(this.surface);
  }

  applyExecutionContract(contract: ExecutionContract | null): void {
    this.activeContract = contract ? cloneExecutionContract(contract) : null;
    if (!this.activeContract) {
      if (this.system.clearExecutionContract) {
        this.system.clearExecutionContract();
      } else {
        this.system.clearDialogExecutionPlan?.();
      }
      this.refreshProjection();
      return;
    }
    if (this.activeContract.state === "sealed") {
      if (this.system.armExecutionContract) {
        this.system.armExecutionContract(this.activeContract);
      } else {
        const dialogPlan = toDialogExecutionPlan(this.activeContract);
        this.system.armDialogExecutionPlan?.(dialogPlan);
      }
    } else {
      if (this.system.restoreExecutionContract) {
        this.system.restoreExecutionContract(this.activeContract);
      } else {
        const dialogPlan = toDialogExecutionPlan(this.activeContract);
        this.system.restoreDialogExecutionPlan?.(dialogPlan);
      }
    }
    this.refreshProjection();
  }

  snapshot(): CollaborationSessionSnapshot {
    return cloneCollaborationSnapshot(this.refreshProjection());
  }

  restore(snapshot: CollaborationSessionSnapshot | null): CollaborationSessionSnapshot {
    if (!snapshot) {
      this.activeContract = null;
      this.queuedFollowUps = [];
      this.focusedChildSessionId = null;
      if (this.system.clearExecutionContract) {
        this.system.clearExecutionContract();
      } else {
        this.system.clearDialogExecutionPlan?.();
      }
      this.system.focusSpawnedSession?.(null);
      this.currentSnapshot = createEmptyCollaborationSnapshot(this.surface);
      return this.snapshot();
    }

    const sanitized = sanitizeCollaborationSnapshot(snapshot, this.surface);
    this.activeContract = sanitized.activeContract
      ? cloneExecutionContract(sanitized.activeContract)
      : this.restoreCompatActiveContract();
    this.queuedFollowUps = sanitized.queuedFollowUps.map((item) => cloneQueuedFollowUp(item));
    this.focusedChildSessionId = sanitized.focusedChildSessionId;
    if (this.activeContract) {
      if (this.activeContract.state === "sealed") {
        if (this.system.armExecutionContract) {
          this.system.armExecutionContract(this.activeContract);
        } else {
          const dialogPlan = toDialogExecutionPlan(this.activeContract);
          this.system.armDialogExecutionPlan?.(dialogPlan);
        }
      } else {
        if (this.system.restoreExecutionContract) {
          this.system.restoreExecutionContract(this.activeContract);
        } else {
          const dialogPlan = toDialogExecutionPlan(this.activeContract);
          this.system.restoreDialogExecutionPlan?.(dialogPlan);
        }
      }
    } else {
      if (this.system.clearExecutionContract) {
        this.system.clearExecutionContract();
      } else {
        this.system.clearDialogExecutionPlan?.();
      }
    }
    this.system.focusSpawnedSession?.(this.focusedChildSessionId);
    return this.syncFromSystem();
  }

  setFocusedChildSession(childSessionId: string | null): void {
    this.focusedChildSessionId = childSessionId;
    this.system.focusSpawnedSession?.(childSessionId);
    this.refreshProjection();
  }

  enqueueFollowUp(
    item: Omit<CollaborationQueuedFollowUp, "id" | "displayText" | "createdAt" | "executionStrategy" | "policy" | "contractStatus"> & {
      id?: string;
      displayText?: string;
      createdAt?: number;
      executionStrategy?: CollaborationQueuedFollowUp["executionStrategy"];
      contractStatus?: CollaborationQueuedFollowUp["contractStatus"];
    },
    policy: FollowUpPolicy,
  ): string {
    const contract = item.contract ? cloneExecutionContract(item.contract) : this.activeContract ? cloneExecutionContract(this.activeContract) : null;
    const executionStrategy = item.executionStrategy ?? contract?.executionStrategy ?? this.activeContract?.executionStrategy ?? "coordinator";
    const contractStatus = item.contractStatus ?? this.resolveQueuedFollowUpContractStatus(contract);
    const queued: CollaborationQueuedFollowUp = {
      id: item.id ?? createId("followup"),
      displayText: item.displayText ?? item.briefContent ?? summarizeText(item.content) ?? "待发送消息",
      content: item.content,
      briefContent: item.briefContent,
      images: item.images ? [...item.images] : undefined,
      attachmentPaths: item.attachmentPaths ? [...item.attachmentPaths] : undefined,
      uploadRecords: cloneUploadRecords(item.uploadRecords),
      executionStrategy,
      createdAt: item.createdAt ?? Date.now(),
      policy,
      contract,
      contractStatus,
      focusedChildSessionId: item.focusedChildSessionId ?? this.focusedChildSessionId,
    };
    this.queuedFollowUps = [...this.queuedFollowUps, queued];
    this.refreshProjection();
    return queued.id;
  }

  removeQueuedFollowUp(itemId: string): void {
    this.queuedFollowUps = this.queuedFollowUps.filter((item) => item.id !== itemId);
    this.refreshProjection();
  }

  runQueuedFollowUp(itemId: string): CollaborationDispatchResult {
    const item = this.queuedFollowUps.find((followUp) => followUp.id === itemId);
    if (!item) {
      throw new Error(`Unknown queued follow-up: ${itemId}`);
    }
    if (!this.validateQueuedFollowUpContract(item)) {
      this.refreshProjection();
      throw new Error("Queued follow-up needs reapproval before dispatch");
    }
    const result = this.dispatchUserInput({
      content: item.content,
      displayText: item.displayText,
      briefContent: item.briefContent,
      images: item.images,
      attachmentPaths: item.attachmentPaths,
      uploadRecords: item.uploadRecords,
    }, {
      contract: item.contract,
      policy: item.policy,
      allowQueue: false,
      focusedChildSessionId: item.focusedChildSessionId ?? null,
      directTargetActorId: item.contract?.executionStrategy === "direct"
        && item.contract.initialRecipientActorIds.length === 1
        ? item.contract.initialRecipientActorIds[0]
        : undefined,
      forceAsNewMessage: true,
    });
    this.queuedFollowUps = this.queuedFollowUps.filter((followUp) => followUp.id !== itemId);
    this.refreshProjection();
    return result;
  }

  clearQueuedFollowUps(): void {
    this.queuedFollowUps = [];
    this.refreshProjection();
  }

  syncFromSystem(): CollaborationSessionSnapshot {
    const dialogMessages = this.getDialogMessages();
    const spawnedTasks = this.system.getSpawnedTasksSnapshot?.() ?? [];
    const pendingInteractions = recoverPendingInteractions(
      dialogMessages,
      this.system.getPendingInteractionsSnapshot?.()
        ?? this.system.getPendingUserInteractions?.()
        ?? [],
    );
    const childSessions = buildCollaborationChildSessions(spawnedTasks);
    const focusedRunId = this.system.getFocusedSpawnedSessionRunId?.() ?? null;
    const focusedChild = focusedRunId
      ? childSessions.find((session) => session.runId === focusedRunId || session.id === focusedRunId) ?? null
      : null;

    const liveContract = this.system.getActiveExecutionContract?.() ?? null;
    if (liveContract) {
      this.activeContract = cloneExecutionContract(liveContract);
    }

    this.focusedChildSessionId = focusedChild?.id ?? null;
    this.queuedFollowUps = this.queuedFollowUps.map((item) => ({
      ...item,
      contractStatus: this.resolveQueuedFollowUpContractStatus(item.contract),
    }));

    if (this.activeContract) {
      this.activeContract = {
        ...cloneExecutionContract(this.activeContract),
        state: this.deriveContractState({
          pendingInteractions,
          childSessions,
          dialogMessages,
        }),
      };
    }

    this.currentSnapshot = {
      version: 1,
      surface: this.surface,
      sessionId: this.system.sessionId,
      activeContract: this.activeContract ? cloneExecutionContract(this.activeContract) : null,
      pendingInteractions,
      childSessions,
      contractDelegations: buildCollaborationContractDelegations(this.activeContract, spawnedTasks),
      queuedFollowUps: this.queuedFollowUps.map((item) => cloneQueuedFollowUp(item)),
      focusedChildSessionId: this.focusedChildSessionId,
      presentationState: buildCollaborationPresentationState({
        surface: this.surface,
        activeContract: this.activeContract,
        pendingInteractions,
        childSessions,
        queuedFollowUps: this.queuedFollowUps,
        focusedChildSessionId: this.focusedChildSessionId,
      }),
      dialogMessages,
      updatedAt: Date.now(),
    };
    return cloneCollaborationSnapshot(this.currentSnapshot);
  }

  dispatchUserInput(
    input: CollaborationDispatchInput | string,
    options?: CollaborationDispatchOptions,
  ): CollaborationDispatchResult {
    const normalizedInput = normalizeDispatchInput(input);
    if (options?.contract !== undefined) {
      this.applyExecutionContract(options.contract ?? null);
    }

    const snapshot = this.syncFromSystem();
    const pendingInteractions = snapshot.pendingInteractions;
    const selectedPendingMessageId = options?.selectedPendingMessageId?.trim() || null;
    const forceAsNewMessage = options?.forceAsNewMessage === true;
    const explicitPending = selectedPendingMessageId
      ? pendingInteractions.find((interaction) => interaction.messageId === selectedPendingMessageId)
      : undefined;
    const effectivePending = explicitPending
      ?? (!forceAsNewMessage && pendingInteractions.length === 1 ? pendingInteractions[0] : undefined);

    if (!forceAsNewMessage && pendingInteractions.length > 1 && !effectivePending) {
      throw new Error("当前有多条待处理交互，请先明确回复对象。");
    }

    if (effectivePending) {
      return this.replyToInteraction(effectivePending.id, normalizedInput);
    }

    if (options?.steerTargetActorId) {
      const result = this.system.steer?.(options.steerTargetActorId, normalizedInput.content);
      if (result && "error" in result) {
        throw new Error(result.error);
      }
      this.syncFromSystem();
      return {
        disposition: "steered",
        messageId: "id" in (result ?? {}) ? (result as DialogMessage).id : undefined,
      };
    }

    const focusedChildSessionId = options && "focusedChildSessionId" in options
      ? options.focusedChildSessionId ?? null
      : this.focusedChildSessionId;
    const focusedChild = focusedChildSessionId
      ? snapshot.childSessions.find((session) => session.id === focusedChildSessionId)
      : undefined;
    const policy = options?.policy ?? this.getDefaultPolicy({
      hasPendingInteractions: pendingInteractions.length > 0,
      hasFocusedChildSession: Boolean(focusedChild?.focusable),
      roomBusy: this.isRoomBusy(snapshot.childSessions),
    });

    if (focusedChild?.focusable && !options?.directTargetActorId && policy === "steer") {
      const message = this.system.sendUserMessageToSpawnedSession?.(focusedChild.runId, normalizedInput.content, {
        _briefContent: normalizedInput.briefContent ?? normalizedInput.displayText,
        images: normalizedInput.images,
      });
      if (normalizedInput.uploadRecords?.length) {
        this.system.registerSessionUploads?.(normalizedInput.uploadRecords, {
          actorId: "user",
          relatedRunId: focusedChild.runId,
        });
      }
      this.focusedChildSessionId = focusedChild.id;
      this.syncFromSystem();
      return {
        disposition: "focused_child",
        childSessionId: focusedChild.id,
        messageId: message?.id,
      };
    }

    if (options?.allowQueue !== false && policy === "queue" && this.isRoomBusy(snapshot.childSessions)) {
      const followUpId = this.enqueueFollowUp({
        content: normalizedInput.content,
        displayText: normalizedInput.displayText ?? normalizedInput.briefContent ?? summarizeText(normalizedInput.content) ?? "待发送消息",
        briefContent: normalizedInput.briefContent,
        images: normalizedInput.images,
        attachmentPaths: normalizedInput.attachmentPaths,
        uploadRecords: normalizedInput.uploadRecords,
        executionStrategy: this.activeContract?.executionStrategy ?? "coordinator",
        contract: options?.contract ?? this.activeContract,
        focusedChildSessionId: focusedChild?.id ?? null,
      }, policy);
      this.syncFromSystem();
      return { disposition: "queued", followUpId };
    }

    const briefContent = normalizedInput.briefContent ?? normalizedInput.displayText;
    const strategy = options?.contract?.executionStrategy ?? this.activeContract?.executionStrategy ?? "coordinator";
    let message: DialogMessage | null = null;

    if (options?.directTargetActorId) {
      message = this.system.send?.("user", options.directTargetActorId, normalizedInput.content, {
        _briefContent: briefContent,
        images: normalizedInput.images,
        relatedRunId: focusedChild?.runId,
      }) ?? null;
    } else if (strategy === "direct" && this.activeContract?.initialRecipientActorIds.length === 1) {
      message = this.system.send?.("user", this.activeContract.initialRecipientActorIds[0], normalizedInput.content, {
        _briefContent: briefContent,
        images: normalizedInput.images,
        relatedRunId: focusedChild?.runId,
      }) ?? null;
    } else if (strategy === "broadcast") {
      message = this.system.broadcast?.("user", normalizedInput.content, {
        _briefContent: briefContent,
        images: normalizedInput.images,
      }) ?? null;
    } else {
      message = this.system.broadcastAndResolve?.("user", normalizedInput.content, {
        _briefContent: briefContent,
        images: normalizedInput.images,
        ...(normalizedInput.externalChannelType ? { externalChannelType: normalizedInput.externalChannelType } : {}),
        ...(normalizedInput.externalChannelId ? { externalChannelId: normalizedInput.externalChannelId } : {}),
        ...(normalizedInput.externalConversationId ? { externalConversationId: normalizedInput.externalConversationId } : {}),
        ...(normalizedInput.externalConversationType ? { externalConversationType: normalizedInput.externalConversationType } : {}),
        ...(normalizedInput.externalSessionId ? { externalSessionId: normalizedInput.externalSessionId } : {}),
        ...(normalizedInput.runtimeDisplayLabel ? { runtimeDisplayLabel: normalizedInput.runtimeDisplayLabel } : {}),
        ...(normalizedInput.runtimeDisplayDetail ? { runtimeDisplayDetail: normalizedInput.runtimeDisplayDetail } : {}),
      })
        ?? this.system.broadcast?.("user", normalizedInput.content, {
          _briefContent: briefContent,
          images: normalizedInput.images,
        })
        ?? null;
    }

    if (normalizedInput.uploadRecords?.length) {
      this.system.registerSessionUploads?.(normalizedInput.uploadRecords, {
        actorId: "user",
        relatedRunId: focusedChild?.runId,
      });
    }

    if (this.activeContract && this.activeContract.state === "sealed") {
      this.activeContract = {
        ...cloneExecutionContract(this.activeContract),
        state: "active",
      };
    }

    this.syncFromSystem();
    return {
      disposition: "dispatched",
      messageId: message?.id,
    };
  }

  replyToInteraction(
    interactionId: string,
    reply: CollaborationDispatchInput | string,
  ): CollaborationDispatchResult {
    const normalizedReply = normalizeDispatchInput(reply);
    const snapshot = this.syncFromSystem();
    const interaction = snapshot.pendingInteractions.find(
      (item) => item.id === interactionId || item.messageId === interactionId,
    );
    if (!interaction) {
      throw new Error(`Unknown pending interaction: ${interactionId}`);
    }
    const message = this.system.replyToMessage?.(interaction.messageId, normalizedReply.content, {
      _briefContent: normalizedReply.briefContent ?? normalizedReply.displayText,
      images: normalizedReply.images,
    }) ?? null;
    if (normalizedReply.uploadRecords?.length) {
      this.system.registerSessionUploads?.(normalizedReply.uploadRecords, {
        actorId: "user",
        relatedRunId: getRelatedRunIdByMessageId(snapshot.dialogMessages, interaction.messageId),
      });
    }
    this.syncFromSystem();
    return {
      disposition: "replied",
      messageId: message?.id,
    };
  }

  dispose(): void {
    this.activeContract = null;
    this.queuedFollowUps = [];
    this.focusedChildSessionId = null;
    this.currentSnapshot = createEmptyCollaborationSnapshot(this.surface);
  }

  private getDialogMessages(): DialogMessage[] {
    return this.system.getDialogMessagesSnapshot?.()
      ?? [...(this.system.getDialogHistory?.() ?? [])].map((message) => ({ ...message }));
  }

  private refreshProjection(): CollaborationSessionSnapshot {
    return this.currentSnapshot = this.currentSnapshot.version === 1
      ? this.syncFromSystem()
      : createEmptyCollaborationSnapshot(this.surface);
  }

  private isRoomBusy(childSessions: readonly CollaborationChildSession[]): boolean {
    return childSessions.some((session) => session.status === "running")
      || this.queuedFollowUps.length > 0
      || this.currentSnapshot.pendingInteractions.length > 0;
  }

  private getDefaultPolicy(params: {
    hasPendingInteractions: boolean;
    hasFocusedChildSession: boolean;
    roomBusy: boolean;
  }): FollowUpPolicy {
    if (params.hasPendingInteractions) return "interrupt";
    if (params.hasFocusedChildSession) return "steer";
    if (params.roomBusy) return "queue";
    return "interrupt";
  }

  private resolveQueuedFollowUpContractStatus(
    contract: ExecutionContract | null | undefined,
  ): CollaborationQueuedFollowUp["contractStatus"] {
    if (!contract) return "missing";
    if (!this.actorRosterProvider) return "ready";
    return doesExecutionContractMatchActorRoster(contract, this.actorRosterProvider())
      ? "ready"
      : "needs_reapproval";
  }

  private validateQueuedFollowUpContract(item: CollaborationQueuedFollowUp): boolean {
    item.contractStatus = this.resolveQueuedFollowUpContractStatus(item.contract);
    return item.contractStatus !== "needs_reapproval";
  }

  private deriveContractState(params: {
    pendingInteractions: readonly PendingInteraction[];
    childSessions: readonly CollaborationChildSession[];
    dialogMessages: readonly DialogMessage[];
  }): ExecutionContract["state"] {
    if (params.childSessions.some((session) => session.status === "failed")) return "failed";
    if (
      params.pendingInteractions.length > 0
      || params.childSessions.some((session) => session.status === "running" || session.status === "waiting")
    ) {
      return "active";
    }
    const lastAgentResult = [...params.dialogMessages].reverse().find((message) => message.kind === "agent_result");
    if (lastAgentResult) return "completed";
    return this.activeContract?.state ?? "sealed";
  }

  private restoreCompatActiveContract(): ExecutionContract | null {
    const liveContract = this.system.getActiveExecutionContract?.() ?? null;
    if (liveContract) {
      return cloneExecutionContract(liveContract);
    }
    const dialogPlan = this.system.getDialogExecutionPlan?.() ?? null;
    if (!dialogPlan) return null;
    const contract = buildExecutionContractFromDialogPlan({
      surface: this.surface,
      plan: dialogPlan as Parameters<typeof buildExecutionContractFromDialogPlan>[0]["plan"],
      actorRoster: this.actorRosterProvider?.(),
    });
    contract.state =
      dialogPlan.state === "armed"
        ? "sealed"
        : dialogPlan.state === "active"
          ? "active"
          : dialogPlan.state === "failed"
            ? "failed"
            : "completed";
    return contract;
  }
}
