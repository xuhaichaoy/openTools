import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  Network,
  Play,
  Square,
  Loader2,
  ChevronDown,
  ChevronRight,
  Trash2,
  CheckCircle,
  Settings2,
  ShieldCheck,
  Copy,
  Download,
  ArrowRightCircle,
  FileText,
  X,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AttachDropdown } from "@/components/ui/AttachDropdown";
import { useClusterStore, type ClusterSession } from "@/store/cluster-store";
import { ChatImage } from "@/components/ai/MessageBubble";
import { useAIStore } from "@/store/ai-store";
import { ClusterOrchestrator } from "@/core/agent/cluster/cluster-orchestrator";
import {
  setActiveOrchestrator,
  getActiveSessionIds,
  getActiveOrchestratorCount,
  clearActiveOrchestrator,
  abortActiveOrchestrator,
  abortAllActiveOrchestrators,
  isClusterRunning,
  setClusterPanelVisible,
} from "@/core/agent/cluster/active-orchestrator";
import type {
  ClusterMode,
  ClusterSessionStatus,
  ClusterPlan,
} from "@/core/agent/cluster/types";
import { ClusterPlanView } from "./ClusterPlanView";
import { ClusterDAGView } from "./ClusterDAGView";
import { AgentInstancePanel } from "./AgentInstancePanel";
import { useAskUserStore } from "@/store/ask-user-store";
import { useToolTrustStore } from "@/store/command-allowlist-store";
import { useConfirmDialogStore } from "@/store/confirm-dialog-store";
import { useClusterPlanApprovalStore } from "@/store/cluster-plan-approval-store";
import type { AskUserQuestion, AskUserAnswers } from "../../core/default-tools";
import { useInputAttachments } from "@/hooks/use-input-attachments";
import { useToast } from "@/components/ui/Toast";
import { handleError } from "@/core/errors";
import { routeToAICenter } from "@/core/ai/ai-center-routing";
import { recordAIRouteEvent } from "@/store/ai-route-store";

const SETTINGS_KEY = "mtools-cluster-settings";
const MAX_ACTIVE_CLUSTER_TASKS = 3;

interface ClusterPanelSettings {
  autoReview: boolean;
  humanApproval: boolean;
  codingMode: boolean;
  largeProjectMode: boolean;
}

function loadSettings(): ClusterPanelSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ClusterPanelSettings>;
      const codingMode = !!parsed.codingMode;
      return {
        autoReview: !!parsed.autoReview,
        humanApproval: !!parsed.humanApproval,
        codingMode,
        largeProjectMode: codingMode && !!parsed.largeProjectMode,
      };
    }
  } catch { /* ignore */ }
  return {
    autoReview: false,
    humanApproval: false,
    codingMode: false,
    largeProjectMode: false,
  };
}

