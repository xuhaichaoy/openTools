import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { pluginActionToTool, type AgentTool } from "./core/react-agent";
import { registry } from "@/core/plugin-system/registry";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { useAgentStore, type AgentTask } from "@/store/agent-store";
import type { RuntimeFallbackContext } from "@/core/agent/runtime";

import { AgentInputBar } from "./components/AgentInputBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { AgentWorkbenchPanel } from "./components/AgentWorkbenchPanel";
import { AgentHistoryDrawer } from "./components/AgentHistoryDrawer";
import { AgentTaskTimeline } from "./components/AgentTaskTimeline";
import { PlanRelationCheckingBanner } from "./components/PlanRelationCheckingBanner";
import { PlanLinkDecisionBanner } from "./components/PlanLinkDecisionBanner";
import { PlanClarificationPanel } from "./components/PlanClarificationPanel";
import { PendingPlanCard } from "./components/PendingPlanCard";
import { AgentHeaderBar } from "./components/AgentHeaderBar";
import { PlanModeToolbar } from "./components/PlanModeToolbar";
import {
  shouldEnablePlanKBByKeyword,
  type PlanThreadState,
} from "./core/plan-mode";
import { createBuiltinAgentTools } from "./core/default-tools";
import { useAgentExecution } from "./hooks/use-agent-execution";
import { useAgentInputAssets } from "./hooks/use-agent-input-assets";
import { usePlanModeWorkflow } from "./hooks/use-plan-mode-workflow";
import {
  findFirstIncompleteClarificationIndex,
  loadPlanThreadsFromStorage,
  persistPlanThreadsToStorage,
  shouldAutoCollapseProcess,
  shouldBypassPlan,
  sortScheduledTasks,
  type PendingPlanClarificationState,
  type PendingPlanLinkDecisionState,
  type PendingPlanState,
  type PlanClarificationAnswers,
  type PlanRelationCheckingState,
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
  togglePlanMode: () => void;
  getPlanMode: () => boolean;
  newSession: () => void;
  getSessionCount: () => number;
}

interface SmartAgentProps {
  onBack?: () => void;
  ai?: MToolsAI;
  headless?: boolean;
  onPlanModeChange?: (enabled: boolean) => void;
}

const EMPTY_AGENT_TASKS: AgentTask[] = [];

