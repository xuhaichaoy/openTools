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
  getMemoryStats,
  migrateAgentMemory,
  saveConfirmedMemory,
  type AIMemoryCandidate,
  type AIMemoryItem,
  type AIMemoryKind,
  type AIMemoryScope,
  type AIMemorySource,
} from "@/core/ai/memory-store";
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

const KIND_OPTIONS = Object.entries(KIND_LABELS) as Array<
  [AIMemoryKind, { label: string; color: string }]
>;
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
  const [stats, setStats] = useState<{
    total: number;
    byKind: Record<string, number>;
    bySource: Record<string, number>;
  } | null>(null);
  const [showStats, setShowStats] = useState(false);

  const loadMemories = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) setIsLoading(true);
    try {
      const [items, archivedItems, candidateItems, nextStats] = await Promise.all([
        listConfirmedMemories(),
        listArchivedMemories(),
        listMemoryCandidates(),
        getMemoryStats(),
      ]);
      setMemories(items);
      setArchivedMemories(archivedItems);
      setCandidates(candidateItems);
      setStats(nextStats);
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
      toast("success", "已删除长期记忆");
      await loadMemories({ silent: true });
    } catch (e) {
      handleError(e, { context: "删除长期记忆" });
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

  const filtered = useMemo(() => memories.filter((m) => {
    if (filterKind !== "all" && m.kind !== filterKind) return false;
    if (filterSource !== "all" && m.source !== filterSource) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      m.content.toLowerCase().includes(q)
      || m.tags.some((t) => t.toLowerCase().includes(q))
      || (SOURCE_LABELS[m.source] ?? m.source).toLowerCase().includes(q)
      || (KIND_LABELS[m.kind]?.label ?? m.kind).toLowerCase().includes(q)
      || (m.workspace_id || "").toLowerCase().includes(q)
      || (m.replaced_by_memory_id || "").toLowerCase().includes(q)
    );
  }), [filterKind, filterSource, memories, searchQuery]);
  const activeMemoryMap = useMemo(
    () => new Map(memories.map((memory) => [memory.id, memory])),
    [memories],
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
          label="正式记忆"
          value={String(memories.length)}
          detail={memories.length > 0 ? "已确认、可参与召回" : "还没有正式记忆"}
        />
        <SummaryCard
          icon={Sparkles}
          label="待确认候选"
          value={String(candidates.length)}
          detail={candidates.length > 0 ? "需要手动确认后生效" : "当前没有待处理候选"}
        />
        <SummaryCard
          icon={ShieldCheck}
          label="自动提取候选"
          value={autoCandidateEnabled ? "开启" : (memoryEnabled ? "关闭" : "停用")}
          detail={memoryEnabled ? "只生成候选，不直接写入正式记忆" : "长期记忆总开关关闭"}
        />
        <SummaryCard
          icon={Clock3}
          label="自动召回"
          value={autoRecallEnabled ? "开启" : (memoryEnabled ? "关闭" : "停用")}
          detail={memoryEnabled ? "发送消息前按相关性注入正式记忆" : "当前不会参与召回"}
        />
      </div>

      {showStats && stats && (
        <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-3">
          <div className="mb-2 text-[10px] text-[var(--color-text-secondary)]">
            当前正式记忆 {stats.total} 条，待确认候选 {candidates.length} 条
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
                按类型
              </div>
              {Object.entries(stats.byKind).map(([kind, count]) => {
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
                按来源
              </div>
              {Object.entries(stats.bySource).map(([source, count]) => (
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
          当前流程是“自动提取候选 → 人工确认 → 正式记忆召回 → 可选云同步”。
          也就是说，现在的记忆是自动提取、半自动入库，不是自动直接写进长期记忆。
        </div>
        <div>
          总开关：{memoryEnabled ? "已开启" : "已关闭"}；云同步：{memorySyncEnabled ? "开启，仅同步正式记忆" : "关闭，仅保留本地正式记忆"}。
        </div>
        <div>
          例外项会直接写入正式记忆：系统生成的项目上下文、会话摘要，以及你在本页手动添加的正式记忆。
        </div>
        <div>
          `memory-graph` 这一类图谱数据目前不参与主召回链路，现阶段重点仍是这套稳定的候选/正式记忆体系。
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
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
              {KIND_OPTIONS.map(([kind, info]) => (
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

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-[var(--color-text)]">待确认候选</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                候选不会自动生效，确认后才进入正式记忆。
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
            <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
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
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs font-semibold text-[var(--color-text)]">正式记忆列表</div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              支持搜索、筛选、编辑和删除；这里只展示已确认并生效的条目。
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

        {filtered.length === 0 ? (
          <div className="text-center py-8 bg-[var(--color-bg)] rounded-xl border border-dashed border-[var(--color-border)]">
            <Brain className="w-8 h-8 text-[var(--color-text-secondary)] mx-auto mb-2 opacity-20" />
            <p className="text-xs text-[var(--color-text-secondary)]">
              {searchQuery || filterKind !== "all" || filterSource !== "all"
                ? "没有匹配的正式记忆"
                : "尚无正式记忆条目"}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((memory) => {
              const kindInfo = KIND_LABELS[memory.kind] ?? { label: memory.kind, color: "#666" };
              const isEditing = editingId === memory.id;
              const editBusy = savingEdit && editingId === memory.id;
              const deleteBusy = deletingMemoryId === memory.id;

              return (
                <div
                  key={memory.id}
                  className="bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] px-3 py-2.5"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
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
                              <X className="w-3 h-3" />
                              取消
                            </button>
                            <button
                              onClick={() => void handleSaveEdit()}
                              disabled={editBusy}
                              className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-[10px] text-white hover:bg-emerald-600 disabled:opacity-50"
                            >
                              {editBusy ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Check className="w-3 h-3" />
                              )}
                              保存
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs leading-relaxed text-[var(--color-text)] break-words">
                          {memory.content}
                        </p>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
                          {memory.scope === "workspace"
                            ? `工作区记忆${memory.workspace_id ? ` · ${formatScopeTarget("workspace", memory.workspace_id)}` : ""}`
                            : memory.scope === "conversation"
                              ? `会话记忆${memory.conversation_id ? ` · ${formatScopeTarget("conversation", memory.conversation_id)}` : ""}`
                              : "全局记忆"}
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
                          title="编辑"
                        >
                          <Edit2 className="w-3 h-3 text-[var(--color-text-secondary)]" />
                        </button>
                        <button
                          onClick={() => void handleDelete(memory.id)}
                          disabled={deleteBusy}
                          className="p-1 rounded hover:bg-red-500/10 disabled:opacity-50"
                          title="删除"
                        >
                          {deleteBusy ? (
                            <Loader2 className="w-3 h-3 animate-spin text-red-400" />
                          ) : (
                            <Trash2 className="w-3 h-3 text-red-400" />
                          )}
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
