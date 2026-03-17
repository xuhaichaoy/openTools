import React, { useState, useEffect, useCallback } from "react";
import { Bot, ArrowDown } from "lucide-react";
import type { AgentTask } from "@/store/agent-store";
import type { ExecutionWaitingStage, RunningPhase } from "../core/ui-state";
import { AgentTaskBlock } from "./AgentTaskBlock";

interface AgentTaskTimelineProps {
  tasks: AgentTask[];
  busy: boolean;
  runningPhase: RunningPhase | null;
  executionWaitingStage: ExecutionWaitingStage | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  collapsedTaskProcesses: Set<string>;
  expandedSteps: Set<string>;
  onToggleTaskProcess: (taskId: string) => void;
  onToggleStep: (key: string) => void;
}

export function AgentTaskTimeline({
  tasks,
  busy,
  runningPhase,
  executionWaitingStage,
  scrollRef,
  collapsedTaskProcesses,
  expandedSteps,
  onToggleTaskProcess,
  onToggleStep,
}: AgentTaskTimelineProps) {
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollBtn(distanceFromBottom > 200);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [scrollRef]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [scrollRef]);

  return (
    <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.04),_transparent_34%)] px-4 py-3 space-y-3">
      {tasks.length === 0 && !busy && (
        <div className="text-center text-[var(--color-text-secondary)] py-12">
          <Bot className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm">输入问题或任务，Agent 会自主思考并调用工具</p>
          <p className="text-xs mt-1 opacity-60">思考 → 行动 → 观察 → 回答</p>
        </div>
      )}

      {tasks.map((task, taskIdx) => (
        <AgentTaskBlock
          key={task.id}
          task={task}
          taskIdx={taskIdx}
          isLastTask={taskIdx === tasks.length - 1}
          isRunning={busy}
          runningPhase={runningPhase}
          executionWaitingStage={executionWaitingStage}
          processCollapsed={collapsedTaskProcesses.has(task.id)}
          onToggleProcess={onToggleTaskProcess}
          expandedSteps={expandedSteps}
          onToggleStep={onToggleStep}
        />
      ))}

      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="sticky bottom-2 left-1/2 -translate-x-1/2 w-7 h-7 rounded-full bg-[var(--color-bg)]/60 border border-[var(--color-border)]/40 shadow-sm flex items-center justify-center text-[var(--color-text-secondary)]/50 hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]/80 transition-all z-10 backdrop-blur-sm"
          title="滚动到底部"
        >
          <ArrowDown className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
