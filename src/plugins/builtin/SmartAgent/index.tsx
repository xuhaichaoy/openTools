import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from "react";
import type { AgentTool } from "./core/react-agent";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import {
  getHiddenAgentTasks,
  getVisibleAgentTasks,
  useAgentStore,
  type AgentTask,
} from "@/store/agent-store";
import { useAppStore } from "@/store/app-store";
import { AICenterHandoffCard } from "@/components/ai/AICenterHandoffCard";
import type { RuntimeFallbackContext } from "@/core/agent/runtime";
import { describeCodingExecutionProfile } from "@/core/agent/coding-profile";
import { getAICenterHandoffImportPaths } from "@/core/ai/ai-center-handoff";

import { AgentInputBar } from "./components/AgentInputBar";
import { useToolTrustStore } from "@/store/command-allowlist-store";
import { useAskUserStore } from "@/store/ask-user-store";
import { useConfirmDialogStore } from "@/store/confirm-dialog-store";
import type { AskUserQuestion } from "./core/default-tools";
import { AgentWorkbenchPanel } from "./components/AgentWorkbenchPanel";
import { AgentHistoryDrawer } from "./components/AgentHistoryDrawer";
import { AgentTaskTimeline } from "./components/AgentTaskTimeline";
import { AgentHeaderBar } from "./components/AgentHeaderBar";
import { AgentFollowUpDock } from "./components/AgentFollowUpDock";
import { AgentPromptContextCard } from "./components/AgentPromptContextCard";
import { AgentSessionContextStrip } from "./components/AgentSessionContextStrip";
import { useAgentExecution } from "./hooks/use-agent-execution";
import { useInputAttachments } from "@/hooks/use-input-attachments";
import { useAgentSessionActions } from "./hooks/use-agent-session-actions";
import { useAgentEffects } from "./hooks/use-agent-effects";
import { useAgentDerivedState } from "./hooks/use-agent-derived-state";
import { useAgentRunActions } from "./hooks/use-agent-run-actions";
import { useShallow } from "zustand/shallow";
import { buildRecoveredAgentTaskPatch } from "./core/agent-task-state";
import {
  buildAgentSessionContextOutline,
  buildAgentSessionReview,
  deriveAgentSessionFiles,
} from "./core/session-insights";
import {
  buildAgentPromptContextSnapshot,
  type AgentPromptContextSnapshot,
} from "./core/prompt-context";
import {
  type ExecutionWaitingStage,
  type RunningPhase,
  type ScheduledFilterMode,
  type ScheduledSortMode,
  type WorkbenchTab,
} from "./core/ui-state";
import { useAgentRunningStore } from "@/store/agent-running-store";

export interface SmartAgentHandle {
  clear: () => void;
  getToolCount: () => number;
  toggleTools: () => void;
  toggleOrchestrator: () => void;
  toggleHistory: () => void;
  newSession: () => void;
  getSessionCount: () => number;
}

interface SmartAgentProps {
  onBack?: () => void;
  ai?: MToolsAI;
  headless?: boolean;
}

const EMPTY_AGENT_TASKS: AgentTask[] = [];
const EMPTY_FOLLOW_UP_QUEUE: NonNullable<
  import("@/store/agent-store").AgentSession["followUpQueue"]
> = [];
const AGENT_SETTINGS_KEY = "mtools-agent-settings";

interface AgentRuntimeSettings {
  codingMode: boolean;
  largeProjectMode: boolean;
  openClawMode: boolean;
}

function loadAgentSettings(): AgentRuntimeSettings {
  try {
    const raw = localStorage.getItem(AGENT_SETTINGS_KEY);
    if (!raw) return { codingMode: false, largeProjectMode: false, openClawMode: false };
    const parsed = JSON.parse(raw) as Partial<AgentRuntimeSettings>;
    const requestedOpenClawMode = !!parsed.openClawMode;
    const codingMode = requestedOpenClawMode || !!parsed.codingMode;
    return {
      codingMode,
      largeProjectMode: codingMode && (requestedOpenClawMode || !!parsed.largeProjectMode),
      openClawMode: requestedOpenClawMode && codingMode,
    };
  } catch {
    return { codingMode: false, largeProjectMode: false, openClawMode: false };
  }
}

