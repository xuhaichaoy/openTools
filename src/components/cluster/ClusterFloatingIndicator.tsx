import { useState, useEffect, useCallback } from "react";
import { Network, Loader2, X, Bot, MessageCircle } from "lucide-react";
import { useClusterStore } from "@/store/cluster-store";
import { useAppStore } from "@/store/app-store";
import { useAgentRunningStore } from "@/store/agent-running-store";
import { useAskUserStore } from "@/store/ask-user-store";
import {
  isClusterRunning,
  getActiveSessionId,
  abortActiveOrchestrator,
} from "@/core/agent/cluster/active-orchestrator";
import type { ClusterSessionStatus } from "@/core/agent/cluster/cluster-types";

const STATUS_LABELS: Record<ClusterSessionStatus, string> = {
  idle: "空闲",
  planning: "规划中",
  executing: "执行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
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
  const clusterSessions = useClusterStore((s) => s.sessions);
  const agentInfo = useAgentRunningStore((s) => s.info);
  const agentAbort = useAgentRunningStore((s) => s.abortFn);
  const askDialog = useAskUserStore((s) => s.dialog);
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const clusterRunning = isClusterRunning();
  const clusterSessionId = getActiveSessionId();
  const clusterSession = clusterSessions.find((s) => s.id === clusterSessionId);
  const clusterStatus = clusterSession?.status;

  // Tick timer for elapsed time
  const anyActive = clusterRunning || !!agentInfo;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  // Reset dismissed when new tasks start
  useEffect(() => {
    if (clusterRunning) setDismissed((p) => { const n = new Set(p); n.delete("cluster"); return n; });
  }, [clusterRunning]);
  useEffect(() => {
    if (agentInfo) setDismissed((p) => { const n = new Set(p); n.delete("agent"); return n; });
  }, [agentInfo]);

  const handleAbortCluster = useCallback(() => {
    abortActiveOrchestrator();
  }, []);

  const handleAbortAgent = useCallback(() => {
    agentAbort?.();
  }, [agentAbort]);

  // Build items to show
  const items: Array<{
    key: string;
    icon: React.ReactNode;
    label: string;
    detail: string;
    elapsed?: string;
    onAbort?: () => void;
    color: string;
  }> = [];

  // Cluster indicator
  if (clusterRunning && clusterStatus && !dismissed.has("cluster")) {
    const elapsed = clusterSession?.startedAt
      ? formatElapsed(now - clusterSession.startedAt)
      : "";
    items.push({
      key: "cluster",
      icon: <Network className="w-3.5 h-3.5" />,
      label: "集群任务",
      detail: STATUS_LABELS[clusterStatus] || clusterStatus,
      elapsed,
      onAbort: handleAbortCluster,
      color: "var(--color-accent)",
    });
  }

  // Agent indicator
  if (agentInfo && !dismissed.has("agent")) {
    const elapsed = formatElapsed(now - agentInfo.startedAt);
    const queryPreview = agentInfo.query.length > 30
      ? agentInfo.query.slice(0, 30) + "…"
      : agentInfo.query;
    items.push({
      key: "agent",
      icon: <Bot className="w-3.5 h-3.5" />,
      label: "Agent 任务",
      detail: queryPreview || "执行中",
      elapsed,
      onAbort: handleAbortAgent,
      color: "#22c55e",
    });
  }

  // Ask user indicator (blinking attention)
  if (askDialog && !dismissed.has("ask")) {
    const sourceLabel = askDialog.source === "cluster" ? "集群" : askDialog.source === "agent" ? "Agent" : "Ask";
    items.push({
      key: "ask",
      icon: <MessageCircle className="w-3.5 h-3.5" />,
      label: `${sourceLabel} 等待回复`,
      detail: askDialog.questions[0]?.label || "请回答问题",
      color: "#f59e0b",
    });
  }

  if (items.length === 0) return null;

  // Don't show if user is already viewing the corresponding AI Center tab
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
          className={`group flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-xs cursor-default select-none transition-all hover:shadow-xl ${
            item.key === "ask" ? "animate-pulse" : ""
          }`}
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
              className="ml-1 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
              title="终止"
              onClick={item.onAbort}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
