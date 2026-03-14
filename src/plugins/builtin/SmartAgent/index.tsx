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
import { useToolTrustStore } from "@/store/command-allowlist-store";
import { useAskUserStore } from "@/store/ask-user-store";
import { useConfirmDialogStore } from "@/store/confirm-dialog-store";
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
import { useShallow } from "zustand/shallow";
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
      getCurrentSession,
      setCurrentSession,
      updateSession,
      addTask,
      updateTask,
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
        getCurrentSession: s.getCurrentSession,
        setCurrentSession: s.setCurrentSession,
        updateSession: s.updateSession,
        addTask: s.addTask,
        updateTask: s.updateTask,
        deleteSession: s.deleteSession,
        deleteAllSessions: s.deleteAllSessions,
        renameSession: s.renameSession,
      })),
    );

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

    const pendingHandoff = useAppStore((s) => s.pendingAgentHandoff);
    useEffect(() => {
      if (!pendingHandoff) return;
      let cancelled = false;

      const applyHandoff = async () => {
        setInput(pendingHandoff.query);
        clearAttachments();
        setPendingSourceHandoff(null);

        if (pendingHandoff.attachmentPaths?.length) {
          for (const path of pendingHandoff.attachmentPaths) {
            if (cancelled) return;
            await addAttachmentFromPath(path);
          }
        }

        if (!cancelled && pendingHandoff.sourceMode && pendingHandoff.sourceSessionId) {
          setPendingSourceHandoff({
            sourceMode: pendingHandoff.sourceMode,
            sourceSessionId: pendingHandoff.sourceSessionId,
          });
        }
      };

      void applyHandoff().finally(() => {
        if (!cancelled) {
          useAppStore.getState().setPendingAgentHandoff(null);
        }
      });

      return () => {
        cancelled = true;
      };
    }, [pendingHandoff, addAttachmentFromPath, clearAttachments]);

    const { handleRun, handleStop } = useAgentRunActions({
      ai,
      input,
      imagePaths,
      fileContextBlock,
      attachmentSummary,
      codingMode: codingMode || openClawMode,
      largeProjectMode: largeProjectMode || openClawMode,
      openClawMode,
      pendingSourceHandoff,
      setInput,
      clearAssets: clearAttachments,
      executeAgentTask,
      stopExecution,
    });

    useEffect(() => {
      saveAgentSettings({ codingMode, largeProjectMode, openClawMode });
    }, [codingMode, largeProjectMode, openClawMode]);

    useEffect(() => {
      handleRunRef.current = handleRun;
    }, [handleRun]);

    useEffect(() => {
      if (running && pendingSourceHandoff) {
        setPendingSourceHandoff(null);
      }
    }, [running, pendingSourceHandoff]);

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

          {currentSession?.sourceHandoff && (
            <div className="mx-4 mt-2 mb-1 flex items-center gap-1.5 text-xs text-indigo-400/80">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
              <span>
                从 {currentSession.sourceHandoff.sourceMode === "ask" ? "Ask" : currentSession.sourceHandoff.sourceMode === "cluster" ? "Cluster" : currentSession.sourceHandoff.sourceMode} 对话延续
              </span>
            </div>
          )}

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
            inputRef={inputRef}
            fileInputRef={fileInputRef}
          />
        </div>

      </div>
    );
  },
);

export default SmartAgentPlugin;
