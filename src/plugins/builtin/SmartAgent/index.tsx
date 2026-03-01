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
import { useAppStore } from "@/store/app-store";
import type { RuntimeFallbackContext } from "@/core/agent/runtime";

import { AgentInputBar } from "./components/AgentInputBar";
import { ConfirmDialog, type ConfirmResult } from "./components/ConfirmDialog";
import {
  useCommandAllowlistStore,
  extractCommandKey,
} from "@/store/command-allowlist-store";
import { useAskUserStore } from "@/store/ask-user-store";
import type { AskUserQuestion, AskUserAnswers } from "./core/default-tools";
import { AgentWorkbenchPanel } from "./components/AgentWorkbenchPanel";
import { AgentHistoryDrawer } from "./components/AgentHistoryDrawer";
import { AgentTaskTimeline } from "./components/AgentTaskTimeline";
import { AgentHeaderBar } from "./components/AgentHeaderBar";
import { useAgentExecution } from "./hooks/use-agent-execution";
import { useInputAttachments } from "@/hooks/use-input-attachments";
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
      attachments,
      imagePaths,
      imagePreviews,
      fileContextBlock,
      handlePaste,
      handleFileSelect,
      handleFolderSelect,
      removeAttachment,
      clearAttachments,
    } = useInputAttachments();

    const [confirmDialog, setConfirmDialog] = useState<{
      toolName: string;
      params: Record<string, unknown>;
      resolve: (confirmed: boolean) => void;
    } | null>(null);

    const handleConfirmResult = useCallback(
      (result: ConfirmResult) => {
        if (!confirmDialog) return;
        if (result.confirmed) {
          if (result.allowLevel) {
            const key = extractCommandKey(confirmDialog.toolName, confirmDialog.params);
            if (result.allowLevel === "session") {
              useCommandAllowlistStore.getState().allowSession(key);
            } else {
              useCommandAllowlistStore.getState().allowPersist(key);
            }
          }
          confirmDialog.resolve(true);
        } else {
          confirmDialog.resolve(false);
        }
        setConfirmDialog(null);
      },
      [confirmDialog],
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

    const askUserOpen = useAskUserStore((s) => s.open);

    const askUser = useCallback(
      (questions: AskUserQuestion[]) => {
        const currentQuery = getCurrentSession()?.tasks?.at(-1)?.query;
        return askUserOpen({
          questions,
          source: "agent",
          taskDescription: currentQuery,
        });
      },
      [askUserOpen, getCurrentSession],
    );

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
      openDangerConfirm: (toolName, params) => {
        const key = extractCommandKey(toolName, params);
        if (useCommandAllowlistStore.getState().isAllowed(key)) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          setConfirmDialog({ toolName, params, resolve });
        });
      },
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
      imagePaths,
      fileContextBlock,
      setInput,
      clearAssets: clearAttachments,
      executeAgentTask,
      stopExecution,
    });

    useEffect(() => {
      handleRunRef.current = handleRun;
    }, [handleRun]);

    useEffect(() => {
      const q = useAppStore.getState().consumePendingAgentInitialQuery();
      if (q) setInput(q);
    }, []);

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
            pendingImagePreviews={imagePreviews}
            onFileSelect={handleFileSelect}
            onRemoveImage={(i) => {
              const img = attachments.filter((a) => a.type === "image")[i];
              if (img) removeAttachment(img.id);
            }}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            onFolderSelect={handleFolderSelect}
            inputRef={inputRef}
            fileInputRef={fileInputRef}
          />
        </div>

        {confirmDialog && (
          <ConfirmDialog
            toolName={confirmDialog.toolName}
            params={confirmDialog.params}
            onResult={handleConfirmResult}
          />
        )}
      </div>
    );
  },
);

export default SmartAgentPlugin;
