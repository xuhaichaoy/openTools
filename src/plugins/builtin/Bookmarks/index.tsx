/**
 * 网页书签管理插件
 *
 * 功能:
 * - 书签增删改查、分类管理
 * - 点击直接打开网址
 * - 从 Chrome / Firefox / Edge 导入（支持 HTML 和 Chrome JSON）
 * - 导出 JSON 备份
 * - 搜索框 `bk ` 前缀快速触发
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useBookmarkStore, type Bookmark } from "@/store/bookmark-store";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";
import {
  Plus,
  Search,
  ExternalLink,
  Trash2,
  Edit3,
  Tag,
  Check,
  X,
  Download,
  Upload,
  ChevronLeft,
  Globe,
  Star,
  FolderOpen,
} from "lucide-react";

export default function BookmarksPlugin({ onBack }: { onBack: () => void }) {
  const {
    bookmarks,
    loaded,
    loadBookmarks,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    searchBookmarks,
    markVisited,
    getCategories,
    exportBookmarks,
    importBookmarks,
    importFromBrowserHTML,
    importFromChromeJSON,
  } = useBookmarkStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importType, setImportType] = useState<"json" | "html" | "chrome">("html");

  const [formData, setFormData] = useState({
    title: "",
    url: "",
    keyword: "",
    category: "",
    favicon: "",
  });

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const filteredBookmarks = useMemo(() => {
    let results = searchBookmarks(searchQuery);
    if (selectedCategory) {
      results = results.filter((b) => b.category === selectedCategory);
    }
    return results.sort((a, b) => {
      // 按访问频率降序，再按创建时间降序
      if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
      return b.createdAt - a.createdAt;
    });
  }, [searchBookmarks, searchQuery, selectedCategory, bookmarks]);

  const categories = useMemo(
    () => getCategories(),
    [getCategories, bookmarks],
  );

  const resetForm = useCallback(() => {
    setFormData({ title: "", url: "", keyword: "", category: "", favicon: "" });
    setEditingId(null);
    setShowForm(false);
  }, []);

  const handleSave = useCallback(() => {
    if (!formData.title.trim() || !formData.url.trim()) return;
    let url = formData.url.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    if (editingId) {
      updateBookmark(editingId, { ...formData, url });
    } else {
      addBookmark({ ...formData, url });
    }
    resetForm();
  }, [formData, editingId, updateBookmark, addBookmark, resetForm]);

  const handleEdit = useCallback((bm: Bookmark) => {
    setFormData({
      title: bm.title,
      url: bm.url,
      keyword: bm.keyword,
      category: bm.category,
      favicon: bm.favicon,
    });
    setEditingId(bm.id);
    setShowForm(true);
  }, []);

  const handleOpen = useCallback(
    (bm: Bookmark) => {
      markVisited(bm.id);
      invoke("open_url", { url: bm.url }).catch((e) =>
        handleError(e, { context: "打开书签" }),
      );
    },
    [markVisited],
  );

  const handleExport = useCallback(() => {
    const json = exportBookmarks();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mtools-bookmarks.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [exportBookmarks]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        let count = 0;
        if (importType === "html") {
          count = importFromBrowserHTML(content);
        } else if (importType === "chrome") {
          count = importFromChromeJSON(content);
        } else {
          count = importBookmarks(content);
        }
        if (count > 0) {
          alert(`成功导入 ${count} 个书签`);
        } else {
          alert("未导入任何新书签（可能已存在或格式不正确）");
        }
        setShowImportMenu(false);
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [importType, importFromBrowserHTML, importFromChromeJSON, importBookmarks],
  );

  const triggerImport = useCallback(
    (type: "json" | "html" | "chrome") => {
      setImportType(type);
      setTimeout(() => fileInputRef.current?.click(), 0);
    },
    [],
  );

  /** 提取域名 */
  const getDomain = (url: string): string => {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch {
      return url;
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)]">
        加载中...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
        <button
          onClick={onBack}
          className="p-1 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
          title="返回"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <Globe className="w-4 h-4 text-blue-500" />
        <h2 className="text-sm font-medium flex-1">网页书签</h2>
        <div className="flex items-center gap-1 relative">
          {/* 导入 */}
          <div className="relative">
            <button
              onClick={() => setShowImportMenu(!showImportMenu)}
              className="p-1.5 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
              title="导入"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>
            {showImportMenu && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg z-50 py-1">
                <button
                  onClick={() => {
                    triggerImport("html");
                    setShowImportMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors flex items-center gap-2"
                >
                  <FolderOpen className="w-3 h-3 text-orange-400" />
                  从浏览器 HTML 导入
                  <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto">
                    通用
                  </span>
                </button>
                <button
                  onClick={() => {
                    triggerImport("chrome");
                    setShowImportMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors flex items-center gap-2"
                >
                  <Globe className="w-3 h-3 text-blue-400" />
                  从 Chrome JSON 导入
                  <span className="text-[10px] text-[var(--color-text-secondary)] ml-auto">
                    Bookmarks
                  </span>
                </button>
                <div className="h-px bg-[var(--color-border)] my-1" />
                <button
                  onClick={() => {
                    triggerImport("json");
                    setShowImportMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors flex items-center gap-2"
                >
                  <Download className="w-3 h-3 text-green-400" />
                  从 mTools JSON 导入
                </button>
              </div>
            )}
          </div>
          {/* 导出 */}
          <button
            onClick={handleExport}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
            title="导出"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          {/* 新建 */}
          <button
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" />
            新建
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索书签..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        {categories.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            <button
              onClick={() => setSelectedCategory("")}
              className={`flex items-center gap-0.5 px-2 py-0.5 text-[10px] rounded-full transition-colors ${
                !selectedCategory
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
              }`}
            >
              全部
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() =>
                  setSelectedCategory(selectedCategory === cat ? "" : cat)
                }
                className={`flex items-center gap-0.5 px-2 py-0.5 text-[10px] rounded-full transition-colors ${
                  selectedCategory === cat
                    ? "bg-[var(--color-accent)] text-white"
                    : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
                }`}
              >
                <Tag className="w-2.5 h-2.5" />
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 编辑表单 */}
      {showForm && (
        <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="space-y-2">
            <input
              type="text"
              value={formData.title}
              onChange={(e) =>
                setFormData({ ...formData, title: e.target.value })
              }
              placeholder="书签标题 *"
              className="w-full px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
            />
            <input
              type="text"
              value={formData.url}
              onChange={(e) =>
                setFormData({ ...formData, url: e.target.value })
              }
              placeholder="网址 * (如 github.com)"
              className="w-full px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
            />
            <div className="flex gap-2">
              <input
                type="text"
                value={formData.keyword}
                onChange={(e) =>
                  setFormData({ ...formData, keyword: e.target.value })
                }
                placeholder="触发关键词（可选）"
                className="flex-1 px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              <input
                type="text"
                value={formData.category}
                onChange={(e) =>
                  setFormData({ ...formData, category: e.target.value })
                }
                placeholder="分类（可选）"
                className="flex-1 px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <div className="flex justify-end gap-1.5">
              <button
                onClick={resetForm}
                className="px-3 py-1 text-xs rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <X className="w-3.5 h-3.5 inline mr-0.5" />
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!formData.title.trim() || !formData.url.trim()}
                className="px-3 py-1 text-xs rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <Check className="w-3.5 h-3.5 inline mr-0.5" />
                {editingId ? "更新" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 书签列表 */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-2">
        {filteredBookmarks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)] gap-2">
            <Globe className="w-8 h-8 opacity-30" />
            <p className="text-xs">
              {bookmarks.length === 0
                ? "暂无书签，点击「新建」添加或从浏览器导入"
                : "无匹配结果"}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {filteredBookmarks.map((bm) => (
              <div
                key={bm.id}
                className="group flex items-center gap-2.5 p-2 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors cursor-pointer"
                onClick={() => handleOpen(bm)}
                title={bm.url}
              >
                {/* Favicon */}
                <div className="w-7 h-7 rounded-lg bg-[var(--color-bg-secondary)] flex items-center justify-center shrink-0 overflow-hidden">
                  {bm.favicon ? (
                    <img
                      src={bm.favicon}
                      alt=""
                      className="w-4 h-4"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                        (
                          e.target as HTMLImageElement
                        ).parentElement!.innerHTML = `<span class="text-[10px] text-[var(--color-text-secondary)]">${bm.title.charAt(0).toUpperCase()}</span>`;
                      }}
                    />
                  ) : (
                    <Globe className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
                  )}
                </div>

                {/* 内容 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">
                      {bm.title}
                    </span>
                    {bm.keyword && (
                      <span className="shrink-0 px-1 py-0.5 text-[10px] bg-[var(--color-bg-secondary)] rounded text-[var(--color-text-secondary)]">
                        {bm.keyword}
                      </span>
                    )}
                    {bm.category && (
                      <span className="shrink-0 px-1 py-0.5 text-[10px] bg-blue-500/10 text-blue-500 rounded">
                        {bm.category}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-[10px] text-[var(--color-text-secondary)] truncate">
                      {getDomain(bm.url)}
                    </p>
                    {bm.visitCount > 0 && (
                      <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
                        <Star className="w-2.5 h-2.5 inline -mt-0.5 mr-0.5 text-amber-400" />
                        {bm.visitCount}
                      </span>
                    )}
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpen(bm);
                    }}
                    className="p-1 rounded hover:bg-blue-500/10 text-[var(--color-text-secondary)] hover:text-blue-500 transition-colors"
                    title="打开"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEdit(bm);
                    }}
                    className="p-1 rounded hover:bg-[var(--color-bg-secondary)] transition-colors"
                    title="编辑"
                  >
                    <Edit3 className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`确定删除「${bm.title}」？`)) {
                        deleteBookmark(bm.id);
                      }
                    }}
                    className="p-1 rounded hover:bg-red-500/10 text-[var(--color-text-secondary)] hover:text-red-500 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部统计 */}
      {bookmarks.length > 0 && (
        <div className="px-3 py-1.5 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-secondary)] flex items-center justify-between">
          <span>
            共 {bookmarks.length} 个书签
            {selectedCategory && ` · ${selectedCategory}: ${filteredBookmarks.length} 个`}
          </span>
          <span>{categories.length} 个分类</span>
        </div>
      )}

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.html,.htm"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* 点击外部关闭导入菜单 */}
      {showImportMenu && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowImportMenu(false)}
        />
      )}
    </div>
  );
}
