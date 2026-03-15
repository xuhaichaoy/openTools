import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  useClipboardStore,
  startClipboardListener,
  stopClipboardListener,
  type ClipboardEntry,
} from "@/store/clipboard-store";
import {
  ArrowLeft,
  Search,
  Trash2,
  Copy,
  CheckCircle,
  Clock,
  XCircle,
} from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";

/* ────────── 时间格式化 ────────── */
function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ────────── 单条条目 ────────── */
function EntryCard({
  entry,
  onCopy,
  onDelete,
}: {
  entry: ClipboardEntry;
  onCopy: (content: string) => void;
  onDelete: (id: number) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy(entry.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group relative rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2.5 hover:border-cyan-400/40 transition-colors">
      {/* 内容预览 */}
      <div
        className="text-sm text-[var(--color-text)] leading-relaxed whitespace-pre-wrap break-all line-clamp-3 cursor-pointer select-none"
        onClick={handleCopy}
        title="点击复制"
      >
        {entry.preview}
      </div>

      {/* 底部：时间 + 操作 */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] text-[var(--color-text-secondary)] flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {timeAgo(entry.timestamp)}
        </span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            title="复制"
          >
            {copied ? (
              <CheckCircle className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={() => onDelete(entry.id)}
            className="p-1 rounded hover:bg-red-500/10 text-[var(--color-text-secondary)] hover:text-red-500 transition-colors"
            title="删除"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────── 主组件 ────────── */
export default function ClipboardHistoryPlugin({ onBack }: { onBack?: () => void }) {
  const { entries, search, loading, setSearch, load, deleteEntry, clearAll, writeToClipboard } =
    useClipboardStore();
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { onMouseDown } = useDragWindow();

  // 首次加载 + 启动监听
  useEffect(() => {
    void load();
    startClipboardListener();
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      stopClipboardListener();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 搜索防抖
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setSearch(val);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        void load(val);
      }, 300);
    },
    [setSearch, load]
  );

  const handleCopy = useCallback(
    (content: string) => {
      writeToClipboard(content);
    },
    [writeToClipboard]
  );

  const handleClearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    clearAll();
    setConfirmClear(false);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* 头部 */}
      <div
        className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-[var(--color-text)]">剪贴板历史</span>
      </div>

      {/* 搜索 + 清空 */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-secondary)]" />
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索剪贴板内容..."
            value={search}
            onChange={handleSearchChange}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:border-cyan-400/50"
          />
          {search && (
            <button
              onClick={() => {
                if (debounceRef.current) {
                  clearTimeout(debounceRef.current);
                }
                setSearch("");
                void load("");
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              <XCircle className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          onClick={handleClearAll}
          className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
            confirmClear
              ? "border-red-500/50 bg-red-500/10 text-red-500 hover:bg-red-500/20"
              : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
          }`}
        >
          {confirmClear ? "确认清空" : "清空"}
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-4 pb-3 space-y-2">
        {loading && entries.length === 0 ? (
          <div className="text-center text-sm text-[var(--color-text-secondary)] py-10">加载中...</div>
        ) : entries.length === 0 ? (
          <div className="text-center py-10">
            <Copy className="w-10 h-10 mx-auto text-[var(--color-text-secondary)] opacity-30 mb-3" />
            <p className="text-sm text-[var(--color-text-secondary)]">
              {search ? "没有匹配的记录" : "暂无剪贴板历史"}
            </p>
            <p className="text-xs text-[var(--color-text-secondary)] opacity-60 mt-1">复制内容后会自动记录</p>
          </div>
        ) : (
          entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              onCopy={handleCopy}
              onDelete={deleteEntry}
            />
          ))
        )}
      </div>

      {/* Footer */}
      {entries.length > 0 && (
        <div className="px-4 py-2 border-t border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] text-center">
          共 {entries.length} 条记录 · 点击条目即可复制
        </div>
      )}
    </div>
  );
}
