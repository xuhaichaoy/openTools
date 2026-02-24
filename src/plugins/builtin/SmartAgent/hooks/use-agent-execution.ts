import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { ReActAgent, type AgentStep, type AgentTool } from "../core/react-agent";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { useAgentStore } from "@/store/agent-store";
import { useAIStore } from "@/store/ai-store";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import type { RunningPhase } from "../core/ui-state";

type AgentStoreState = ReturnType<typeof useAgentStore.getState>;

interface UseAgentExecutionParams {
  ai?: MToolsAI;
  running: boolean;
  setRunning: Dispatch<SetStateAction<boolean>>;
  setRunningPhase: Dispatch<SetStateAction<RunningPhase | null>>;
  availableTools: AgentTool[];
  currentSessionId: string | null;
  createSession: AgentStoreState["createSession"];
  addTask: AgentStoreState["addTask"];
  updateTask: AgentStoreState["updateTask"];
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  openDangerConfirm: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
}

interface UseAgentExecutionResult {
  executeAgentTask: (
    query: string,
    opts?: {
      sessionId?: string;
      taskId?: string;
    },
  ) => Promise<void>;
  stopExecution: () => void;
}

export function useAgentExecution({
  ai,
  running,
  setRunning,
  setRunningPhase,
  availableTools,
  currentSessionId,
  createSession,
  addTask,
  updateTask,
  inputRef,
  scrollRef,
  openDangerConfirm,
}: UseAgentExecutionParams): UseAgentExecutionResult {
  const abortControllerRef = useRef<AbortController | null>(null);

  const stopExecution = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setRunning(false);
      setRunningPhase(null);
    }
  }, [setRunning, setRunningPhase]);

  const executeAgentTask = useCallback(
    async (
      query: string,
      opts?: {
        sessionId?: string;
        taskId?: string;
      },
    ) => {
      if (!ai || !query.trim() || running) return;

      let sessionId = opts?.sessionId || currentSessionId;
      let taskId = opts?.taskId || "";
      const historySteps: AgentStep[] = [];
      const snapshot = useAgentStore.getState();

      if (!sessionId || !snapshot.sessions.some((s) => s.id === sessionId)) {
        sessionId = createSession(query);
        const newSession = useAgentStore
          .getState()
          .sessions.find((s) => s.id === sessionId);
        taskId = taskId || newSession?.tasks[0]?.id || "";
      } else if (!taskId) {
        const session = snapshot.sessions.find((s) => s.id === sessionId);
        if (session) {
          for (const task of session.tasks) {
            historySteps.push(...task.steps);
            if (task.answer) {
              historySteps.push({
                type: "answer",
                content: task.answer,
                timestamp: session.createdAt,
              });
            }
          }
        }
        taskId = addTask(sessionId, query);
      }

      if (!sessionId || !taskId) return;

      setRunning(true);
      setRunningPhase("executing");
      if (inputRef.current) inputRef.current.style.height = "auto";
      updateTask(sessionId, taskId, {
        status: "running",
        retry_count: 0,
        last_error: undefined,
        next_run_at: undefined,
      });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const existingTask = useAgentStore
        .getState()
        .sessions.find((s) => s.id === sessionId)
        ?.tasks.find((t) => t.id === taskId);
      const collectedSteps: AgentStep[] = existingTask?.steps ? [...existingTask.steps] : [];
      const fcCompatibilityKey = buildAgentFCCompatibilityKey(useAIStore.getState().config);

      const agent = new ReActAgent(
        ai,
        availableTools,
        {
          maxIterations: 8,
          verbose: true,
          fcCompatibilityKey,
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
          confirmDangerousAction: openDangerConfirm,
        },
        (step) => {
          const findLastIdx = (pred: (s: AgentStep) => boolean) => {
            for (let i = collectedSteps.length - 1; i >= 0; i--) {
              if (pred(collectedSteps[i])) return i;
            }
            return -1;
          };

          if (step.streaming) {
            const lastIdx = findLastIdx((s) => !!s.streaming && s.type === step.type);
            if (lastIdx >= 0) {
              collectedSteps[lastIdx] = step;
            } else {
              collectedSteps.push(step);
            }
          } else {
            const streamIdx = findLastIdx((s) => !!s.streaming && s.type === step.type);
            if (streamIdx >= 0) {
              collectedSteps.splice(streamIdx, 1);
            }
            collectedSteps.push(step);
          }

          updateTask(sessionId!, taskId, { steps: [...collectedSteps] });
          setTimeout(() => {
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: "smooth",
            });
          }, 100);
        },
        historySteps,
      );

      try {
        const result = await agent.run(query, abortController.signal);
        updateTask(sessionId, taskId, { answer: result, status: "success" });
      } catch (e) {
        const aborted = (e as Error).message === "Aborted";
        const msg = aborted ? "任务已通过用户请求停止。" : `Agent 执行失败: ${e}`;
        updateTask(sessionId, taskId, {
          answer: msg,
          status: aborted ? "cancelled" : "error",
          last_error: aborted ? undefined : String(e),
        });
      } finally {
        setRunning(false);
        abortControllerRef.current = null;
        setRunningPhase((prev) => (prev === "executing" ? null : prev));
        inputRef.current?.focus();
      }
    },
    [
      ai,
      running,
      currentSessionId,
      createSession,
      addTask,
      setRunning,
      setRunningPhase,
      updateTask,
      inputRef,
      availableTools,
      openDangerConfirm,
      scrollRef,
    ],
  );

  return {
    executeAgentTask,
    stopExecution,
  };
}
