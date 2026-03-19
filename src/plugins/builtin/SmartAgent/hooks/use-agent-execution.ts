import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { ReActAgent, type AgentStep, type AgentTool } from "../core/react-agent";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import {
  getAgentSessionCompactedTaskCount,
  getAgentSessionLiveTasks,
  hasAgentSessionHiddenTasks,
  useAgentStore,
} from "@/store/agent-store";
import { useAIStore } from "@/store/ai-store";
import { useAgentMemoryStore } from "@/store/agent-memory-store";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import {
  getEnhancedAgentMaxIterations,
  normalizeCodingExecutionProfile,
  type CodingExecutionProfile,
} from "@/core/agent/coding-profile";
import { loadAndResolveSkills } from "@/store/skill-store";
import { applySkillToolFilter } from "@/core/agent/skills/skill-resolver";
import {
  getExecutionWaitingStageLabel,
  type ExecutionWaitingStage,
  type RunningPhase,
} from "../core/ui-state";
import {
  buildAgentSessionCompactionState,
  enrichAgentSessionCompactionState,
  isAgentContextPressureError,
  shouldAutoCompactAgentSession,
} from "../core/session-compaction";
import {
  buildAgentPromptContextSnapshot,
  type AgentPromptContextSnapshot,
} from "../core/prompt-context";
import { useAgentRunningStore } from "@/store/agent-running-store";
import { recordAIRouteEvent } from "@/store/ai-route-store";
import { applyIncomingAgentStep } from "../core/agent-task-state";
import {
  buildAssistantSupplementalPrompt,
  shouldAutoSaveAssistantMemory,
  shouldRecallAssistantMemory,
} from "@/core/ai/assistant-config";
import { modelSupportsImageInput } from "@/core/ai/model-capabilities";
import { autoExtractMemories } from "@/core/agent/actor/actor-memory";
import { buildKnowledgeContextMessages } from "@/core/agent/actor/middlewares/knowledge-base-middleware";
import { isRetryableError } from "@/core/agent/actor/middlewares/model-retry-middleware";
import {
  assembleAgentExecutionContext,
  buildAgentExecutionContextPlan,
} from "@/core/agent/context-runtime";
import { persistAgentTurnContextIngest } from "@/core/agent/context-runtime/context-ingest";
import { persistAgentSessionCompactionArtifacts } from "@/core/agent/context-runtime/compaction-orchestrator";

type AgentStoreState = ReturnType<typeof useAgentStore.getState>;
export const AGENT_EXECUTION_HEARTBEAT_INTERVAL_MS = 10_000;
export const AGENT_EXECUTION_TIMEOUT_MS = 600_000;
export const AGENT_EXECUTION_TIMEOUT_LARGE_PROJECT_MS = 1_800_000;
export const AGENT_MODEL_STALL_TIMEOUT_MS = 90_000;
export const AGENT_MODEL_STALL_TIMEOUT_LARGE_PROJECT_MS = 180_000;

interface UseAgentExecutionParams {
  ai?: MToolsAI;
  setRunning: Dispatch<SetStateAction<boolean>>;
  setRunningPhase: Dispatch<SetStateAction<RunningPhase | null>>;
  setExecutionWaitingStage: Dispatch<SetStateAction<ExecutionWaitingStage | null>>;
  availableTools: AgentTool[];
  currentSessionId: string | null;
  createSession: AgentStoreState["createSession"];
  addTask: AgentStoreState["addTask"];
  updateTask: AgentStoreState["updateTask"];
  updateSession: AgentStoreState["updateSession"];
  forkSession: AgentStoreState["forkSession"];
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  openDangerConfirm: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
  resetPerRunState: (() => void) | null;
  notifyToolCalled?: ((toolName: string) => void) | null;
  onPromptContextSnapshot?: ((snapshot: AgentPromptContextSnapshot | null) => void) | null;
}

interface UseAgentExecutionResult {
  executeAgentTask: (
    query: string,
    opts?: {
      sessionId?: string;
      taskId?: string;
      systemHint?: string;
      codingHint?: string;
      images?: string[];
      attachmentPaths?: string[];
      runProfile?: CodingExecutionProfile;
      sourceHandoff?: import("@/store/agent-store").AgentSession["sourceHandoff"];
      forceNewSession?: boolean;
    },
  ) => Promise<void>;
  stopExecution: () => void;
}

