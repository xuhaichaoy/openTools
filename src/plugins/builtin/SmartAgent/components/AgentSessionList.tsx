import React, { useState, useRef, useEffect, useMemo, useDeferredValue, useCallback, memo } from "react";
import {
  Bot,
  PanelLeftClose,
  Search,
  Plus,
  Pencil,
  Check,
  X,
  Trash2,
} from "lucide-react";
import type { AgentTask } from "@/store/agent-store";

// 格式化时间的纯函数，提取到组件外避免重复创建
const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  if (isToday) return `今天 ${time}`;
  if (isYesterday) return `昨天 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
};

// Agent 会话列表项组件，使用 memo 避免不必要的重渲染
interface AgentSessionItemProps {
  session: {
    id: string;
    title: string;
    tasks: AgentTask[];
    createdAt: number;
    visibleTaskCount?: number;
    followUpQueue?: Array<unknown>;
    forkMeta?: { parentSessionId: string; parentVisibleTaskCount: number; createdAt: number };
    compaction?: {
      compactedTaskCount: number;
      preservedIdentifiers?: string[];
      bootstrapReinjectionPreview?: string[];
    };
  };
  isActive: boolean;
  isEditing: boolean;
  editTitle: string;
  onSelect: (id: string) => void;
  onStartRename: (id: string, title: string) => void;
  onConfirmRename: (id: string) => void;
  onCancelEdit: () => void;
  onEditTitleChange: (value: string) => void;
  onDelete: (id: string) => void;
  editInputRef: React.RefObject<HTMLInputElement | null>;
}

const AgentSessionItem = memo(function AgentSessionItem({
  session,
  isActive,
  isEditing,
  editTitle,
  onSelect,
  onStartRename,
  onConfirmRename,
  onCancelEdit,
  onEditTitleChange,
  onDelete,
  editInputRef,
}: AgentSessionItemProps) {
  // 使用 useMemo 缓存计算结果
  const lastTask = session.tasks[session.tasks.length - 1];
  const preview = lastTask?.answer?.slice(0, 60) || lastTask?.query?.slice(0, 60) || "空会话";
  const totalSteps = useMemo(
    () => session.tasks.reduce((sum, t) => sum + t.steps.length, 0),
    [session.tasks]
  );
  const visibleTaskCount =
    typeof session.visibleTaskCount === "number"
      ? Math.min(session.visibleTaskCount, session.tasks.length)
      : session.tasks.length;
  const hiddenTaskCount = Math.max(0, session.tasks.length - visibleTaskCount);
  const isCompleted = lastTask?.answer != null;
  const timeStr = formatTime(session.createdAt);

  return (
    <div
      className={`group relative rounded-xl px-3 py-2 cursor-pointer transition-all ${
        isActive
          ? "bg-emerald-500/10 border border-emerald-500/20"
          : "hover:bg-[var(--color-bg-hover)] border border-transparent"
      }`}
      onClick={() => !isEditing && onSelect(session.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div
              className="flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                ref={editInputRef}
                type="text"
                value={editTitle}
                onChange={(e) => onEditTitleChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onConfirmRename(session.id);
                  if (e.key === "Escape") onCancelEdit();
                }}
                className="flex-1 text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded px-1.5 py-0.5 outline-none border border-emerald-500/40"
              />
              <button
                onClick={() => onConfirmRename(session.id)}
                className="p-0.5 text-green-400 hover:text-green-300"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onCancelEdit}
                className="p-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="text-xs font-medium text-[var(--color-text)] truncate">
              {session.title || "新任务"}
            </div>
          )}
          {!isEditing && (
            <div className="text-[10px] text-[var(--color-text-secondary)] truncate mt-0.5">
              {preview}
            </div>
          )}
        </div>

        {!isEditing && (
          <div
            className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => onStartRename(session.id, session.title)}
              className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
              title="重命名"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={() => onDelete(session.id)}
              className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="删除"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {!isEditing && (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
            {timeStr}
          </span>
          <span className="text-[10px] text-[var(--color-text-secondary)] opacity-40">
            {visibleTaskCount} / {session.tasks.length} 个任务 · {totalSteps} 步
          </span>
          {hiddenTaskCount > 0 && (
            <span className="text-[10px] text-amber-600 opacity-70">
              +{hiddenTaskCount} 收起
            </span>
          )}
          {session.forkMeta && (
            <span className="text-[10px] text-sky-600 opacity-70">
              分支
            </span>
          )}
          {session.compaction?.compactedTaskCount ? (
            <span className="text-[10px] text-emerald-600 opacity-70">
              摘要 {session.compaction.compactedTaskCount}
            </span>
          ) : null}
          {session.compaction?.preservedIdentifiers?.length || session.compaction?.bootstrapReinjectionPreview?.length ? (
            <span className="text-[10px] text-teal-600 opacity-70">
              护栏
            </span>
          ) : null}
          {session.followUpQueue?.length ? (
            <span className="text-[10px] text-violet-600 opacity-70">
              跟进 {session.followUpQueue.length}
            </span>
          ) : null}
          {isCompleted && (
            <span className="text-[10px] text-emerald-500 opacity-60">
              已完成
            </span>
          )}
        </div>
      )}
    </div>
  );
});

interface AgentSessionListProps {
  sessions: Array<{
    id: string;
    title: string;
    tasks: AgentTask[];
    createdAt: number;
    visibleTaskCount?: number;
    followUpQueue?: Array<unknown>;
    forkMeta?: { parentSessionId: string; parentVisibleTaskCount: number; createdAt: number };
    compaction?: {
      compactedTaskCount: number;
      preservedIdentifiers?: string[];
      bootstrapReinjectionPreview?: string[];
    };
  }>;
  currentSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function AgentSessionList({
  sessions,
  currentSessionId,
  onSelect,
  onDelete,
  onDeleteAll,
  onRename,
  onNew,
  onClose,
}: AgentSessionListProps) {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<
    { type: "single"; id: string } | { type: "all" } | null
  >(null);
  const [visibleCount, setVisibleCount] = useState(10);
  const editInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 使用 useDeferredValue 实现搜索防抖，延迟更新过滤结果
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // 使用 useMemo 缓存过滤结果，只在 deferredSearch 或 sessions 变化时重新计算
  const filtered = useMemo(() => {
    if (!deferredSearch) return sessions;
    const q = deferredSearch.toLowerCase();
    return sessions.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      return s.tasks.some((t) => t.query.toLowerCase().includes(q));
    });
  }, [sessions, deferredSearch]);

  // 分页显示：只显示前 visibleCount 条
  const visibleSessions = useMemo(() => {
    return filtered.slice(0, visibleCount);
  }, [filtered, visibleCount]);

  // 监听滚动，接近底部时加载更多
  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = listEl;
      // 距离底部 200px 时加载更多
      if (scrollHeight - scrollTop - clientHeight < 200 && visibleCount < filtered.length) {
        setVisibleCount((prev) => Math.min(prev + 10, filtered.length));
      }
    };

    listEl.addEventListener("scroll", handleScroll);
    return () => listEl.removeEventListener("scroll", handleScroll);
  }, [filtered.length, visibleCount]);

  // 搜索时重置可见数量
  useEffect(() => {
    setVisibleCount(10);
  }, [deferredSearch]);

  // 使用 useCallback 缓存事件处理函数
  const handleStartRename = useCallback((id: string, title: string) => {
    setEditingId(id);
    setEditTitle(title);
  }, []);

  const handleConfirmRename = useCallback((id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed) onRename(id, trimmed);
    setEditingId(null);
  }, [editTitle, onRename]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleEditTitleChange = useCallback((value: string) => {
    setEditTitle(value);
  }, []);

  return (
    <div className="flex flex-col h-full relative">
      {/* 删除确认 */}
      {deleteConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 rounded-r-xl">
          <div className="w-[260px] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-xl p-4 mx-3">
            <p className="text-sm text-[var(--color-text)] mb-4">
              {deleteConfirm.type === "all"
                ? "确定删除全部历史会话？"
                : "确定删除这个会话？"}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (deleteConfirm.type === "all") {
                    onDeleteAll();
                  } else {
                    onDelete(deleteConfirm.id);
                  }
                  setDeleteConfirm(null);
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 顶部 */}
      <div className="px-3 pt-3 pb-2 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-colors"
              title="关闭"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold text-[var(--color-text)]">
              Agent 历史
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDeleteConfirm({ type: "all" })}
              disabled={sessions.length === 0}
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border border-red-500/25 text-red-500 hover:bg-red-500/10 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
              title="一键删除全部历史会话"
            >
              <Trash2 className="w-3 h-3" />
              清空
            </button>
            <button
              onClick={onNew}
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
            >
              <Plus className="w-3 h-3" />
              新任务
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索历史任务..."
            className="w-full text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded-lg pl-7 pr-2 py-1.5 outline-none border border-[var(--color-border)] focus:border-emerald-500/40 transition-colors"
          />
        </div>
      </div>

      {/* 列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-secondary)]">
            <Bot className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs opacity-60">
              {search ? "没有找到匹配的任务" : "暂无历史记录"}
            </p>
          </div>
        ) : (
          <>
            {visibleSessions.map((session) => (
              <AgentSessionItem
                key={session.id}
                session={session}
                isActive={session.id === currentSessionId}
                isEditing={editingId === session.id}
                editTitle={editTitle}
                onSelect={onSelect}
                onStartRename={handleStartRename}
                onConfirmRename={handleConfirmRename}
                onCancelEdit={handleCancelEdit}
                onEditTitleChange={handleEditTitleChange}
                onDelete={(id) => setDeleteConfirm({ type: "single", id })}
                editInputRef={editInputRef}
              />
            ))}
            {visibleCount < filtered.length && (
              <div className="text-center py-2 text-[10px] text-[var(--color-text-secondary)] opacity-60">
                已显示 {visibleCount} / {filtered.length} 条，继续滚动加载更多...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
