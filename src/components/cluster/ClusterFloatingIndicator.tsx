import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Network, Loader2, X, Bot, MessageCircle } from "lucide-react";
import { useClusterStore } from "@/store/cluster-store";
import { useAppStore } from "@/store/app-store";
import { useAgentRunningStore } from "@/store/agent-running-store";
import { useAskUserStore } from "@/store/ask-user-store";
import {
  isClusterRunning,
  getActiveSessionIds,
  getActiveOrchestratorCount,
  abortActiveOrchestrator,
} from "@/core/agent/cluster/active-orchestrator";
import type { ClusterSessionStatus } from "@/core/agent/cluster/types";
import { routeToAICenter } from "@/core/ai/ai-center-routing";

const STATUS_LABELS: Record<ClusterSessionStatus, string> = {
  idle: "空闲",
  planning: "规划中",
  awaiting_approval: "等待审批",
  dispatching: "分发中",
  running: "执行中",
  aggregating: "汇总中",
  done: "已完成",
  error: "失败",
};

function formatElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export function ClusterFloatingIndicator() {
  const aiCenterMode = useAppStore((s) => s.aiCenterMode);
  const currentView = useAppStore((s) => s.currentView());
  const pushView = useAppStore((s) => s.pushView);
  const clusterSessions = useClusterStore((s) => s.sessions);
  const agentInfo = useAgentRunningStore((s) => s.info);
  const agentAbort = useAgentRunningStore((s) => s.abortFn);
  const askDialog = useAskUserStore((s) => s.dialog);
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const clusterRunning = isClusterRunning();
  const activeClusterSessionIds = getActiveSessionIds();
  const clusterRunningCount = getActiveOrchestratorCount();
  const activeClusterSessionId = activeClusterSessionIds[0] ?? null;
  const clusterSession = clusterSessions.find((s) => s.id === activeClusterSessionId);
  const clusterStatus = clusterSession?.status;

  const anyActive = clusterRunning || !!agentInfo;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  useEffect(() => {
    if (clusterRunning) {
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete("cluster");
        return next;
      });
    }
  }, [clusterRunning]);

  useEffect(() => {
    if (agentInfo) {
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete("agent");
        return next;
      });
    }
  }, [agentInfo]);

  const handleAbortCluster = useCallback(() => {
    void abortActiveOrchestrator(activeClusterSessionId ?? undefined);
  }, [activeClusterSessionId]);

  const handleAbortAgent = useCallback(() => {
    agentAbort?.();
  }, [agentAbort]);

  const handleOpenCluster = useCallback(() => {
    routeToAICenter({
      mode: "cluster",
      source: "floating_indicator",
      taskId: activeClusterSessionId ?? undefined,
      pushView,
    });
  }, [activeClusterSessionId, pushView]);

  const handleOpenAgent = useCallback(() => {
    routeToAICenter({
      mode: "agent",
      source: "floating_indicator",
      taskId: agentInfo?.sessionId,
      pushView,
    });
  }, [agentInfo?.sessionId, pushView]);

  const handleOpenAskSource = useCallback(() => {
    const sourceMode = askDialog?.source === "cluster" ? "cluster" : "agent";
    routeToAICenter({
      mode: sourceMode,
      source: "floating_indicator",
      pushView,
      note: "focus ask_user source",
    });
  }, [askDialog?.source, pushView]);

  const items: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    detail: string;
    elapsed?: string;
    onAbort?: () => void;
    onOpen: () => void;
    color: string;
  }> = [];

  if (clusterRunning && !dismissed.has("cluster")) {
    const elapsed = clusterSession?.createdAt
      ? formatElapsed(now - clusterSession.createdAt)
      : "";
    const effectiveStatus: ClusterSessionStatus = clusterStatus ?? "running";
    const detail = clusterRunningCount > 1
      ? `${STATUS_LABELS[effectiveStatus]} · ${clusterRunningCount} 个任务`
      : STATUS_LABELS[effectiveStatus] || effectiveStatus;

    items.push({
      key: "cluster",
      icon: <Network className="w-3.5 h-3.5" />,
      label: "集群任务",
      detail,
      elapsed,
      onAbort: handleAbortCluster,
      onOpen: handleOpenCluster,
      color: "var(--color-accent)",
    });
  }

  if (agentInfo && !dismissed.has("agent")) {
    const elapsed = formatElapsed(now - agentInfo.startedAt);
    const queryPreview = agentInfo.query.length > 30
      ? `${agentInfo.query.slice(0, 30)}…`
      : agentInfo.query;

    items.push({
      key: "agent",
      icon: <Bot className="w-3.5 h-3.5" />,
      label: "Agent 任务",
      detail: queryPreview || "执行中",
      elapsed,
      onAbort: handleAbortAgent,
      onOpen: handleOpenAgent,
      color: "#22c55e",
    });
  }

  if (askDialog && !dismissed.has("ask")) {
    const sourceLabel = askDialog.source === "cluster" ? "集群" : "Agent";
    items.push({
      key: "ask",
      icon: <MessageCircle className="w-3.5 h-3.5" />,
      label: `${sourceLabel} 等待回复`,
      detail: askDialog.questions[0]?.question || "请回答问题",
      onOpen: handleOpenAskSource,
      color: "#f59e0b",
    });
  }

  if (items.length === 0) return null;

  const isOnAiCenter = currentView === "ai-center";
  if (isOnAiCenter && items.length === 1) {
    const onlyItem = items[0];
    if (
      (onlyItem.key === "cluster" && aiCenterMode === "cluster") ||
      (onlyItem.key === "agent" && aiCenterMode === "agent") ||
      (onlyItem.key === "ask" && aiCenterMode === "ask")
    ) {
      return null;
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
      {items.map((item) => (
        <div
          key={item.key}
          role="button"
          tabIndex={0}
          className={`group flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-xs select-none transition-all hover:shadow-xl ${
            item.key === "ask" ? "animate-pulse" : ""
          }`}
          onClick={item.onOpen}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              item.onOpen();
            }
          }}
        >
          <span style={{ color: item.color }} className="flex items-center">
            {item.key === "ask" ? item.icon : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          </span>
          <span className="font-medium text-[var(--color-text-primary)]">{item.label}</span>
          <span className="text-[var(--color-text-secondary)] max-w-[180px] truncate">{item.detail}</span>
          {item.elapsed && (
            <span className="text-[var(--color-text-tertiary)] tabular-nums">{item.elapsed}</span>
          )}
          {item.onAbort && (
            <button
              type="button"
              className="ml-1 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
              title="终止"
              onClick={(e) => {
                e.stopPropagation();
                item.onAbort?.();
              }}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
