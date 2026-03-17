import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Brain,
  Trash2,
  Search,
  Loader2,
  Edit2,
  Check,
  X,
  RefreshCw,
  BarChart3,
  Sparkles,
  Clock3,
  ShieldCheck,
  Plus,
  Save,
} from "lucide-react";
import {
  confirmMemoryCandidate,
  dismissMemoryCandidate,
  listMemoryCandidates,
  listConfirmedMemories,
  listArchivedMemories,
  deleteMemory,
  updateMemoryContent,
  migrateAgentMemory,
  organizeRecentFileMemories,
  saveConfirmedMemory,
  type AIMemoryCandidate,
  type AIMemoryItem,
  type AIMemoryKind,
  type AIMemoryScope,
  type AIMemorySource,
} from "@/core/ai/memory-store";
import {
  getFileMemorySnapshot,
  type FileMemorySnapshot,
} from "@/core/ai/file-memory";
import { useAIStore } from "@/store/ai-store";
import { useToast } from "@/components/ui/Toast";
import { handleError } from "@/core/errors";

const BRAND = "#F28F36";

const KIND_LABELS: Record<AIMemoryKind, { label: string; color: string }> = {
  preference: { label: "偏好", color: "#3b82f6" },
  fact: { label: "事实", color: "#22c55e" },
  goal: { label: "目标", color: "#f59e0b" },
  constraint: { label: "约束", color: "#ef4444" },
  project_context: { label: "项目", color: "#8b5cf6" },
  conversation_summary: { label: "摘要", color: "#06b6d4" },
  session_note: { label: "会话笔记", color: "#64748b" },
  knowledge: { label: "知识", color: "#14b8a6" },
  behavior: { label: "行为", color: "#f97316" },
};

const SOURCE_LABELS: Record<AIMemorySource, string> = {
  user: "用户确认",
  assistant: "AI 提取",
  system: "系统",
  agent: "Agent / 工具保存",
};

const SCOPE_LABELS: Record<"global" | "conversation" | "workspace", string> = {
  global: "全局",
  conversation: "会话",
  workspace: "工作区",
};

const MODE_LABELS: Record<"ask" | "agent" | "cluster" | "dialog" | "system", string> = {
  ask: "Ask",
  agent: "Agent",
  cluster: "Cluster",
  dialog: "Dialog",
  system: "System",
};

const ARCHIVE_REASON_LABELS: Record<"deleted" | "replaced" | "limit_trimmed", string> = {
  deleted: "手动删除",
  replaced: "被新记忆替换",
  limit_trimmed: "超过上限被归档",
};

type MemoryCenterView = "durable" | "session_notes" | "review_queue";

const MEMORY_CENTER_VIEWS: Array<{
  id: MemoryCenterView;
  label: string;
  description: string;
}> = [
  {
    id: "durable",
    label: "长期记忆",
    description: "稳定偏好、长期约束、项目背景",
  },
  {
    id: "session_notes",
    label: "会话笔记",
    description: "静默沉淀的上下文缓存",
  },
  {
    id: "review_queue",
    label: "审查队列",
    description: "少量后台候选，集中处理",
  },
];

const KIND_OPTIONS = Object.entries(KIND_LABELS) as Array<
  [AIMemoryKind, { label: string; color: string }]
>;
const MANUAL_KIND_OPTIONS = KIND_OPTIONS.filter(
  ([kind]) => kind !== "session_note" && kind !== "conversation_summary",
);
const SOURCE_OPTIONS = Object.entries(SOURCE_LABELS) as Array<
  [AIMemorySource, string]
>;

