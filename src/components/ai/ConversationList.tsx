import { useState, useRef, useEffect } from "react";
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
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const filtered = conversations.filter(
    (c) =>
      c.title.toLowerCase().includes(search.toLowerCase()) ||
      c.messages.some((m) =>
        m.content.toLowerCase().includes(search.toLowerCase())
      )
  );

  const handleStartRename = (id: string, currentTitle: string) => {
    setEditingId(id);
    setEditTitle(currentTitle);
  };

  const handleConfirmRename = (id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed) {
      renameConversation(id, trimmed);
    }
    setEditingId(null);
  };

  const handleSelect = (id: string) => {
    setCurrentConversation(id);
    onClose();
  };

  const handleNew = () => {
    createConversation();
    onClose();
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    if (isToday) return `今天 ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    if (isYesterday) return `昨天 ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  };

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
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-secondary)]">
            <MessageSquare className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs opacity-60">
              {search ? "没有找到匹配的对话" : "暂无对话记录"}
            </p>
          </div>
        ) : (
          filtered.map((conv) => {
            const isActive = conv.id === currentConversationId;
            const isEditing = editingId === conv.id;
            const lastMsg = conv.messages.filter(m => m.role !== 'system').slice(-1)[0];
            const preview = lastMsg?.content?.slice(0, 60) || "空对话";

            return (
              <div
                key={conv.id}
                className={`group relative rounded-xl px-3 py-2 cursor-pointer transition-all ${
                  isActive
                    ? "bg-indigo-500/10 border border-indigo-500/20"
                    : "hover:bg-[var(--color-bg-hover)] border border-transparent"
                }`}
                onClick={() => !isEditing && handleSelect(conv.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleConfirmRename(conv.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="flex-1 text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded px-1.5 py-0.5 outline-none border border-indigo-500/40"
                        />
                        <button
                          onClick={() => handleConfirmRename(conv.id)}
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
                        {conv.title}
                      </div>
                    )}
                    {!isEditing && (
                      <div className="text-[10px] text-[var(--color-text-secondary)] truncate mt-0.5">
                        {preview}
                      </div>
                    )}
                  </div>

                  {/* 操作按钮 */}
                  {!isEditing && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleStartRename(conv.id, conv.title)}
                        className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                        title="重命名"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(conv.id)}
                        className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="删除"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                {/* 时间和消息数 */}
                {!isEditing && (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
                      {formatTime(conv.createdAt)}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-secondary)] opacity-40">
                      {conv.messages.filter(m => m.role !== 'system').length} 条消息
                    </span>
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