function saveSettings(s: ClusterPanelSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const STATUS_LABELS: Record<ClusterSessionStatus, string> = {
  idle: "空闲",
  planning: "规划中...",
  awaiting_approval: "等待审批...",
  dispatching: "分发中...",
  running: "执行中...",
  aggregating: "汇总中...",
  done: "已完成",
  error: "出错",
};

function SessionStatusBadge({ status }: { status: ClusterSessionStatus }) {
  const isActive = [
    "planning", "awaiting_approval", "dispatching", "running", "aggregating",
  ].includes(status);
  const color =
    status === "done"
      ? "text-green-600 bg-green-500/10"
      : status === "error"
        ? "text-red-600 bg-red-500/10"
        : isActive
          ? "text-blue-600 bg-blue-500/10"
          : "text-[var(--color-text-tertiary)] bg-gray-500/10";

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${color}`}
    >
      {isActive && <Loader2 className="w-3 h-3 animate-spin" />}
      {STATUS_LABELS[status]}
    </span>
  );
}

const PLANNING_HINTS: Partial<Record<ClusterSessionStatus, { icon: React.ReactNode; text: string; detail: string }>> = {
  planning: {
    icon: <Loader2 className="w-5 h-5 text-[var(--color-accent)] animate-spin" />,
    text: "正在分析任务...",
    detail: "Planner Agent 正在理解任务需求，拆分子任务",
  },
  awaiting_approval: {
    icon: <ShieldCheck className="w-5 h-5 text-purple-500" />,
    text: "等待审批",
    detail: "执行计划已生成，等待您确认后开始执行",
  },
  dispatching: {
    icon: <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />,
    text: "正在分发任务...",
    detail: "正在将子任务分配给对应的 Agent",
  },
};

function PlanningIndicator({ status }: { status: ClusterSessionStatus }) {
  const hint = PLANNING_HINTS[status];
  if (!hint) return null;

  return (
    <div className="flex flex-col items-center justify-center py-6 gap-2">
      {hint.icon}
      <span className="text-sm font-medium text-[var(--color-text-primary)]">
        {hint.text}
      </span>
      <span className="text-[11px] text-[var(--color-text-tertiary)] text-center max-w-[280px]">
        {hint.detail}
      </span>
    </div>
  );
}

function SessionCard({
  session,
  isActive,
  onSelect,
}: {
  session: ClusterSession;
  isActive: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(isActive);
  const [copied, setCopied] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const { toast } = useToast();

  const handleCopyQuery = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(session.query).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard access denied */ });
  };

  const handleCopyResult = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!session.result) return;
    navigator.clipboard.writeText(session.result.finalAnswer).then(() => {
      toast("success", "已复制");
    }).catch(() => { toast("warning", "复制失败"); });
  };

  const handleSaveResult = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!session.result) return;
    const baseName = session.query.slice(0, 40).replace(/[/\\?%*:|"<>]/g, "_").trim() || "cluster-result";
    const defaultPath = `${baseName}-${Date.now()}.md`;
    try {
      const filePath = await save({
        defaultPath,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (filePath) {
        await writeTextFile(filePath, session.result.finalAnswer);
        toast("success", "已保存");
      }
    } catch (err) {
      handleError(err, { context: "导出结果", silent: true });
      toast("warning", "保存失败");
    }
  };

  const handleContinueWithAgent = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!session.result) return;
    const report = session.result.finalAnswer;
    const truncated = report.length > 2000 ? report.slice(0, 2000) + "\n\n...（完整内容见上方 Cluster 报告）" : report;
    const prefilled = `根据以下 Cluster 分析报告，请帮我改进/修复或按报告执行（可在此补充具体诉求，如：修复其中的问题、把建议落地为代码、保存为文档等）：\n\n${truncated}`;
    routeToAICenter({
      mode: "agent",
      source: "cluster_continue_to_agent",
      agentInitialQuery: prefilled,
      taskId: session.id,
      navigate: false,
    });
  };

  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        isActive
          ? "border-[var(--color-accent)]/20 bg-[var(--color-accent)]/1"
          : "border-[var(--color-border)]"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors cursor-pointer select-none"
        onClick={() => {
          onSelect();
          setExpanded(!expanded);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
            setExpanded(!expanded);
          }
        }}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] shrink-0" />
        )}
        <Network className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 text-left line-clamp-1 font-medium min-w-0">
          {session.query.slice(0, 60)}
          {session.query.length > 60 && "…"}
        </span>
        <button
          type="button"
          className="shrink-0 p-1 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] transition-colors"
          onClick={handleCopyQuery}
          title="复制任务名称"
        >
          {copied ? (
            <CheckCircle className="w-3.5 h-3.5 text-green-500" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
        {session.mode && (
          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${
            session.mode === "parallel_split"
              ? "bg-blue-500/10 text-blue-500"
              : "bg-purple-500/10 text-purple-500"
          }`}>
            {session.mode === "parallel_split" ? "并行" : "协作"}
          </span>
        )}
        {session.model && (
          <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)] max-w-[80px] truncate" title={session.model}>
            {session.model}
          </span>
        )}
        <SessionStatusBadge status={session.status} />
      </div>

      {expanded && (
        <div className="border-t border-[var(--color-border)] px-3 py-3 space-y-3">
          {session.images && session.images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {session.images.map((img) => (
                <ChatImage
                  key={img}
                  path={img}
                  className="w-16 h-16 object-cover rounded-md border border-[var(--color-border)] cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={(blobUrl) => setPreviewImage(blobUrl)}
                />
              ))}
            </div>
          )}

          {!session.plan && !session.result && session.instances.length === 0 && (
            <PlanningIndicator status={session.status} />
          )}

          {session.plan && (
            <>
              <ClusterPlanView
                plan={session.plan}
                instances={session.instances}
              />
              {session.plan.steps.length > 1 && (
                <ClusterDAGView
                  plan={session.plan}
                  instances={session.instances}
                />
              )}
            </>
          )}

          {session.instances.length > 0 && (
            <AgentInstancePanel instances={session.instances} />
          )}

          {session.result && (
            <div className="mt-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] text-[var(--color-text-tertiary)]">最终结果</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="flex items-center gap-1 px-2 py-1 text-[10px] rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
                    onClick={handleCopyResult}
                    title="复制结果"
                  >
                    <Copy className="w-3 h-3" />
                    复制
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1 px-2 py-1 text-[10px] rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
                    onClick={handleSaveResult}
                    title="保存为 Markdown 文件"
                  >
                    <Download className="w-3 h-3" />
                    保存为文件
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1 px-2 py-1 text-[10px] rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] transition-colors"
                    onClick={handleContinueWithAgent}
                    title="跳转到 Agent 并带入报告，便于后续修改/写文件"
                  >
                    <ArrowRightCircle className="w-3 h-3" />
                    用 Agent 继续
                  </button>
                </div>
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed bg-[var(--color-bg-secondary)] rounded-lg p-4 prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-table:my-3 prose-td:py-1.5 prose-th:py-1.5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {session.result.finalAnswer}
                </ReactMarkdown>
              </div>
              <div className="text-[10px] text-[var(--color-text-tertiary)] mt-1">
                耗时 {(session.result.totalDurationMs / 1000).toFixed(1)}s ·{" "}
                {session.result.agentInstances.length} 个 Agent
              </div>
            </div>
          )}
        </div>
      )}
      {previewImage && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out animate-in fade-in duration-200"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            alt="预览大图"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl animate-in zoom-in-95 duration-200"
          />
          <button
            className="absolute top-6 right-6 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors shadow-lg"
            onClick={() => setPreviewImage(null)}
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
}