function formatRelativeTime(timestamp?: number | null): string {
  if (!timestamp) return "未记录";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时前`;
  if (diff < 2_592_000_000) return `${Math.max(1, Math.floor(diff / 86_400_000))} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

function collectRecentTargets(
  entries: Array<{ value?: string | null; timestamp?: number | null }>,
): string[] {
  const latestByValue = new Map<string, number>();
  for (const entry of entries) {
    const value = String(entry.value || "").trim();
    if (!value) continue;
    const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : 0;
    const previous = latestByValue.get(value) ?? 0;
    if (timestamp >= previous) {
      latestByValue.set(value, timestamp);
    }
  }

  return [...latestByValue.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([value]) => value)
    .slice(0, 8);
}

function formatScopeTarget(scope: AIMemoryScope, target?: string | null): string | null {
  const value = String(target || "").trim();
  if (!value) return null;
  if (scope === "workspace") {
    return value.split("/").filter(Boolean).pop() || value;
  }
  return value;
}

function buildCountMap<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function matchesMemoryFilters(
  memory: AIMemoryItem,
  filters: {
    filterKind: string;
    filterSource: string;
    searchQuery: string;
  },
): boolean {
  if (filters.filterKind !== "all" && memory.kind !== filters.filterKind) return false;
  if (filters.filterSource !== "all" && memory.source !== filters.filterSource) return false;
  if (!filters.searchQuery.trim()) return true;
  const q = filters.searchQuery.toLowerCase();
  return (
    memory.content.toLowerCase().includes(q)
    || memory.tags.some((t) => t.toLowerCase().includes(q))
    || (SOURCE_LABELS[memory.source] ?? memory.source).toLowerCase().includes(q)
    || (KIND_LABELS[memory.kind]?.label ?? memory.kind).toLowerCase().includes(q)
    || (memory.workspace_id || "").toLowerCase().includes(q)
    || (memory.conversation_id || "").toLowerCase().includes(q)
    || (memory.replaced_by_memory_id || "").toLowerCase().includes(q)
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Brain;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex items-center gap-2">
        <div className="rounded-lg bg-[#F28F36]/10 p-1.5 text-[#F28F36]">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <span className="text-[11px] text-[var(--color-text-secondary)]">{label}</span>
      </div>
      <div className="mt-2 text-lg font-semibold text-[var(--color-text)]">{value}</div>
      <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">{detail}</div>
    </div>
  );
}

export function MemoryTab() {
  const config = useAIStore((s) => s.config);
  const loadConfig = useAIStore((s) => s.loadConfig);
  const syncMemoryCandidatesToStore = useAIStore((s) => s.loadMemoryCandidates);
  const { toast } = useToast();
  const [memories, setMemories] = useState<AIMemoryItem[]>([]);
  const [archivedMemories, setArchivedMemories] = useState<AIMemoryItem[]>([]);
  const [candidates, setCandidates] = useState<AIMemoryCandidate[]>([]);
  const [fileMemorySnapshot, setFileMemorySnapshot] = useState<FileMemorySnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterKind, setFilterKind] = useState<string>("all");
  const [filterSource, setFilterSource] = useState<string>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
  const [candidateActionId, setCandidateActionId] = useState<string | null>(null);
  const [creatingMemory, setCreatingMemory] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [draftKind, setDraftKind] = useState<AIMemoryKind>("preference");
  const [draftScope, setDraftScope] = useState<AIMemoryScope>("global");
  const [draftScopeTarget, setDraftScopeTarget] = useState("");
  const [showAllArchived, setShowAllArchived] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showFileMemoryPreview, setShowFileMemoryPreview] = useState(false);
  const [activeView, setActiveView] = useState<MemoryCenterView>("durable");

  const loadMemories = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) setIsLoading(true);
    try {
      const [items, archivedItems, candidateItems] = await Promise.all([
        listConfirmedMemories(),
        listArchivedMemories(),
        listMemoryCandidates(),
      ]);
      setMemories(items);
      setArchivedMemories(archivedItems);
      setCandidates(candidateItems);
      const fileSnapshot = await getFileMemorySnapshot({ recentDays: 3 }).catch(() => null);
      setFileMemorySnapshot(fileSnapshot);
      await syncMemoryCandidatesToStore().catch(() => undefined);
    } catch (e) {
      handleError(e, { context: "加载 AI 记忆", silent: true });
    }
    if (!silent) setIsLoading(false);
  }, [syncMemoryCandidatesToStore]);

  useEffect(() => {
    void loadConfig();
    void loadMemories();
  }, [loadConfig, loadMemories]);

  const handleDelete = async (id: string) => {
    setDeletingMemoryId(id);
    try {
      await deleteMemory(id);
      toast("success", "已删除记忆");
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "删除 AI 记忆" });
    } finally {
      setDeletingMemoryId(null);
    }
  };

  const handleEdit = (memory: AIMemoryItem) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setSavingEdit(true);
    try {
      const updated = await updateMemoryContent(editingId, editContent);
      if (!updated) {
        toast("warning", "内容无效、重复或包含敏感信息");
        return;
      }
      setEditingId(null);
      setEditContent("");
      toast("success", "记忆已更新");
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "更新长期记忆" });
    } finally {
      setSavingEdit(false);
    }
  };

  const handleMigrate = async () => {
    setIsRefreshing(true);
    try {
      const count = await migrateAgentMemory();
      if (count > 0) {
        toast("success", `已迁移 ${count} 条旧版记忆`);
      } else {
        toast("info", "没有检测到可迁移的旧版记忆");
      }
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "迁移旧版记忆" });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await loadMemories({ silent: true });
    setIsRefreshing(false);
  };

  const handleOrganizeRecentMemory = async () => {
    setIsRefreshing(true);
    try {
      const candidates = await organizeRecentFileMemories(5);
      if (candidates.length > 0) {
        toast("success", `已从 recent daily memory 整理出 ${candidates.length} 条长期记忆候选`);
      } else {
        toast("info", "最近的 daily memory 里暂时没有适合提升为长期记忆的内容");
      }
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "整理 recent daily memory" });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleConfirmCandidate = async (
    candidateId: string,
    options?: { replaceConflicts?: boolean },
  ) => {
    setCandidateActionId(`confirm:${candidateId}`);
    try {
      const saved = await confirmMemoryCandidate(candidateId, options);
      if (saved) {
        toast("success", options?.replaceConflicts ? "已替换旧记忆并保存新记忆" : "候选已转为正式记忆");
      } else {
        toast("warning", "候选无效、重复或已失效");
      }
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "确认记忆候选" });
    } finally {
      setCandidateActionId(null);
    }
  };

  const handleDismissCandidate = async (candidateId: string) => {
    setCandidateActionId(`dismiss:${candidateId}`);
    try {
      await dismissMemoryCandidate(candidateId);
      toast("info", "已忽略该候选");
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "忽略记忆候选" });
    } finally {
      setCandidateActionId(null);
    }
  };

  const handleDismissAllCandidates = async () => {
    if (candidates.length === 0) return;
    setCandidateActionId("dismiss-all");
    try {
      await Promise.all(candidates.map((candidate) => dismissMemoryCandidate(candidate.id)));
      toast("success", `已忽略 ${candidates.length} 条候选`);
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "批量忽略记忆候选" });
    } finally {
      setCandidateActionId(null);
    }
  };

  const handleCreateMemory = async () => {
    if (!draftContent.trim()) {
      toast("warning", "请先输入要保存的记忆内容");
      return;
    }
    setCreatingMemory(true);
    try {
      const trimmedScopeTarget = draftScopeTarget.trim();
      if (draftScope === "workspace" && !trimmedScopeTarget) {
        toast("warning", "工作区记忆需要填写工作区路径或标识");
        return;
      }
      if (draftScope === "conversation" && !trimmedScopeTarget) {
        toast("warning", "会话记忆需要填写会话 ID");
        return;
      }
      const saved = await saveConfirmedMemory(draftContent, {
        kind: draftKind,
        source: "user",
        scope: draftScope,
        workspaceId: draftScope === "workspace" ? trimmedScopeTarget : undefined,
        conversationId: draftScope === "conversation" ? trimmedScopeTarget : undefined,
      });
      if (!saved) {
        toast("warning", "内容无效、重复、过短或包含敏感信息");
        return;
      }
      setDraftContent("");
      setDraftKind("preference");
      setDraftScope("global");
      setDraftScopeTarget("");
      toast("success", "已手动添加正式记忆");
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "手动添加长期记忆" });
    } finally {
      setCreatingMemory(false);
    }
  };

  const confirmedLongTermMemories = useMemo(
    () => memories.filter((memory) => memory.kind !== "session_note"),
    [memories],
  );
  const sessionNotes = useMemo(
    () => memories.filter((memory) => memory.kind === "session_note"),
    [memories],
  );
  const memoryFilters = useMemo(
    () => ({ filterKind, filterSource, searchQuery }),
    [filterKind, filterSource, searchQuery],
  );
  const filteredLongTermMemories = useMemo(
    () => confirmedLongTermMemories.filter((memory) => matchesMemoryFilters(memory, memoryFilters)),
    [confirmedLongTermMemories, memoryFilters],
  );
  const filteredSessionNotes = useMemo(
    () => sessionNotes.filter((memory) => matchesMemoryFilters(memory, memoryFilters)),
    [memoryFilters, sessionNotes],
  );
  const activeMemoryMap = useMemo(
    () => new Map(memories.map((memory) => [memory.id, memory])),
    [memories],
  );
  const longTermByKind = useMemo(
    () => buildCountMap(confirmedLongTermMemories.map((memory) => memory.kind)),
    [confirmedLongTermMemories],
  );
  const sessionNoteByScope = useMemo(
    () => buildCountMap(sessionNotes.map((memory) => memory.scope)),
    [sessionNotes],
  );
  const confirmedBySource = useMemo(
    () => buildCountMap(memories.map((memory) => memory.source)),
    [memories],
  );
  const legacySummaryCount = useMemo(
    () => confirmedLongTermMemories.filter((memory) => memory.kind === "conversation_summary").length,
    [confirmedLongTermMemories],
  );
  const memoryEnabled = config.enable_long_term_memory !== false;
  const autoCandidateEnabled = memoryEnabled && config.enable_memory_auto_save !== false;
  const autoRecallEnabled = memoryEnabled && config.enable_memory_auto_recall !== false;
  const memorySyncEnabled = memoryEnabled && config.enable_memory_sync !== false;
  const workspaceSuggestions = useMemo(
    () => collectRecentTargets([
      ...memories.map((memory) => ({
        value: memory.workspace_id,
        timestamp: memory.updated_at,
      })),
      ...archivedMemories.map((memory) => ({
        value: memory.workspace_id,
        timestamp: memory.archived_at ?? memory.updated_at,
      })),
      ...candidates.map((candidate) => ({
        value: candidate.workspace_id,
        timestamp: candidate.created_at,
      })),
    ]),
    [archivedMemories, candidates, memories],
  );
  const conversationSuggestions = useMemo(
    () => collectRecentTargets([
      ...memories.map((memory) => ({
        value: memory.conversation_id,
        timestamp: memory.updated_at,
      })),
      ...archivedMemories.map((memory) => ({
        value: memory.conversation_id,
        timestamp: memory.archived_at ?? memory.updated_at,
      })),
      ...candidates.map((candidate) => ({
        value: candidate.conversation_id,
        timestamp: candidate.created_at,
      })),
    ]),
    [archivedMemories, candidates, memories],
  );
  const scopeTargetSuggestions = useMemo(() => {
    if (draftScope === "workspace") return workspaceSuggestions;
    if (draftScope === "conversation") return conversationSuggestions;
    return [];
  }, [conversationSuggestions, draftScope, workspaceSuggestions]);
  const archivedPreview = showAllArchived ? archivedMemories : archivedMemories.slice(0, 6);
  const hasMemoryFilters = !!searchQuery.trim() || filterKind !== "all" || filterSource !== "all";
  const viewCountMap = useMemo<Record<MemoryCenterView, number>>(
    () => ({
      durable: confirmedLongTermMemories.length,
      session_notes: sessionNotes.length,
      review_queue: candidates.length,
    }),
    [candidates.length, confirmedLongTermMemories.length, sessionNotes.length],
  );

  const renderMemoryList = (
    items: AIMemoryItem[],
    options: {
      emptyTitle: string;
      emptyDescription: string;
      accent?: "default" | "muted";
    },
  ) => {
    if (items.length === 0) {
      return (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-6 text-center">
          <Brain className="mx-auto mb-2 h-7 w-7 text-[var(--color-text-secondary)] opacity-20" />
          <div className="text-xs text-[var(--color-text-secondary)]">{options.emptyTitle}</div>
          <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]/80">
            {options.emptyDescription}
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {items.map((memory) => {
          const kindInfo = KIND_LABELS[memory.kind] ?? { label: memory.kind, color: "#666" };
          const isEditing = editingId === memory.id;
          const editBusy = savingEdit && editingId === memory.id;
          const deleteBusy = deletingMemoryId === memory.id;
          const scopeLabel = memory.scope === "workspace"
            ? `工作区记忆${memory.workspace_id ? ` · ${formatScopeTarget("workspace", memory.workspace_id)}` : ""}`
            : memory.scope === "conversation"
              ? `会话记忆${memory.conversation_id ? ` · ${formatScopeTarget("conversation", memory.conversation_id)}` : ""}`
              : "全局记忆";

          return (
            <div
              key={memory.id}
              className={`rounded-lg border px-3 py-2.5 ${
                options.accent === "muted"
                  ? "border-slate-200/80 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/40"
                  : "border-[var(--color-border)] bg-[var(--color-bg)]"
              }`}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={3}
                        className="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text)] outline-none"
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => {
                            setEditingId(null);
                            setEditContent("");
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                        >
                          <X className="h-3 w-3" />
                          取消
                        </button>
                        <button
                          onClick={() => void handleSaveEdit()}
                          disabled={editBusy}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-[10px] text-white hover:bg-emerald-600 disabled:opacity-50"
                        >
                          {editBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Check className="h-3 w-3" />
                          )}
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="break-words text-xs leading-relaxed text-[var(--color-text)]">
                      {memory.content}
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span
                      className="rounded px-1 py-0.5 text-[9px] font-medium"
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
                      {scopeLabel}
                    </span>
                    <span className="text-[9px] text-[var(--color-text-secondary)]">
                      使用 {memory.use_count} 次
                    </span>
                    {!!memory.supersedes_memory_ids?.length && (
                      <span className="text-[9px] text-amber-700 dark:text-amber-300">
                        替换了 {memory.supersedes_memory_ids.length} 条旧记忆
                      </span>
                    )}
                    <span className="text-[9px] text-[var(--color-text-secondary)]">
                      更新于 {formatRelativeTime(memory.updated_at)}
                    </span>
                    {memory.last_used_at ? (
                      <span className="text-[9px] text-[var(--color-text-secondary)]">
                        最近命中 {formatRelativeTime(memory.last_used_at)}
                      </span>
                    ) : null}
                    {memory.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-[var(--color-bg-secondary)] px-1 py-0.5 text-[9px] text-[var(--color-text-secondary)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                {!isEditing && (
                  <div className="shrink-0 flex items-center gap-0.5">
                    <button
                      onClick={() => handleEdit(memory)}
                      className="rounded p-1 hover:bg-[var(--color-bg-secondary)]"
                      title="编辑"
                    >
                      <Edit2 className="h-3 w-3 text-[var(--color-text-secondary)]" />
                    </button>
                    <button
                      onClick={() => void handleDelete(memory.id)}
                      disabled={deleteBusy}
                      className="rounded p-1 hover:bg-red-500/10 disabled:opacity-50"
                      title="删除"
                    >
                      {deleteBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin text-red-400" />
                      ) : (
                        <Trash2 className="h-3 w-3 text-red-400" />
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: BRAND }} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">AI 记忆管理</h2>
          <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
            候选需要你确认后才会进入正式记忆；正式记忆才会参与召回和云同步。
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void handleOrganizeRecentMemory()}
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="整理 recent daily memory"
            disabled={isRefreshing}
          >
            整理记忆
          </button>
          <button
            onClick={() => setShowStats((v) => !v)}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="统计"
          >
            <BarChart3 className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          </button>
          <button
            onClick={() => void handleMigrate()}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="迁移旧记忆"
            disabled={isRefreshing}
          >
            <RefreshCw className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          </button>
          <button
            onClick={() => void handleRefresh()}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
            title="刷新"
            disabled={isRefreshing}
          >
            <Loader2
              className={`w-3.5 h-3.5 text-[var(--color-text-secondary)] ${isRefreshing ? "animate-spin" : "hidden"}`}
            />
            {!isRefreshing && <RefreshCw className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SummaryCard
          icon={Brain}
          label="长期记忆"
          value={String(confirmedLongTermMemories.length)}
          detail={confirmedLongTermMemories.length > 0 ? "偏好、约束、项目背景等稳定记忆" : "还没有稳定长期记忆"}
        />
        <SummaryCard
          icon={Clock3}
          label="会话笔记"
          value={String(sessionNotes.length)}
          detail={sessionNotes.length > 0 ? "静默沉淀，用于同会话/工作区召回" : "当前没有沉淀会话笔记"}
        />
        <SummaryCard
          icon={Sparkles}
          label="待确认候选"
          value={String(candidates.length)}
          detail={candidates.length > 0 ? "只有高价值候选才需要你确认" : "当前没有待处理候选"}
        />
        <SummaryCard
          icon={ShieldCheck}
          label="自动召回"
          value={autoRecallEnabled ? "开启" : (memoryEnabled ? "关闭" : "停用")}
          detail={memoryEnabled ? "长期记忆和会话笔记会按相关性注入" : "当前不会参与召回"}
        />
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
        <div className="inline-flex flex-wrap gap-2">
          {MEMORY_CENTER_VIEWS.map((view) => {
            const active = activeView === view.id;
            return (
              <button
                key={view.id}
                type="button"
                onClick={() => setActiveView(view.id)}
                className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-[#F28F36] bg-[#F28F36]/10 text-[#F28F36]"
                    : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                }`}
              >
                <div className="text-[11px] font-medium">
                  {view.label}
                  <span className="ml-1 text-[10px] opacity-80">
                    {viewCountMap[view.id]}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] opacity-80">
                  {view.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {fileMemorySnapshot && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-[var(--color-text)]">文件型记忆主干</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                正式长期记忆会同步到 `MEMORY.md`，静默会话笔记会写入 `memory/YYYY-MM-DD.md`。
              </div>
            </div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              recent daily: {fileMemorySnapshot.recentDailyFiles.length} 天
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
              <div className="text-[10px] text-[var(--color-text-secondary)]">长期记忆文件</div>
              <div className="mt-1 break-all text-[11px] leading-5 text-[var(--color-text)]">
                {fileMemorySnapshot.longTermPath}
              </div>
              <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                {fileMemorySnapshot.longTermContent.trim()
                  ? `${fileMemorySnapshot.longTermContent.split("\n").filter((line) => line.trim().startsWith("- ")).length} 条已落盘`
                  : "当前还没有正式长期记忆写入文件"}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
              <div className="text-[10px] text-[var(--color-text-secondary)]">今日日志文件</div>
              <div className="mt-1 break-all text-[11px] leading-5 text-[var(--color-text)]">
                {fileMemorySnapshot.todayPath}
              </div>
              <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                {fileMemorySnapshot.todayContent.trim()
                  ? `${fileMemorySnapshot.todayContent.split(/^##\s/m).filter(Boolean).length} 条今日沉淀`
                  : "今天还没有写入 daily memory"}
              </div>
            </div>
          </div>
          {fileMemorySnapshot.recentDailyFiles.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] text-[var(--color-text-secondary)]">最近 daily memory</div>
                <button
                  type="button"
                  onClick={() => setShowFileMemoryPreview((prev) => !prev)}
                  className="rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg)]"
                >
                  {showFileMemoryPreview ? "收起预览" : "展开预览"}
                </button>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {fileMemorySnapshot.recentDailyFiles.map((file) => (
                  <span
                    key={file.path}
                    className="rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                    title={file.path}
                  >
                    {file.name}
                  </span>
                ))}
              </div>
              {showFileMemoryPreview && (
                <div className="mt-2 grid grid-cols-1 gap-2">
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
                    <div className="text-[10px] text-[var(--color-text-secondary)]">MEMORY.md 预览</div>
                    <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-[var(--color-text)]">
                      {fileMemorySnapshot.longTermContent.trim() || "当前为空"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      {fileMemorySnapshot.recentDailyFiles[0]?.name ?? "今日"} 预览
                    </div>
                    <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-[var(--color-text)]">
                      {fileMemorySnapshot.recentDailyFiles[0]?.content?.trim()
                        || fileMemorySnapshot.todayContent.trim()
                        || "当前为空"}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showStats && (
        <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-3">
          <div className="mb-2 text-[10px] text-[var(--color-text-secondary)]">
            当前已确认记忆 {memories.length} 条，其中长期记忆 {confirmedLongTermMemories.length} 条、会话笔记 {sessionNotes.length} 条，待确认候选 {candidates.length} 条
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
                长期记忆类型
              </div>
              {Object.keys(longTermByKind).length === 0 ? (
                <div className="text-[10px] text-[var(--color-text-secondary)]">暂无长期记忆</div>
              ) : Object.entries(longTermByKind).map(([kind, count]) => {
                const kindMeta = KIND_LABELS[kind as AIMemoryKind];
                return (
                  <div key={kind} className="flex items-center justify-between py-0.5">
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{
                        background: `${kindMeta?.color ?? "#666"}20`,
                        color: kindMeta?.color ?? "#666",
                      }}
                    >
                      {kindMeta?.label ?? kind}
                    </span>
                    <span className="text-xs font-mono">{count}</span>
                  </div>
                );
              })}
            </div>
            <div>
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
                会话笔记作用域
              </div>
              {Object.keys(sessionNoteByScope).length === 0 ? (
                <div className="text-[10px] text-[var(--color-text-secondary)]">暂无会话笔记</div>
              ) : Object.entries(sessionNoteByScope).map(([scope, count]) => (
                <div key={scope} className="flex items-center justify-between py-0.5">
                  <span className="text-[10px] text-[var(--color-text-secondary)]">
                    {SCOPE_LABELS[scope as AIMemoryScope] ?? scope}
                  </span>
                  <span className="text-xs font-mono">{count}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
                已确认来源
              </div>
              {Object.entries(confirmedBySource).map(([source, count]) => (
                <div key={source} className="flex items-center justify-between py-0.5">
                  <span className="text-[10px] text-[var(--color-text-secondary)]">
                    {SOURCE_LABELS[source as AIMemorySource] ?? source}
                  </span>
                  <span className="text-xs font-mono">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[10px] text-[var(--color-text-secondary)] space-y-1.5">
        <div>
          当前流程已经拆成两层：“会话笔记静默沉淀” + “长期记忆后台整理”。
          自动运行结果更偏向写入会话笔记；明确且高置信的长期规则会直接升级为正式记忆，其余才进入后台候选队列。
        </div>
        <div>
          总开关：{memoryEnabled ? "已开启" : "已关闭"}；云同步：{memorySyncEnabled ? "开启，仅同步正式记忆" : "关闭，仅保留本地正式记忆"}。
        </div>
        <div>
          例外项会直接写入已确认记忆：系统生成的项目上下文，以及你在本页手动添加的正式记忆。会话笔记主要服务于当前会话/工作区召回，不再强行占用长期记忆确认流。
        </div>
        <div>
          `memory-graph` 这一类图谱数据目前不参与主召回链路，现阶段重点仍是这套稳定的候选/正式记忆体系。
        </div>
        <div>
          自动提取候选：{autoCandidateEnabled ? "已开启，主流程默认静默，只保留后台候选" : (memoryEnabled ? "已关闭，仅保留手动确认" : "停用")}。
        </div>
      </div>

      {activeView === "durable" && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Plus className="w-3.5 h-3.5 text-[#F28F36]" />
            <div>
              <div className="text-xs font-semibold text-[var(--color-text)]">手动添加正式记忆</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                适合直接录入稳定偏好、长期约束、项目背景等。
              </div>
            </div>
          </div>
          <textarea
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            placeholder="例如：默认用中文回答，先给结论，再展开步骤。"
            rows={4}
            className="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text)] outline-none"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value as AIMemoryKind)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text)] outline-none"
            >
              {MANUAL_KIND_OPTIONS.map(([kind, info]) => (
                <option key={kind} value={kind}>
                  {info.label}
                </option>
              ))}
            </select>
            <select
              value={draftScope}
              onChange={(e) => {
                setDraftScope(e.target.value as AIMemoryScope);
                setDraftScopeTarget("");
              }}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text)] outline-none"
            >
              <option value="global">全局记忆</option>
              <option value="workspace">工作区记忆</option>
              <option value="conversation">会话记忆</option>
            </select>
            <button
              onClick={() => void handleCreateMemory()}
              disabled={creatingMemory}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#F28F36] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[#e07d25] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creatingMemory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存为正式记忆
            </button>
          </div>
          {draftScope !== "global" && (
            <div className="space-y-2">
              <input
                value={draftScopeTarget}
                onChange={(e) => setDraftScopeTarget(e.target.value)}
                list={draftScope === "workspace" ? "memory-workspace-targets" : "memory-conversation-targets"}
                placeholder={draftScope === "workspace" ? "输入工作区路径或项目标识，如 /Users/demo/project" : "输入会话 ID"}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text)] outline-none"
              />
              {draftScope === "workspace" && (
                <datalist id="memory-workspace-targets">
                  {workspaceSuggestions.map((target) => (
                    <option key={target} value={target} />
                  ))}
                </datalist>
              )}
              {draftScope === "conversation" && (
                <datalist id="memory-conversation-targets">
                  {conversationSuggestions.map((target) => (
                    <option key={target} value={target} />
                  ))}
                </datalist>
              )}
              {scopeTargetSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {scopeTargetSuggestions.slice(0, 6).map((target) => (
                    <button
                      key={target}
                      type="button"
                      onClick={() => setDraftScopeTarget(target)}
                      className={`rounded-full border px-2 py-1 text-[10px] transition-colors ${
                        draftScopeTarget === target
                          ? "border-[#F28F36] bg-[#F28F36]/10 text-[#F28F36]"
                          : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                      }`}
                      title={target}
                    >
                      {formatScopeTarget(draftScope, target)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="text-[10px] text-[var(--color-text-secondary)]">
            {draftScope === "global"
              ? "全局记忆会在所有模式下按相关性参与召回。"
              : draftScope === "workspace"
                ? "工作区记忆适合项目结构、项目偏好和仓库上下文，只会在同一工作区内优先召回。"
                : "会话记忆适合单个房间/任务的长期上下文，只会在对应会话中参与召回。"}
          </div>
        </div>
      )}

      {activeView === "review_queue" && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-[var(--color-text)]">后台审查队列</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                主对话流程默认静默运行，只有少量值得审查的候选才会进入这里。
              </div>
            </div>
            {candidates.length > 0 && (
              <button
                onClick={() => void handleDismissAllCandidates()}
                disabled={candidateActionId === "dismiss-all"}
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
              >
                {candidateActionId === "dismiss-all" ? "处理中..." : "全部忽略"}
              </button>
            )}
          </div>

          {candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-5 text-center text-[10px] text-[var(--color-text-secondary)]">
              当前没有待确认候选
            </div>
          ) : (
            <div className="max-h-[520px] space-y-2 overflow-auto pr-1">
              {candidates.map((candidate) => {
                const confirmBusy = candidateActionId === `confirm:${candidate.id}`;
                const dismissBusy = candidateActionId === `dismiss:${candidate.id}`;
                const kindMeta = candidate.kind ? KIND_LABELS[candidate.kind] : null;
                return (
                  <div
                    key={candidate.id}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2"
                  >
                    <div className="text-xs text-[var(--color-text)] break-words">
                      {candidate.content}
                    </div>
                    <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                      {candidate.reason}
                    </div>
                    {candidate.evidence && candidate.evidence !== candidate.content && (
                      <div className="mt-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">
                        证据：{candidate.evidence}
                      </div>
                    )}
                    {candidate.conflict_summary && (
                      <div className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
                        {candidate.conflict_summary}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
                      {kindMeta && (
                        <span
                          className="rounded-full px-1.5 py-0.5"
                          style={{
                            background: `${kindMeta.color}20`,
                            color: kindMeta.color,
                          }}
                        >
                          {kindMeta.label}
                        </span>
                      )}
                      <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5">
                        置信度 {Math.round(candidate.confidence * 100)}%
                      </span>
                      <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5">
                        {(candidate.scope && SCOPE_LABELS[candidate.scope]) || (candidate.conversation_id ? "会话" : "全局")}
                      </span>
                      {candidate.scope === "workspace" && candidate.workspace_id && (
                        <span
                          className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5"
                          title={candidate.workspace_id}
                        >
                          {formatScopeTarget("workspace", candidate.workspace_id)}
                        </span>
                      )}
                      {candidate.scope === "conversation" && candidate.conversation_id && (
                        <span
                          className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5"
                          title={candidate.conversation_id}
                        >
                          {formatScopeTarget("conversation", candidate.conversation_id)}
                        </span>
                      )}
                      {candidate.source && (
                        <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5">
                          {SOURCE_LABELS[candidate.source] ?? candidate.source}
                        </span>
                      )}
                      {candidate.source_mode && (
                        <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5">
                          {MODE_LABELS[candidate.source_mode] ?? candidate.source_mode}
                        </span>
                      )}
                      <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5">
                        {candidate.review_surface === "background" ? "后台候选" : "建议确认"}
                      </span>
                      {!!candidate.conflict_memory_ids?.length && (
                        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                          冲突 {candidate.conflict_memory_ids.length}
                        </span>
                      )}
                      <span>{formatRelativeTime(candidate.created_at)}</span>
                    </div>
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        onClick={() => void handleDismissCandidate(candidate.id)}
                        disabled={dismissBusy || confirmBusy}
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
                      >
                        {dismissBusy ? "忽略中..." : "忽略"}
                      </button>
                      {!!candidate.conflict_memory_ids?.length && (
                        <button
                          onClick={() => void handleConfirmCandidate(candidate.id, { replaceConflicts: true })}
                          disabled={confirmBusy || dismissBusy}
                          className="rounded-md bg-amber-500 px-2 py-1 text-[10px] text-white hover:bg-amber-600 disabled:opacity-50"
                        >
                          {confirmBusy ? "替换中..." : "替换旧项"}
                        </button>
                      )}
                      <button
                        onClick={() => void handleConfirmCandidate(candidate.id)}
                        disabled={confirmBusy || dismissBusy}
                        className="rounded-md bg-[#F28F36] px-2 py-1 text-[10px] text-white hover:bg-[#e07d25] disabled:opacity-50"
                      >
                        {confirmBusy ? "记住中..." : (!!candidate.conflict_memory_ids?.length ? "保留并记住" : "记住")}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeView !== "review_queue" && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xs font-semibold text-[var(--color-text)]">
                {activeView === "durable" ? "长期记忆" : "会话笔记"}
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                {activeView === "durable"
                  ? "稳定偏好、长期约束和项目背景会优先保留在这里，并跨模式参与召回。"
                  : "运行过程中的阶段性上下文会静默沉淀到这里，主要在同会话或同工作区内回补上下文。"}
              </div>
            </div>
            {!config.enable_long_term_memory && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
                长期记忆总开关当前关闭，现有数据仍可管理，但不会自动召回/提取。
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 md:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-secondary)]" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索内容、标签、类型或来源..."
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-2 pl-8 pr-3 text-xs text-[var(--color-text)] outline-none"
              />
            </div>
            <select
              value={filterKind}
              onChange={(e) => setFilterKind(e.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text)] outline-none"
            >
              <option value="all">全部类型</option>
              {KIND_OPTIONS.map(([kind, info]) => (
                <option key={kind} value={kind}>
                  {info.label}
                </option>
              ))}
            </select>
            <select
              value={filterSource}
              onChange={(e) => setFilterSource(e.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text)] outline-none"
            >
              <option value="all">全部来源</option>
              {SOURCE_OPTIONS.map(([source, label]) => (
                <option key={source} value={source}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {activeView === "durable" && filteredLongTermMemories.length === 0 && (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] py-8 text-center">
              <Brain className="mx-auto mb-2 h-8 w-8 text-[var(--color-text-secondary)] opacity-20" />
              <p className="text-xs text-[var(--color-text-secondary)]">
                {hasMemoryFilters ? "当前筛选下没有匹配的长期记忆" : "尚无长期记忆"}
              </p>
            </div>
          )}

          {activeView === "session_notes" && filteredSessionNotes.length === 0 && (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] py-8 text-center">
              <Brain className="mx-auto mb-2 h-8 w-8 text-[var(--color-text-secondary)] opacity-20" />
              <p className="text-xs text-[var(--color-text-secondary)]">
                {hasMemoryFilters ? "当前筛选下没有匹配的会话笔记" : "尚无会话笔记"}
              </p>
            </div>
          )}

          {activeView === "durable" && (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-[var(--color-text)]">长期记忆</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    稳定偏好、长期约束、项目背景等会优先保留在这里，并跨模式参与召回。
                  </div>
                </div>
                <div className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">
                  {filteredLongTermMemories.length} / {confirmedLongTermMemories.length}
                </div>
              </div>
              {legacySummaryCount > 0 && (
                <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-2.5 py-1.5 text-[10px] text-sky-700 dark:text-sky-300">
                  兼容保留了 {legacySummaryCount} 条旧版“对话摘要”记忆；新流程默认改为沉淀到“会话笔记”。
                </div>
              )}
              {renderMemoryList(filteredLongTermMemories, {
                emptyTitle: hasMemoryFilters ? "当前筛选下没有长期记忆" : "还没有长期记忆",
                emptyDescription: hasMemoryFilters
                  ? "可以调整搜索词、类型或来源筛选后再看。"
                  : "确认候选或手动录入稳定偏好后，这里会开始积累。",
              })}
            </div>
          )}

          {activeView === "session_notes" && (
            <div className="space-y-2 pt-1">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-[var(--color-text)]">会话笔记</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    运行过程中的阶段性上下文会静默沉淀到这里，主要在同会话或同工作区内回补上下文。
                  </div>
                </div>
                <div className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">
                  {filteredSessionNotes.length} / {sessionNotes.length}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10px] text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
                会话笔记不会进入待确认流，也不适合作为全局偏好使用；它更像自动整理的“当前上下文缓存”。
              </div>
              {renderMemoryList(filteredSessionNotes, {
                emptyTitle: hasMemoryFilters ? "当前筛选下没有会话笔记" : "当前还没有会话笔记",
                emptyDescription: hasMemoryFilters
                  ? "可以切换筛选条件，或者把类型改回“全部类型”。"
                  : "当 AI 在会话中持续工作时，重要阶段信息会逐步沉淀到这里。",
                accent: "muted",
              })}
            </div>
          )}
        </div>
      )}

      {archivedMemories.length > 0 && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-[var(--color-text)]">最近归档 / 替换记录</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                这里保留最近被替换、手动删除或超上限归档的正式记忆，方便追溯。
              </div>
            </div>
            {archivedMemories.length > 6 && (
              <button
                type="button"
                onClick={() => setShowAllArchived((value) => !value)}
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
              >
                {showAllArchived ? "收起" : `查看全部 ${archivedMemories.length} 条`}
              </button>
            )}
          </div>
          <div className="space-y-2">
            {archivedPreview.map((memory) => {
              const replacement = memory.replaced_by_memory_id
                ? activeMemoryMap.get(memory.replaced_by_memory_id)
                : null;
              return (
                <div
                  key={memory.id}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2"
                >
                  <div className="text-xs text-[var(--color-text)]/80 break-words">
                    {memory.content}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
                    <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5">
                      {ARCHIVE_REASON_LABELS[memory.archived_reason ?? "deleted"] ?? "已归档"}
                    </span>
                    <span>{formatRelativeTime(memory.archived_at ?? memory.updated_at)}</span>
                  </div>
                  {replacement && (
                    <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300 break-words">
                      替换为：{replacement.content}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
