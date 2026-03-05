import { useState, useEffect, useCallback } from "react";
import {
  Brain,
  Trash2,
  Search,
  Loader2,
  Edit2,
  Check,
  X,
  RefreshCw,
  Filter,
  BarChart3,
} from "lucide-react";
import {
  aiMemoryDb,
  listConfirmedMemories,
  deleteMemory,
  updateMemoryContent,
  getMemoryStats,
  migrateAgentMemory,
  type AIMemoryItem,
  type AIMemoryKind,
} from "@/core/ai/memory-store";

const BRAND = "#F28F36";

const KIND_LABELS: Record<string, { label: string; color: string }> = {
  preference: { label: "偏好", color: "#3b82f6" },
  fact: { label: "事实", color: "#22c55e" },
  goal: { label: "目标", color: "#f59e0b" },
  constraint: { label: "约束", color: "#ef4444" },
  project_context: { label: "项目", color: "#8b5cf6" },
  conversation_summary: { label: "摘要", color: "#06b6d4" },
};

const SOURCE_LABELS: Record<string, string> = {
  user: "用户确认",
  assistant: "AI 提取",
  system: "系统",
  agent: "Agent 保存",
};

export function MemoryTab() {
  const [memories, setMemories] = useState<AIMemoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterKind, setFilterKind] = useState<string>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [stats, setStats] = useState<{ total: number; byKind: Record<string, number>; bySource: Record<string, number> } | null>(null);
  const [showStats, setShowStats] = useState(false);

  const loadMemories = useCallback(async () => {
    setIsLoading(true);
    try {
      const items = await listConfirmedMemories();
      setMemories(items);
      const s = await getMemoryStats();
      setStats(s);
    } catch {
      // ignore
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const handleDelete = async (id: string) => {
    await deleteMemory(id);
    setMemories((prev) => prev.filter((m) => m.id !== id));
  };

  const handleEdit = (memory: AIMemoryItem) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    await updateMemoryContent(editingId, editContent);
    setEditingId(null);
    await loadMemories();
  };

  const handleMigrate = async () => {
    const count = await migrateAgentMemory();
    if (count > 0) await loadMemories();
  };

  const filtered = memories.filter((m) => {
    if (filterKind !== "all" && m.kind !== filterKind) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        m.content.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    return true;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: BRAND }} />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">AI 记忆管理</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            管理 AI 学习到的偏好、事实和约束（共 {memories.length} 条）
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowStats((v) => !v)}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="统计"
          >
            <BarChart3 className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          </button>
          <button
            onClick={handleMigrate}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="迁移旧记忆"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          </button>
        </div>
      </div>

      {showStats && stats && (
        <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
                按类型
              </div>
              {Object.entries(stats.byKind).map(([kind, count]) => (
                <div key={kind} className="flex items-center justify-between py-0.5">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: `${KIND_LABELS[kind]?.color ?? "#666"}20`,
                      color: KIND_LABELS[kind]?.color ?? "#666",
                    }}
                  >
                    {KIND_LABELS[kind]?.label ?? kind}
                  </span>
                  <span className="text-xs font-mono">{count}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
                按来源
              </div>
              {Object.entries(stats.bySource).map(([source, count]) => (
                <div key={source} className="flex items-center justify-between py-0.5">
                  <span className="text-[10px] text-[var(--color-text-secondary)]">
                    {SOURCE_LABELS[source] ?? source}
                  </span>
                  <span className="text-xs font-mono">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Search & Filter */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--color-text-secondary)]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索记忆..."
            className="w-full pl-7 pr-3 py-1.5 bg-[var(--color-bg-secondary)] rounded-lg text-xs text-[var(--color-text)] outline-none border-0"
          />
        </div>
        <select
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value)}
          className="px-2 py-1.5 bg-[var(--color-bg-secondary)] rounded-lg text-xs text-[var(--color-text)] outline-none border-0 cursor-pointer"
        >
          <option value="all">全部类型</option>
          {Object.entries(KIND_LABELS).map(([kind, { label }]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* Memory List */}
      {filtered.length === 0 ? (
        <div className="text-center py-8 bg-[var(--color-bg)] rounded-xl border border-dashed border-[var(--color-border)]">
          <Brain className="w-8 h-8 text-[var(--color-text-secondary)] mx-auto mb-2 opacity-20" />
          <p className="text-xs text-[var(--color-text-secondary)]">
            {searchQuery || filterKind !== "all" ? "没有匹配的记忆" : "尚无记忆条目"}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((memory) => {
            const kindInfo = KIND_LABELS[memory.kind] ?? { label: memory.kind, color: "#666" };
            const isEditing = editingId === memory.id;

            return (
              <div
                key={memory.id}
                className="bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <input
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          className="flex-1 bg-[var(--color-bg-secondary)] rounded px-2 py-1 text-xs text-[var(--color-text)] outline-none"
                          autoFocus
                        />
                        <button onClick={handleSaveEdit} className="p-1 rounded hover:bg-emerald-500/10">
                          <Check className="w-3 h-3 text-emerald-500" />
                        </button>
                        <button onClick={() => setEditingId(null)} className="p-1 rounded hover:bg-red-500/10">
                          <X className="w-3 h-3 text-red-400" />
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs leading-relaxed">{memory.content}</p>
                    )}

                    <div className="flex items-center gap-1.5 mt-1">
                      <span
                        className="text-[9px] px-1 py-0.5 rounded font-medium"
                        style={{
                          background: `${kindInfo.color}20`,
                          color: kindInfo.color,
                        }}
                      >
                        {kindInfo.label}
                      </span>
                      <span className="text-[9px] text-[var(--color-text-secondary)]">
                        {SOURCE_LABELS[memory.source] ?? memory.source}
                      </span>
                      <span className="text-[9px] text-[var(--color-text-secondary)]">
                        x{memory.use_count}
                      </span>
                      {memory.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[9px] px-1 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>

                  {!isEditing && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => handleEdit(memory)}
                        className="p-1 rounded hover:bg-[var(--color-bg-secondary)]"
                      >
                        <Edit2 className="w-3 h-3 text-[var(--color-text-secondary)]" />
                      </button>
                      <button
                        onClick={() => handleDelete(memory.id)}
                        className="p-1 rounded hover:bg-red-500/10"
                      >
                        <Trash2 className="w-3 h-3 text-red-400" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
