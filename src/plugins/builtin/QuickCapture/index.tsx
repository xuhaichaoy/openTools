import React, { useState, useCallback, useRef } from "react";
import {
  PenLine,
  Image,
  Link2,
  FileText,
  Mic,
  CheckSquare,
  ScanText,
  Plus,
  Trash2,
  Tag,
  Search,
  X,
  Clock,
  Loader2,
} from "lucide-react";
import { useMarks } from "./hooks/useMarks";
import {
  emitPluginEvent,
  PluginEventTypes,
} from "@/core/plugin-system/event-bus";
import type { MarkType } from "@/core/database/marks";

const TYPE_ICONS: Record<MarkType, React.ReactNode> = {
  text: <PenLine className="w-4 h-4" />,
  image: <Image className="w-4 h-4" />,
  link: <Link2 className="w-4 h-4" />,
  file: <FileText className="w-4 h-4" />,
  recording: <Mic className="w-4 h-4" />,
  todo: <CheckSquare className="w-4 h-4" />,
  scan: <ScanText className="w-4 h-4" />,
};

const TYPE_COLORS: Record<MarkType, string> = {
  text: "text-blue-500 bg-blue-500/10",
  image: "text-green-500 bg-green-500/10",
  link: "text-purple-500 bg-purple-500/10",
  file: "text-orange-500 bg-orange-500/10",
  recording: "text-red-500 bg-red-500/10",
  todo: "text-teal-500 bg-teal-500/10",
  scan: "text-amber-500 bg-amber-500/10",
};

const TYPE_LABELS: Record<MarkType, string> = {
  text: "文本",
  image: "图片",
  link: "链接",
  file: "文件",
  recording: "录音",
  todo: "待办",
  scan: "扫描",
};

