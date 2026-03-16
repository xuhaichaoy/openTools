import React from "react";
import type { AgentTask } from "@/store/agent-store";
import { AgentSessionList } from "./AgentSessionList";

interface AgentHistoryDrawerProps {
  visible: boolean;
  sessions: Array<{
    id: string;
    title: string;
    tasks: AgentTask[];
    createdAt: number;
    visibleTaskCount?: number;
    followUpQueue?: Array<unknown>;
    forkMeta?: { parentSessionId: string; parentVisibleTaskCount: number; createdAt: number };
    compaction?: { compactedTaskCount: number };
  }>;
  currentSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function AgentHistoryDrawer({
  visible,
  sessions,
  currentSessionId,
  onSelect,
  onDelete,
  onDeleteAll,
  onRename,
  onNew,
  onClose,
}: AgentHistoryDrawerProps) {
  if (!visible) return null;

  return (
    <>
      <div className="absolute inset-0 bg-black/20 z-20" onClick={onClose} />
      <div className="absolute left-0 top-0 bottom-0 w-[280px] bg-[var(--color-bg)] border-r border-[var(--color-border)] z-30 shadow-2xl animate-in slide-in-from-left duration-200">
        <AgentSessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelect={onSelect}
          onDelete={onDelete}
          onDeleteAll={onDeleteAll}
          onRename={onRename}
          onNew={onNew}
          onClose={onClose}
        />
      </div>
    </>
  );
}