function saveAgentSettings(settings: AgentRuntimeSettings): void {
  try {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore write errors
  }
}

const SmartAgentPlugin = forwardRef<SmartAgentHandle, SmartAgentProps>(
  function SmartAgentPlugin({ onBack, ai, headless }, ref) {
    const [input, setInput] = useState("");
    const [running, setRunning] = useState(false);
    const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
    const [collapsedTaskProcesses, setCollapsedTaskProcesses] = useState<Set<string>>(
      new Set(),
    );
    const [availableTools, setAvailableTools] = useState<AgentTool[]>([]);
    const [resetPerRunState, setResetPerRunState] = useState<(() => void) | null>(null);
    const [notifyToolCalled, setNotifyToolCalled] = useState<((toolName: string) => void) | null>(null);
    const [showWorkbench, setShowWorkbench] = useState(false);
    const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("review");
    const [showHistory, setShowHistory] = useState(false);
    const [runningPhase, setRunningPhase] = useState<RunningPhase | null>(null);
    const [executionWaitingStage, setExecutionWaitingStage] =
      useState<ExecutionWaitingStage | null>(null);
    const [scheduledQuery, setScheduledQuery] = useState("");
    const [scheduledType, setScheduledType] = useState<
      "once" | "interval" | "cron"
    >("once");
    const [scheduledValue, setScheduledValue] = useState("");
    const [scheduledStatusFilter, setScheduledStatusFilter] =
      useState<ScheduledFilterMode>("all");
    const [scheduledSortMode, setScheduledSortMode] =
      useState<ScheduledSortMode>("next_run_asc");
    const [latestPromptContextSnapshot, setLatestPromptContextSnapshot] =
      useState<AgentPromptContextSnapshot | null>(null);
    const [codingMode, setCodingMode] = useState(
      () => loadAgentSettings().codingMode,
    );
    const [largeProjectMode, setLargeProjectMode] = useState(
      () => loadAgentSettings().largeProjectMode,
    );
    const [openClawMode, setOpenClawMode] = useState(
      () => loadAgentSettings().openClawMode,
    );
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const isComposingRef = useRef(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const {
      attachments,
      imagePaths,
      imagePreviews,
      fileContextBlock,
      attachmentSummary,
      handlePaste,
      handleFileSelect,
      handleFileSelectNative,
      handleFolderSelect,
      handleDrop,
      handleDragOver,
      removeAttachment,
      clearAttachments,
      addAttachmentFromPath,
    } = useInputAttachments();
    const openConfirmDialog = useConfirmDialogStore((s) => s.open);

    const confirmHostFallback = useCallback(
      (context: RuntimeFallbackContext) =>
        openConfirmDialog({
          source: "agent",
          toolName:
            context.action === "run_shell_command"
              ? "run_shell_command_host_fallback"
              : "write_file_host_fallback",
          params: {
            ...context,
            warning:
              typeof context.reason === "string" && context.reason.trim()
                ? context.reason
                : "该操作需要你的确认。",
          },
        }),
      [openConfirmDialog],
    );

    const {
      sessions,
      scheduledTasks,
      currentSessionId,
      historyLoaded,
      loadHistory,
      loadScheduledTasks,
      createScheduledTask,
      pauseScheduledTask,
      resumeScheduledTask,
      cancelScheduledTask,
      createSession,
      setCurrentSession,
      updateSession,
      addTask,
      updateTask,
      revertCurrentSessionToPreviousTask,
      redoCurrentSession,
      restoreCurrentSession,
      forkSession,
      enqueueFollowUp,
      dequeueFollowUp,
      removeFollowUp,
      clearFollowUpQueue,
      deleteSession,
      deleteAllSessions,
      renameSession,
    } = useAgentStore(
      useShallow((s) => ({
        sessions: s.sessions,
        scheduledTasks: s.scheduledTasks,
        currentSessionId: s.currentSessionId,
        historyLoaded: s.historyLoaded,
        loadHistory: s.loadHistory,
        loadScheduledTasks: s.loadScheduledTasks,
        createScheduledTask: s.createScheduledTask,
        pauseScheduledTask: s.pauseScheduledTask,
        resumeScheduledTask: s.resumeScheduledTask,
        cancelScheduledTask: s.cancelScheduledTask,
        createSession: s.createSession,
        setCurrentSession: s.setCurrentSession,
        updateSession: s.updateSession,
        addTask: s.addTask,
        updateTask: s.updateTask,
        revertCurrentSessionToPreviousTask: s.revertCurrentSessionToPreviousTask,
        redoCurrentSession: s.redoCurrentSession,
        restoreCurrentSession: s.restoreCurrentSession,
        forkSession: s.forkSession,
        enqueueFollowUp: s.enqueueFollowUp,
        dequeueFollowUp: s.dequeueFollowUp,
        removeFollowUp: s.removeFollowUp,
        clearFollowUpQueue: s.clearFollowUpQueue,
        deleteSession: s.deleteSession,
        deleteAllSessions: s.deleteAllSessions,
        renameSession: s.renameSession,
      })),
    );

    const askUserDialog = useAskUserStore((s) => s.dialog);
    const askUserOpen = useAskUserStore((s) => s.open);
    const activeAgentRun = useAgentRunningStore((s) => s.info);

    const currentSession = useMemo(
      () => sessions.find((session) => session.id === currentSessionId) ?? null,
      [currentSessionId, sessions],
    );
    // 避免本地 UI 状态变化时每次都重新 slice，导致自动折叠/恢复 effect 被误触发。
    const tasks = useMemo(
      () => (currentSession ? getVisibleAgentTasks(currentSession) : EMPTY_AGENT_TASKS),
      [currentSession],
    );
    const hiddenTasks = useMemo(
      () => (currentSession ? getHiddenAgentTasks(currentSession) : EMPTY_AGENT_TASKS),
      [currentSession],
    );
    const followUpQueue = currentSession?.followUpQueue ?? EMPTY_FOLLOW_UP_QUEUE;
    const sessionReview = buildAgentSessionReview(currentSession);
    const sessionFiles = deriveAgentSessionFiles(currentSession);
    const sessionContextLines = buildAgentSessionContextOutline(currentSession);
    const sessionRunningInBackground = activeAgentRun?.sessionId === currentSessionId;
    const hasAnyAgentRun = Boolean(activeAgentRun);
    const effectiveRunning = running || sessionRunningInBackground;
    const effectiveRunningPhase = runningPhase ?? (effectiveRunning ? "executing" : null);
    const effectiveWaitingStage =
      executionWaitingStage
      ?? (sessionRunningInBackground
        ? askUserDialog?.source === "agent"
          ? "user_confirm"
          : "model_first_token"
        : null);
    const {
      hasAnySteps,
      busy,
      visibleScheduledTasks,
      scheduledStats,
    } = useAgentDerivedState({
      tasks,
      running: running || hasAnyAgentRun,
      scheduledTasks,
      scheduledStatusFilter,
      scheduledSortMode,
    });

    const askUser = useCallback(
      (questions: AskUserQuestion[]) => {
        const currentQuery = tasks.at(-1)?.query;
        return askUserOpen({
          questions,
          source: "agent",
          taskDescription: currentQuery,
        });
      },
      [askUserOpen, tasks],
    );

    const syncedBackgroundSessionRef = useRef<string | null>(null);

    useEffect(() => {
      if (!activeAgentRun?.sessionId) {
        syncedBackgroundSessionRef.current = null;
        return;
      }
      if (syncedBackgroundSessionRef.current === activeAgentRun.sessionId) {
        return;
      }
      const targetSessionId = activeAgentRun.sessionId;
      if (!sessions.some((session) => session.id === targetSessionId)) {
        return;
      }
      syncedBackgroundSessionRef.current = targetSessionId;
      if (currentSessionId !== targetSessionId) {
        setCurrentSession(targetSessionId);
      }
    }, [activeAgentRun?.sessionId, currentSessionId, sessions, setCurrentSession]);

    const resetSessionVisualState = useCallback(() => {
      setInput("");
      setExpandedSteps(new Set());
      setCollapsedTaskProcesses(new Set());
      clearAttachments();
    }, [clearAttachments]);

    useAgentEffects({
      ai,
      historyLoaded,
      loadHistory,
      loadScheduledTasks,
      tasks,
      setCollapsedTaskProcesses,
      confirmHostFallback,
      askUser,
      setAvailableTools,
      setResetPerRunState,
      setNotifyToolCalled,
    });

    const handleRunRef = useRef<(() => void | Promise<void>) | null>(null);
    const { executeAgentTask, stopExecution } = useAgentExecution({
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
      openDangerConfirm: (toolName, params) => {
        if (!useToolTrustStore.getState().shouldConfirm(toolName)) {
          return Promise.resolve(true);
        }
        return openConfirmDialog({
          source: "agent",
          toolName,
          params,
        });
      },
      resetPerRunState,
      notifyToolCalled,
      onPromptContextSnapshot: setLatestPromptContextSnapshot,
    });

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !isComposingRef.current &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        handleRunRef.current?.();
      }
    }, []);

    const [pendingSourceHandoff, setPendingSourceHandoff] = useState<
      import("@/store/agent-store").AgentSession["sourceHandoff"] | null
    >(null);

    const pendingHandoff = useAppStore((s) => s.pendingAICenterHandoff);
    useEffect(() => {
      if (!pendingHandoff || pendingHandoff.mode !== "agent") return;
      let cancelled = false;

      const applyHandoff = async () => {
        const payload = pendingHandoff.payload;
        setInput(payload.query);
        clearAttachments();
        setPendingSourceHandoff(null);

        for (const path of getAICenterHandoffImportPaths(payload)) {
            if (cancelled) return;
            await addAttachmentFromPath(path);
        }

        if (!cancelled && payload.sourceMode) {
          setPendingSourceHandoff(payload);
        }
      };

      void applyHandoff().finally(() => {
        if (!cancelled) {
          useAppStore.getState().setPendingAICenterHandoff(null);
        }
      });

      return () => {
        cancelled = true;
      };
    }, [pendingHandoff, addAttachmentFromPath, clearAttachments]);

    const { handleRun, handleStop, effectiveRunProfile } = useAgentRunActions({
      ai,
      busy,
      currentSessionId,
      currentSession,
      input,
      imagePaths,
      attachmentPaths: attachments
        .map((attachment) => attachment.path)
        .filter((path): path is string => typeof path === "string" && path.trim().length > 0),
      fileContextBlock,
      attachmentSummary,
      codingMode: codingMode || openClawMode,
      largeProjectMode: largeProjectMode || openClawMode,
      openClawMode,
      pendingSourceHandoff,
      setInput,
      clearAssets: clearAttachments,
      enqueueFollowUp,
      executeAgentTask,
      stopExecution,
    });
    const autoExecutionModeLabel = effectiveRunProfile.autoDetected
      ? describeCodingExecutionProfile(effectiveRunProfile.profile)
      : null;
    const effectivePromptContextSnapshot = useMemo(() => {
      if (
        latestPromptContextSnapshot
        && latestPromptContextSnapshot.sessionId
        && latestPromptContextSnapshot.sessionId === currentSessionId
      ) {
        return latestPromptContextSnapshot;
      }

      const hasDraftContext = Boolean(
        currentSession
        || input.trim()
        || attachmentSummary.trim()
        || fileContextBlock.trim()
        || pendingSourceHandoff,
      );
      if (!hasDraftContext) {
        return null;
      }

      return buildAgentPromptContextSnapshot({
        session: currentSession,
        query: input,
        runProfile: effectiveRunProfile.profile.codingMode
          ? effectiveRunProfile.profile
          : undefined,
        attachmentSummary: attachmentSummary || undefined,
        systemHint: fileContextBlock || undefined,
        sourceHandoff: pendingSourceHandoff ?? currentSession?.sourceHandoff,
        files: sessionFiles,
        contextLines: sessionContextLines,
        workspaceRoot: currentSession?.workspaceRoot,
        workspaceReset: Boolean(currentSession?.lastContextResetAt),
        continuityStrategy: currentSession?.lastContinuityStrategy,
        continuityReason: currentSession?.lastContinuityReason,
        memoryItemCount: currentSession?.lastMemoryItemCount,
        historyContextMessageCount: currentSession?.compaction?.summary ? 2 : 0,
        knowledgeContextMessageCount: 0,
      });
    }, [
      latestPromptContextSnapshot,
      currentSessionId,
      currentSession,
      input,
      attachmentSummary,
      fileContextBlock,
      pendingSourceHandoff,
      effectiveRunProfile.profile,
      sessionFiles,
      sessionContextLines,
    ]);

    useEffect(() => {
      saveAgentSettings({ codingMode, largeProjectMode, openClawMode });
    }, [codingMode, largeProjectMode, openClawMode]);

    useEffect(() => {
      handleRunRef.current = handleRun;
    }, [handleRun]);

    useEffect(() => {
      if (effectiveRunning && pendingSourceHandoff) {
        setPendingSourceHandoff(null);
      }
    }, [effectiveRunning, pendingSourceHandoff]);

    useEffect(() => {
      if (effectiveRunning || !currentSessionId || tasks.length === 0) return;
      const finishedAt = Date.now();
      for (const task of tasks) {
        const patch = buildRecoveredAgentTaskPatch(task, finishedAt);
        if (!patch) continue;
        updateTask(currentSessionId, task.id, patch);
      }
    }, [currentSessionId, effectiveRunning, tasks, updateTask]);

    const queuedRunIdRef = useRef<string | null>(null);
    const runQueuedFollowUp = useCallback(async () => {
      if (busy || !currentSession) return;

      let targetSessionId = currentSession.id;
      let next: ReturnType<typeof dequeueFollowUp> = null;

      if (hiddenTasks.length > 0 && followUpQueue.length > 0) {
        const forkedSessionId = forkSession(currentSession.id, {
          visibleOnly: true,
          title: `${currentSession.title || "新任务"} · 分支`,
        });
        if (forkedSessionId) {
          for (const item of followUpQueue) {
            enqueueFollowUp(forkedSessionId, {
              query: item.query,
              images: item.images,
              attachmentPaths: item.attachmentPaths,
              systemHint: item.systemHint,
              codingHint: item.codingHint,
              runProfile: item.runProfile,
              sourceHandoff: item.sourceHandoff,
              forceNewSession: item.forceNewSession,
            });
          }
          clearFollowUpQueue(currentSession.id);
          targetSessionId = forkedSessionId;
          next = dequeueFollowUp(forkedSessionId);
        }
      }

      if (!next) {
        next = dequeueFollowUp(targetSessionId);
      }
      if (!next) return;

      queuedRunIdRef.current = next.id;
      try {
        await executeAgentTask(next.query, {
          sessionId: targetSessionId,
          ...(next.forceNewSession ? { forceNewSession: true } : {}),
          images: next.images,
          attachmentPaths: next.attachmentPaths,
          systemHint: next.systemHint,
          codingHint: next.codingHint,
          runProfile: next.runProfile,
          sourceHandoff: next.sourceHandoff,
        });
      } finally {
        queuedRunIdRef.current = null;
      }
    }, [
      clearFollowUpQueue,
      currentSession,
      dequeueFollowUp,
      enqueueFollowUp,
      executeAgentTask,
      followUpQueue,
      forkSession,
      hiddenTasks.length,
      busy,
    ]);

    const lastTaskStatus = tasks[tasks.length - 1]?.status;
    useEffect(() => {
      if (
        busy
        || queuedRunIdRef.current
        || followUpQueue.length === 0
        || lastTaskStatus !== "success"
      ) {
        return;
      }
      void runQueuedFollowUp();
    }, [busy, followUpQueue.length, lastTaskStatus, runQueuedFollowUp]);

    const toggleStep = useCallback((key: string) => {
      setExpandedSteps((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }, []);

    const toggleTaskProcess = useCallback((taskId: string) => {
      setCollapsedTaskProcesses((prev) => {
        const next = new Set(prev);
        if (next.has(taskId)) next.delete(taskId);
        else next.add(taskId);
        return next;
      });
    }, []);

    const {
      handleClear,
      handleNewSession,
      handleSelectHistorySession,
      handleDeleteHistorySession,
      handleDeleteAllHistory,
      handleCreateScheduledTask,
      toggleWorkbenchTab,
    } = useAgentSessionActions({
      busy,
      currentSessionId,
      workbenchTab,
      scheduledQuery,
      scheduledType,
      scheduledValue,
      createSession,
      setCurrentSession,
      updateSession,
      deleteSession,
      deleteAllSessions,
      createScheduledTask,
      setShowHistory,
      setScheduledQuery,
      setScheduledValue,
      setShowWorkbench,
      setWorkbenchTab,
      resetSessionVisualState,
      inputRef,
    });

    useImperativeHandle(ref, () => ({
      clear: handleClear,
      getToolCount: () => availableTools.length,
      toggleTools: () => toggleWorkbenchTab("tools"),
      toggleOrchestrator: () => toggleWorkbenchTab("orchestrator"),
      toggleHistory: () => setShowHistory((v) => !v),
      newSession: handleNewSession,
      getSessionCount: () => sessions.length,
    }), [handleClear, availableTools.length, handleNewSession, sessions.length, toggleWorkbenchTab]);

    return (
      <div className="flex h-full bg-[var(--color-bg)] text-[var(--color-text)] relative" onDrop={handleDrop} onDragOver={handleDragOver}>
        <AgentHistoryDrawer
          visible={showHistory}
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelect={handleSelectHistorySession}
          onDelete={handleDeleteHistorySession}
          onDeleteAll={handleDeleteAllHistory}
          onRename={renameSession}
          onNew={() => {
            handleNewSession();
            setShowHistory(false);
          }}
          onClose={() => setShowHistory(false)}
        />

        <div className="flex min-h-0 flex-1 min-w-0 flex-col">
          {!headless && (
            <AgentHeaderBar
              onBack={onBack}
              sessionsCount={sessions.length}
              availableToolsCount={availableTools.length}
              scheduledTasksCount={scheduledTasks.length}
              queuedFollowUpsCount={followUpQueue.length}
              currentSessionTitle={currentSession?.title}
              busy={busy}
              showReviewWorkbench={showWorkbench && workbenchTab === "review"}
              showToolsWorkbench={showWorkbench && workbenchTab === "tools"}
              showOrchestratorWorkbench={showWorkbench && workbenchTab === "orchestrator"}
              hasAnySteps={hasAnySteps}
              canRevert={tasks.length > 0}
              onShowHistory={() => setShowHistory(true)}
              onNewSession={handleNewSession}
              onRevert={revertCurrentSessionToPreviousTask}
              onToggleReviewWorkbench={() => toggleWorkbenchTab("review")}
              onToggleToolsWorkbench={() => toggleWorkbenchTab("tools")}
              onToggleOrchestratorWorkbench={() => toggleWorkbenchTab("orchestrator")}
              onClear={handleClear}
            />
          )}

          <AgentWorkbenchPanel
            visible={showWorkbench}
            workbenchTab={workbenchTab}
            onSelectTab={setWorkbenchTab}
            onClose={() => setShowWorkbench(false)}
            currentSessionTitle={currentSession?.title}
            sessionReview={sessionReview}
            sessionFiles={sessionFiles}
            sessionContextLines={sessionContextLines}
            promptContextSnapshot={effectivePromptContextSnapshot}
            sessionCompactionSummary={currentSession?.compaction?.summary}
            availableTools={availableTools}
            scheduledStats={scheduledStats}
            scheduledStatusFilter={scheduledStatusFilter}
            onChangeScheduledStatusFilter={setScheduledStatusFilter}
            scheduledSortMode={scheduledSortMode}
            onChangeScheduledSortMode={setScheduledSortMode}
            visibleScheduledTasks={visibleScheduledTasks}
            scheduledQuery={scheduledQuery}
            onChangeScheduledQuery={setScheduledQuery}
            scheduledType={scheduledType}
            onChangeScheduledType={setScheduledType}
            scheduledValue={scheduledValue}
            onChangeScheduledValue={setScheduledValue}
            onCreateScheduledTask={() => {
              void handleCreateScheduledTask();
            }}
            onRefreshScheduledTasks={() => {
              void loadScheduledTasks();
            }}
            onPauseTask={(taskId) => {
              void pauseScheduledTask(taskId);
            }}
            onResumeTask={(taskId) => {
              void resumeScheduledTask(taskId);
            }}
            onCancelTask={(taskId) => {
              void cancelScheduledTask(taskId);
            }}
          />

          {currentSession?.sourceHandoff && (
            <div className="mx-4 mt-2 mb-1">
              <AICenterHandoffCard handoff={currentSession.sourceHandoff} variant="active" />
            </div>
          )}

          {!currentSession?.sourceHandoff && pendingSourceHandoff && input.trim() && !running && (
            <div className="mx-4 mt-2 mb-1">
              <AICenterHandoffCard
                handoff={pendingSourceHandoff}
                dismissLabel="清除"
                onDismiss={() => setPendingSourceHandoff(null)}
              />
            </div>
          )}

          {currentSession && (
            <AgentSessionContextStrip
              session={currentSession}
              snapshot={effectivePromptContextSnapshot}
              hiddenTaskCount={hiddenTasks.length}
              onRedo={redoCurrentSession}
              onRestore={restoreCurrentSession}
              onFork={() => {
                forkSession(currentSession.id, { visibleOnly: true });
              }}
            />
          )}

          {effectivePromptContextSnapshot && (
            <AgentPromptContextCard snapshot={effectivePromptContextSnapshot} />
          )}

          <AgentTaskTimeline
            tasks={tasks}
            busy={effectiveRunning}
            runningPhase={effectiveRunningPhase}
            executionWaitingStage={effectiveWaitingStage}
            scrollRef={scrollRef}
            collapsedTaskProcesses={collapsedTaskProcesses}
            expandedSteps={expandedSteps}
            onToggleTaskProcess={toggleTaskProcess}
            onToggleStep={toggleStep}
          />

          <AgentFollowUpDock
            items={followUpQueue}
            running={busy}
            onRunNext={() => {
              void runQueuedFollowUp();
            }}
            onRemove={(followUpId) => {
              if (currentSessionId) {
                removeFollowUp(currentSessionId, followUpId);
              }
            }}
            onClear={() => {
              if (currentSessionId) {
                clearFollowUpQueue(currentSessionId);
              }
            }}
          />

          <AgentInputBar
            running={busy}
            ai={!!ai}
            hasExistingTasks={tasks.length > 0}
            onRun={handleRun}
            onStop={handleStop}
            input={input}
            onInputChange={setInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              setTimeout(() => {
                isComposingRef.current = false;
              }, 200);
            }}
            pendingImagePreviews={imagePreviews}
            onFileSelect={handleFileSelect}
            onRemoveImage={(i) => {
              const img = attachments.filter((a) => a.type === "image")[i];
              if (img) removeAttachment(img.id);
            }}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            onFolderSelect={handleFolderSelect}
            onFileSelectNative={handleFileSelectNative}
            onAddFilePath={addAttachmentFromPath}
            codingMode={codingMode}
            largeProjectMode={largeProjectMode}
            onToggleCodingMode={() => {
              setCodingMode((prev) => {
                const next = !prev;
                if (!next) {
                  setLargeProjectMode(false);
                  setOpenClawMode(false);
                }
                return next;
              });
            }}
            onToggleLargeProjectMode={() => {
              setCodingMode(true);
              setLargeProjectMode((prev) => {
                const next = !prev;
                if (!next) setOpenClawMode(false);
                return next;
              });
            }}
            openClawMode={openClawMode}
            onToggleOpenClawMode={() => {
              setOpenClawMode((prev) => {
                const next = !prev;
                if (next) {
                  setCodingMode(true);
                  setLargeProjectMode(true);
                }
                return next;
              });
            }}
            autoExecutionModeLabel={autoExecutionModeLabel}
            autoExecutionModeReasons={effectiveRunProfile.reasons}
            inputRef={inputRef}
            fileInputRef={fileInputRef}
          />
        </div>

      </div>
    );
  },
);

export default SmartAgentPlugin;
