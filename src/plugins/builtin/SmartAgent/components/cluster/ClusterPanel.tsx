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
  XCircle,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useClusterStore, type ClusterSession } from "@/store/cluster-store";
import { ClusterOrchestrator } from "@/core/agent/cluster/cluster-orchestrator";
import {
  setActiveOrchestrator,
  getActiveOrchestrator,
  clearActiveOrchestrator,
  abortActiveOrchestrator,
  setClusterPanelVisible,
} from "@/core/agent/cluster/active-orchestrator";
import type {
  ClusterMode,
  ClusterSessionStatus,
  ClusterPlan,
  PlanApprovalRequest,
} from "@/core/agent/cluster/types";
import { ClusterPlanView } from "./ClusterPlanView";
import { ClusterDAGView } from "./ClusterDAGView";
import { AgentInstancePanel } from "./AgentInstancePanel";

const SETTINGS_KEY = "mtools-cluster-settings";

function loadSettings(): { autoReview: boolean; humanApproval: boolean } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { autoReview: false, humanApproval: false };
}

function saveSettings(s: { autoReview: boolean; humanApproval: boolean }) {
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

  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        isActive
          ? "border-[var(--color-accent)]/20 bg-[var(--color-accent)]/1"
          : "border-[var(--color-border)]"
      }`}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => {
          onSelect();
          setExpanded(!expanded);
        }}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] shrink-0" />
        )}
        <Network className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 text-left line-clamp-1 font-medium">
          {session.query.slice(0, 60)}
        </span>
        {session.mode && (
          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${
            session.mode === "parallel_split"
              ? "bg-blue-500/10 text-blue-500"
              : "bg-purple-500/10 text-purple-500"
          }`}>
            {session.mode === "parallel_split" ? "并行" : "协作"}
          </span>
        )}
        <SessionStatusBadge status={session.status} />
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] px-3 py-3 space-y-3">
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
              <div className="text-[10px] text-[var(--color-text-tertiary)] mb-1">
                最终结果
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none text-xs bg-[var(--color-bg-secondary)] rounded-lg p-3">
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
    </div>
  );
}

