import React, { useEffect, useState, useCallback, useRef } from "react";
import { Send, X, FileText, Folder, File } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { InputAttachment } from "@/hooks/use-input-attachments";
import { AttachDropdown } from "@/components/ui/AttachDropdown";

interface AgentInputBarProps {
  running: boolean;
  ai: boolean;
  hasExistingTasks: boolean;
  onRun: () => void;
  onStop: () => void;
  input: string;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  pendingImagePreviews: string[];
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveImage: (index: number) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  attachments?: InputAttachment[];
  onRemoveAttachment?: (id: string) => void;
  onFolderSelect?: () => void;
  onFileSelectNative?: () => void;
  onAddFilePath?: (path: string) => void;
}

export function AgentInputBar({
  running,
  ai,
  hasExistingTasks,
  onRun,
  onStop,
  input,
  onInputChange,
  onKeyDown,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  pendingImagePreviews,
  onFileSelect,
  onRemoveImage,
  inputRef,
  fileInputRef,
  attachments,
  onRemoveAttachment,
  onFolderSelect,
  onFileSelectNative,
  onAddFilePath,
}: AgentInputBarProps) {
  const useAttachments = attachments && onRemoveAttachment;
  const hasAttachments = useAttachments ? attachments.length > 0 : pendingImagePreviews.length > 0;

  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [atSuggestions, setAtSuggestions] = useState<{ name: string; path: string; isDir: boolean }[]>([]);
  const [atSelectedIdx, setAtSelectedIdx] = useState(0);
  const atMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 9 * 16) + "px";
  }, [input]);

  const fetchAtSuggestions = useCallback(async (query: string) => {
    try {
      if (query === "/") {
        const commonRoots = [
          { name: "Users", path: "/Users", isDir: true },
          { name: "tmp", path: "/tmp", isDir: true },
          { name: "opt", path: "/opt", isDir: true },
          { name: "usr", path: "/usr", isDir: true },
          { name: "Applications", path: "/Applications", isDir: true },
          { name: "Library", path: "/Library", isDir: true },
        ];
        setAtSuggestions(commonRoots);
        setAtSelectedIdx(0);
        return;
      }
      const lastSlash = query.lastIndexOf("/");
      const dirPath = query.slice(0, lastSlash) || "/";
      const lastPart = query.slice(lastSlash + 1).toLowerCase();
      const raw = await invoke<string>("list_directory", { path: dirPath });
      const entries = JSON.parse(raw) as { name: string; is_dir: boolean }[];
      const filtered = entries
        .filter((e) => !e.name.startsWith("."))
        .filter((e) => !lastPart || e.name.toLowerCase().startsWith(lastPart))
        .sort((a, b) => {
          if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 15)
        .map((e) => ({
          name: e.name,
          path: `${dirPath === "/" ? "" : dirPath}/${e.name}`.replace(/\/+/g, "/"),
          isDir: e.is_dir,
        }));
      setAtSuggestions(filtered);
      setAtSelectedIdx(0);
    } catch {
      setAtSuggestions([]);
    }
  }, []);

  useEffect(() => {
    if (atQuery === null) return;
    const timer = setTimeout(() => fetchAtSuggestions(atQuery), 150);
    return () => clearTimeout(timer);
  }, [atQuery, fetchAtSuggestions]);

  const handleInputChangeWithAt = useCallback((value: string, cursorPosition?: number) => {
    onInputChange(value);
    const cursorPos = cursorPosition ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\/[^\s]*)$/);
    if (atMatch) {
      setAtQuery(atMatch[1]);
    } else {
      setAtQuery(null);
      setAtSuggestions([]);
    }
  }, [onInputChange]);

  const selectAtSuggestion = useCallback((suggestion: { name: string; path: string; isDir: boolean }) => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart ?? input.length;
    const textBeforeCursor = input.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\/[^\s]*)$/);
    if (!atMatch) return;

    if (suggestion.isDir) {
      const newBefore = textBeforeCursor.slice(0, atMatch.index!) + `@${suggestion.path}/`;
      const newValue = newBefore + input.slice(cursorPos);
      onInputChange(newValue);
      setAtQuery(suggestion.path + "/");
      setTimeout(() => {
        textarea.setSelectionRange(newBefore.length, newBefore.length);
        textarea.focus();
      }, 0);
    } else {
      const newBefore = textBeforeCursor.slice(0, atMatch.index!);
      const rest = input.slice(cursorPos);
      onInputChange(newBefore + rest);
      setAtQuery(null);
      setAtSuggestions([]);
      if (onAddFilePath) {
        onAddFilePath(suggestion.path);
      }
      setTimeout(() => {
        textarea.setSelectionRange(newBefore.length, newBefore.length);
        textarea.focus();
      }, 0);
    }
  }, [input, onInputChange, inputRef, onAddFilePath]);

  const handleKeyDownWithAt = useCallback((e: React.KeyboardEvent) => {
    if (atSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtSelectedIdx((i) => (i + 1) % atSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtSelectedIdx((i) => (i - 1 + atSuggestions.length) % atSuggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectAtSuggestion(atSuggestions[atSelectedIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtQuery(null);
        setAtSuggestions([]);
        return;
      }
    }
    onKeyDown(e);
  }, [atSuggestions, atSelectedIdx, selectAtSuggestion, onKeyDown]);

  return (
    <div className="p-2 pb-1 border-t border-[var(--color-border)]">
      {/* @ 提及路径补全 */}
      {atSuggestions.length > 0 && (
        <div ref={atMenuRef} className="pb-1">
          <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto">
            <div className="px-2 py-1 border-b border-[var(--color-border)]">
              <span className="text-[10px] text-[var(--color-text-secondary)]">
                选择文件（Tab/Enter 确认，Esc 关闭）
              </span>
            </div>
            {atSuggestions.map((s, i) => (
              <button
                key={s.path}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
                  i === atSelectedIdx
                    ? "bg-emerald-500/10 text-emerald-600"
                    : "hover:bg-[var(--color-bg-hover)] text-[var(--color-text)]"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectAtSuggestion(s);
                }}
                onMouseEnter={() => setAtSelectedIdx(i)}
              >
                {s.isDir ? <Folder className="w-3.5 h-3.5 shrink-0 text-amber-500" /> : <File className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-secondary)]" />}
                <span className="truncate">{s.name}{s.isDir ? "/" : ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="relative flex items-end gap-1 bg-[var(--color-bg-secondary)] p-1 px-2 rounded-xl border border-[var(--color-border)] shadow-sm focus-within:shadow-md focus-within:border-emerald-500/30 transition-all">
        <AttachDropdown
          onFileClick={onFileSelectNative ?? (() => fileInputRef.current?.click())}
          onFolderClick={onFolderSelect}
          accent="emerald"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.yaml,.yml,.toml,.xml,.csv,.log,.js,.ts,.jsx,.tsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.swift,.kt,.rb,.php,.sh,.sql,.css,.html,.htm,.vue,.svelte"
          className="hidden"
          onChange={onFileSelect}
        />

        <div className="flex-1 flex flex-col min-w-0">
          {useAttachments && attachments.length > 0 ? (
            <div className="flex gap-2 flex-wrap px-1 pt-1.5 pb-1">
              {attachments.map((a) => (
                <div key={a.id} className="relative group shrink-0">
                  {a.type === "image" ? (
                    <>
                      <img
                        src={a.preview ?? ""}
                        alt={a.name}
                        className="w-14 h-14 object-cover rounded-lg border border-[var(--color-border)] hover:brightness-90 transition-all shadow-sm"
                      />
                      <button
                        type="button"
                        onClick={() => onRemoveAttachment(a.id)}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm z-10"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </>
                  ) : (
                    <div className={`relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] max-w-[180px] ${a.type === "folder" ? "border-amber-500/30 bg-amber-500/5" : ""}`}>
                      {a.type === "folder"
                        ? <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                        : <FileText className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] shrink-0" />
                      }
                      <span className="text-[10px] truncate text-[var(--color-text-secondary)]" title={a.path || a.name}>
                        {a.type === "folder" ? `📂 ${a.name}` : a.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => onRemoveAttachment(a.id)}
                        className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm z-10"
                      >
                        <X className="w-2 h-2" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : pendingImagePreviews.length > 0 ? (
            <div className="flex gap-2 flex-wrap px-1 pt-1.5 pb-1">
              {pendingImagePreviews.map((preview, i) => (
                <div key={i} className="relative group shrink-0">
                  <img
                    src={preview}
                    alt={`待发送图片 ${i + 1}`}
                    className="w-14 h-14 object-cover rounded-lg border border-[var(--color-border)] hover:brightness-90 transition-all shadow-sm"
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveImage(i)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm z-10"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            className="w-full bg-transparent text-[var(--color-text)] text-[14px] px-1 outline-none resize-none min-h-[2rem] max-h-[9rem] placeholder:text-[var(--color-text-secondary)]/50 leading-relaxed py-2"
            placeholder={
              hasAttachments
                ? "输入描述（可省略）..."
                : hasExistingTasks
                  ? "继续追问，保持上下文..."
                  : "输入任务或问题..."
            }
            value={input}
            onChange={(e) => {
              handleInputChangeWithAt(e.target.value, e.target.selectionStart ?? undefined);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 9 * 16) + "px";
            }}
            onKeyDown={handleKeyDownWithAt}
            onPaste={onPaste}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            rows={1}
          />
        </div>

        <div className="flex items-center gap-1 shrink-0 self-end mb-0.5">
          {running && (
            <button
              onClick={onStop}
              className="p-2 rounded-full bg-red-500 text-white hover:bg-red-600 transition-all shadow-sm active:scale-95"
              title="停止生成"
            >
              <span className="w-4 h-4 flex items-center justify-center font-bold text-xs">
                ■
              </span>
            </button>
          )}
          <button
            onClick={onRun}
            disabled={(!input.trim() && !hasAttachments) || !ai}
            className="p-2 rounded-full bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:hover:bg-emerald-500 disabled:cursor-not-allowed transition-all shadow-sm active:scale-95"
            aria-label="发送"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
      {!ai && (
        <p className="text-xs text-red-500 mt-1 px-1">
          请先在设置中配置 AI 模型
        </p>
      )}
    </div>
  );
}