export function ClusterPanel() {
  const savedSettings = loadSettings();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ClusterMode>("parallel_split");
  const [runningCount, setRunningCount] = useState(() => getActiveOrchestratorCount());
  const [showSettings, setShowSettings] = useState(false);
  const [autoReview, setAutoReview] = useState(savedSettings.autoReview);
  const [humanApproval, setHumanApproval] = useState(savedSettings.humanApproval);
  const [codingMode, setCodingMode] = useState(savedSettings.codingMode);
  const [largeProjectMode, setLargeProjectMode] = useState(
    savedSettings.largeProjectMode,
  );
  const unmountedRef = useRef(false);
  const { toast } = useToast();
  const openConfirmDialog = useConfirmDialogStore((s) => s.open);
  const openPlanApprovalDialog = useClusterPlanApprovalStore((s) => s.open);

  const clusterFileInputRef = useRef<HTMLInputElement>(null);
  const {
    attachments,
    imagePaths,
    fileContextBlock,
    attachmentSummary,
    handlePaste,
    handleFileSelect,
    handleFolderSelect,
    removeAttachment,
    clearAttachments,
  } = useInputAttachments();

  const aiConfig = useAIStore((s) => s.config);
  const sessions = useClusterStore((s) => s.sessions);
  const currentSessionId = useClusterStore((s) => s.currentSessionId);
  const createSession = useClusterStore((s) => s.createSession);
  const setCurrentSession = useClusterStore((s) => s.setCurrentSession);
  const deleteAllSessions = useClusterStore((s) => s.deleteAllSessions);
  const hasAnyRunning = runningCount > 0;
  const currentSessionRunning = !!(currentSessionId && isClusterRunning(currentSessionId));

  useEffect(() => {
    saveSettings({ autoReview, humanApproval, codingMode, largeProjectMode });
  }, [autoReview, humanApproval, codingMode, largeProjectMode]);

  useEffect(() => {
    unmountedRef.current = false;
    setClusterPanelVisible(true);

    const activeSessionIds = getActiveSessionIds();
    if (activeSessionIds.length > 0) {
      const { setCurrentSession: setSession } = useClusterStore.getState();
      setSession(activeSessionIds[0]);
    }

    const syncTimer = setInterval(() => {
      const nextCount = getActiveOrchestratorCount();
      setRunningCount((prev) => (prev !== nextCount ? nextCount : prev));
    }, 500);

    return () => {
      unmountedRef.current = true;
      setClusterPanelVisible(false);
      clearInterval(syncTimer);
    };
  }, []);

  const confirmDangerousAction = useCallback(
    (toolName: string, params: Record<string, unknown>): Promise<boolean> => {
      if (!useToolTrustStore.getState().shouldConfirm(toolName)) {
        return Promise.resolve(true);
      }
      return openConfirmDialog({
        source: "cluster",
        toolName,
        params,
      });
    },
    [openConfirmDialog],
  );

  const askUserOpen = useAskUserStore((s) => s.open);

  const askUser = useCallback(
    (questions: AskUserQuestion[]): Promise<AskUserAnswers> =>
      askUserOpen({
        questions,
        source: "cluster",
        taskDescription: input.trim() || undefined,
      }),
    [askUserOpen, input],
  );

  const handlePlanApproval = useCallback(
    (plan: ClusterPlan, sessionId: string) =>
      openPlanApprovalDialog({ plan, sessionId }),
    [openPlanApprovalDialog],
  );

  const handleRun = useCallback(async () => {
    const trimmed = input.trim();
    const hasAttachments = attachments.length > 0;
    if (!trimmed && !hasAttachments) return;

    const activeCount = getActiveOrchestratorCount();
    if (activeCount >= MAX_ACTIVE_CLUSTER_TASKS) {
      toast("warning", `当前最多同时运行 ${MAX_ACTIVE_CLUSTER_TASKS} 个集群任务`);
      return;
    }

    const userText = trimmed || (fileContextBlock.trim() ? "请了解项目结构，等待下一步指令。" : "（无文字描述）");
    const displayQuery = attachmentSummary ? `${attachmentSummary}\n${userText}` : userText;
    const fullQuery = fileContextBlock.trim()
      ? `${fileContextBlock}\n\n---\n\n${userText}`
      : userText;
    const sessionId = createSession(displayQuery, mode, aiConfig.model, imagePaths.length > 0 ? imagePaths : undefined);
    recordAIRouteEvent({
      mode: "cluster",
      source: "cluster_run",
      taskId: sessionId,
      queryPreview: displayQuery.slice(0, 120),
    });
    setInput("");
    clearAttachments();

    const abortController = new AbortController();

    const orchestrator = new ClusterOrchestrator({
      maxConcurrency: codingMode && largeProjectMode ? 3 : 4,
      signal: abortController.signal,
      autoReviewCodeSteps: autoReview || codingMode,
      maxReviewRetries: codingMode ? 3 : 2,
      codingMode,
      largeProjectMode,
      confirmDangerousAction,
      askUser,
      onPlanApproval: humanApproval
        ? (request) => handlePlanApproval(request.plan, sessionId)
        : undefined,
      onStatusChange: (status) => {
        useClusterStore.getState().updateSession(sessionId, { status });
      },
      onInstanceUpdate: (instance) => {
        useClusterStore.getState().updateInstance(sessionId, instance);
      },
      onProgress: (event) => {
        if (event.type === "plan_created" || event.type === "plan_approved") {
          const detail = event.detail as { plan?: ClusterPlan } | undefined;
          if (detail?.plan) {
            useClusterStore.getState().updateSession(sessionId, { plan: detail.plan });
          }
        }
      },
    });

    if (fileContextBlock.trim()) {
      orchestrator.setProjectContext(fileContextBlock.trim());
    }
    setActiveOrchestrator(sessionId, orchestrator, abortController);
    setRunningCount(getActiveOrchestratorCount());

    try {
      const result = await orchestrator.execute(fullQuery, mode, imagePaths.length > 0 ? imagePaths : undefined);
      const plan = orchestrator.getMessageBus().getContext("_plan") as
        | ClusterPlan
        | undefined;
      useClusterStore.getState().updateSession(sessionId, {
        status: result.finalAnswer.startsWith("集群执行失败") ? "error" : "done",
        plan,
        result,
        finishedAt: Date.now(),
      });
    } catch {
      useClusterStore.getState().updateSession(sessionId, {
        status: "error",
        finishedAt: Date.now(),
      });
    } finally {
      clearActiveOrchestrator(sessionId);
      if (!unmountedRef.current) {
        setRunningCount(getActiveOrchestratorCount());
      }
    }
  }, [input, attachments, fileContextBlock, attachmentSummary, imagePaths, mode, autoReview, humanApproval, codingMode, largeProjectMode, createSession, clearAttachments, aiConfig.model, handlePlanApproval, confirmDangerousAction, askUser, toast]);

  const handleAbort = useCallback(() => {
    const targetSessionId =
      currentSessionId && isClusterRunning(currentSessionId)
        ? currentSessionId
        : undefined;
    void abortActiveOrchestrator(targetSessionId).finally(() => {
      setRunningCount(getActiveOrchestratorCount());
    });
  }, [currentSessionId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleRun();
      }
    },
    [handleRun],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-medium">Agent Cluster</span>
          <span className="text-xs text-[var(--color-text-tertiary)]">
            ({sessions.length})
          </span>
          {hasAnyRunning && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">
              运行中 {runningCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`p-1 rounded transition-colors ${
              showSettings
                ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            }`}
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          {sessions.length > 0 && (
            <button
              className="text-xs text-[var(--color-text-tertiary)] hover:text-red-500 transition-colors flex items-center gap-1"
              onClick={() => {
                if (hasAnyRunning) {
                  void abortAllActiveOrchestrators().finally(() => {
                    setRunningCount(getActiveOrchestratorCount());
                  });
                }
                deleteAllSessions();
              }}
            >
              <Trash2 className="w-3 h-3" />
              清空
            </button>
          )}
        </div>
      </div>

      {showSettings && (
        <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-2.5 bg-[var(--color-bg-secondary)]">
          <div className="text-[10px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
            集群设置
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={autoReview}
              onChange={(e) => setAutoReview(e.target.checked)}
              className="rounded border-[var(--color-border)]"
            />
            <span>自动代码审查 (Coder → Reviewer 循环)</span>
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={humanApproval}
              onChange={(e) => setHumanApproval(e.target.checked)}
              className="rounded border-[var(--color-border)]"
            />
            <span>计划审批 (执行前人工确认)</span>
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={codingMode}
              onChange={(e) => {
                const checked = e.target.checked;
                setCodingMode(checked);
                if (!checked) setLargeProjectMode(false);
              }}
              className="rounded border-[var(--color-border)]"
            />
            <span>Coding 模式（仅影响代码类任务）</span>
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={largeProjectMode}
              onChange={(e) => {
                const checked = e.target.checked;
                setCodingMode(true);
                setLargeProjectMode(checked);
              }}
              className="rounded border-[var(--color-border)]"
            />
            <span>大项目策略（分阶段 + 提高预算）</span>
          </label>
        </div>
      )}

      <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-2">
        <div className="flex gap-2">
          <div className="flex flex-col gap-1 shrink-0">
            <AttachDropdown
              onFileClick={() => clusterFileInputRef.current?.click()}
              onFolderClick={handleFolderSelect}
              disabled={false}
              accent="accent"
            />
          </div>
          <div className="flex-1 flex flex-col gap-1.5">
            {attachments.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {attachments.map((a) => (
                  <div key={a.id} className="relative group shrink-0">
                    {a.type === "image" ? (
                      <>
                        <img
                          src={a.preview ?? ""}
                          alt={a.name}
                          className="w-12 h-12 object-cover rounded-lg border border-[var(--color-border)]"
                        />
                        <button
                          type="button"
                          onClick={() => removeAttachment(a.id)}
                          className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                        >
                          <X className="w-2 h-2" />
                        </button>
                      </>
                    ) : (
                      <div className="relative flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] max-w-[120px]">
                        <FileText className="w-3 h-3 text-[var(--color-text-tertiary)] shrink-0" />
                        <span className="text-[10px] truncate text-[var(--color-text-secondary)]" title={a.name}>{a.name}</span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(a.id)}
                          className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                        >
                          <X className="w-1.5 h-1.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <textarea
              className="flex-1 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] min-h-[2.5rem]"
              rows={2}
              maxLength={10000}
              placeholder={attachments.length > 0 ? "输入描述（可省略）..." : "输入复杂任务，Agent 集群将协作完成..."}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={false}
            />
          </div>
          <input
            ref={clusterFileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.yaml,.yml,.toml,.xml,.csv,.log,.js,.ts,.jsx,.tsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.swift,.kt,.rb,.php,.sh,.sql,.css,.html,.htm,.vue,.svelte"
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs flex-wrap">
            <span className="text-[var(--color-text-tertiary)]">模式:</span>
            <button
              type="button"
              className={`cursor-pointer px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
                mode === "parallel_split"
                  ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] border-[var(--color-accent)]/30 shadow-sm"
                  : "text-[var(--color-text-secondary)] border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-tertiary)]/30"
              }`}
              onClick={() => setMode("parallel_split")}
            >
              并行分治
            </button>
            <button
              type="button"
              className={`cursor-pointer px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
                mode === "multi_role"
                  ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)] border-[var(--color-accent)]/30 shadow-sm"
                  : "text-[var(--color-text-secondary)] border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-tertiary)]/30"
              }`}
              onClick={() => setMode("multi_role")}
            >
              多角色协作
            </button>
            {aiConfig.model && (
              <span className="text-[var(--color-text-tertiary)]">
                · {aiConfig.model}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {autoReview && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">
                Review
              </span>
            )}
            {humanApproval && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600">
                审批
              </span>
            )}
            {codingMode && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600">
                Coding
              </span>
            )}
            {codingMode && largeProjectMode && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-600">
                大项目
              </span>
            )}
          </div>
          <div className="flex-1" />
          {hasAnyRunning && (
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-500/10 text-red-600 rounded-lg hover:bg-red-500/20 transition-colors"
              onClick={handleAbort}
            >
              <Square className="w-3 h-3" />
              {currentSessionRunning ? "停止当前" : "停止最近"}
            </button>
          )}
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
            onClick={handleRun}
            disabled={(!input.trim() && attachments.length === 0) || runningCount >= MAX_ACTIVE_CLUSTER_TASKS}
            title={
              runningCount >= MAX_ACTIVE_CLUSTER_TASKS
                ? `最多同时运行 ${MAX_ACTIVE_CLUSTER_TASKS} 个集群任务`
                : undefined
            }
          >
            <Play className="w-3 h-3" />
            执行
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {sessions.length === 0 && (
          <div className="text-center text-[var(--color-text-secondary)] py-12">
            <Network className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p className="text-sm">Agent Cluster 多智能体协作</p>
            <p className="text-xs mt-1 opacity-60">
              输入复杂任务，多个 Agent 将并行/协作完成
            </p>
          </div>
        )}

        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            isActive={session.id === currentSessionId}
            onSelect={() => setCurrentSession(session.id)}
          />
        ))}
      </div>
    </div>
  );
}