function PlanApprovalDialog({
  plan,
  onApprove,
  onReject,
}: {
  plan: ClusterPlan;
  onApprove: () => void;
  onReject: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onReject();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onApprove();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onApprove, onReject]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[var(--color-accent)]" />
            <h3 className="text-sm font-semibold">审批执行计划</h3>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            请确认以下计划是否可以执行（Esc 拒绝，⌘+Enter 批准）
          </p>
        </div>

        <div className="px-5 py-4 max-h-80 overflow-auto space-y-2">
          <div className="text-xs text-[var(--color-text-secondary)]">
            模式: {plan.mode === "multi_role" ? "多角色协作" : "并行分治"} · {plan.steps.length} 个步骤
          </div>
          {plan.steps.map((step) => (
            <div key={step.id} className="border border-[var(--color-border)] rounded-lg px-3 py-2 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-[var(--color-accent)]">{step.role}</span>
                <span className="text-[var(--color-text-tertiary)]">{step.id}</span>
                {step.reviewAfter && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">自动审查</span>
                )}
              </div>
              <p className="text-[var(--color-text-secondary)]">{step.task}</p>
              {step.dependencies.length > 0 && (
                <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1">
                  依赖: {step.dependencies.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">
          <button
            className="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
            onClick={onReject}
          >
            <XCircle className="w-3.5 h-3.5" />
            拒绝
          </button>
          <button
            className="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
            onClick={onApprove}
          >
            <CheckCircle className="w-3.5 h-3.5" />
            批准执行
          </button>
        </div>
      </div>
    </div>
  );
}

export function ClusterPanel() {
  const savedSettings = loadSettings();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ClusterMode>("parallel_split");
  const [busy, setBusy] = useState(() => !!getActiveOrchestrator());
  const [showSettings, setShowSettings] = useState(false);
  const [autoReview, setAutoReview] = useState(savedSettings.autoReview);
  const [humanApproval, setHumanApproval] = useState(savedSettings.humanApproval);
  const unmountedRef = useRef(false);

  const [approvalPlan, setApprovalPlan] = useState<ClusterPlan | null>(null);
  const approvalResolveRef = useRef<((result: PlanApprovalRequest) => void) | null>(null);

  const sessions = useClusterStore((s) => s.sessions);
  const currentSessionId = useClusterStore((s) => s.currentSessionId);
  const createSession = useClusterStore((s) => s.createSession);
  const setCurrentSession = useClusterStore((s) => s.setCurrentSession);
  const updateSession = useClusterStore((s) => s.updateSession);
  const updateInstance = useClusterStore((s) => s.updateInstance);
  const deleteAllSessions = useClusterStore((s) => s.deleteAllSessions);

  useEffect(() => {
    saveSettings({ autoReview, humanApproval });
  }, [autoReview, humanApproval]);

  useEffect(() => {
    unmountedRef.current = false;
    setClusterPanelVisible(true);

    const active = getActiveOrchestrator();
    if (active) {
      const { setCurrentSession: setSession } = useClusterStore.getState();
      setSession(active.sessionId);
    }

    const syncTimer = setInterval(() => {
      const running = !!getActiveOrchestrator();
      setBusy((prev) => (prev !== running ? running : prev));
    }, 500);

    return () => {
      unmountedRef.current = true;
      setClusterPanelVisible(false);
      clearInterval(syncTimer);
      if (approvalResolveRef.current) {
        approvalResolveRef.current({ plan: {} as ClusterPlan, status: "rejected" });
        approvalResolveRef.current = null;
      }
    };
  }, []);

  const handlePlanApproval = useCallback(
    (request: PlanApprovalRequest): Promise<PlanApprovalRequest> => {
      return new Promise((resolve) => {
        if (unmountedRef.current) {
          resolve({ plan: request.plan, status: "rejected" });
          return;
        }
        setApprovalPlan(request.plan);
        approvalResolveRef.current = resolve;
      });
    },
    [],
  );

  const handleApprove = useCallback(() => {
    if (approvalResolveRef.current && approvalPlan) {
      approvalResolveRef.current({ plan: approvalPlan, status: "approved" });
      approvalResolveRef.current = null;
      setApprovalPlan(null);
    }
  }, [approvalPlan]);

  const handleReject = useCallback(() => {
    if (approvalResolveRef.current && approvalPlan) {
      approvalResolveRef.current({ plan: approvalPlan, status: "rejected" });
      approvalResolveRef.current = null;
      setApprovalPlan(null);
    }
  }, [approvalPlan]);

  const confirmDangerousAction = useCallback(
    async (toolName: string, params: Record<string, unknown>): Promise<boolean> => {
      const message = `Agent 集群中的工具 "${toolName}" 需要确认执行。\n参数: ${JSON.stringify(params, null, 2).slice(0, 300)}`;
      return window.confirm(message);
    },
    [],
  );

  const askUser = useCallback(
    async (questions: import("@/plugins/builtin/SmartAgent/core/default-tools").AskUserQuestion[]) => {
      const answers: Record<string, string | string[]> = {};
      for (const q of questions) {
        const optionsHint = q.options?.length ? `\n选项: ${q.options.join(", ")}` : "";
        const result = window.prompt(`[Agent 集群提问]\n${q.question}${optionsHint}`);
        answers[q.question] = result ?? "";
      }
      return answers;
    },
    [],
  );

  const handleRun = useCallback(async () => {
    const query = input.trim();
    if (!query || busy) return;

    const sessionId = createSession(query, mode);
    setInput("");
    setBusy(true);

    const abortController = new AbortController();

    const orchestrator = new ClusterOrchestrator({
      maxConcurrency: 4,
      signal: abortController.signal,
      autoReviewCodeSteps: autoReview,
      maxReviewRetries: 2,
      confirmDangerousAction,
      askUser,
      onPlanApproval: humanApproval ? handlePlanApproval : undefined,
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

    setActiveOrchestrator(sessionId, orchestrator, abortController);

    try {
      const result = await orchestrator.execute(query, mode);
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
      clearActiveOrchestrator();
      if (!unmountedRef.current) setBusy(false);
    }
  }, [input, mode, busy, autoReview, humanApproval, createSession, handlePlanApproval, confirmDangerousAction, askUser]);

  const handleAbort = useCallback(() => {
    abortActiveOrchestrator();
    setBusy(false);
  }, []);

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
      {approvalPlan && (
        <PlanApprovalDialog
          plan={approvalPlan}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-medium">Agent Cluster</span>
          <span className="text-xs text-[var(--color-text-tertiary)]">
            ({sessions.length})
          </span>
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
              onClick={deleteAllSessions}
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
        </div>
      )}

      <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-2">
        <div className="flex gap-2">
          <textarea
            className="flex-1 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            rows={2}
            maxLength={10000}
            placeholder="输入复杂任务，Agent 集群将协作完成..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-[var(--color-text-tertiary)]">模式:</span>
            <button
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                mode === "parallel_split"
                  ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
              }`}
              onClick={() => setMode("parallel_split")}
            >
              并行分治
            </button>
            <button
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                mode === "multi_role"
                  ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
              }`}
              onClick={() => setMode("multi_role")}
            >
              多角色协作
            </button>
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
          </div>
          <div className="flex-1" />
          {busy ? (
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-500/10 text-red-600 rounded-lg hover:bg-red-500/20 transition-colors"
              onClick={handleAbort}
            >
              <Square className="w-3 h-3" />
              停止
            </button>
          ) : (
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
              onClick={handleRun}
              disabled={!input.trim()}
            >
              <Play className="w-3 h-3" />
              执行
            </button>
          )}
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
