/**
 * 快捷短语 / 文本片段 插件
 *
 * 功能:
 * - 管理静态文本片段（邮箱签名、代码模板、常用回复等）
 * - 支持 AI 动态片段（实时生成内容）
 * - 搜索框 `sn ` 前缀快速触发
 * - 点击即复制到剪贴板
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSnippetStore, type Snippet } from "@/store/snippet-store";
import { invoke } from "@tauri-apps/api/core";
import type { PluginContext } from "@/core/plugin-system/context";
import { handleError } from "@/core/errors";
import {
  Plus,
  Search,
  Copy,
  Trash2,
  Edit3,
  Sparkles,
  Tag,
  Check,
  X,
  Download,
  Upload,
  ChevronLeft,
} from "lucide-react";

interface SnippetsProps {
  onBack: () => void;
  context: PluginContext;
}

export function Snippets({ onBack, context }: SnippetsProps) {
  const { ai } = context;
  const {
    snippets,
    loaded,
    loadSnippets,
    addSnippet,
    updateSnippet,
    deleteSnippet,
    searchSnippets,
    markUsed,
    getCategories,
    exportSnippets,
    importSnippets,
  } = useSnippetStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 表单状态
  const [formData, setFormData] = useState({
    title: "",
    content: "",
    keyword: "",
    category: "",
    isDynamic: false,
    dynamicPrompt: "",
  });

  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  const filteredSnippets = useMemo(() => {
    return searchSnippets(searchQuery);
  }, [searchSnippets, searchQuery, snippets]);

  const categories = useMemo(() => getCategories(), [getCategories, snippets]);

  const resetForm = useCallback(() => {
    setFormData({
      title: "",
      content: "",
      keyword: "",
      category: "",
      isDynamic: false,
      dynamicPrompt: "",
    });
    setEditingId(null);
    setShowForm(false);
  }, []);

  const handleSave = useCallback(() => {
    if (!formData.title.trim()) return;

    if (editingId) {
      updateSnippet(editingId, formData);
    } else {
      addSnippet(formData);
    }
    resetForm();
  }, [formData, editingId, updateSnippet, addSnippet, resetForm]);

  const handleEdit = useCallback((snippet: Snippet) => {
    setFormData({
      title: snippet.title,
      content: snippet.content,
      keyword: snippet.keyword,
      category: snippet.category,
      isDynamic: snippet.isDynamic,
      dynamicPrompt: snippet.dynamicPrompt,
    });
    setEditingId(snippet.id);
    setShowForm(true);
  }, []);

  const handleCopy = useCallback(
    async (snippet: Snippet) => {
      let text = snippet.content;

      // 动态片段：调用 AI 生成
      if (snippet.isDynamic && snippet.dynamicPrompt) {
        setGeneratingId(snippet.id);
        try {
          const result = await ai.chat({
            messages: [
              { role: "system", content: "你是一个文本生成助手。根据用户的提示词生成内容。直接输出生成的内容，不要解释。" },
              { role: "user", content: snippet.dynamicPrompt },
            ],
            temperature: 0.8,
          });
          text = result.content.trim();
        } catch (e) {
          handleError(e, { context: "AI 动态片段生成" });
          text = `[生成失败: ${e}]`;
        } finally {
          setGeneratingId(null);
        }
      }

      // 写入剪贴板
      try {
        await invoke("clipboard_history_write", { text });
        markUsed(snippet.id);
        setCopyFeedback(snippet.id);
        setTimeout(() => setCopyFeedback(null), 1500);
      } catch (e) {
        handleError(e, { context: "复制快捷短语到剪贴板" });
      }
    },
    [ai, markUsed],
  );

  const handleExport = useCallback(() => {
    const json = exportSnippets();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mtools-snippets.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [exportSnippets]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const count = importSnippets(reader.result as string);
        if (count > 0) {
          alert(`成功导入 ${count} 条短语`);
        } else {
          alert("未导入任何新短语（可能已存在或格式不正确）");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [importSnippets],
  );

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
        <h2 className="text-sm font-medium flex-1">快捷短语</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={handleImport}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
            title="导入"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleExport}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
            title="导出"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
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
            placeholder="搜索短语..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        {categories.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() =>
                  setSearchQuery(searchQuery === cat ? "" : cat)
                }
                className={`flex items-center gap-0.5 px-2 py-0.5 text-[10px] rounded-full transition-colors ${
                  searchQuery === cat
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
              placeholder="标题 *"
              className="w-full px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
            />
            <div className="flex gap-2">
              <input
                type="text"
                value={formData.keyword}
                onChange={(e) =>
                  setFormData({ ...formData, keyword: e.target.value })
                }
                placeholder="触发关键词"
                className="flex-1 px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              <input
                type="text"
                value={formData.category}
                onChange={(e) =>
                  setFormData({ ...formData, category: e.target.value })
                }
                placeholder="分类"
                className="flex-1 px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={formData.isDynamic}
                onChange={(e) =>
                  setFormData({ ...formData, isDynamic: e.target.checked })
                }
                className="rounded"
              />
              <Sparkles className="w-3 h-3" />
              AI 动态生成内容
            </label>
            {formData.isDynamic ? (
              <textarea
                value={formData.dynamicPrompt}
                onChange={(e) =>
                  setFormData({ ...formData, dynamicPrompt: e.target.value })
                }
                placeholder="AI 提示词模板（如：生成一个 16 位随机密码）"
                rows={2}
                className="w-full px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] resize-none"
              />
            ) : (
              <textarea
                value={formData.content}
                onChange={(e) =>
                  setFormData({ ...formData, content: e.target.value })
                }
                placeholder="片段内容"
                rows={3}
                className="w-full px-2.5 py-1.5 text-xs bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] resize-none"
              />
            )}
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
                disabled={!formData.title.trim()}
                className="px-3 py-1 text-xs rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <Check className="w-3.5 h-3.5 inline mr-0.5" />
                {editingId ? "更新" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 片段列表 */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-2">
        {filteredSnippets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)] gap-2">
            <p className="text-xs">
              {snippets.length === 0 ? "暂无短语，点击「新建」添加" : "无匹配结果"}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredSnippets.map((snippet) => (
              <div
                key={snippet.id}
                className="group flex items-start gap-2 p-2 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors cursor-pointer"
                onClick={() => handleCopy(snippet)}
                title="点击复制到剪贴板"
              >
                {/* 图标 */}
                <div className="shrink-0 mt-0.5">
                  {snippet.isDynamic ? (
                    <Sparkles className="w-4 h-4 text-amber-500" />
                  ) : (
                    <Copy className="w-4 h-4 text-[var(--color-text-secondary)]" />
                  )}
                </div>

                {/* 内容 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">
                      {snippet.title}
                    </span>
                    {snippet.keyword && (
                      <span className="shrink-0 px-1 py-0.5 text-[10px] bg-[var(--color-bg-secondary)] rounded text-[var(--color-text-secondary)]">
                        {snippet.keyword}
                      </span>
                    )}
                    {snippet.category && (
                      <span className="shrink-0 px-1 py-0.5 text-[10px] bg-blue-500/10 text-blue-500 rounded">
                        {snippet.category}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-[var(--color-text-secondary)] truncate mt-0.5">
                    {snippet.isDynamic
                      ? `🤖 ${snippet.dynamicPrompt}`
                      : snippet.content}
                  </p>
                </div>

                {/* 操作按钮 */}
                <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {copyFeedback === snippet.id ? (
                    <Check className="w-3.5 h-3.5 text-green-500" />
                  ) : generatingId === snippet.id ? (
                    <span className="text-[10px] text-amber-500 animate-pulse">
                      生成中...
                    </span>
                  ) : (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEdit(snippet);
                        }}
                        className="p-1 rounded hover:bg-[var(--color-bg-secondary)] transition-colors"
                        title="编辑"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`确定删除「${snippet.title}」？`)) {
                            deleteSnippet(snippet.id);
                          }
                        }}
                        className="p-1 rounded hover:bg-red-500/10 text-[var(--color-text-secondary)] hover:text-red-500 transition-colors"
                        title="删除"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}
