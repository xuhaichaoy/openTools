import { useState, useRef, useEffect } from "react";
import {
  Loader2,
  Square,
  Zap,
  X,
  ArrowLeft,
  FileText,
} from "lucide-react";
import type { InputAttachment } from "@/hooks/use-input-attachments";
import { AttachDropdown } from "@/components/ui/AttachDropdown";

const PROMPT_TEMPLATES = [
  { icon: "🌐", label: "翻译为英文", prompt: "请将以下内容翻译为英文，保持原意和语气：\n\n" },
  { icon: "🇨🇳", label: "翻译为中文", prompt: "请将以下内容翻译为中文，保持原意和语气：\n\n" },
  { icon: "📝", label: "润色文字", prompt: "请帮我润色以下文字，使其更加通顺专业：\n\n" },
  { icon: "📋", label: "总结内容", prompt: "请帮我总结以下内容的要点：\n\n" },
  { icon: "💻", label: "代码审查", prompt: "请审查以下代码，指出问题并给出优化建议：\n\n```\n\n```" },
  { icon: "🐛", label: "修复代码Bug", prompt: "以下代码存在 bug，请帮我找到并修复：\n\n```\n\n```" },
  { icon: "📖", label: "解释代码", prompt: "请逐行解释以下代码的功能：\n\n```\n\n```" },
  { icon: "✍️", label: "写正则表达式", prompt: "请帮我写一个正则表达式，要求：" },
];

export interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  isStreaming: boolean;
  stopStreaming: () => void;
  pendingImages: string[];
  pendingImagePreviews: string[];
  onPaste: (e: React.ClipboardEvent) => void;
  onRemoveImage: (index: number) => void;
  previewImage: string | null;
  setPreviewImage: (value: string | null) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  isComposingRef: React.MutableRefObject<boolean>;
  messages: { content?: string; streaming?: boolean }[];
  /** 统一附件（图片+文本文件），与 pendingImages 二选一；提供时显示文件/文件夹按钮 */
  attachments?: InputAttachment[];
  onRemoveAttachment?: (id: string) => void;
  onFileSelect?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFolderSelect?: () => void;
  fileInputRef?: React.RefObject<HTMLInputElement | null>;
}

