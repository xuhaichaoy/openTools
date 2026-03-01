import React, { useState, useRef, useEffect, useMemo, useDeferredValue, useCallback, memo } from "react";
import {
  MessageSquare,
  Trash2,
  Pencil,
  Check,
  X,
  Search,
  Plus,
  PanelLeftClose,
} from "lucide-react";
import { useAIStore } from "@/store/ai-store";

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

// 对话列表项组件，使用 memo 避免不必要的重渲染
interface ConversationItemProps {
  conv: {
    id: string;
    title: string;
    messages: Array<{ role: string; content: string }>;
    createdAt: number;
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

const ConversationItem = memo(function ConversationItem({
  conv,
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
}: ConversationItemProps) {
  const lastMsg = conv.messages.filter(m => m.role !== 'system').slice(-1)[0];
  const preview = lastMsg?.content?.slice(0, 60) || "空对话";
  const messageCount = conv.messages.filter(m => m.role !== 'system').length;
  const timeStr = formatTime(conv.createdAt);

  return (
    <div
      className={`group relative rounded-xl px-3 py-2 cursor-pointer transition-all ${
        isActive
          ? "bg-indigo-500/10 border border-indigo-500/20"
          : "hover:bg-[var(--color-bg-hover)] border border-transparent"
      }`}
      onClick={() => !isEditing && onSelect(conv.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <input
                ref={editInputRef}
                type="text"
                value={editTitle}
                onChange={(e) => onEditTitleChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onConfirmRename(conv.id);
                  if (e.key === "Escape") onCancelEdit();
                }}
                className="flex-1 text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded px-1.5 py-0.5 outline-none border border-indigo-500/40"
              />
              <button
                onClick={() => onConfirmRename(conv.id)}
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
              {conv.title}
            </div>
          )}
          {!isEditing && (
            <div className="text-[10px] text-[var(--color-text-secondary)] truncate mt-0.5">
              {preview}
            </div>
          )}
        </div>

        {!isEditing && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => onStartRename(conv.id, conv.title)}
              className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
              title="重命名"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={() => onDelete(conv.id)}
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
            {messageCount} 条消息
          </span>
        </div>
      )}
    </div>
  );
});

export function ConversationList({ onClose }: { onClose: () => void }) {
  const {
    conversations,
    currentConversationId,
    setCurrentConversation,
    deleteConversation,
    renameConversation,
    createConversation,
  } = useAIStore();

  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
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

  // 使用 useMemo 缓存过滤结果，只在 deferredSearch 或 conversations 变化时重新计算
  const filtered = useMemo(() => {
    if (!deferredSearch) return conversations;
    const query = deferredSearch.toLowerCase();
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(query) ||
        c.messages.some((m) => m.content.toLowerCase().includes(query))
    );
  }, [conversations, deferredSearch]);

  // 分页显示：只显示前 visibleCount 条
  const visibleConversations = useMemo(() => {
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

  // 使用 useCallback 缓存事件处理函数，避免子组件重渲染
  const handleSelect = useCallback((id: string) => {
    setCurrentConversation(id);
    onClose();
  }, [setCurrentConversation, onClose]);

  const handleNew = useCallback(() => {
    createConversation();
    onClose();
  }, [createConversation, onClose]);

  const handleStartRename = useCallback((id: string, currentTitle: string) => {
    setEditingId(id);
    setEditTitle(currentTitle);
  }, []);

  const handleConfirmRename = useCallback((id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed) {
      renameConversation(id, trimmed);
    }
    setEditingId(null);
  }, [editTitle, renameConversation]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleEditTitleChange = useCallback((value: string) => {
    setEditTitle(value);
  }, []);

  return (
    <div className="flex flex-col h-full relative">
      {/* 删除确认弹窗（应用内弹窗，避免原生 confirm 导致窗口失焦隐藏） */}
      {deleteConfirmId && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 rounded-r-xl">
          <div className="w-[260px] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-xl p-4 mx-3">
            <p className="text-sm text-[var(--color-text)] mb-4">确定删除这个对话？</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  deleteConversation(deleteConfirmId);
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

      {/* 顶部操作 */}
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
              对话历史
            </span>
          </div>
          <button
            onClick={handleNew}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-3 h-3" />
            新对话
          </button>
        </div>

        {/* 搜索 */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索对话..."
            className="w-full text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded-lg pl-7 pr-2 py-1.5 outline-none border border-[var(--color-border)] focus:border-indigo-500/40 transition-colors"
          />
        </div>
      </div>

      {/* 对话列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-secondary)]">
            <MessageSquare className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs opacity-60">
              {search ? "没有找到匹配的对话" : "暂无对话记录"}
            </p>
          </div>
        ) : (
          <>
            {visibleConversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conv={conv}
                isActive={conv.id === currentConversationId}
                isEditing={editingId === conv.id}
                editTitle={editTitle}
                onSelect={handleSelect}
                onStartRename={handleStartRename}
                onConfirmRename={handleConfirmRename}
                onCancelEdit={handleCancelEdit}
                onEditTitleChange={handleEditTitleChange}
                onDelete={setDeleteConfirmId}
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