export function useAgentExecution({
  ai,
  setRunning,
  setRunningPhase,
  setExecutionWaitingStage,
  availableTools,
  currentSessionId,
  createSession,
  addTask,
  updateTask,
  updateSession,
  forkSession,
  inputRef,
  scrollRef,
  openDangerConfirm,
  resetPerRunState,
  notifyToolCalled,
  onPromptContextSnapshot,
}: UseAgentExecutionParams): UseAgentExecutionResult {
  const abortControllerRef = useRef<AbortController | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
    if (timeoutTimerRef.current) { clearTimeout(timeoutTimerRef.current); timeoutTimerRef.current = null; }
  }, []);

  const stopExecution = useCallback(() => {
    clearTimers();
    const localAbortController = abortControllerRef.current;
    const globalAbortFn = useAgentRunningStore.getState().abortFn;

    if (localAbortController) {
      localAbortController.abort();
      abortControllerRef.current = null;
    } else if (globalAbortFn) {
      globalAbortFn();
    }

    if (localAbortController || globalAbortFn) {
      setRunning(false);
      setRunningPhase(null);
      setExecutionWaitingStage(null);
      useAgentRunningStore.getState().stop();
    }
  }, [clearTimers, setExecutionWaitingStage, setRunning, setRunningPhase]);

  const executeAgentTask = useCallback(
    async (
      query: string,
      opts?: {
        sessionId?: string;
        taskId?: string;
        systemHint?: string;
        codingHint?: string;
        images?: string[];
        attachmentPaths?: string[];
        runProfile?: CodingExecutionProfile;
        sourceHandoff?: import("@/store/agent-store").AgentSession["sourceHandoff"];
        forceNewSession?: boolean;
      },
    ) => {
      if (!ai || !query.trim()) return;

      resetPerRunState?.();

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        clearTimers();
      }

      let sessionId = opts?.forceNewSession ? null : (opts?.sessionId || currentSessionId);
      let taskId = opts?.taskId || "";
      const snapshot = useAgentStore.getState();
      let session = sessionId
        ? snapshot.sessions.find((item) => item.id === sessionId)
        : undefined;
      const turnSourceHandoff = opts?.sourceHandoff;
      const executionContextPlan = await buildAgentExecutionContextPlan({
        query,
        currentSession: session,
        attachmentPaths: opts?.attachmentPaths,
        images: opts?.images,
        sourceHandoff: turnSourceHandoff,
        forceNewSession: opts?.forceNewSession,
      });
      const continuityDecision = executionContextPlan.continuity;
      const shouldStartIsolatedSession =
        !taskId
        && (
          !sessionId
          || !session
          || continuityDecision.strategy === "fork_session"
        );

      if (
        session
        && !taskId
        && continuityDecision.strategy !== "fork_session"
        && hasAgentSessionHiddenTasks(session)
      ) {
        const forkedSessionId = forkSession(session.id, {
          visibleOnly: true,
          title: `${session.title || "新任务"} · 分支`,
        });
        if (forkedSessionId) {
          sessionId = forkedSessionId;
          session = useAgentStore.getState().sessions.find(
            (item) => item.id === forkedSessionId,
          );
        }
      }

      if (shouldStartIsolatedSession) {
        sessionId = createSession(query, executionContextPlan.promptSourceHandoff, {
          images: opts?.images,
          attachmentPaths: opts?.attachmentPaths,
        });
        const newSession = useAgentStore
          .getState()
          .sessions.find((s) => s.id === sessionId);
        taskId = taskId || newSession?.tasks[0]?.id || "";
        session = newSession;
      } else if (sessionId && session && !taskId) {
        const compactDecision = shouldAutoCompactAgentSession(session);
        if (compactDecision.shouldCompact) {
          const baseCompaction = buildAgentSessionCompactionState(session, {
            reason: compactDecision.reason,
          });
          const compaction = await enrichAgentSessionCompactionState(
            session,
            baseCompaction,
          ).catch(() => baseCompaction);
          if (
            compaction &&
            compaction.compactedTaskCount > getAgentSessionCompactedTaskCount(session)
          ) {
            void persistAgentSessionCompactionArtifacts({
              session,
              compaction,
            }).catch(() => undefined);
            updateSession(session.id, { compaction });
            session = useAgentStore.getState().sessions.find(
              (item) => item.id === sessionId,
            ) ?? session;
          }
        }
        taskId = addTask(
          sessionId,
          query,
          opts?.images,
          opts?.attachmentPaths,
        );
        session = useAgentStore.getState().sessions.find(
          (item) => item.id === sessionId,
        );
      }

      if (!sessionId || !taskId) return;

      recordAIRouteEvent({
        mode: "agent",
        source: "agent_run",
        taskId: sessionId,
        queryPreview: query.length > 120 ? `${query.slice(0, 120)}...` : query,
      });

      const setWaitingStageIfChanged = (stage: ExecutionWaitingStage | null) => {
        setExecutionWaitingStage((prev) => (prev === stage ? prev : stage));
        useAgentRunningStore.getState().patch({
          waitingStage: stage ?? undefined,
        });
      };

      setRunning(true);
      setRunningPhase("executing");
      setWaitingStageIfChanged("model_first_token");
      const runStartedAt = Date.now();
      useAgentRunningStore.getState().start(
        {
          sessionId,
          query,
          startedAt: runStartedAt,
          workspaceRoot: executionContextPlan.effectiveWorkspaceRoot,
          waitingStage: "model_first_token",
        },
        () => abortControllerRef.current?.abort(),
      );
      if (inputRef.current) inputRef.current.style.height = "auto";
      updateTask(sessionId, taskId, {
        status: "running",
        retry_count: 0,
        last_error: undefined,
        next_run_at: undefined,
        last_started_at: runStartedAt,
      });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      let lastProgressAt = runStartedAt;
      let timeoutAborted = false;
      let modelStallAborted = false;
      clearTimers();
      let lastHeartbeatStage: ExecutionWaitingStage | null = null;
      const existingTask = useAgentStore
        .getState()
        .sessions.find((s) => s.id === sessionId)
        ?.tasks.find((t) => t.id === taskId);
      const collectedSteps: AgentStep[] = existingTask?.steps ? [...existingTask.steps] : [];
      let latestPromptContextSnapshot: AgentPromptContextSnapshot | null = null;
      const fcCompatibilityKey = buildAgentFCCompatibilityKey(useAIStore.getState().config);
      let scrollTimer: ReturnType<typeof setTimeout> | null = null;

      const applyStep = (step: AgentStep, markProgress = true) => {
        const nextSteps = applyIncomingAgentStep(collectedSteps, step);
        collectedSteps.splice(0, collectedSteps.length, ...nextSteps);

        if (markProgress) {
          lastProgressAt = Date.now();
        }

        if (step.type === "answer" && step.streaming) {
          setWaitingStageIfChanged("model_generating");
        } else if (step.type === "action") {
          setWaitingStageIfChanged("tool_waiting");
        } else if (
          step.type === "observation" &&
          step.content.includes("等待用户确认执行")
        ) {
          setWaitingStageIfChanged("user_confirm");
        } else if (step.type === "thought") {
          setWaitingStageIfChanged("model_first_token");
        }

        updateTask(sessionId!, taskId, {
          steps: [...collectedSteps],
          // 避免 FC 中间轮次的流式文本覆盖最终答案，造成“先出现再重置”。
          ...(step.type === "answer" && !step.streaming
            ? { answer: step.content }
            : {}),
        });
        if (scrollTimer) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          scrollTimer = null;
          scrollRef.current?.scrollTo({
            top: scrollRef.current.scrollHeight,
            behavior: "smooth",
          });
        }, 120);
      };

      applyStep(
        {
          type: "thought",
          content: "开始执行，正在请求模型...",
          timestamp: Date.now(),
        },
        true,
      );

      const aiConfig = useAIStore.getState().config;
      const supportsImageInput = modelSupportsImageInput(
        aiConfig.model || "",
        aiConfig.protocol,
      );
      console.log(
        `[AgentExecution] Image support check: model="${aiConfig.model}" protocol="${aiConfig.protocol}" supportsImage=${supportsImageInput} images=${opts?.images?.length ?? 0}`,
      );
      const skillContext = await loadAndResolveSkills(query);
      const skillsPrompt = skillContext.mergedSystemPrompt || undefined;
      const hasCodingWorkflowSkill = skillContext.visibleSkillIds.includes("builtin-coding-workflow");
      const toolsForRun = applySkillToolFilter(
        availableTools,
        skillContext.mergedToolFilter,
      );
      const runProfile = normalizeCodingExecutionProfile(opts?.runProfile);
      let userMemoryPrompt: string | undefined;
      let memoryRecallAttempted = false;
      let appliedMemoryIds: string[] = [];
      let appliedMemoryPreview: string[] = [];
      let transcriptRecallAttempted = false;
      let transcriptRecallHitCount = 0;
      let transcriptRecallPreview: string[] = [];
      if (shouldRecallAssistantMemory(aiConfig)) {
        let memorySnap = useAgentMemoryStore.getState();
        if (!memorySnap.loaded) {
          await memorySnap.load();
          memorySnap = useAgentMemoryStore.getState();
        }
        const memoryBundle = await memorySnap.getMemoryRecallBundleAsync(query, {
          topK: 6,
          conversationId: sessionId,
          workspaceId: executionContextPlan.effectiveWorkspaceRoot,
          preferSemantic: true,
        });
        userMemoryPrompt = memoryBundle.prompt || undefined;
        memoryRecallAttempted = memoryBundle.searched;
        appliedMemoryIds = memoryBundle.memoryIds.slice(0, 8);
        appliedMemoryPreview = memoryBundle.memoryPreview.slice(0, 4);
        transcriptRecallAttempted = memoryBundle.transcriptSearched;
        transcriptRecallHitCount = memoryBundle.transcriptHitCount;
        transcriptRecallPreview = memoryBundle.transcriptPreview.slice(0, 4);
      }
      updateTask(sessionId, taskId, {
        memoryRecallAttempted,
        appliedMemoryIds,
        appliedMemoryPreview,
        transcriptRecallAttempted,
        transcriptRecallHitCount,
        appliedTranscriptPreview: transcriptRecallPreview,
      });

      const contextLimit = runProfile.largeProjectMode ? 160_000 : undefined;
      const knowledgeContextMessages = await buildKnowledgeContextMessages(query, {
        contextTokens: contextLimit,
      });
      const supplementalSystemPrompt = buildAssistantSupplementalPrompt(
        aiConfig.system_prompt,
      );
      const currentAttachmentSummary = [
        opts?.attachmentPaths?.length
          ? `附件 ${opts.attachmentPaths.length} 项`
          : "",
        opts?.images?.length
          ? `图片 ${opts.images.length} 张`
          : "",
      ].filter(Boolean).join("，") || undefined;
      const effectiveWorkspaceRoot = executionContextPlan.effectiveWorkspaceRoot;
      const shouldResetInheritedContext =
        executionContextPlan.shouldResetInheritedContext;
      const promptSourceHandoff = executionContextPlan.promptSourceHandoff;
      updateSession(sessionId, {
        ...(executionContextPlan.workspaceRootToPersist
          ? { workspaceRoot: executionContextPlan.workspaceRootToPersist }
          : {}),
        ...(effectiveWorkspaceRoot
          ? { repoRoot: effectiveWorkspaceRoot }
          : {}),
        lastTaskIntent: executionContextPlan.scope.queryIntent,
        lastContinuityStrategy: continuityDecision.strategy,
        lastContinuityReason: continuityDecision.reason,
        lastContextResetAt: shouldResetInheritedContext ? Date.now() : undefined,
        lastSoftResetAt:
          continuityDecision.strategy === "soft_reset" ? Date.now() : undefined,
        lastMemoryRecallAttempted: memoryRecallAttempted,
        lastMemoryRecallPreview: appliedMemoryPreview,
        lastTranscriptRecallAttempted: transcriptRecallAttempted,
        lastTranscriptRecallHitCount: transcriptRecallHitCount,
        lastTranscriptRecallPreview: transcriptRecallPreview,
      });
      session = useAgentStore.getState().sessions.find(
        (item) => item.id === sessionId,
      ) ?? session;
      const maxIterations = getEnhancedAgentMaxIterations(
        aiConfig.agent_max_iterations ?? 25,
        runProfile,
      );
      const timeoutMs = runProfile.largeProjectMode || runProfile.openClawMode
        ? AGENT_EXECUTION_TIMEOUT_LARGE_PROJECT_MS
        : AGENT_EXECUTION_TIMEOUT_MS;
      const modelStallTimeoutMs = runProfile.largeProjectMode || runProfile.openClawMode
        ? AGENT_MODEL_STALL_TIMEOUT_LARGE_PROJECT_MS
        : AGENT_MODEL_STALL_TIMEOUT_MS;

      if (runProfile.codingMode) {
        applyStep(
          {
            type: "observation",
            content: runProfile.largeProjectMode
              ? runProfile.openClawMode
                ? "已启用 OpenClaw（大项目强约束）：将按阶段推进、限定扫描范围并提高执行预算。"
                : "已启用 Coding 模式（大项目）：将按阶段推进并提高迭代预算。"
              : "已启用 Coding 模式：将优先走先读后改、改后验证流程。",
            timestamp: Date.now(),
          },
          false,
        );
      }
      if (shouldResetInheritedContext) {
        const resetMessage =
          continuityDecision.reason === "workspace_switch"
            ? `检测到工作区切换，本轮将按新工作区重置继承上下文：${effectiveWorkspaceRoot}`
            : "检测到当前请求与上文工作线索不连续，本轮将按新任务重置继承上下文。";
        applyStep(
          {
            type: "observation",
            content: resetMessage,
            timestamp: Date.now(),
          },
          false,
        );
      } else if (continuityDecision.reason === "path_focus_shift") {
        applyStep(
          {
            type: "observation",
            content: "检测到你本轮明确切到了同工作区里的另一组路径，本轮只继承历史摘要，不沿用上一轮的 live files 和 handoff。",
            timestamp: Date.now(),
          },
          false,
        );
      }
      const buildHistorySteps = (
        currentSession:
          | import("@/store/agent-store").AgentSession
          | undefined,
      ): AgentStep[] => {
        if (!currentSession) return [];
        const historySteps: AgentStep[] = [];
        for (const task of getAgentSessionLiveTasks(currentSession)) {
          const steps = task.steps || [];
          const keySteps = steps.filter(
            (step) =>
              step.type === "action"
              || step.type === "observation"
              || step.type === "answer",
          );
          for (const step of keySteps.slice(-6)) {
            historySteps.push({
              ...step,
              timestamp: step.timestamp || task.createdAt || currentSession.createdAt,
            });
          }
          if (task.answer) {
            const alreadyHasAnswer = keySteps.some(
              (step) => step.type === "answer" && step.content === task.answer,
            );
            if (!alreadyHasAnswer) {
              historySteps.push({
                type: "answer",
                content: task.answer,
                timestamp: task.createdAt || currentSession.createdAt,
              });
            }
          }
        }
        return historySteps;
      };
      const createAgent = async (
        currentSession:
          | import("@/store/agent-store").AgentSession
          | undefined,
      ) => {
        const assembledContext = await assembleAgentExecutionContext({
          session: currentSession,
          query,
          executionContextPlan,
          runProfile,
          forceNewSession: opts?.forceNewSession,
          attachmentSummary: currentAttachmentSummary,
          systemHint: opts?.systemHint,
          userMemoryPrompt,
          skillsPrompt,
          supplementalSystemPrompt,
          codingHint: opts?.codingHint,
          knowledgeContextMessageCount: knowledgeContextMessages.length,
          memoryRecallAttempted,
          memoryRecallPreview: appliedMemoryPreview,
          transcriptRecallAttempted,
          transcriptRecallHitCount,
          transcriptRecallPreview,
        });
        const sessionContextMessages = assembledContext.sessionContextMessages;
        const promptContextSnapshot = assembledContext.promptContextSnapshot;
        updateSession(sessionId, {
          lastActivePaths: promptContextSnapshot.files
            .map((file) => file.path)
            .filter((path) => typeof path === "string" && path.trim().length > 0)
            .slice(0, 12),
          lastTaskIntent: executionContextPlan.scope.queryIntent,
          lastContinuityStrategy: promptContextSnapshot.continuityStrategy,
          lastContinuityReason: promptContextSnapshot.continuityReason,
          lastContextResetAt: promptContextSnapshot.workspaceReset
            ? (session?.lastContextResetAt ?? Date.now())
            : undefined,
          lastMemoryItemCount: promptContextSnapshot.memoryItemCount,
          lastMemoryRecallAttempted: promptContextSnapshot.memoryRecallAttempted,
          lastMemoryRecallPreview: promptContextSnapshot.memoryRecallPreview,
          lastTranscriptRecallAttempted: promptContextSnapshot.transcriptRecallAttempted,
          lastTranscriptRecallHitCount: promptContextSnapshot.transcriptRecallHitCount,
          lastTranscriptRecallPreview: promptContextSnapshot.transcriptRecallPreview,
        });
        latestPromptContextSnapshot = promptContextSnapshot;
        onPromptContextSnapshot?.(promptContextSnapshot);

        return new ReActAgent(
          ai,
          toolsForRun,
          {
            maxIterations,
            temperature: aiConfig.temperature ?? 0.7,
            verbose: true,
            fcCompatibilityKey,
            userMemoryPrompt,
            skillsPrompt,
            extraSystemPrompt: assembledContext.extraSystemPrompt,
            skipInternalCodingBlock: hasCodingWorkflowSkill,
            codingHint: opts?.codingHint,
            ...(contextLimit ? { contextLimit } : {}),
            contextMessages: [
              ...sessionContextMessages,
              ...knowledgeContextMessages,
            ],
            dangerousToolPatterns: [
              "write_file",
              "open_path",
              "shell",
              "run_shell",
              "system-actions_",
              "native_calendar_create",
              "native_reminder_create",
              "native_notes_create",
              "native_mail_create",
              "native_shortcuts_run",
            ],
            confirmDangerousAction: async (toolName, params) => {
              setWaitingStageIfChanged("user_confirm");
              const confirmed = await openDangerConfirm(toolName, params);
              setWaitingStageIfChanged(confirmed ? "tool_waiting" : "model_first_token");
              return confirmed;
            },
            onToolExecuted: notifyToolCalled ?? undefined,
          },
          (step) => {
            applyStep(step, true);
          },
          continuityDecision.carryRecentSteps ? buildHistorySteps(currentSession) : [],
        );
      };

      let agent = await createAgent(session);
      const refreshPromptContextSnapshot = () => {
        const refreshedSession = useAgentStore.getState().sessions.find(
          (item) => item.id === sessionId,
        ) ?? session;
        const nextSnapshot = buildAgentPromptContextSnapshot({
          session: refreshedSession,
          query,
          runProfile: runProfile.codingMode ? runProfile : undefined,
          attachmentSummary: currentAttachmentSummary,
          systemHint: opts?.systemHint,
          sourceHandoff: promptSourceHandoff,
          userMemoryPrompt,
          skillsPrompt,
          extraSystemPrompt: supplementalSystemPrompt,
          codingHint: opts?.codingHint,
          bootstrapContextFileNames:
            latestPromptContextSnapshot?.bootstrapContextFileNames ?? [],
          bootstrapContextDiagnostics:
            latestPromptContextSnapshot?.bootstrapDiagnostics,
          workspaceRoot:
            latestPromptContextSnapshot?.workspaceRoot ?? effectiveWorkspaceRoot,
          workspaceReset: shouldResetInheritedContext,
          continuityStrategy: continuityDecision.strategy,
          continuityReason: continuityDecision.reason,
          memoryItemCount: refreshedSession?.lastMemoryItemCount,
          memoryRecallAttempted:
            latestPromptContextSnapshot?.memoryRecallAttempted
            ?? refreshedSession?.lastMemoryRecallAttempted,
          memoryRecallPreview:
            latestPromptContextSnapshot?.memoryRecallPreview
            ?? refreshedSession?.lastMemoryRecallPreview,
          transcriptRecallAttempted:
            latestPromptContextSnapshot?.transcriptRecallAttempted
            ?? refreshedSession?.lastTranscriptRecallAttempted,
          transcriptRecallHitCount:
            latestPromptContextSnapshot?.transcriptRecallHitCount
            ?? refreshedSession?.lastTranscriptRecallHitCount,
          transcriptRecallPreview:
            latestPromptContextSnapshot?.transcriptRecallPreview
            ?? refreshedSession?.lastTranscriptRecallPreview,
          historyContextMessageCount:
            latestPromptContextSnapshot?.historyContextMessageCount ?? 0,
          knowledgeContextMessageCount:
            latestPromptContextSnapshot?.knowledgeContextMessageCount ?? 0,
          files: latestPromptContextSnapshot?.files,
          contextLines: latestPromptContextSnapshot?.contextLines,
        });
        latestPromptContextSnapshot = nextSnapshot;
        onPromptContextSnapshot?.(nextSnapshot);
      };

      heartbeatTimerRef.current = setInterval(() => {
        if (abortController.signal.aborted) return;
        const now = Date.now();
        const idleMs = now - lastProgressAt;
        if (idleMs < AGENT_EXECUTION_HEARTBEAT_INTERVAL_MS) return;
        const runningSec = Math.floor((now - runStartedAt) / 1000);
        const idleSec = Math.floor(idleMs / 1000);
        const latestStep = collectedSteps[collectedSteps.length - 1];
        const waitingStage: ExecutionWaitingStage = (() => {
          if (!latestStep || collectedSteps.length <= 1) return "model_first_token";
          if (latestStep.type === "answer" && latestStep.streaming) {
            return "model_generating";
          }
          if (
            latestStep.type === "observation" &&
            latestStep.content.includes("等待用户确认执行")
          ) {
            return "user_confirm";
          }
          if (latestStep.type === "action" && latestStep.toolName) {
            return "tool_waiting";
          }
          return "model_first_token";
        })();
        setWaitingStageIfChanged(waitingStage);
        const modelLikelyStalled =
          idleMs >= modelStallTimeoutMs &&
          (waitingStage === "model_first_token" ||
            waitingStage === "model_generating");
        if (modelLikelyStalled) {
          modelStallAborted = true;
          applyStep(
            {
              type: "observation",
              content: `检测到模型长时间无进展（>${Math.floor(
                modelStallTimeoutMs / 1000,
              )}s），将自动中断本次执行。`,
              timestamp: now,
            },
            false,
          );
          abortController.abort("MODEL_STALL_TIMEOUT");
          return;
        }
        if (waitingStage === lastHeartbeatStage) {
          return;
        }
        lastHeartbeatStage = waitingStage;
        applyStep(
          {
            type: "observation",
            content: `当前正在等待：${getExecutionWaitingStageLabel(waitingStage)}（已运行 ${runningSec}s，最近 ${idleSec}s 无新进展）`,
            timestamp: now,
          },
          false,
        );
      }, AGENT_EXECUTION_HEARTBEAT_INTERVAL_MS);

      timeoutTimerRef.current = setTimeout(() => {
        if (abortControllerRef.current !== abortController) return;
        timeoutAborted = true;
        abortController.abort();
      }, timeoutMs);

      const retryMax = aiConfig.agent_retry_max ?? 3;
      const retryBackoffMs = aiConfig.agent_retry_backoff_ms ?? 5000;
      let usedRetryCount = 0;

      try {
        let effectiveQuery = opts?.systemHint ? `${opts.systemHint}\n\n---\n\n${query}` : query;
        if (opts?.images?.length) {
          effectiveQuery += supportsImageInput
            ? `\n\n[系统提示] 用户已附带 ${opts.images.length} 张图片，这些图片已自动包含在本次对话中，你可以直接看到并分析它们。请勿使用截图工具或其他方式重新获取图片，也不要对图片路径调用 read_file / read_file_range；直接基于已有图片进行分析即可。`
            : `\n\n[系统提示] 用户附带了 ${opts.images.length} 张图片，但当前模型不支持直接识别图片内容。不要假装自己看到了图片，也不要把图片路径当作文本文件去读取。若任务依赖图片细节，请明确提示用户切换到支持视觉输入的模型，或先提供 OCR / 文字描述后再继续。`;
        }
        let lastError: Error | null = null;
        let contextRecovered = false;

        for (let attempt = 0; attempt <= retryMax; attempt++) {
          if (abortController.signal.aborted) throw new Error("Aborted");
          modelStallAborted = false;

          if (attempt > 0) {
            const delay = retryBackoffMs * Math.pow(2, attempt - 1);
            const nextRunAt = Date.now() + delay;
            usedRetryCount = attempt;
            updateTask(sessionId, taskId, {
              retry_count: attempt,
              last_error: lastError ? String(lastError) : undefined,
              next_run_at: nextRunAt,
              status: "running",
            });
            applyStep({
              type: "observation",
              content: `API 错误，${Math.ceil(delay / 1000)} 秒后自动重试（第 ${attempt}/${retryMax} 次）...`,
              timestamp: Date.now(),
            }, false);
            await new Promise((r) => setTimeout(r, delay));
            if (abortController.signal.aborted) throw new Error("Aborted");
            updateTask(sessionId, taskId, {
              next_run_at: undefined,
              status: "running",
            });
            resetPerRunState?.();
          }

          try {
            const result = await agent.run(effectiveQuery, abortController.signal, opts?.images);
            const finishedAt = Date.now();
            updateTask(sessionId, taskId, {
              answer: result,
              status: "success",
              retry_count: 0,
              next_run_at: undefined,
              last_error: undefined,
              last_finished_at: finishedAt,
              last_duration_ms: finishedAt - runStartedAt,
              last_result_status: "success",
            });
            const latestSession = useAgentStore.getState().sessions.find(
              (item) => item.id === sessionId,
            ) ?? session;
            const ingestResult = await persistAgentTurnContextIngest({
              sessionId,
              taskId,
              query,
              steps: collectedSteps,
              status: "success",
              durationMs: finishedAt - runStartedAt,
              answer: result,
              workspaceRoot: effectiveWorkspaceRoot,
              workspaceReset: shouldResetInheritedContext,
              scope: executionContextPlan.scope,
              continuity: continuityDecision,
              promptContextSnapshot: latestPromptContextSnapshot,
              session: latestSession,
              memoryAutoExtractionScheduled: shouldAutoSaveAssistantMemory(aiConfig),
            });
            updateSession(sessionId, {
              lastSessionNotePreview: ingestResult.sessionNotePreview,
              lastContextRuntimeReport: ingestResult.debugReport,
            });
            refreshPromptContextSnapshot();
            if (shouldAutoSaveAssistantMemory(aiConfig)) {
              void autoExtractMemories(`${query}\n${result}`, taskId, {
                sourceMode: "agent",
                workspaceId: effectiveWorkspaceRoot,
                skipSessionNote: true,
              }).catch(() => undefined);
            }
            lastError = null;
            break;
          } catch (e) {
            const aborted = (e as Error).message === "Aborted";
            if (aborted) {
              if (timeoutAborted) throw e;
              if (modelStallAborted) {
                throw new Error("MODEL_STALL_TIMEOUT");
              } else {
                throw e;
              }
            } else {
              lastError = e as Error;
            }
            if (
              !contextRecovered
              && isAgentContextPressureError(lastError)
              && sessionId
            ) {
              const latestSession = useAgentStore.getState().sessions.find(
                (item) => item.id === sessionId,
              );
              if (latestSession) {
                const recoveredBaseCompaction = buildAgentSessionCompactionState(
                  latestSession,
                  { reason: "context_recovery", aggressive: true },
                );
                const recoveredCompaction = await enrichAgentSessionCompactionState(
                  latestSession,
                  recoveredBaseCompaction,
                ).catch(() => recoveredBaseCompaction);
                if (
                  recoveredCompaction
                  && recoveredCompaction.compactedTaskCount
                    > getAgentSessionCompactedTaskCount(latestSession)
                ) {
                  contextRecovered = true;
                  updateSession(sessionId, { compaction: recoveredCompaction });
                  session = useAgentStore.getState().sessions.find(
                    (item) => item.id === sessionId,
                  ) ?? latestSession;
                  void persistAgentSessionCompactionArtifacts({
                    session: latestSession,
                    compaction: recoveredCompaction,
                  }).catch(() => undefined);
                  agent = await createAgent(session);
                  applyStep(
                    {
                      type: "observation",
                      content:
                        "检测到上下文压力过大，已自动整理早期历史摘要，并准备重试一次。",
                      timestamp: Date.now(),
                    },
                    false,
                  );
                  resetPerRunState?.();
                  continue;
                }
              }
            }
            const isRetryable = isRetryableError(lastError);
            if (!isRetryable || attempt >= retryMax) {
              throw lastError;
            }
          }
        }

        if (lastError) throw lastError;
      } catch (e) {
        const aborted = (e as Error).message === "Aborted";
        const modelStall = String(e).includes("MODEL_STALL_TIMEOUT");
        const msg = aborted
          ? timeoutAborted
            ? `Agent 执行超时（${Math.floor(timeoutMs / 1000)} 秒）已自动停止，请拆分任务后重试。`
            : "任务已通过用户请求停止。"
          : modelStall
            ? "模型长时间无响应，已自动中断本次执行。请重试或切换模型后再试。"
            : `Agent 执行失败: ${e}`;
        const finishedAt = Date.now();
        const finalStatus =
          aborted && !timeoutAborted ? "cancelled" : "error";
        updateTask(sessionId, taskId, {
          answer: msg,
          status: finalStatus,
          retry_count: aborted && !timeoutAborted ? 0 : usedRetryCount,
          next_run_at: undefined,
          last_error: aborted && !timeoutAborted ? undefined : String(e),
          last_finished_at: finishedAt,
          last_duration_ms: finishedAt - runStartedAt,
          last_result_status: aborted && !timeoutAborted ? undefined : "error",
        });
        const latestSession = useAgentStore.getState().sessions.find(
          (item) => item.id === sessionId,
        ) ?? session;
        const ingestResult = await persistAgentTurnContextIngest({
          sessionId,
          taskId,
          query,
          steps: collectedSteps,
          status: finalStatus,
          durationMs: finishedAt - runStartedAt,
          answer: msg,
          error: aborted && !timeoutAborted ? undefined : String(e),
          workspaceRoot: effectiveWorkspaceRoot,
          workspaceReset: shouldResetInheritedContext,
          scope: executionContextPlan.scope,
          continuity: continuityDecision,
          promptContextSnapshot: latestPromptContextSnapshot,
          session: latestSession,
          memoryAutoExtractionScheduled: false,
        });
        updateSession(sessionId, {
          lastSessionNotePreview: ingestResult.sessionNotePreview,
          lastContextRuntimeReport: ingestResult.debugReport,
        });
        refreshPromptContextSnapshot();
      } finally {
        if (abortControllerRef.current === abortController) {
          clearTimers();
          setRunning(false);
          useAgentRunningStore.getState().stop();
          abortControllerRef.current = null;
          setWaitingStageIfChanged(null);
          setRunningPhase((prev) => (prev === "executing" ? null : prev));
        }
        inputRef.current?.focus();
      }
    },
    [
      ai,
      currentSessionId,
      createSession,
      addTask,
      clearTimers,
      forkSession,
      setRunning,
      setRunningPhase,
      setExecutionWaitingStage,
      updateTask,
      updateSession,
      inputRef,
      availableTools,
      openDangerConfirm,
      notifyToolCalled,
      onPromptContextSnapshot,
      scrollRef,
      resetPerRunState,
    ],
  );

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  return {
    executeAgentTask,
    stopExecution,
  };
}