export function ChatInput({
  input,
  setInput,
  onSend,
  isStreaming,
  stopStreaming,
  pendingImages,
  pendingImagePreviews,
  onPaste,
  onRemoveImage,
  previewImage,
  setPreviewImage,
  inputRef,
  isComposingRef,
  messages,
  attachments,
  onRemoveAttachment,
  onFileSelect,
  onFolderSelect,
  fileInputRef,
}: ChatInputProps) {
  const [showTemplates, setShowTemplates] = useState(false);
  const templateRef = useRef<HTMLDivElement>(null);
  const internalFileInputRef = useRef<HTMLInputElement>(null);
  const fileInputEl = fileInputRef ?? internalFileInputRef;
  const useAttachments = attachments && onRemoveAttachment;
  const hasImages = useAttachments
    ? attachments.some((a) => a.type === "image")
    : pendingImages.length > 0;
  const hasAnyAttachment = useAttachments ? attachments.length > 0 : pendingImages.length > 0;

  // 内容变化时（含程序预填）同步 textarea 高度，最多 3 行
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 9 * 16) + "px";
  }, [input]);

  // 点击外部关闭 Prompt 模板菜单
  useEffect(() => {
    if (!showTemplates) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        templateRef.current &&
        !templateRef.current.contains(e.target as Node)
      ) {
        setShowTemplates(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTemplates]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // keyCode 229 = IME 正在处理；isComposingRef = 输入法组合中
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !isComposingRef.current &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <>
      {/* 停止生成按钮 + token 计数 */}
      {isStreaming &&
        (() => {
          const streamingMsg = messages.find((m) => m.streaming);
          const charCount = streamingMsg?.content?.length || 0;
          const estimatedTokens = Math.ceil(
            [...(streamingMsg?.content || "")].reduce(
              (sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 1.5 : 0.25),
              0,
            ),
          );
          return (
            <div className="flex items-center justify-center gap-3 py-1">
              <button
                onClick={stopStreaming}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:border-red-500/30 hover:bg-red-500/5 transition-all shadow-sm"
              >
                <Square className="w-3 h-3" />
                停止生成
              </button>
              {charCount > 0 && (
                <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
                  ~{estimatedTokens} tokens · {charCount} 字符
                </span>
              )}
            </div>
          );
        })()}

      {/* 输入区域 */}
      <div className="p-2 pb-1">
        <div className="relative flex items-center gap-1 bg-[var(--color-bg-secondary)] p-1 px-2 rounded-xl border border-[var(--color-border)] shadow-sm focus-within:shadow-md focus-within:border-indigo-500/30 transition-all">
          {/* 文件/文件夹按钮（可选） */}
          {(onFileSelect || onFolderSelect) && (
            <div className="flex items-center gap-0.5 shrink-0">
              {onFileSelect && (
                <input
                  ref={fileInputEl as React.RefObject<HTMLInputElement>}
                  type="file"
                  multiple
                  accept="image/*,.txt,.md,.json,.yaml,.yml,.toml,.xml,.csv,.log,.js,.ts,.jsx,.tsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.swift,.kt,.rb,.php,.sh,.sql,.css,.html,.htm,.vue,.svelte"
                  className="hidden"
                  onChange={onFileSelect}
                />
              )}
              <AttachDropdown
                onFileClick={() => (fileInputEl as React.RefObject<HTMLInputElement>)?.current?.click()}
                onFolderClick={onFolderSelect}
                accent="indigo"
              />
            </div>
          )}
          {/* Prompt 模板按钮 */}
          <div className="relative shrink-0" ref={templateRef}>
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-indigo-500 hover:bg-indigo-500/5 transition-colors"
              title="Prompt 模板"
            >
              <Zap className="w-4 h-4" />
            </button>
            {showTemplates && (
              <div className="absolute bottom-full mb-2 left-0 w-56 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden z-50">
                <div className="px-3 py-2 border-b border-[var(--color-border)]">
                  <span className="text-[11px] font-medium text-[var(--color-text)]">
                    快捷模板
                  </span>
                </div>
                <div className="py-1 max-h-[240px] overflow-y-auto">
                  {PROMPT_TEMPLATES.map((t) => (
                    <button
                      key={t.label}
                      onClick={() => {
                        setInput(t.prompt);
                        setShowTemplates(false);
                        inputRef.current?.focus();
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors text-left"
                    >
                      <span>{t.icon}</span>
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex-1 flex flex-col min-w-0">
            {/* 附件预览区：统一附件 或 仅图片 */}
            {useAttachments && attachments.length > 0 ? (
              <div className="flex gap-2 flex-wrap px-2 pt-1.5 pb-1">
                {attachments.map((a) => (
                  <div key={a.id} className="relative group shrink-0">
                    {a.type === "image" ? (
                      <>
                        <img
                          src={a.preview ?? ""}
                          alt={a.name}
                          className="w-14 h-14 object-cover rounded-lg border border-[var(--color-border)] cursor-zoom-in hover:brightness-90 transition-all shadow-sm"
                          onClick={() => a.preview && setPreviewImage(a.preview)}
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
                      <div className="relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] max-w-[140px]">
                        <FileText className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] shrink-0" />
                        <span className="text-[10px] truncate text-[var(--color-text-secondary)]" title={a.name}>
                          {a.name}
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
              <div className="flex gap-2 flex-wrap px-2 pt-1.5 pb-1">
                {pendingImagePreviews.map((preview, i) => (
                  <div key={i} className="relative group shrink-0">
                    <img
                      src={preview}
                      alt={`待发送图片 ${i + 1}`}
                      className="w-14 h-14 object-cover rounded-lg border border-[var(--color-border)] cursor-zoom-in hover:brightness-90 transition-all shadow-sm"
                      onClick={() => setPreviewImage(preview)}
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
              className="w-full bg-transparent text-[var(--color-text)] text-[14px] px-2 outline-none resize-none min-h-[2rem] max-h-[9rem] placeholder:text-[var(--color-text-secondary)]/50 leading-relaxed py-2"
              placeholder={
                hasAnyAttachment
                  ? "输入描述（可省略）..."
                  : "输入消息..."
              }
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 9 * 16) + "px";
              }}
              onKeyDown={handleKeyDown}
              onPaste={onPaste}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                setTimeout(() => {
                  isComposingRef.current = false;
                }, 200);
              }}
              rows={1}
              style={{ height: "auto" }}
            />
          </div>
          <button
            onClick={onSend}
            disabled={
              isStreaming || (!input.trim() && !hasAnyAttachment)
            }
            className="p-2 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:hover:bg-indigo-600 disabled:cursor-not-allowed transition-all shadow-sm active:scale-95 shrink-0"
            aria-label="发送"
          >
            {isStreaming ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <ArrowLeft className="w-5 h-5 rotate-90" />
            )}
          </button>
        </div>
        <div className="text-[10px] text-center text-[var(--color-text-secondary)] mt-1 opacity-60">
          Enter 发送 · Shift+Enter 换行 · ⌘N 新对话 · ⌘F 搜索
        </div>
      </div>

      {/* 图片大图预览 */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out animate-in fade-in duration-200"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            alt="预览大图"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl animate-in zoom-in-95 duration-200"
          />
          <button
            className="absolute top-6 right-6 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
            onClick={() => setPreviewImage(null)}
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </>
  );
}
