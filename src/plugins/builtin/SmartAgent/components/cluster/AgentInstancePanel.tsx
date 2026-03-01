import React, { useState, useMemo } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Search,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentInstance } from "@/core/agent/cluster/types";

interface AgentInstancePanelProps {
  instances: AgentInstance[];
}

const ROLE_LABELS: Record<string, string> = {
  planner: "规划者",
  researcher: "研究员",
  coder: "编码者",
  reviewer: "审查者",
  executor: "执行者",
};

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "done":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600">
          <CheckCircle2 className="w-3 h-3" />
          完成
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-600">
          <XCircle className="w-3 h-3" />
          错误
        </span>
      );
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600">
          <Loader2 className="w-3 h-3 animate-spin" />
          运行中
        </span>
      );
    case "reviewing":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600">
          <Search className="w-3 h-3" />
          审查中
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-500/10 text-[var(--color-text-tertiary)]">
          <Clock className="w-3 h-3" />
          等待
        </span>
      );
  }
}

function StepsList({ steps }: { steps: AgentInstance["steps"] }) {
  const displaySteps = useMemo(() => dedupeStreamingSteps(steps).slice(-10), [steps]);
  const totalDeduped = useMemo(() => dedupeStreamingSteps(steps).length, [steps]);

  return (
    <div className="space-y-1">
      <div className="text-[var(--color-text-tertiary)] text-[10px]">
        执行步骤 ({totalDeduped})
      </div>
      <div className="max-h-40 overflow-auto space-y-0.5">
        {displaySteps.map((step, i) => (
          <div
            key={i}
            className="flex items-start gap-1.5 text-[11px] text-[var(--color-text-secondary)]"
          >
            <span className="shrink-0 text-[var(--color-text-tertiary)] w-[72px] text-right">
              {step.type}
            </span>
            <span className="line-clamp-2 min-w-0" title={step.toolName ? `${step.toolName}: ${step.content}` : step.content}>
              {step.toolName
                ? `${step.toolName}: ${step.content}`
                : step.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function dedupeStreamingSteps(steps: AgentInstance["steps"]): AgentInstance["steps"] {
  const result: AgentInstance["steps"] = [];
  for (const step of steps) {
    if (step.streaming && result.length > 0) {
      const prev = result[result.length - 1];
      if (prev.streaming && prev.type === step.type) {
        result[result.length - 1] = step;
        continue;
      }
    }
    result.push(step);
  }
  return result;
}

function InstanceCard({ instance }: { instance: AgentInstance }) {
  const [expanded, setExpanded] = useState(false);
  const roleName = ROLE_LABELS[instance.role.id] ?? instance.role.name;
  const durationMs =
    instance.finishedAt && instance.startedAt
      ? instance.finishedAt - instance.startedAt
      : null;

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] shrink-0" />
        )}
        <Bot className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">{roleName}</span>
        {instance.stepId && (
          <span className="text-[var(--color-text-tertiary)]">
            ({instance.stepId})
          </span>
        )}
        <div className="flex-1" />
        {(instance.reviewCount ?? 0) > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">
            Review x{instance.reviewCount}
          </span>
        )}
        <StatusBadge status={instance.status} />
        {durationMs !== null && (
          <span className="text-[10px] text-[var(--color-text-tertiary)]">
            {durationMs < 1000
              ? `${durationMs}ms`
              : `${(durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] px-3 py-3 text-xs space-y-3">
          {instance.error && (
            <div className="text-red-500 bg-red-500/5 px-2 py-1 rounded text-[11px]">
              {instance.error}
            </div>
          )}

          {instance.result && (
            <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed prose-p:my-2 prose-headings:mt-3 prose-headings:mb-1.5 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-table:my-2 prose-td:py-1.5 prose-th:py-1.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {instance.result.length > 1000
                  ? instance.result.slice(0, 1000) + "\n\n...（已截断）"
                  : instance.result}
              </ReactMarkdown>
            </div>
          )}

          {instance.steps.length > 0 && (
            <StepsList steps={instance.steps} />
          )}

          {!instance.error && !instance.result && instance.steps.length === 0 && (
              <div className="text-[var(--color-text-tertiary)] text-[11px]">
                暂无输出
              </div>
            )}
        </div>
      )}
    </div>
  );
}

export function AgentInstancePanel({ instances }: AgentInstancePanelProps) {
  if (instances.length === 0) {
    return (
      <div className="text-center text-[var(--color-text-tertiary)] py-6 text-xs">
        尚无 Agent 实例
      </div>
    );
  }

  const running = instances.filter((i) => i.status === "running").length;
  const reviewing = instances.filter((i) => i.status === "reviewing").length;
  const done = instances.filter((i) => i.status === "done").length;
  const errored = instances.filter((i) => i.status === "error").length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs text-[var(--color-text-secondary)]">
        <span>Agent 实例: {instances.length}</span>
        {running > 0 && (
          <span className="text-blue-500">运行中: {running}</span>
        )}
        {reviewing > 0 && (
          <span className="text-amber-500">审查中: {reviewing}</span>
        )}
        {done > 0 && <span className="text-green-500">完成: {done}</span>}
        {errored > 0 && <span className="text-red-500">错误: {errored}</span>}
      </div>

      <div className="space-y-2">
        {instances.map((inst) => (
          <InstanceCard key={inst.id} instance={inst} />
        ))}
      </div>
    </div>
  );
}
