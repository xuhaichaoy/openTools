import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { ReActAgent, type AgentStep, type AgentTool } from "../core/react-agent";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { useAgentStore } from "@/store/agent-store";
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
import { useAgentRunningStore } from "@/store/agent-running-store";
import { recordAIRouteEvent } from "@/store/ai-route-store";
import { applyIncomingAgentStep } from "../core/agent-task-state";
import {
  buildAssistantSupplementalPrompt,
  shouldAutoSaveAssistantMemory,
  shouldRecallAssistantMemory,
} from "@/core/ai/assistant-config";
import { autoExtractMemories } from "@/core/agent/actor/actor-memory";
import { buildKnowledgeContextMessages } from "@/core/agent/actor/middlewares/knowledge-base-middleware";
import { isRetryableError } from "@/core/agent/actor/middlewares/model-retry-middleware";

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
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  openDangerConfirm: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
  resetPerRunState: (() => void) | null;
  notifyToolCalled?: ((toolName: string) => void) | null;
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
      runProfile?: CodingExecutionProfile;
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
  inputRef,
  scrollRef,
  openDangerConfirm,
  resetPerRunState,
  notifyToolCalled,
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
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
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
        runProfile?: CodingExecutionProfile;
        sourceHandoff?: import("@/store/agent-store").AgentSession["sourceHandoff"];
      },
    ) => {
      if (!ai || !query.trim()) return;

      resetPerRunState?.();

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        clearTimers();
      }

      let sessionId = opts?.sessionId || currentSessionId;
      let taskId = opts?.taskId || "";
      const historySteps: AgentStep[] = [];
      const snapshot = useAgentStore.getState();

      if (!sessionId || !snapshot.sessions.some((s) => s.id === sessionId)) {
        sessionId = createSession(query, opts?.sourceHandoff);
        const newSession = useAgentStore
          .getState()
          .sessions.find((s) => s.id === sessionId);
        taskId = taskId || newSession?.tasks[0]?.id || "";
      } else if (!taskId) {
        const session = snapshot.sessions.find((s) => s.id === sessionId);
        if (session) {
          for (const task of session.tasks) {
            const steps = task.steps || [];
            const keySteps = steps.filter(
              (s) => s.type === "action" || s.type === "observation" || s.type === "answer",
            );
            for (const step of keySteps.slice(-6)) {
              historySteps.push({
                ...step,
                timestamp: step.timestamp || session.createdAt,
              });
            }
            if (task.answer) {
              const alreadyHasAnswer = keySteps.some(
                (s) => s.type === "answer" && s.content === task.answer,
              );
              if (!alreadyHasAnswer) {
                historySteps.push({
                  type: "answer",
                  content: task.answer,
                  timestamp: session.createdAt,
                });
              }
            }
          }
        }
        taskId = addTask(sessionId, query, opts?.images);
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
      };

      setRunning(true);
      setRunningPhase("executing");
      setWaitingStageIfChanged("model_first_token");
      const runStartedAt = Date.now();
      useAgentRunningStore.getState().start(
        { sessionId, query, startedAt: runStartedAt },
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
      const skillContext = await loadAndResolveSkills(query);
      const skillsPrompt = skillContext.mergedSystemPrompt || undefined;
      const hasCodingWorkflowSkill = skillContext.visibleSkillIds.includes("builtin-coding-workflow");
      const toolsForRun = applySkillToolFilter(
        availableTools,
        skillContext.mergedToolFilter,
      );
      const runProfile = normalizeCodingExecutionProfile(opts?.runProfile);
      let userMemoryPrompt: string | undefined;
      if (shouldRecallAssistantMemory(aiConfig)) {
        let memorySnap = useAgentMemoryStore.getState();
        if (!memorySnap.loaded) {
          await memorySnap.load();
          memorySnap = useAgentMemoryStore.getState();
        }
        userMemoryPrompt = await memorySnap.getMemoriesForQueryPromptAsync(query, {
          topK: 6,
          preferSemantic: true,
        }) || undefined;
      }

      const contextLimit = runProfile.largeProjectMode ? 160_000 : undefined;
      const knowledgeContextMessages = await buildKnowledgeContextMessages(query, {
        contextTokens: contextLimit,
      });
      const extraSystemPrompt = buildAssistantSupplementalPrompt(
        aiConfig.system_prompt,
      );
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

      const agent = new ReActAgent(
        ai,
        toolsForRun,
        {
          maxIterations,
          temperature: aiConfig.temperature ?? 0.7,
          verbose: true,
          fcCompatibilityKey,
          userMemoryPrompt,
          skillsPrompt,
          extraSystemPrompt,
          skipInternalCodingBlock: hasCodingWorkflowSkill,
          codingHint: opts?.codingHint,
          ...(contextLimit ? { contextLimit } : {}),
          contextMessages: knowledgeContextMessages,
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
        historySteps,
      );

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

      try {
        let effectiveQuery = opts?.systemHint ? `${opts.systemHint}\n\n---\n\n${query}` : query;
        if (opts?.images?.length) {
          effectiveQuery += `\n\n[系统提示] 用户已附带 ${opts.images.length} 张图片，这些图片已自动包含在本次对话中，你可以直接看到并分析它们。请勿使用截图工具或其他方式重新获取图片，也不要对图片路径调用 read_file / read_file_range；直接基于已有图片进行分析即可。`;
        }
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= retryMax; attempt++) {
          if (abortController.signal.aborted) throw new Error("Aborted");
          modelStallAborted = false;

          if (attempt > 0) {
            const delay = retryBackoffMs * Math.pow(2, attempt - 1);
            applyStep({
              type: "observation",
              content: `API 错误，${Math.ceil(delay / 1000)} 秒后自动重试（第 ${attempt}/${retryMax} 次）...`,
              timestamp: Date.now(),
            }, false);
            await new Promise((r) => setTimeout(r, delay));
            if (abortController.signal.aborted) throw new Error("Aborted");
            resetPerRunState?.();
          }

          try {
            const result = await agent.run(effectiveQuery, abortController.signal, opts?.images);
            const finishedAt = Date.now();
            updateTask(sessionId, taskId, {
              answer: result,
              status: "success",
              last_error: undefined,
              last_finished_at: finishedAt,
              last_duration_ms: finishedAt - runStartedAt,
              last_result_status: "success",
            });
            if (shouldAutoSaveAssistantMemory(aiConfig)) {
              void autoExtractMemories(`${query}\n${result}`, taskId, {
                sourceMode: "agent",
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
        updateTask(sessionId, taskId, {
          answer: msg,
          status: aborted && !timeoutAborted ? "cancelled" : "error",
          last_error: aborted && !timeoutAborted ? undefined : String(e),
          last_finished_at: finishedAt,
          last_duration_ms: finishedAt - runStartedAt,
          last_result_status: aborted && !timeoutAborted ? undefined : "error",
        });
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
      setRunning,
      setRunningPhase,
      setExecutionWaitingStage,
      updateTask,
      inputRef,
      availableTools,
      openDangerConfirm,
      notifyToolCalled,
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
