import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Sparkles,
  FileText,
  CheckSquare,
  Loader2,
  Copy,
  Check,
  Save,
  RefreshCw,
} from "lucide-react";
import { writeTextFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { BaseDirectory } from "@tauri-apps/plugin-fs";
import { marksDb, type Mark } from "@/core/database/marks";
import {
  marksToMarkdown,
  NOTE_TEMPLATES,
  type NoteTemplate,
} from "./utils/mark-to-md";
import {
  emitPluginEvent,
  PluginEventTypes,
} from "@/core/plugin-system/event-bus";
import { handleError } from "@/core/errors";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";

interface AINotePluginProps {
  onBack?: () => void;
  ai?: MToolsAI;
}

const AINotePlugin: React.FC<AINotePluginProps> = ({ onBack, ai }) => {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [template, setTemplate] = useState<NoteTemplate>(NOTE_TEMPLATES[0]);
  const [generatedNote, setGeneratedNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // 加载所有 Marks
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const all = await marksDb.getAll();
        setMarks(all.filter((m) => !m.archived));
      } catch (e) {
        handleError(e, { context: "加载 AI 笔记录入内容" });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (selectedIds.size === marks.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(marks.map((m) => m.id)));
    }
  }, [marks, selectedIds]);

  const handleGenerate = useCallback(async () => {
    if (!ai || selectedIds.size === 0) return;
    setGenerating(true);
    setGeneratedNote("");

    const selected = marks.filter((m) => selectedIds.has(m.id));
    const rawMd = marksToMarkdown(selected);

    try {
      await ai.stream({
        messages: [
          { role: "system", content: template.systemPrompt },
          {
            role: "user",
            content: `请将以下碎片化录入内容整理成笔记：\n\n${rawMd}`,
          },
        ],
        onChunk: (chunk) => {
          setGeneratedNote((prev) => prev + chunk);
        },
        onDone: (full) => {
          setGeneratedNote(full);
          setGenerating(false);
        },
      });
    } catch (e) {
      setGeneratedNote(`生成失败: ${e}`);
      setGenerating(false);
    }
  }, [ai, selectedIds, marks, template]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(generatedNote);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [generatedNote]);

  const handleSave = useCallback(async () => {
    if (!generatedNote) return;
    try {
      if (!(await exists("notes", { baseDir: BaseDirectory.AppData }))) {
        await mkdir("notes", {
          baseDir: BaseDirectory.AppData,
          recursive: true,
        });
      }
      const fileName = `AI-Note-${new Date().toISOString().slice(0, 10)}-${Date.now()}.md`;
      await writeTextFile(`notes/${fileName}`, generatedNote, {
        baseDir: BaseDirectory.AppData,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      // 通知其他插件
      emitPluginEvent(PluginEventTypes.NOTE_GENERATED, "ai-note-gen", {
        fileName,
        content: generatedNote,
      });
      // 标记已使用的 Marks
      for (const id of selectedIds) {
        await marksDb.update(id, { usedInNote: true });
      }
    } catch (e) {
      handleError(e, { context: "保存 AI 笔记到文件" });
    }
  }, [generatedNote, selectedIds]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
            >
              ←
            </button>
          )}
          <Sparkles className="w-5 h-5 text-yellow-500" />
          <h2 className="font-semibold">AI 笔记生成</h2>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：选择录入内容 */}
        <div className="w-72 border-r border-[var(--color-border)] flex flex-col">
          <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center justify-between">
            <span className="text-sm font-medium">
              选择录入 ({selectedIds.size}/{marks.length})
            </span>
            <button
              onClick={selectAll}
              className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              {selectedIds.size === marks.length ? "取消全选" : "全选"}
            </button>
          </div>

          {/* 模板选择 */}
          <div className="px-3 py-2 border-b border-[var(--color-border)]">
            <label className="text-xs text-[var(--color-text-secondary)] mb-1 block">
              生成模板
            </label>
            <select
              value={template.id}
              onChange={(e) =>
                setTemplate(
                  NOTE_TEMPLATES.find((t) => t.id === e.target.value) ??
                    NOTE_TEMPLATES[0],
                )
              }
              className="w-full text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-2 py-1.5"
            >
              {NOTE_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} - {t.description}
                </option>
              ))}
            </select>
          </div>

          {/* Mark 列表 */}
          <div className="flex-1 overflow-auto p-2 space-y-1">
            {loading ? (
              <div className="flex items-center justify-center h-20">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : marks.length === 0 ? (
              <p className="text-center text-[var(--color-text-secondary)] text-sm py-8">
                暂无录入内容
                <br />
                请先使用"快速录入"插件添加内容
              </p>
            ) : (
              marks.map((mark) => (
                <button
                  key={mark.id}
                  onClick={() => toggleSelect(mark.id)}
                  className={`w-full text-left p-2 rounded-md text-sm transition-colors flex items-start gap-2 ${
                    selectedIds.has(mark.id)
                      ? "bg-yellow-500/10 border border-yellow-500/30"
                      : "hover:bg-[var(--color-bg-secondary)] border border-transparent"
                  }`}
                >
                  <div
                    className={`shrink-0 w-4 h-4 rounded border mt-0.5 flex items-center justify-center ${
                      selectedIds.has(mark.id)
                        ? "bg-yellow-500 border-yellow-500"
                        : "border-[var(--color-border)]"
                    }`}
                  >
                    {selectedIds.has(mark.id) && (
                      <Check className="w-3 h-3 text-white" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-xs">
                      {mark.title || mark.content.slice(0, 50)}
                    </p>
                    <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                      {mark.type} ·{" "}
                      {new Date(mark.createdAt).toLocaleDateString("zh-CN")}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* 生成按钮 */}
          <div className="p-3 border-t border-[var(--color-border)]">
            <button
              onClick={handleGenerate}
              disabled={selectedIds.size === 0 || generating || !ai}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 transition-colors text-sm font-medium disabled:opacity-50"
            >
              {generating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              {generating ? "生成中..." : "AI 生成笔记"}
            </button>
          </div>
        </div>

        {/* 右侧：生成结果 */}
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
            <span className="text-sm font-medium">生成结果</span>
            <div className="flex gap-1">
              {generatedNote && (
                <>
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-[var(--color-bg-secondary)] rounded hover:bg-[var(--color-bg-tertiary)]"
                  >
                    {copied ? (
                      <Check className="w-3 h-3 text-green-500" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    {copied ? "已复制" : "复制"}
                  </button>
                  <button
                    onClick={handleSave}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-yellow-500 text-white rounded hover:bg-yellow-600"
                  >
                    {saved ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <Save className="w-3 h-3" />
                    )}
                    {saved ? "已保存" : "保存到笔记"}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="flex-1 p-3 overflow-auto">
            {generating && !generatedNote && (
              <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
                <Loader2 className="w-5 h-5 animate-spin text-yellow-500" />
                <span className="text-sm">AI 正在生成笔记...</span>
              </div>
            )}
            {generatedNote ? (
              <textarea
                ref={noteRef}
                value={generatedNote}
                onChange={(e) => setGeneratedNote(e.target.value)}
                className="w-full h-full bg-transparent resize-none text-sm leading-relaxed focus:outline-none font-mono"
              />
            ) : (
              !generating && (
                <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)]">
                  <Sparkles className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-sm">选择录入内容后点击生成</p>
                  <p className="text-xs mt-1 opacity-60">
                    AI 将根据模板整理成结构化笔记
                  </p>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AINotePlugin;
