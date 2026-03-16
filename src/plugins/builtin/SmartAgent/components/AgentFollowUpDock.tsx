import React from "react";
import { Clock3, Play, Trash2 } from "lucide-react";
import type { AgentQueuedFollowUp } from "@/store/agent-store";

interface AgentFollowUpDockProps {
  items: AgentQueuedFollowUp[];
  running: boolean;
  onRunNext: () => void;
  onRemove: (followUpId: string) => void;
  onClear: () => void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AgentFollowUpDock({
  items,
  running,
  onRunNext,
  onRemove,
  onClear,
}: AgentFollowUpDockProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mx-4 mb-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600">
          <Clock3 className="h-3 w-3" />
          后续跟进 {items.length}
        </div>
        <p className="text-[11px] text-[var(--color-text-secondary)]">
          {running
            ? "当前任务完成后会自动继续第一条跟进；若本轮失败，队列会保留等待手动继续。"
            : "当前空闲，可以立即继续下一条跟进。"}
        </p>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onRunNext}
            disabled={running}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 px-2 py-1 text-[11px] text-emerald-600 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Play className="h-3 w-3" />
            立即执行
          </button>
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            清空
          </button>
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        {items.slice(0, 3).map((item, index) => (
          <div
            key={item.id}
            className="flex items-start gap-2 rounded-xl bg-[var(--color-bg)]/70 px-2.5 py-2"
          >
            <div className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text-secondary)]">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] leading-5 text-[var(--color-text)]">
                {item.query}
              </div>
              <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                入队于 {formatTime(item.createdAt)}
                {item.attachmentPaths?.length
                  ? ` · ${item.attachmentPaths.length} 个工作集文件`
                  : ""}
                {item.images?.length
                  ? ` · ${item.images.length} 张图片`
                  : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="rounded-full p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-red-500"
              title="移除该跟进"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {items.length > 3 && (
          <div className="text-[10px] text-[var(--color-text-secondary)]">
            还有 {items.length - 3} 条跟进已排队，等待继续处理。
          </div>
        )}
      </div>
    </div>
  );
}