const SmartAgentPlugin = forwardRef<SmartAgentHandle, SmartAgentProps>(
  function SmartAgentPlugin({ onBack, ai, headless, onPlanModeChange }, ref) {
    const [input, setInput] = useState("");
    const [running, setRunning] = useState(false);
    const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
    const [collapsedTaskProcesses, setCollapsedTaskProcesses] = useState<Set<string>>(
      new Set(),
    );
    const [availableTools, setAvailableTools] = useState<AgentTool[]>([]);
    const [showWorkbench, setShowWorkbench] = useState(false);
    const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("tools");
    const [showHistory, setShowHistory] = useState(false);
    const [planMode, setPlanMode] = useState(true);
    const [planning, setPlanning] = useState(false);
    const [runningPhase, setRunningPhase] = useState<RunningPhase | null>(null);
    const [planThreads, setPlanThreads] = useState<Record<string, PlanThreadState>>(() =>
      loadPlanThreadsFromStorage(),
    );
    const [pendingPlanClarification, setPendingPlanClarification] =
      useState<PendingPlanClarificationState | null>(null);
    const [planClarificationAnswers, setPlanClarificationAnswers] =
      useState<PlanClarificationAnswers>({});
    const [planClarificationError, setPlanClarificationError] = useState<string | null>(
      null,
    );
    const [clarificationQuestionIndex, setClarificationQuestionIndex] = useState(0);
    const [pendingPlan, setPendingPlan] = useState<PendingPlanState | null>(null);
    const [pendingPlanLinkDecision, setPendingPlanLinkDecision] =
      useState<PendingPlanLinkDecisionState | null>(null);
    const [planRelationChecking, setPlanRelationChecking] =
      useState<PlanRelationCheckingState | null>(null);
    const [planKnowledgeEnabled, setPlanKnowledgeEnabled] = useState(false);
    const [forceNewPlanNextRun, setForceNewPlanNextRun] = useState(false);
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
    const planningTaskRef = useRef<{ sessionId: string; taskId: string } | null>(null);
    const planningStopRequestedRef = useRef(false);
    const {
      pendingImages,
      pendingImagePreviews,
      handlePaste,
      handleFileSelect,
      removeImage,
      clearAssets,
    } = useAgentInputAssets();

    const setPlanModeValue = useCallback(
      (next: boolean | ((prev: boolean) => boolean)) => {
        setPlanMode((prev) => {
          const resolved = typeof next === "function" ? next(prev) : next;
          onPlanModeChange?.(resolved);
          return resolved;
        });
      },
      [onPlanModeChange],
    );

    // 危险操作确认对话框
    const [confirmDialog, setConfirmDialog] = useState<{
      toolName: string;
      params: Record<string, unknown>;
      resolve: (confirmed: boolean) => void;
    } | null>(null);

    const confirmHostFallback = useCallback(
      (context: RuntimeFallbackContext) =>
        new Promise<boolean>((resolve) => {
          const toolName =
            context.action === "run_shell_command"
              ? "run_shell_command_host_fallback"
              : "write_file_host_fallback";

          setConfirmDialog({
            toolName,
            params: {
              ...context,
              warning: "容器运行时不可用，将降级到宿主机执行该操作。",
            },
            resolve,
          });
        }),
      [],
    );

    // Agent store
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
    const hasAnySteps = tasks.some((t) => t.steps.length > 0);
    const busy = running || planning;
    const currentPlanThread = currentSessionId
      ? planThreads[currentSessionId] || null
      : null;
    const pendingClarificationThread = pendingPlanClarification
      ? planThreads[pendingPlanClarification.sessionId] || null
      : null;
    const pendingDraftThread = pendingPlan ? planThreads[pendingPlan.sessionId] || null : null;
    const clarificationQuestions = pendingPlanClarification?.questions || [];
    const clarificationQuestionCount = clarificationQuestions.length;
    const activeClarificationIndex =
      clarificationQuestionCount === 0
        ? 0
        : Math.min(
            Math.max(clarificationQuestionIndex, 0),
            clarificationQuestionCount - 1,
          );
    const activeClarificationQuestion =
      clarificationQuestionCount > 0
        ? clarificationQuestions[activeClarificationIndex] || null
        : null;
    const firstIncompleteClarificationIndex =
      clarificationQuestionCount > 0
        ? findFirstIncompleteClarificationIndex(
            clarificationQuestions,
            planClarificationAnswers,
          )
        : -1;
    const clarificationReadyToSubmit = firstIncompleteClarificationIndex === -1;
    const requiredClarificationTotal = clarificationQuestions.filter(
      (question) => question.required,
    ).length;
    const requiredClarificationCompleted = clarificationQuestions.filter((question) => {
      if (!question.required) return false;
      const answer = planClarificationAnswers[question.id];
      const selected = (answer?.selectedOptions || []).filter((option) => !!option);
      const custom = answer?.customInput?.trim() || "";
      return selected.length > 0 || custom.length > 0;
    }).length;
    const planKBKeywordHit = shouldEnablePlanKBByKeyword(input);
    const filteredScheduledTasks =
      scheduledStatusFilter === "all"
        ? scheduledTasks
        : scheduledStatusFilter === "attention"
          ? scheduledTasks.filter(
              (task) =>
                task.status === "error" || task.last_result_status === "skipped",
            )
          : scheduledTasks.filter((task) => task.status === scheduledStatusFilter);
    const visibleScheduledTasks = sortScheduledTasks(
      filteredScheduledTasks,
      scheduledSortMode,
    );
    const scheduledStats = {
      total: scheduledTasks.length,
      running: scheduledTasks.filter((task) => task.status === "running").length,
      error: scheduledTasks.filter((task) => task.status === "error").length,
      skipped: scheduledTasks.filter((task) => task.last_result_status === "skipped")
        .length,
    };

    const resetPlanTransientState = useCallback(() => {
      setPendingPlanLinkDecision(null);
      setPlanRelationChecking(null);
      setPendingPlanClarification(null);
      setPlanClarificationAnswers({});
      setPlanClarificationError(null);
      setClarificationQuestionIndex(0);
      setPendingPlan(null);
    }, []);

    const resetSessionVisualState = useCallback(() => {
      setInput("");
      setExpandedSteps(new Set());
      setCollapsedTaskProcesses(new Set());
      setForceNewPlanNextRun(false);
      clearAssets();
    }, [clearAssets]);

    // ---- Effects ----

    useEffect(() => {
      if (!historyLoaded) loadHistory();
      loadScheduledTasks();
    }, [historyLoaded, loadHistory, loadScheduledTasks]);

    useEffect(() => {
      setCollapsedTaskProcesses((prev) => {
        const next = new Set(prev);
        let changed = false;

        const aliveIds = new Set(tasks.map((task) => task.id));
        for (const taskId of next) {
          if (!aliveIds.has(taskId)) {
            next.delete(taskId);
            changed = true;
          }
        }

        for (const task of tasks) {
          const shouldCollapse = shouldAutoCollapseProcess(task);
          if (shouldCollapse && !next.has(task.id)) {
            next.add(task.id);
            changed = true;
          } else if (!shouldCollapse && next.has(task.id)) {
            next.delete(task.id);
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    }, [tasks]);

    useEffect(() => {
      if (!pendingPlanClarification) {
        setClarificationQuestionIndex(0);
        return;
      }
      setClarificationQuestionIndex((prev) =>
        Math.min(prev, Math.max(0, pendingPlanClarification.questions.length - 1)),
      );
    }, [pendingPlanClarification]);

    useEffect(() => {
      persistPlanThreadsToStorage(planThreads);
    }, [planThreads]);

    useEffect(() => {
      if (!historyLoaded) return;
      setPlanThreads((prev) => {
        const alive = new Set(sessions.map((session) => session.id));
        let changed = false;
        const next: Record<string, PlanThreadState> = {};
        for (const [sessionId, thread] of Object.entries(prev)) {
          if (alive.has(sessionId)) {
            next[sessionId] = thread;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, [sessions, historyLoaded]);

    // 收集所有插件暴露的 actions 作为工具
    useEffect(() => {
      if (!ai) return;
      const allActions = registry.getAllActions();
      const tools: AgentTool[] = allActions.map(
        ({ pluginId, pluginName, action }) =>
          pluginActionToTool(pluginId, pluginName, action, ai),
      );

      tools.push(...createBuiltinAgentTools(confirmHostFallback));

      setAvailableTools(tools);
    }, [ai, confirmHostFallback]);

    // ---- Agent Run ----

    const handleRunRef = useRef<(() => void | Promise<void>) | null>(null);
    const { executeAgentTask, stopExecution } = useAgentExecution({
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
      openDangerConfirm: (toolName, params) =>
        new Promise<boolean>((resolve) => {
          setConfirmDialog({ toolName, params, resolve });
        }),
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

    const handleStop = useCallback(() => {
      stopExecution();

      if (planning) {
        planningStopRequestedRef.current = true;
        const currentPlanningTask = planningTaskRef.current;
        if (currentPlanningTask) {
          updateTask(currentPlanningTask.sessionId, currentPlanningTask.taskId, {
            status: "cancelled",
            answer: "计划生成已停止。",
          });
        }
        setPlanning(false);
        setRunningPhase(null);
        void import("@tauri-apps/api/core")
          .then(({ invoke }) => invoke("ai_stop_stream"))
          .catch(() => undefined);
      }
    }, [planning, updateTask, stopExecution]);

    const {
      runPlanWorkflow,
      handleSelectClarificationOption,
      handleClarificationCustomInput,
      handleSubmitPlanClarification,
      handleCancelPlanClarification,
      handleExecutePlan,
      handleCancelPlan,
      handleResolvePlanLinkDecision,
    } = usePlanModeWorkflow({
      ai,
      busy,
      currentSessionId,
      planKnowledgeEnabled,
      planThreads,
      setPlanThreads,
      pendingPlanLinkDecision,
      setPendingPlanLinkDecision,
      pendingPlanClarification,
      setPendingPlanClarification,
      planClarificationAnswers,
      setPlanClarificationAnswers,
      setPlanClarificationError,
      setClarificationQuestionIndex,
      pendingPlan,
      setPendingPlan,
      setPlanning,
      setRunningPhase,
      setPlanRelationChecking,
      planningTaskRef,
      planningStopRequestedRef,
      createSession,
      addTask,
      updateTask,
      executeAgentTask,
    });

    const handleRun = useCallback(async () => {
      if (!ai || (!input.trim() && pendingImages.length === 0) || busy) return;

      let query = input.trim();
      const imagePaths = [...pendingImages];
      if (imagePaths.length > 0) {
        const imageInfo = imagePaths.join("\n");
        query = query
          ? `${query}\n\n[用户附带了以下图片文件]\n${imageInfo}`
          : `请分析以下图片文件:\n${imageInfo}`;
      }

      setInput("");
      clearAssets();
      resetPlanTransientState();

      if (!planMode || shouldBypassPlan(query, imagePaths.length)) {
        setForceNewPlanNextRun(false);
        await executeAgentTask(query);
        return;
      }

      const forcedRelation = forceNewPlanNextRun ? "unrelated" : undefined;
      setForceNewPlanNextRun(false);
      await runPlanWorkflow(query, { forcedRelation });
    }, [
      ai,
      input,
      pendingImages,
      busy,
      planMode,
      executeAgentTask,
      forceNewPlanNextRun,
      runPlanWorkflow,
      clearAssets,
      resetPlanTransientState,
    ]);

    handleRunRef.current = handleRun;

    // ---- Helpers ----

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

    const handleClear = useCallback(() => {
      const id = useAgentStore.getState().currentSessionId;
      if (id) updateSession(id, { tasks: [] });
      if (id) {
        setPlanThreads((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      resetSessionVisualState();
      resetPlanTransientState();
    }, [updateSession, resetSessionVisualState, resetPlanTransientState]);

    const handleNewSession = useCallback(() => {
      createSession("");
      resetSessionVisualState();
      resetPlanTransientState();
      inputRef.current?.focus();
    }, [createSession, resetSessionVisualState, resetPlanTransientState]);

    const handleSelectHistorySession = useCallback(
      (id: string) => {
        setCurrentSession(id);
        setShowHistory(false);
        resetSessionVisualState();
        resetPlanTransientState();
      },
      [setCurrentSession, resetSessionVisualState, resetPlanTransientState],
    );

    const handleDeleteHistorySession = useCallback(
      (sessionIdToDelete: string) => {
        deleteSession(sessionIdToDelete);
        setPlanThreads((prev) => {
          if (!prev[sessionIdToDelete]) return prev;
          const next = { ...prev };
          delete next[sessionIdToDelete];
          return next;
        });

        const affectsCurrent = currentSessionId === sessionIdToDelete;
        const affectsTransient =
          pendingPlan?.sessionId === sessionIdToDelete ||
          pendingPlanClarification?.sessionId === sessionIdToDelete ||
          pendingPlanLinkDecision?.sessionId === sessionIdToDelete ||
          planRelationChecking?.sessionId === sessionIdToDelete;

        if (affectsCurrent) {
          resetSessionVisualState();
        }
        if (affectsCurrent || affectsTransient) {
          resetPlanTransientState();
        }
      },
      [
        deleteSession,
        currentSessionId,
        pendingPlan,
        pendingPlanClarification,
        pendingPlanLinkDecision,
        planRelationChecking,
        resetSessionVisualState,
        resetPlanTransientState,
      ],
    );

    const handleDeleteAllHistory = useCallback(() => {
      deleteAllSessions();
      setPlanThreads({});
      setShowHistory(false);
      resetSessionVisualState();
      resetPlanTransientState();
    }, [deleteAllSessions, resetSessionVisualState, resetPlanTransientState]);

    const handleCreateScheduledTask = useCallback(async () => {
      const query = scheduledQuery.trim();
      const value = scheduledValue.trim();
      if (!query || !value) return;
      const created = await createScheduledTask({
        query,
        scheduleType: scheduledType,
        scheduleValue: value,
        sessionId: currentSessionId || undefined,
      });
      if (created) {
        setScheduledQuery("");
        setScheduledValue("");
      }
    }, [
      scheduledQuery,
      scheduledValue,
      createScheduledTask,
      scheduledType,
      currentSessionId,
    ]);

    const toggleWorkbenchTab = useCallback(
      (tab: WorkbenchTab) => {
        setShowWorkbench((prev) => (prev && workbenchTab === tab ? false : true));
        setWorkbenchTab(tab);
      },
      [workbenchTab],
    );

    useImperativeHandle(ref, () => ({
      clear: handleClear,
      getToolCount: () => availableTools.length,
      toggleTools: () => toggleWorkbenchTab("tools"),
      toggleOrchestrator: () => toggleWorkbenchTab("orchestrator"),
      toggleHistory: () => setShowHistory((v) => !v),
      togglePlanMode: () => setPlanModeValue((v) => !v),
      getPlanMode: () => planMode,
      newSession: handleNewSession,
      getSessionCount: () => sessions.length,
    }), [handleClear, availableTools.length, handleNewSession, sessions.length, setPlanModeValue, planMode, toggleWorkbenchTab]);

    // ---- Render ----

    return (
      <div className="flex h-full bg-[var(--color-bg)] text-[var(--color-text)] relative">
        {/* 历史会话侧边栏 */}
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

        {/* 主体 */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* 头部 */}
          {!headless && (
            <AgentHeaderBar
              onBack={onBack}
              sessionsCount={sessions.length}
              availableToolsCount={availableTools.length}
              scheduledTasksCount={scheduledTasks.length}
              showToolsWorkbench={showWorkbench && workbenchTab === "tools"}
              showOrchestratorWorkbench={showWorkbench && workbenchTab === "orchestrator"}
              planMode={planMode}
              hasAnySteps={hasAnySteps}
              onShowHistory={() => setShowHistory(true)}
              onToggleToolsWorkbench={() => toggleWorkbenchTab("tools")}
              onToggleOrchestratorWorkbench={() => toggleWorkbenchTab("orchestrator")}
              onTogglePlanMode={() => setPlanModeValue((v) => !v)}
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

          <PlanRelationCheckingBanner state={planRelationChecking} />

          <PlanLinkDecisionBanner
            decision={pendingPlanLinkDecision}
            busy={busy}
            onResolveRelated={() => {
              void handleResolvePlanLinkDecision("related");
            }}
            onResolveUnrelated={() => {
              void handleResolvePlanLinkDecision("unrelated");
            }}
          />

          <PlanClarificationPanel
            pendingPlanClarification={pendingPlanClarification}
            threadVersion={pendingClarificationThread?.planVersion || 1}
            activeQuestion={activeClarificationQuestion}
            activeQuestionIndex={activeClarificationIndex}
            questionCount={clarificationQuestionCount}
            answers={planClarificationAnswers}
            onPrevQuestion={() =>
              setClarificationQuestionIndex((idx) => Math.max(0, idx - 1))
            }
            onNextQuestion={() =>
              setClarificationQuestionIndex((idx) =>
                Math.min(clarificationQuestionCount - 1, idx + 1),
              )
            }
            onSelectOption={handleSelectClarificationOption}
            onCustomInput={handleClarificationCustomInput}
            onSubmit={() => {
              void handleSubmitPlanClarification();
            }}
            onCancel={handleCancelPlanClarification}
            busy={busy}
            error={planClarificationError}
            readyToSubmit={clarificationReadyToSubmit}
            requiredCompletedCount={requiredClarificationCompleted}
            requiredTotalCount={requiredClarificationTotal}
          />

          <PendingPlanCard
            pendingPlan={pendingPlan}
            pendingDraftFollowup={pendingDraftThread?.latestFollowup}
            busy={busy}
            onExecute={() => {
              void handleExecutePlan();
            }}
            onCancel={handleCancelPlan}
          />

          {/* 推理过程：多任务块 */}
          <AgentTaskTimeline
            tasks={tasks}
            busy={busy}
            runningPhase={runningPhase}
            scrollRef={scrollRef}
            collapsedTaskProcesses={collapsedTaskProcesses}
            expandedSteps={expandedSteps}
            onToggleTaskProcess={toggleTaskProcess}
            onToggleStep={toggleStep}
          />

          <PlanModeToolbar
            visible={planMode}
            busy={busy}
            forceNewPlanNextRun={forceNewPlanNextRun}
            planKnowledgeEnabled={planKnowledgeEnabled}
            planKBKeywordHit={planKBKeywordHit}
            currentPlanThread={currentPlanThread}
            onToggleForceNewPlan={() => setForceNewPlanNextRun((prev) => !prev)}
            onTogglePlanKnowledge={() => setPlanKnowledgeEnabled((prev) => !prev)}
          />

          {/* 输入区域 */}
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

        {/* 危险操作确认对话框 */}
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
      </div>
    );
  },
);

export default SmartAgentPlugin;
