import React, { useState, useRef, useEffect } from "react";
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

interface AgentSessionListProps {
  sessions: Array<{
    id: string;
    title: string;
    tasks: AgentTask[];
    createdAt: number;
  }>;
  currentSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function AgentSessionList({
  sessions,
  currentSessionId,
  onSelect,
  onDelete,
  onRename,
  onNew,
  onClose,
}: AgentSessionListProps) {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const filtered = sessions.filter((s) => {
    const q = search.toLowerCase();
    if (s.title.toLowerCase().includes(q)) return true;
    return s.tasks.some((t) => t.query.toLowerCase().includes(q));
  });

  const handleConfirmRename = (id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed) onRename(id, trimmed);
    setEditingId(null);
  };

  const formatTime = (ts: number) => {
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

  return (
    <div className="flex flex-col h-full relative">
      {/* 删除确认 */}
      {deleteConfirmId && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 rounded-r-xl">
          <div className="w-[260px] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-xl p-4 mx-3">
            <p className="text-sm text-[var(--color-text)] mb-4">
              确定删除这个会话？
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onDelete(deleteConfirmId);
                  setDeleteConfirmId(null);
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
          <button
            onClick={onNew}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
          >
            <Plus className="w-3 h-3" />
            新任务
          </button>
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
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-secondary)]">
            <Bot className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs opacity-60">
              {search ? "没有找到匹配的任务" : "暂无历史记录"}
            </p>
          </div>
        ) : (
          filtered.map((session) => {
            const isActive = session.id === currentSessionId;
            const isEditing = editingId === session.id;
            const lastTask = session.tasks[session.tasks.length - 1];
            const preview =
              lastTask?.answer?.slice(0, 60) ||
              lastTask?.query?.slice(0, 60) ||
              "空会话";
            const totalSteps = session.tasks.reduce(
              (sum, t) => sum + t.steps.length,
              0,
            );
            const isCompleted = lastTask?.answer != null;

            return (
              <div
                key={session.id}
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
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              handleConfirmRename(session.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="flex-1 text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded px-1.5 py-0.5 outline-none border border-emerald-500/40"
                        />
                        <button
                          onClick={() => handleConfirmRename(session.id)}
                          className="p-0.5 text-green-400 hover:text-green-300"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
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
                        onClick={() => {
                          setEditingId(session.id);
                          setEditTitle(session.title);
                        }}
                        className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                        title="重命名"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(session.id)}
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
                      {formatTime(session.createdAt)}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-secondary)] opacity-40">
                      {session.tasks.length} 个任务 · {totalSteps} 步
                    </span>
                    {isCompleted && (
                      <span className="text-[10px] text-emerald-500 opacity-60">
                        已完成
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
