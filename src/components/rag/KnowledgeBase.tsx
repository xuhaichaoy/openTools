import { useState, useEffect, useRef } from "react";
import {
  ArrowLeft, Upload, Trash2, RefreshCw, Search, BookOpen,
  HardDrive, FileText, AlertCircle, CheckCircle, Loader2,
  Cloud, Users, Plus, Download, Edit3, Save, Eye, Database,
} from "lucide-react";
import { handleError } from "@/core/errors";
import { useRAGStore } from "@/store/rag-store";
import { useAuthStore } from "@/store/auth-store";
import { useTeamStore } from "@/store/team-store";
import { useKbStore, type KbScope, type KbCloudDoc } from "@/store/kb-store";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useDragWindow } from "@/hooks/useDragWindow";

const BRAND = "#F28F36";
const EMERALD = "#34D399";
const BLUE = "#60A5FA";

export function KnowledgeBase({ onBack }: { onBack?: () => void }) {
  const rag = useRAGStore();
  const { isLoggedIn } = useAuthStore();
  const { teams, loadTeams } = useTeamStore();
  const kb = useKbStore();
  const { onMouseDown } = useDragWindow();

  useEffect(() => {
    rag.loadDocs();
    rag.loadStats();
    if (isLoggedIn) {
      loadTeams();
      kb.loadPersonalDocs();
    }
  }, [isLoggedIn]);

  useEffect(() => {
    if (isLoggedIn) {
      teams.forEach((t) => {
        if (!kb.teamDocs[t.id]) {
          kb.loadTeamDocs(t.id);
        }
      });
    }
  }, [isLoggedIn, teams]);

  const scopeLabel = (scope: KbScope) => {
    if (scope.type === "indexed") return "已索引文档";
    if (scope.type === "search") return "语义搜索";
    if (scope.type === "personal") return "个人文档";
    if (scope.type === "team") return scope.teamName;
    return "";
  };

  return (
    <div className="bg-[var(--color-bg)] overflow-hidden flex flex-col h-full">
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <div className="flex items-center gap-2">
          {onBack && (
            <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <BookOpen className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-medium text-[var(--color-text)]">知识库与文档</span>
          <span className="text-[10px] text-[var(--color-text-secondary)] ml-1">{scopeLabel(kb.activeScope)}</span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-48 shrink-0 border-r border-[var(--color-border)] overflow-y-auto bg-[var(--color-bg-secondary)]">
          <SidebarTree
            activeScope={kb.activeScope}
            onSelectScope={kb.setScope}
            indexedDocCount={rag.docs.length}
            personalDocCount={kb.personalDocs.length}
            teams={teams}
            teamDocs={kb.teamDocs}
            isLoggedIn={isLoggedIn}
          />
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          {kb.activeScope.type === "indexed" && <IndexedDocsPanel />}
          {kb.activeScope.type === "search" && <SearchPanel />}
          {kb.activeScope.type === "personal" && <CloudPanel scope="personal" />}
          {kb.activeScope.type === "team" && (
            <CloudPanel scope="team" teamId={kb.activeScope.teamId} teamName={kb.activeScope.teamName} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── 左侧树形导航 ──

interface SidebarTreeProps {
  activeScope: KbScope;
  onSelectScope: (scope: KbScope) => void;
  indexedDocCount: number;
  personalDocCount: number;
  teams: { id: string; name: string }[];
  teamDocs: Record<string, KbCloudDoc[]>;
  isLoggedIn: boolean;
}

function SidebarTree({
  activeScope, onSelectScope,
  indexedDocCount, personalDocCount, teams, teamDocs, isLoggedIn,
}: SidebarTreeProps) {
  const isActive = (scope: KbScope) => {
    if (scope.type === activeScope.type) {
      if (scope.type === "team" && activeScope.type === "team") {
        return scope.teamId === activeScope.teamId;
      }
      return true;
    }
    return false;
  };

  return (
    <div className="py-2 text-xs">
      {/* 知识库分组 */}
      <div className="px-3 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
        知识库
      </div>
      <TreeItem
        icon={<Database className="w-3.5 h-3.5" />}
        label="已索引文档"
        count={indexedDocCount}
        active={isActive({ type: "indexed" })}
        onClick={() => onSelectScope({ type: "indexed" })}
        color={EMERALD}
      />
      <TreeItem
        icon={<Search className="w-3.5 h-3.5" />}
        label="语义搜索"
        count={0}
        active={isActive({ type: "search" })}
        onClick={() => onSelectScope({ type: "search" })}
        color={EMERALD}
      />

      {/* 文档空间分组 */}
      {isLoggedIn && (
        <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
          <div className="px-3 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
            文档空间
          </div>
          <TreeItem
            icon={<Cloud className="w-3.5 h-3.5" />}
            label="个人文档"
            count={personalDocCount}
            active={isActive({ type: "personal" })}
            onClick={() => onSelectScope({ type: "personal" })}
            color={BLUE}
          />
          {teams.map((team) => (
            <TreeItem
              key={team.id}
              icon={<Users className="w-3.5 h-3.5" />}
              label={team.name}
              count={teamDocs[team.id]?.length ?? 0}
              active={isActive({ type: "team", teamId: team.id, teamName: team.name })}
              onClick={() => onSelectScope({ type: "team", teamId: team.id, teamName: team.name })}
              color={BRAND}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeItem({
  icon, label, count, active, onClick, color,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors"
      style={{
        background: active ? `${color}15` : "transparent",
        color: active ? color : "var(--color-text-secondary)",
      }}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && (
        <span
          className="text-[9px] px-1.5 py-0.5 rounded-full"
          style={{ background: `${color}15`, color }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ── 已索引文档面板 ──

function IndexedDocsPanel() {
  const {
    docs, stats, isLoading, isIndexing,
    loadDocs, importDoc, removeDoc, reindexDoc, loadStats,
  } = useRAGStore();
  const { teams } = useTeamStore();

  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "文档", extensions: ["txt", "md", "json", "csv", "html"] },
        ],
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        for (const filePath of paths) {
          if (filePath) await importDoc(filePath);
        }
      }
    } catch (e) {
      handleError(e, { context: "导入文档" });
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "indexed": return <CheckCircle className="w-3.5 h-3.5 text-green-400" />;
      case "processing": return <Loader2 className="w-3.5 h-3.5 text-yellow-400 animate-spin" />;
      case "error": return <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
      default: return <FileText className="w-3.5 h-3.5 text-gray-400" />;
    }
  };

  const getSourceLabel = (doc: { sourceType?: string; sourceId?: string }) => {
    const st = doc.sourceType || "local";
    if (st === "personal") return { text: "个人文档", color: BLUE };
    if (st === "team") {
      const team = teams.find((t) => t.id === doc.sourceId);
      return { text: team ? team.name : "团队", color: BRAND };
    }
    return { text: "本地导入", color: "#9CA3AF" };
  };

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
        <div className="text-xs font-medium text-[var(--color-text)]">已索引文档</div>
        <button
          onClick={handleImport}
          disabled={isIndexing}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-40 transition-colors"
        >
          {isIndexing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          导入本地文件
        </button>
      </div>

      {stats && (
        <div className="flex items-center gap-4 px-4 py-1.5 text-[10px] text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]">
          <span>{stats.totalDocs} 篇文档</span>
          <span>{stats.totalChunks} 个分块</span>
          <span>~{stats.totalTokens.toLocaleString()} tokens</span>
          <span><HardDrive className="w-3 h-3 inline mr-0.5" />{formatSize(stats.indexSize)}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-2">
          {isLoading && (
            <div className="text-center py-8 text-[var(--color-text-secondary)]">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
              <span className="text-xs">加载中...</span>
            </div>
          )}
          {!isLoading && docs.length === 0 && (
            <EmptyState icon={BookOpen} text="暂无已索引文档" hint={'点击「导入本地文件」或从文档空间「索引到知识库」'} />
          )}
          {docs.map((doc) => {
            const source = getSourceLabel(doc);
            return (
              <div
                key={doc.id}
                className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-emerald-500/30 transition-colors"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {getStatusIcon(doc.status)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-[var(--color-text)] truncate">{doc.name}</span>
                      <span
                        className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0"
                        style={{ background: `${source.color}15`, color: source.color }}
                      >
                        {source.text}
                      </span>
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-2 mt-0.5">
                      <span>{doc.chunkCount} 块</span>
                      <span>~{doc.tokenCount} tokens</span>
                      <span>{formatSize(doc.size)}</span>
                    </div>
                    {doc.errorMsg && (
                      <div className="text-[10px] text-red-400 mt-0.5 truncate">{doc.errorMsg}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <IconButton onClick={() => reindexDoc(doc.id)} disabled={isIndexing} title="重建索引">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton onClick={() => removeDoc(doc.id)} title="从知识库移除" hoverColor="red-500">
                    <Trash2 className="w-3.5 h-3.5" />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── 语义搜索面板 ──

function SearchPanel() {
  const {
    searchResults, searchQuery,
    search, setSearchQuery,
  } = useRAGStore();

  const handleSearch = () => {
    if (!searchQuery.trim()) return;
    search(searchQuery.trim());
  };

  return (
    <>
      <div className="flex items-center px-4 py-2 border-b border-[var(--color-border)]">
        <div className="text-xs font-medium text-[var(--color-text)]">语义搜索</div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-emerald-400"
              placeholder="输入检索内容，从所有已索引文档中搜索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
            <button
              onClick={handleSearch}
              disabled={!searchQuery.trim()}
              className="px-3 py-2 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 transition-colors flex items-center gap-1"
            >
              <Search className="w-3 h-3" />
              检索
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                找到 {searchResults.length} 个相关片段
              </div>
              {searchResults.map((result, i) => (
                <div key={i} className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] text-emerald-400 font-medium">{result.chunk.metadata.source}</span>
                    <span className="text-[10px] text-[var(--color-text-secondary)]">
                      相似度: {(result.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">
                    {result.chunk.content.length > 300
                      ? result.chunk.content.slice(0, 300) + "..."
                      : result.chunk.content}
                  </p>
                </div>
              ))}
            </div>
          )}
          {searchResults.length === 0 && !searchQuery && (
            <EmptyState icon={Search} text="输入关键词后点击检索" hint="搜索范围：所有已索引文档" />
          )}
          {searchResults.length === 0 && searchQuery && (
            <EmptyState icon={Search} text="未找到相关内容" hint="尝试换个关键词，或先导入更多文档" />
          )}
        </div>
      </div>
    </>
  );
}

// ── 云端面板（个人 / 团队共用） ──

function CloudPanel({
  scope,
  teamId,
  teamName,
}: {
  scope: "personal" | "team";
  teamId?: string;
  teamName?: string;
}) {
  const kb = useKbStore();
  const ragDocs = useRAGStore((s) => s.docs);
  const [creating, setCreating] = useState(false);
  const [editingDoc, setEditingDoc] = useState<KbCloudDoc | null>(null);
  const [viewingDoc, setViewingDoc] = useState<KbCloudDoc | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const docs = scope === "personal" ? kb.personalDocs : (teamId ? kb.teamDocs[teamId] || [] : []);
  const color = scope === "personal" ? BLUE : BRAND;

  const isDocIndexed = (docName: string) => {
    return ragDocs.some((d) => d.name === docName && d.sourceType === scope);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      if (scope === "personal") {
        await kb.uploadPersonalDoc(file);
      } else if (teamId) {
        await kb.uploadTeamDoc(teamId, file);
      }
    } catch (err) {
      handleError(err, { context: "上传文档" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleDelete = async (docId: string) => {
    try {
      if (scope === "personal") {
        await kb.deletePersonalDoc(docId);
      } else if (teamId) {
        await kb.deleteTeamDoc(teamId, docId);
      }
    } catch (err) {
      handleError(err, { context: "删除文档" });
    }
  };

  const handleView = async (doc: KbCloudDoc) => {
    try {
      const fullDoc = scope === "personal"
        ? await kb.getDocContent(doc.id)
        : await kb.getTeamDocContent(teamId!, doc.id);
      setViewingDoc(fullDoc);
    } catch (err) {
      handleError(err, { context: "查看文档" });
    }
  };

  const handleEdit = async (doc: KbCloudDoc) => {
    try {
      const fullDoc = scope === "personal"
        ? await kb.getDocContent(doc.id)
        : await kb.getTeamDocContent(teamId!, doc.id);
      setEditingDoc(fullDoc);
    } catch (err) {
      handleError(err, { context: "加载文档" });
    }
  };

  const [indexingId, setIndexingId] = useState<string | null>(null);
  const handleIndexToKb = async (doc: KbCloudDoc) => {
    setIndexingId(doc.id);
    try {
      const fullDoc = scope === "personal"
        ? await kb.getDocContent(doc.id)
        : await kb.getTeamDocContent(teamId!, doc.id);
      await invoke("rag_import_from_content", {
        name: fullDoc.name,
        content: fullDoc.content || "",
        format: fullDoc.format,
        tags: fullDoc.tags || [],
        sourceType: scope,
        sourceId: scope === "team" ? teamId : undefined,
      });
      useRAGStore.getState().loadDocs();
      useRAGStore.getState().loadStats();
    } catch (err) {
      handleError(err, { context: "索引到知识库" });
    } finally {
      setIndexingId(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (editingDoc) {
    return (
      <DocEditor
        doc={editingDoc}
        scope={scope}
        teamId={teamId}
        onClose={() => setEditingDoc(null)}
        color={color}
      />
    );
  }

  if (viewingDoc) {
    return (
      <DocViewer
        doc={viewingDoc}
        onClose={() => setViewingDoc(null)}
        onEdit={() => { setViewingDoc(null); handleEdit(viewingDoc); }}
        color={color}
      />
    );
  }

  if (creating) {
    return (
      <DocCreator
        scope={scope}
        teamId={teamId}
        onClose={() => setCreating(false)}
        color={color}
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
        <div className="text-xs font-medium text-[var(--color-text)]">
          {scope === "personal" ? "个人文档" : `${teamName} · 团队文档`}
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".txt,.md,.json,.csv,.html" onChange={handleUpload} className="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
          >
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            上传
          </button>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg text-white transition-colors"
            style={{ background: color }}
          >
            <Plus className="w-3 h-3" />
            新建
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {kb.loading && (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
            <span className="text-xs">加载中...</span>
          </div>
        )}
        {!kb.loading && docs.length === 0 && (
          <EmptyState
            icon={scope === "personal" ? Cloud : Users}
            text={scope === "personal" ? "暂无个人文档" : "团队暂无文档"}
            hint={'点击「新建」创建文档或「上传」导入文件'}
          />
        )}
        <div className="space-y-2">
          {docs.map((doc) => {
            const indexed = isDocIndexed(doc.name);
            return (
              <div
                key={doc.id}
                className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] transition-colors"
                style={{ borderColor: "var(--color-border)" }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = `${color}40`)}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <FileText className="w-3.5 h-3.5 shrink-0" style={{ color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-[var(--color-text)] truncate">{doc.name}</span>
                      {indexed && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 bg-emerald-500/10 text-emerald-500">
                          已索引
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-2 mt-0.5">
                      <span className="uppercase">{doc.format}</span>
                      <span>{formatSize(doc.size)}</span>
                      {doc.uploader_name && <span>{doc.uploader_name}</span>}
                      <span>{new Date(doc.updated_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <IconButton
                    onClick={() => handleIndexToKb(doc)}
                    disabled={indexingId === doc.id}
                    title={indexed ? "重新索引到知识库" : "索引到知识库"}
                  >
                    {indexingId === doc.id
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Download className="w-3.5 h-3.5" />
                    }
                  </IconButton>
                  <IconButton onClick={() => handleView(doc)} title="查看">
                    <Eye className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton onClick={() => handleEdit(doc)} title="编辑">
                    <Edit3 className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton onClick={() => handleDelete(doc.id)} title="删除" hoverColor="red-500">
                    <Trash2 className="w-3.5 h-3.5" />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── 内联文档创建器 ──

function DocCreator({
  scope, teamId, onClose, color,
}: {
  scope: "personal" | "team";
  teamId?: string;
  onClose: () => void;
  color: string;
}) {
  const kb = useKbStore();
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [format, setFormat] = useState("md");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!name.trim()) { setError("请输入文档标题"); return; }
    if (!content.trim()) { setError("文档内容不能为空"); return; }
    setSaving(true);
    setError("");
    try {
      if (scope === "personal") {
        await kb.createPersonalDoc(name.trim(), content, format);
      } else if (teamId) {
        await kb.createTeamDoc(teamId, name.trim(), content, format);
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-medium text-[var(--color-text)]">新建文档</span>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg text-white disabled:opacity-50"
          style={{ background: color }}
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          保存
        </button>
      </div>

      <div className="p-4 space-y-3 flex-1 flex flex-col">
        <div className="flex gap-2">
          <input
            autoFocus
            type="text"
            placeholder="文档标题"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
          />
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-2 py-2 outline-none border border-[var(--color-border)]"
          >
            <option value="md">Markdown</option>
            <option value="txt">纯文本</option>
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
            <option value="html">HTML</option>
          </select>
        </div>
        {error && <p className="text-[10px] text-red-500">{error}</p>}
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="在这里编写文档内容..."
          className="flex-1 bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] resize-none font-mono leading-relaxed focus:border-[var(--color-accent)]"
        />
      </div>
    </div>
  );
}

// ── 内联文档编辑器 ──

function DocEditor({
  doc, scope, teamId, onClose, color,
}: {
  doc: KbCloudDoc;
  scope: "personal" | "team";
  teamId?: string;
  onClose: () => void;
  color: string;
}) {
  const kb = useKbStore();
  const [name, setName] = useState(doc.name);
  const [content, setContent] = useState(doc.content || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      if (scope === "personal") {
        await kb.updateDoc(doc.id, { name: name.trim(), content });
      } else if (teamId) {
        await kb.updateTeamDoc(teamId, doc.id, { name: name.trim(), content });
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-xs font-medium text-[var(--color-text)] bg-transparent outline-none border-b border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)] px-1 py-0.5"
          />
          <span className="text-[10px] text-[var(--color-text-secondary)] uppercase">{doc.format}</span>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg text-white disabled:opacity-50"
          style={{ background: color }}
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          保存
        </button>
      </div>
      {error && <p className="text-[10px] text-red-500 px-4 pt-1">{error}</p>}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="flex-1 bg-[var(--color-bg)] text-[var(--color-text)] text-xs px-4 py-3 outline-none resize-none font-mono leading-relaxed"
      />
    </div>
  );
}

// ── 文档查看器 ──

function DocViewer({
  doc, onClose, onEdit, color,
}: {
  doc: KbCloudDoc;
  onClose: () => void;
  onEdit: () => void;
  color: string;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-medium text-[var(--color-text)]">{doc.name}</span>
          <span className="text-[10px] text-[var(--color-text-secondary)] uppercase">{doc.format}</span>
        </div>
        <button
          onClick={onEdit}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
        >
          <Edit3 className="w-3 h-3" />
          编辑
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <pre className="text-xs text-[var(--color-text)] whitespace-pre-wrap font-mono leading-relaxed">
          {doc.content || "(无内容)"}
        </pre>
      </div>
    </div>
  );
}

// ── 通用小组件 ──

function IconButton({
  onClick, disabled, title, children, hoverColor,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  hoverColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded text-[var(--color-text-secondary)] transition-colors ${
        hoverColor
          ? `hover:bg-${hoverColor}/10 hover:text-${hoverColor}`
          : "hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
      } disabled:opacity-40`}
      title={title}
    >
      {children}
    </button>
  );
}

function EmptyState({
  icon: Icon, text, hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
  hint?: string;
}) {
  return (
    <div className="text-center py-8 text-[var(--color-text-secondary)]">
      <Icon className="w-10 h-10 mx-auto mb-3 opacity-30" />
      <p className="text-xs">{text}</p>
      {hint && <p className="text-[10px] mt-1">{hint}</p>}
    </div>
  );
}
