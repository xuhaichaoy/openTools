import React from "react";
import {
  buildAgentPromptContextReport,
  type AgentPromptContextSnapshot,
} from "../core/prompt-context";

const STORAGE_KEY = "mtools-agent-prompt-context-expanded";

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function AgentPromptContextCard({
  snapshot,
}: {
  snapshot: AgentPromptContextSnapshot;
}) {
  const [expanded, setExpanded] = React.useState(loadExpanded);
  const reportLines = React.useMemo(
    () => buildAgentPromptContextReport(snapshot),
    [snapshot],
  );

  const toggleExpanded = React.useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return (
    <div className="mx-4 mt-2 mb-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[12px] font-medium text-[var(--color-text)]">当前上下文</div>
        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700">
          {snapshot.runModeLabel}
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          文件 {snapshot.files.length}
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          记忆 {snapshot.memoryItemCount}
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          任务 {snapshot.review.visibleTaskCount}
        </span>
        <button
          type="button"
          onClick={toggleExpanded}
          className="ml-auto rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
        >
          {expanded ? "收起" : "展开"}
        </button>
      </div>

      <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
        模型这轮拿到的是同一份上下文快照，方便直接核对有没有被旧项目或旧任务污染。
      </div>

      {expanded && (
        <div className="mt-3 rounded-2xl border border-[var(--color-border)]/70 bg-[var(--color-bg)]/35 p-2">
          <div className="max-h-[min(42vh,28rem)] space-y-2 overflow-y-auto pr-1">
            {reportLines.map((line) => (
              <div
                key={line}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12px] leading-5 text-[var(--color-text)]"
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
