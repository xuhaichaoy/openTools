import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { Network, Loader2, X, Bot, MessageCircle, Users } from "lucide-react";
import { useClusterStore } from "@/store/cluster-store";
import { useAppStore } from "@/store/app-store";
import { useAgentStore } from "@/store/agent-store";
import { useAIStore } from "@/store/ai-store";
import { routeToAICenter } from "@/core/ai/ai-center-routing";
import {
  abortRuntimeSession,
  hasRuntimeAbortHandler,
  type RuntimeSessionMode,
  type RuntimeSessionRecord,
  useRuntimeStateStore,
} from "@/core/agent/context-runtime/runtime-state";
import {
  buildRuntimeIndicatorDetail,
  getRuntimeIndicatorMeta,
  shouldPulseRuntimeIndicator,
} from "@/core/agent/context-runtime/runtime-indicator";

const MODE_ORDER: RuntimeSessionMode[] = ["cluster", "agent", "dialog", "ask"];

const MODE_ICONS: Record<RuntimeSessionMode, ReactNode> = {
  ask: <MessageCircle className="w-3.5 h-3.5" />,
  agent: <Bot className="w-3.5 h-3.5" />,
  cluster: <Network className="w-3.5 h-3.5" />,
  dialog: <Users className="w-3.5 h-3.5" />,
};

function formatElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function pickVisibleRuntimeRecord(
  sessions: RuntimeSessionRecord[],
  foregroundSessionId?: string,
): RuntimeSessionRecord | null {
  if (sessions.length === 0) return null;
  if (foregroundSessionId) {
    const foreground = sessions.find((session) => session.sessionId === foregroundSessionId);
    if (foreground) return foreground;
  }
  return [...sessions].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

interface RuntimeIndicatorItem {
  key: string;
  mode: RuntimeSessionMode;
  sessionId: string;
  label: string;
  detail: string;
  elapsed?: string;
  onAbort?: () => void;
  onOpen: () => void;
  color: string;
  pulse: boolean;
}

export function ClusterFloatingIndicator() {
  const aiCenterMode = useAppStore((s) => s.aiCenterMode);
  const currentView = useAppStore((s) => s.currentView());
  const pushView = useAppStore((s) => s.pushView);
  const setClusterCurrentSession = useClusterStore((s) => s.setCurrentSession);
  const setAgentCurrentSession = useAgentStore((s) => s.setCurrentSession);
  const setAskCurrentConversation = useAIStore((s) => s.setCurrentConversation);
  const runtimeSessions = useRuntimeStateStore((s) => s.sessions);
  const foregroundSessionIds = useRuntimeStateStore((s) => s.foregroundSessionIds);
  const [now, setNow] = useState(() => Date.now());

  const openRuntimeSession = useCallback((mode: RuntimeSessionMode, sessionId: string) => {
    useRuntimeStateStore.getState().setForegroundSession(mode, sessionId);
    switch (mode) {
      case "ask":
        setAskCurrentConversation(sessionId);
        routeToAICenter({
          mode: "ask",
          source: "floating_indicator",
          taskId: sessionId,
          note: "resume ask runtime",
          pushView,
        });
        return;
      case "agent":
        setAgentCurrentSession(sessionId);
        routeToAICenter({
          mode: "agent",
          source: "floating_indicator",
          taskId: sessionId,
          note: "resume agent runtime",
          pushView,
        });
        return;
      case "cluster":
        setClusterCurrentSession(sessionId);
        routeToAICenter({
          mode: "cluster",
          source: "floating_indicator",
          taskId: sessionId,
          note: "resume cluster runtime",
          pushView,
        });
        return;
      case "dialog":
        routeToAICenter({
          mode: "dialog",
          source: "floating_indicator",
          taskId: sessionId,
          note: "resume dialog runtime",
          pushView,
        });
    }
  }, [pushView, setAgentCurrentSession, setAskCurrentConversation, setClusterCurrentSession]);

  const stopRuntimeSession = useCallback((mode: RuntimeSessionMode, sessionId: string) => {
    void abortRuntimeSession(mode, sessionId);
  }, []);

  const items = useMemo(() => {
    const sessions = Object.values(runtimeSessions);
    const nextItems: RuntimeIndicatorItem[] = [];

    for (const mode of MODE_ORDER) {
      const modeSessions = sessions
        .filter((session) => session.mode === mode)
        .sort((a, b) => b.startedAt - a.startedAt);
      const record = pickVisibleRuntimeRecord(modeSessions, foregroundSessionIds[mode]);
      if (!record) continue;

      const meta = getRuntimeIndicatorMeta(mode);
      nextItems.push({
        key: record.key,
        mode,
        sessionId: record.sessionId,
        label: meta.label,
        detail: buildRuntimeIndicatorDetail(record, modeSessions.length),
        elapsed: formatElapsed(Math.max(0, now - record.startedAt)),
        onAbort: hasRuntimeAbortHandler(mode, record.sessionId)
          ? () => stopRuntimeSession(mode, record.sessionId)
          : undefined,
        onOpen: () => openRuntimeSession(mode, record.sessionId),
        color: meta.color,
        pulse: shouldPulseRuntimeIndicator(record),
      });
    }

    return nextItems;
  }, [foregroundSessionIds, now, openRuntimeSession, runtimeSessions, stopRuntimeSession]);

  useEffect(() => {
    if (items.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [items.length]);

  const isOnManagementCenter = currentView === "management-center";
  const isOnAiCenter = currentView === "ai-center";
  if (isOnManagementCenter) return null;
  const visibleItems = items.filter((item) => {
    if (!isOnAiCenter) return true;
    return aiCenterMode !== item.mode;
  });

  if (visibleItems.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
      {visibleItems.map((item) => (
        <div
          key={item.key}
          role="button"
          tabIndex={0}
          className={`group flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-xs select-none transition-all hover:shadow-xl ${
            item.pulse ? "animate-pulse" : ""
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
            {item.pulse ? MODE_ICONS[item.mode] : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          </span>
          <span className="font-medium text-[var(--color-text-primary)]">{item.label}</span>
          <span className="text-[var(--color-text-secondary)] max-w-[200px] truncate">{item.detail}</span>
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
