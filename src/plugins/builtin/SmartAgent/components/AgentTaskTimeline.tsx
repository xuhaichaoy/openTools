import React from "react";
import { Bot } from "lucide-react";
import type { AgentTask } from "@/store/agent-store";
import type { RunningPhase } from "../core/ui-state";
import { AgentTaskBlock } from "./AgentTaskBlock";

interface AgentTaskTimelineProps {
  tasks: AgentTask[];
  busy: boolean;
  runningPhase: RunningPhase | null;
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
  scrollRef,
  collapsedTaskProcesses,
  expandedSteps,
  onToggleTaskProcess,
  onToggleStep,
}: AgentTaskTimelineProps) {
  return (
    <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
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
          processCollapsed={collapsedTaskProcesses.has(task.id)}
          onToggleProcess={() => onToggleTaskProcess(task.id)}
          expandedSteps={expandedSteps}
          onToggleStep={onToggleStep}
        />
      ))}
    </div>
  );
}
