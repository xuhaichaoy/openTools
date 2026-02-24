import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import type { AgentTool } from "./core/react-agent";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { useAgentStore, type AgentTask } from "@/store/agent-store";
import type { RuntimeFallbackContext } from "@/core/agent/runtime";

import { AgentInputBar } from "./components/AgentInputBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { AskUserDialog } from "./components/AskUserDialog";
import type { AskUserQuestion, AskUserAnswers } from "./core/default-tools";
import { AgentWorkbenchPanel } from "./components/AgentWorkbenchPanel";
import { AgentHistoryDrawer } from "./components/AgentHistoryDrawer";
import { AgentTaskTimeline } from "./components/AgentTaskTimeline";
import { AgentHeaderBar } from "./components/AgentHeaderBar";
import { useAgentExecution } from "./hooks/use-agent-execution";
import { useAgentInputAssets } from "./hooks/use-agent-input-assets";
import { useAgentSessionActions } from "./hooks/use-agent-session-actions";
import { useAgentEffects } from "./hooks/use-agent-effects";
import { useAgentDerivedState } from "./hooks/use-agent-derived-state";
import { useAgentRunActions } from "./hooks/use-agent-run-actions";
import {
  type ExecutionWaitingStage,
  type RunningPhase,
  type ScheduledFilterMode,
  type ScheduledSortMode,
  type WorkbenchTab,
} from "./core/ui-state";

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
    const [showWorkbench, setShowWorkbench] = useState(false);
    const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("tools");
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
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const isComposingRef = useRef(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const {
      pendingImages,
      pendingImagePreviews,
      handlePaste,
      handleFileSelect,
      removeImage,
      clearAssets,
    } = useAgentInputAssets();

    const [confirmDialog, setConfirmDialog] = useState<{
      toolName: string;
      params: Record<string, unknown>;
      resolve: (confirmed: boolean) => void;
    } | null>(null);

    const [askUserDialog, setAskUserDialog] = useState<{
      questions: AskUserQuestion[];
      resolve: (answers: AskUserAnswers) => void;
    } | null>(null);

    const askUser = useCallback(
      (questions: AskUserQuestion[]) =>
        new Promise<AskUserAnswers>((resolve) => {
          setAskUserDialog({ questions, resolve });
        }),
      [],
    );

    const confirmHostFallback = useCallback(
      (context: RuntimeFallbackContext) =>
        new Promise<boolean>((resolve) => {
          const toolName =
            context.action === "run_shell_command"
              ? "run_shell_command_host_fallback"
              : "write_file_host_fallback";
          const warning =
            typeof context.reason === "string" && context.reason.trim()
              ? context.reason
              : "该操作需要你的确认。";

          setConfirmDialog({
            toolName,
            params: {
              ...context,
              warning,
            },
            resolve,
          });
        }),
      [],
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
      getCurrentSession,
      setCurrentSession,
      updateSession,
      addTask,
      updateTask,
      deleteSession,
      deleteAllSessions,
      renameSession,
    } = useAgentStore();

    const currentSession = getCurrentSession();
    const tasks = currentSession?.tasks ?? EMPTY_AGENT_TASKS;
    const {
      hasAnySteps,
      busy,
      visibleScheduledTasks,
      scheduledStats,
    } = useAgentDerivedState({
      tasks,
      running,
      scheduledTasks,
      scheduledStatusFilter,
      scheduledSortMode,
    });

    const resetSessionVisualState = useCallback(() => {
      setInput("");
      setExpandedSteps(new Set());
      setCollapsedTaskProcesses(new Set());
      clearAssets();
    }, [clearAssets]);

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
      inputRef,
      scrollRef,
      openDangerConfirm: (toolName, params) =>
        new Promise<boolean>((resolve) => {
          setConfirmDialog({ toolName, params, resolve });
        }),
      resetPerRunState,
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

    const { handleRun, handleStop } = useAgentRunActions({
      ai,
      input,
      pendingImages,
      setInput,
      clearAssets,
      executeAgentTask,
      stopExecution,
    });

    useEffect(() => {
      handleRunRef.current = handleRun;
    }, [handleRun]);

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
      <div className="flex h-full bg-[var(--color-bg)] text-[var(--color-text)] relative">
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

        <div className="flex flex-col flex-1 min-w-0">
          {!headless && (
            <AgentHeaderBar
              onBack={onBack}
              sessionsCount={sessions.length}
              availableToolsCount={availableTools.length}
              scheduledTasksCount={scheduledTasks.length}
              showToolsWorkbench={showWorkbench && workbenchTab === "tools"}
              showOrchestratorWorkbench={showWorkbench && workbenchTab === "orchestrator"}
              hasAnySteps={hasAnySteps}
              onShowHistory={() => setShowHistory(true)}
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

          <AgentTaskTimeline
            tasks={tasks}
            busy={busy}
            runningPhase={runningPhase}
            executionWaitingStage={executionWaitingStage}
            scrollRef={scrollRef}
            collapsedTaskProcesses={collapsedTaskProcesses}
            expandedSteps={expandedSteps}
            onToggleTaskProcess={toggleTaskProcess}
            onToggleStep={toggleStep}
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
            pendingImagePreviews={pendingImagePreviews}
            onFileSelect={handleFileSelect}
            onRemoveImage={removeImage}
            inputRef={inputRef}
            fileInputRef={fileInputRef}
          />
        </div>

        {confirmDialog && (
          <ConfirmDialog
            toolName={confirmDialog.toolName}
            params={confirmDialog.params}
            onConfirm={() => {
              confirmDialog.resolve(true);
              setConfirmDialog(null);
            }}
            onCancel={() => {
              confirmDialog.resolve(false);
              setConfirmDialog(null);
            }}
          />
        )}
        {askUserDialog && (
          <AskUserDialog
            questions={askUserDialog.questions}
            onSubmit={(answers) => {
              askUserDialog.resolve(answers);
              setAskUserDialog(null);
            }}
          />
        )}
      </div>
    );
  },
);

export default SmartAgentPlugin;
