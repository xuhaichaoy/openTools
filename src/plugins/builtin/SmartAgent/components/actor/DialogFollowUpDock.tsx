import React from "react";
import { Clock3, Play, Trash2 } from "lucide-react";
import type { DialogQueuedFollowUp } from "@/core/agent/actor/types";

interface DialogFollowUpDockProps {
  items: DialogQueuedFollowUp[];
  disabled?: boolean;
  onRunNext: () => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DialogFollowUpDock({
  items,
  disabled = false,
  onRunNext,
  onRemove,
  onClear,
}: DialogFollowUpDockProps) {
  if (items.length === 0) return null;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/45 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-700">
          <Clock3 className="h-3 w-3" />
          后续消息 {items.length}
        </span>
        <span className="text-[10px] text-[var(--color-text-secondary)]">
          当前房间还在处理上一轮协作，新消息会排队，等房间空下来后继续。
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={disabled}
            onClick={onRunNext}
            className="inline-flex items-center gap-1 rounded-full border border-cyan-500/25 px-2 py-1 text-[10px] text-cyan-700 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Play className="h-3 w-3" />
            立即继续
          </button>
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            清空
          </button>
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        {items.slice(0, 2).map((item, index) => (
          <div
            key={item.id}
            className="flex items-start gap-2 rounded-lg bg-[var(--color-bg)]/75 px-2.5 py-2"
          >
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text-secondary)]">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] leading-5 text-[var(--color-text)]">
                {item.displayText}
              </div>
              <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                入队于 {formatTime(item.createdAt)}
                {item.attachmentPaths?.length ? ` · ${item.attachmentPaths.length} 个附件` : ""}
                {item.images?.length ? ` · ${item.images.length} 张图片` : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="rounded-full p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-red-500"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {items.length > 2 && (
          <div className="text-[10px] text-[var(--color-text-secondary)]">
            还有 {items.length - 2} 条后续消息已排队。
          </div>
        )}
      </div>
    </div>
  );
}