const QuickCapturePlugin: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const {
    marks,
    tags,
    loading,
    activeTag,
    setActiveTag,
    searchKeyword,
    setSearchKeyword,
    addMark,
    removeMark,
    updateMark,
    addTag,
    removeTag,
  } = useMarks();

  const [inputType, setInputType] = useState<MarkType>("text");
  const [inputContent, setInputContent] = useState("");
  const [inputTags, setInputTags] = useState<string[]>([]);
  const [showTagInput, setShowTagInput] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(async () => {
    console.log("[QuickCapture] handleSubmit called", {
      type: inputType,
      content: inputContent,
    });
    if (!inputContent.trim()) return;
    try {
      await addMark(inputType, inputContent.trim(), { tags: inputTags });
      console.log("[QuickCapture] addMark success");
      emitPluginEvent(PluginEventTypes.MARK_CREATED, "quick-capture", {
        type: inputType,
        content: inputContent.trim(),
        tags: inputTags,
      });
      setInputContent("");
      setInputTags([]);
      inputRef.current?.focus();
    } catch (error) {
      console.error("[QuickCapture] Failed to add mark:", error);
    }
  }, [inputType, inputContent, inputTags, addMark]);

  const handleAddTag = useCallback(async () => {
    if (!newTagName.trim()) return;
    await addTag(newTagName.trim());
    setNewTagName("");
    setShowTagInput(false);
  }, [newTagName, addTag]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return d.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

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
          <PenLine className="w-5 h-5 text-cyan-500" />
          <h2 className="font-semibold">快速录入</h2>
          <span className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] px-2 py-0.5 rounded-full">
            {marks.length} 条
          </span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：标签栏 */}
        <div className="w-32 border-r border-[var(--color-border)] flex flex-col bg-[var(--color-bg-secondary)]/30">
          <button
            onClick={() => setActiveTag(null)}
            className={`px-3 py-2 text-sm text-left hover:bg-[var(--color-bg-secondary)] transition-colors ${
              !activeTag ? "bg-[var(--color-bg-secondary)] font-medium" : ""
            }`}
          >
            全部
          </button>
          {tags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => setActiveTag(tag.name)}
              className={`px-3 py-2 text-sm text-left hover:bg-[var(--color-bg-secondary)] transition-colors flex items-center gap-1.5 ${
                activeTag === tag.name
                  ? "bg-[var(--color-bg-secondary)] font-medium"
                  : ""
              }`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: tag.color || "#6b7280" }}
              />
              <span className="truncate">{tag.name}</span>
            </button>
          ))}
          <button
            onClick={() => setShowTagInput(!showTagInput)}
            className="px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> 新标签
          </button>
          {showTagInput && (
            <div className="px-2 pb-2">
              <input
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                placeholder="标签名..."
                className="w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
                autoFocus
              />
            </div>
          )}
        </div>

        {/* 右侧：主内容 */}
        <div className="flex-1 flex flex-col">
          {/* 输入区域 */}
          <div className="p-3 border-b border-[var(--color-border)]">
            {/* 类型选择 */}
            <div className="flex gap-1 mb-2">
              {(Object.keys(TYPE_ICONS) as MarkType[]).map((type) => (
                <button
                  key={type}
                  onClick={() => setInputType(type)}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                    inputType === type
                      ? TYPE_COLORS[type] + " font-medium"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  }`}
                >
                  {TYPE_ICONS[type]}
                  {TYPE_LABELS[type]}
                </button>
              ))}
            </div>

            {/* 输入框 */}
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={inputContent}
                onChange={(e) => setInputContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder={`输入${TYPE_LABELS[inputType]}内容... (Cmd+Enter 保存)`}
                rows={2}
                className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              />
              <button
                onClick={handleSubmit}
                disabled={!inputContent.trim()}
                className="self-end px-3 py-2 bg-cyan-500 text-white rounded-lg hover:bg-cyan-600 transition-colors text-sm font-medium disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 搜索 */}
          <div className="px-3 py-2 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2 bg-[var(--color-bg-secondary)] rounded-lg px-2">
              <Search className="w-4 h-4 text-[var(--color-text-secondary)]" />
              <input
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                placeholder="搜索录入内容..."
                className="flex-1 py-1.5 bg-transparent text-sm focus:outline-none"
              />
              {searchKeyword && (
                <button onClick={() => setSearchKeyword("")}>
                  <X className="w-3 h-3 text-[var(--color-text-secondary)]" />
                </button>
              )}
            </div>
          </div>

          {/* 列表 */}
          <div className="flex-1 overflow-auto p-3 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-5 h-5 animate-spin text-cyan-500" />
              </div>
            ) : marks.length === 0 ? (
              <div className="text-center text-[var(--color-text-secondary)] py-12">
                <PenLine className="w-10 h-10 mx-auto mb-2 opacity-20" />
                <p className="text-sm">暂无录入内容</p>
                <p className="text-xs mt-1 opacity-60">
                  使用上方输入框快速记录
                </p>
              </div>
            ) : (
              marks.map((mark) => (
                <div
                  key={mark.id}
                  className="group flex gap-3 p-3 bg-[var(--color-bg-secondary)] rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
                >
                  <div
                    className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${TYPE_COLORS[mark.type]}`}
                  >
                    {TYPE_ICONS[mark.type]}
                  </div>
                  <div className="flex-1 min-w-0">
                    {mark.title && (
                      <p className="text-sm font-medium truncate">
                        {mark.title}
                      </p>
                    )}
                    <p className="text-sm text-[var(--color-text-secondary)] line-clamp-2 break-all">
                      {mark.content}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-[var(--color-text-secondary)] flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatTime(mark.createdAt)}
                      </span>
                      {mark.tags.map((t) => (
                        <span
                          key={t}
                          className="text-xs px-1.5 py-0.5 bg-[var(--color-bg)] rounded"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => removeMark(mark.id)}
                    className="self-start opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/10 hover:text-red-500 rounded transition-all"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuickCapturePlugin;
