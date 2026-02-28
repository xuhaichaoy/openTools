import { useState, useEffect } from "react";
import { Network, Loader2, X } from "lucide-react";
import { useClusterStore } from "@/store/cluster-store";
import { useAppStore } from "@/store/app-store";
import {
  isClusterRunning,
  getActiveSessionId,
  abortActiveOrchestrator,
} from "@/core/agent/cluster/active-orchestrator";
import type { ClusterSessionStatus } from "@/core/agent/cluster/types";

const STATUS_LABELS: Partial<Record<ClusterSessionStatus, string>> = {
  planning: "规划中",
  awaiting_approval: "待审批",
  dispatching: "分发中",
  running: "执行中",
  aggregating: "汇总中",
};

export function ClusterFloatingIndicator() {
  const activeSessionId = getActiveSessionId();
  const session = useClusterStore((s) =>
    s.sessions.find((sess) => sess.id === activeSessionId),
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const running = isClusterRunning();
  if (!running || !session) return null;

  const elapsed = Math.floor((Date.now() - session.createdAt) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
  void tick;

  const doneCount = session.instances.filter(
    (i) => i.status === "done" || i.status === "error",
  ).length;
  const totalCount = session.instances.length;
  const statusText = STATUS_LABELS[session.status] ?? session.status;

  const handleNavigate = () => {
    useAppStore.getState().setAiCenterMode("cluster");
    useAppStore.getState().pushView("ai-center");
  };

  const handleAbort = (e: React.MouseEvent) => {
    e.stopPropagation();
    abortActiveOrchestrator();
  };

  return (
    <div className="fixed bottom-4 right-4 z-[9998] animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div
        className="flex items-center gap-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl px-3 py-2 shadow-lg backdrop-blur-sm cursor-pointer hover:border-cyan-500/50 transition-colors group"
        onClick={handleNavigate}
        title="返回 Agent 集群"
      >
        <div className="relative">
          <Network className="w-4 h-4 text-cyan-500" />
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
        </div>

        <div className="flex flex-col gap-0">
          <span className="text-[11px] font-medium text-[var(--color-text)] leading-tight">
            集群 {statusText}
          </span>
          <span className="text-[10px] text-[var(--color-text-secondary)] leading-tight">
            {totalCount > 0 ? `${doneCount}/${totalCount} Agent` : ""} · {timeStr}
          </span>
        </div>

        <Loader2 className="w-3.5 h-3.5 text-cyan-500 animate-spin ml-0.5" />

        <button
          className="ml-1 p-0.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
          title="终止集群"
          onClick={handleAbort}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
