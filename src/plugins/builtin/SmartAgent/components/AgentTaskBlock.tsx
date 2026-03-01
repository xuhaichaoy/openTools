import React, { useCallback, useState } from "react";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Brain,
  Wrench,
  Eye,
  MessageCircle,
  AlertCircle,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { AgentTask } from "@/store/agent-store";
import { ChatImage } from "@/components/ai/MessageBubble";
import {
  getExecutionWaitingStageLabel,
  type ExecutionWaitingStage,
} from "../core/ui-state";

// 代码块组件提取到渲染函数外，避免每次渲染创建新的组件引用
function CodeBlock({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"code">) {
  if (!className) {
    return (
      <code className="bg-(--color-code-bg)" {...props}>
        {children}
      </code>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

const MD_COMPONENTS = { code: CodeBlock };

/**
 * 流式渲染（不带语法高亮）与完成后渲染（带语法高亮）分离，
 * 并用 React.memo 避免内容未变时重复解析 Markdown。
 */
const MarkdownContent = React.memo(function MarkdownContent({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  if (isStreaming) {
    // 流式阶段跳过 rehypeHighlight（开销最大），避免每个 chunk 都做语法高亮
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    );
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={MD_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
});

const STEP_ICONS: Record<string, React.ReactNode> = {
  thought: <Brain className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />,
  action: <Wrench className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />,
  observation: <Eye className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />,
  answer: (
    <MessageCircle className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
  ),
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
  runningPhase?: "executing" | null;
  executionWaitingStage?: ExecutionWaitingStage | null;
  processCollapsed: boolean;
  /** 接受 taskId 参数，由外部传入稳定引用（避免内联箭头函数破坏 memo） */
  onToggleProcess: (taskId: string) => void;
  expandedSteps: Set<string>;
  onToggleStep: (key: string) => void;
}

function formatClock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function summarizeStepText(content: string, maxLen = 56) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function AgentTaskBlockInner({
  task,
  taskIdx,
  isLastTask,
  isRunning,
  runningPhase,
  executionWaitingStage,
  processCollapsed,
  onToggleProcess,
  expandedSteps,
  onToggleStep,
}: AgentTaskBlockProps) {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const isRunningTask = isRunning && isLastTask;
  // 稳定化 onToggleProcess 绑定，避免内联箭头函数破坏子组件 memo
  const handleToggleProcess = useCallback(
    () => onToggleProcess(task.id),
    [onToggleProcess, task.id],
  );
  const effectiveStatus =
    task.status || (isRunningTask ? "running" : task.answer ? "success" : "pending");
  const shouldCollapseProcess = processCollapsed && effectiveStatus !== "running";
  const lastStep = task.steps[task.steps.length - 1];

  const statusClassMap: Record<string, string> = {
    success: "text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]/75",
    running: "text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]/75",
    error: "text-red-500 bg-red-500/12",
    pending: "text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]/75",
    paused: "text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]/75",
    cancelled: "text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]/75",
  };
  const statusLabelMap: Record<string, string> = {
    success: "已完成",
    running: "执行中",
    error: "失败",
    pending: "待执行",
    paused: "已暂停",
    cancelled: "已取消",
  };

  return (
    <div className="space-y-1.5">
      <div className="rounded-lg bg-sky-500/[0.06] px-2.5 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-sky-700 font-semibold shrink-0">
            任务 {taskIdx + 1}
          </span>
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1 ${statusClassMap[effectiveStatus] || statusClassMap.pending}`}
          >
            {effectiveStatus === "running" && (
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
            )}
            {statusLabelMap[effectiveStatus] || "待执行"}
          </span>
          {lastStep && (
            <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto">
              {formatClock(lastStep.timestamp)}
            </span>
          )}
        </div>
        <p className="text-[15px] mt-1 leading-snug break-words text-[var(--color-text)]">
          {task.query}
        </p>
        {task.images && task.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {task.images.map((img) => (
              <ChatImage
                key={img}
                path={img}
                className="w-16 h-16 object-cover rounded-md border border-[var(--color-border)] cursor-pointer hover:opacity-80 transition-opacity"
                onClick={(blobUrl) => setPreviewImage(blobUrl)}
              />
            ))}
          </div>
        )}
      </div>

      {task.steps.length > 0 && effectiveStatus !== "running" && (
        <button
          onClick={handleToggleProcess}
          className="w-full rounded-md bg-[var(--color-bg-secondary)]/45 px-2 py-1 text-left flex items-center gap-2"
        >
          {shouldCollapseProcess ? (
            <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          )}
          <span className="text-xs font-medium text-[var(--color-text)]">执行过程</span>
          <span className="text-xs text-[var(--color-text-secondary)] ml-auto">
            {shouldCollapseProcess
              ? `已折叠 ${task.steps.length} 步`
              : `展开中 · ${task.steps.length} 步`}
          </span>
        </button>
      )}

      {task.steps.length > 0 && !shouldCollapseProcess && (
        <div className="space-y-1.5">
          {task.steps.map((step, stepIdx) => {
            const stepKey = `${task.id}-${stepIdx}`;
            const isError = step.type === "error";
            return (
              <div
                key={stepKey}
                className={`rounded-md transition-colors ${
                  isError
                    ? "bg-red-500/[0.06]"
                    : "bg-[var(--color-bg-secondary)]/55"
                }`}
              >
                <button
                  onClick={() => onToggleStep(stepKey)}
                  className="w-full flex items-center gap-2 p-1.5 text-left"
                >
                  {expandedSteps.has(stepKey) ? (
                    <ChevronDown className="w-3 h-3 shrink-0 text-[var(--color-text-secondary)]" />
                  ) : (
                    <ChevronRight className="w-3 h-3 shrink-0 text-[var(--color-text-secondary)]" />
                  )}
                  {STEP_ICONS[step.type]}
                  <span className="text-[12px] font-medium">{STEP_LABELS[step.type]}</span>
                  {step.toolName && (
                    <span className="text-[11px] text-[var(--color-text-secondary)] truncate">
                      → {step.toolName}
                    </span>
                  )}
                  <span className="text-[11px] text-[var(--color-text-secondary)] ml-auto shrink-0">
                    {formatClock(step.timestamp)}
                  </span>
                </button>
                {expandedSteps.has(stepKey) && (
                  <div className="px-2.5 pb-2 text-[12px] whitespace-pre-wrap break-words pt-1 mx-1.5 mb-1 border-t border-[var(--color-border)]/45">
                    {step.content}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {effectiveStatus === "running" && (
        <div className="rounded-md bg-[var(--color-bg-secondary)]/65 px-2 py-1 text-[var(--color-text-secondary)] space-y-0.5">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-secondary)]" />
            <span className="text-[12px]">
              Agent 执行中...
            </span>
          </div>
          {lastStep?.content && (
            <div className="text-[11px] text-[var(--color-text-secondary)] pl-6">
              最近进展：{STEP_LABELS[lastStep.type]} · {summarizeStepText(lastStep.content)}
            </div>
          )}
          {runningPhase === "executing" && executionWaitingStage && (
            <div className="text-[11px] text-[var(--color-text-secondary)] pl-6">
              当前正在等待：{getExecutionWaitingStageLabel(executionWaitingStage)}
            </div>
          )}
          <span className="sr-only">
            Agent 执行中...
          </span>
        </div>
      )}

      {task.answer && (
        <div className="rounded-lg bg-emerald-500/[0.08] px-2.5 py-2">
          <h4 className="text-[12px] font-semibold text-emerald-700 mb-1 flex items-center gap-1.5">
            {effectiveStatus === "running" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <MessageCircle className="w-4 h-4" />
            )}
            {effectiveStatus === "running" ? "回答（生成中）" : "回答"}
          </h4>
          <div className="text-[13px] leading-relaxed break-words [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:text-[17px] [&_h1]:font-semibold [&_h1]:my-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:my-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:my-1.5 [&_hr]:my-2 [&_hr]:border-[var(--color-border)] [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-emerald-500/35 [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-text-secondary)] [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-[var(--color-border)] [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-2 [&_td]:py-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-[var(--color-code-bg)] [&_pre]:p-2 [&_pre]:text-[12px] [&_code]:rounded [&_code]:bg-[var(--color-code-bg)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]">
            <MarkdownContent
              content={task.answer}
              isStreaming={effectiveStatus === "running"}
            />
            {effectiveStatus === "running" && (
              <span className="inline-block w-1.5 h-4 bg-emerald-600 animate-pulse ml-1 align-middle" />
            )}
          </div>
        </div>
      )}

      {!isLastTask && (
        <div className="border-t border-dashed border-[var(--color-border)]/70 my-1" />
      )}

      {previewImage && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out animate-in fade-in duration-200"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            alt="预览大图"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl animate-in zoom-in-95 duration-200"
          />
          <button
            className="absolute top-6 right-6 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors shadow-lg"
            onClick={() => setPreviewImage(null)}
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * React.memo 包裹：仅当 task 数据或直接影响渲染的 props 变化时才重渲染。
 * expandedSteps Set 每次 toggle 都换新引用，通过手动比较本 task 涉及的 key 来降低无效重渲染。
 */
export const AgentTaskBlock = React.memo(AgentTaskBlockInner, (prev, next) => {
  if (
    prev.taskIdx !== next.taskIdx ||
    prev.isLastTask !== next.isLastTask ||
    prev.isRunning !== next.isRunning ||
    prev.runningPhase !== next.runningPhase ||
    prev.executionWaitingStage !== next.executionWaitingStage ||
    prev.processCollapsed !== next.processCollapsed ||
    prev.onToggleProcess !== next.onToggleProcess ||
    prev.onToggleStep !== next.onToggleStep
  ) {
    return false; // 需要重渲染
  }
  // task 引用变了时，精确比较实际影响渲染的字段
  if (prev.task !== next.task) {
    if (
      prev.task.query !== next.task.query ||
      prev.task.answer !== next.task.answer ||
      prev.task.status !== next.task.status ||
      prev.task.steps.length !== next.task.steps.length ||
      prev.task.steps[prev.task.steps.length - 1]?.content !==
        next.task.steps[next.task.steps.length - 1]?.content
    ) {
      return false; // 需要重渲染
    }
  }
  // expandedSteps Set 换了引用，只检查本 task 相关的 key 是否变化
  if (prev.expandedSteps !== next.expandedSteps) {
    const stepCount = next.task.steps.length;
    for (let i = 0; i < stepCount; i++) {
      const key = `${next.task.id}-${i}`;
      if (prev.expandedSteps.has(key) !== next.expandedSteps.has(key)) {
        return false; // 需要重渲染
      }
    }
  }
  return true; // 无需重渲染
});
