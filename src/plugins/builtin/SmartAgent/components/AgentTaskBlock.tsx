import React from "react";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Brain,
  Wrench,
  Eye,
  MessageCircle,
  AlertCircle,
} from "lucide-react";
import type { AgentStep } from "../core/react-agent";
import type { AgentTask } from "@/store/agent-store";

const STEP_ICONS: Record<string, React.ReactNode> = {
  thought: <Brain className="w-3.5 h-3.5 text-purple-500" />,
  action: <Wrench className="w-3.5 h-3.5 text-blue-500" />,
  observation: <Eye className="w-3.5 h-3.5 text-green-500" />,
  answer: <MessageCircle className="w-3.5 h-3.5 text-emerald-500" />,
  error: <AlertCircle className="w-3.5 h-3.5 text-red-500" />,
};

const STEP_LABELS: Record<string, string> = {
  thought: "思考",
  action: "操作",
  observation: "观察",
  answer: "回答",
  error: "错误",
};

interface AgentTaskBlockProps {
  task: AgentTask;
  taskIdx: number;
  isLastTask: boolean;
  isRunning: boolean;
  expandedSteps: Set<string>;
  onToggleStep: (key: string) => void;
}

export function AgentTaskBlock({
  task,
  taskIdx,
  isLastTask,
  isRunning,
  expandedSteps,
  onToggleStep,
}: AgentTaskBlockProps) {
  const isRunningTask = isRunning && isLastTask;

  return (
    <div className="space-y-2">
      {/* 任务标题 */}
      <div className="p-3 bg-indigo-500/5 border border-indigo-500/20 rounded-lg">
        <div className="flex items-center gap-2">
          <span className="text-xs text-indigo-500 font-medium shrink-0">
            任务 {taskIdx + 1}
          </span>
          {task.answer && !isRunningTask && (
            <span className="text-[10px] text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded-full shrink-0">
              ✓ 已完成
            </span>
          )}
          {isRunningTask && (
            <span className="text-[10px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0 flex items-center gap-1">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              执行中
            </span>
          )}
        </div>
        <p className="text-sm mt-1">{task.query}</p>
      </div>

      {/* 步骤 */}
      {task.steps.map((step, stepIdx) => {
        const stepKey = `${taskIdx}-${stepIdx}`;
        return (
          <div
            key={stepKey}
            className={`rounded-lg border transition-colors ${
              step.type === "answer"
                ? "border-emerald-500/30 bg-emerald-500/5"
                : step.type === "error"
                  ? "border-red-500/30 bg-red-500/5"
                  : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
            }`}
          >
            <button
              onClick={() => onToggleStep(stepKey)}
              className="w-full flex items-center gap-2 p-2 text-left"
            >
              {expandedSteps.has(stepKey) ? (
                <ChevronDown className="w-3 h-3 shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 shrink-0" />
              )}
              {STEP_ICONS[step.type]}
              <span className="text-xs font-medium">
                {STEP_LABELS[step.type]}
              </span>
              {step.toolName && (
                <span className="text-xs text-[var(--color-text-secondary)]">
                  → {step.toolName}
                </span>
              )}
              <span className="text-xs text-[var(--color-text-secondary)] ml-auto">
                {new Date(step.timestamp).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </button>
            {expandedSteps.has(stepKey) && (
              <div className="px-3 pb-2 text-sm whitespace-pre-wrap border-t border-[var(--color-border)] pt-2 mx-2 mb-2">
                {step.content}
              </div>
            )}
          </div>
        );
      })}

      {/* 正在运行动画 */}
      {isRunningTask && (
        <div className="flex items-center gap-2 p-3 text-[var(--color-text-secondary)]">
          <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
          <span className="text-sm">Agent 思考中...</span>
        </div>
      )}

      {/* 任务回答 */}
      {task.answer && !isRunningTask && (
        <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
          <h4 className="text-sm font-medium text-emerald-600 mb-2 flex items-center gap-1.5">
            <MessageCircle className="w-4 h-4" />
            回答
          </h4>
          <div className="text-sm leading-relaxed whitespace-pre-wrap">
            {task.answer}
          </div>
        </div>
      )}

      {/* 任务间分割线 */}
      {!isLastTask && (
        <div className="border-t border-dashed border-[var(--color-border)] my-2" />
      )}
    </div>
  );
}
