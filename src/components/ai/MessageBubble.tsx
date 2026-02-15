import { memo, useCallback, useRef } from "react";
import { useState } from "react";
import { User, Bot, Copy, Check, RefreshCw, Pencil, X } from "lucide-react";
import type { ChatMessage } from "@/store/ai-store";
import { useAIStore } from "@/store/ai-store";
import { ToolCallDisplay } from "./ToolCallDisplay";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/** 从 React 子节点递归取出纯文本（rehype-highlight 会把代码变成 span 等，不能直接用 String(children)） */
function getTextFromChildren(children: React.ReactNode): string {
  if (children == null) return "";
  if (typeof children === "string") return children;
  if (Array.isArray(children))
    return children.map(getTextFromChildren).join("");
  if (
    typeof children === "object" &&
    "props" in children &&
    children.props != null
  ) {
    return getTextFromChildren((children as any).props.children);
  }
  return "";
}

/** 代码块头部 — 显示语言标签和复制按钮 */
function CodeBlock({ className, children, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1] || "";

  const handleCopy = useCallback(() => {
    const raw =
      codeRef.current?.textContent?.replace(/\n$/, "") ??
      getTextFromChildren(children).replace(/\n$/, "");
    if (raw) navigator.clipboard.writeText(raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [children]);

  return (
    <div className="relative group my-2">
      {lang && (
        <div className="flex items-center justify-between px-3 py-1 bg-[var(--color-code-header)] rounded-t-lg border-b border-[var(--color-border)]">
          <span className="text-[10px] text-[var(--color-text-secondary)] uppercase font-mono">
            {lang}
          </span>
          <button
            onClick={handleCopy}
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors p-0.5"
            title="复制代码"
          >
            {copied ? (
              <Check className="w-3 h-3 text-green-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>
      )}
      <code
        ref={codeRef}
        className={`${className || ""} ${lang ? "!rounded-t-none" : ""}`}
        {...props}
      >
        {children}
      </code>
      {!lang && (
        <button
          onClick={handleCopy}
          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all p-1 rounded bg-[var(--color-bg)]/80"
          title="复制代码"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-400" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
        </button>
      )}
    </div>
  );
}

/** 格式化时间戳 */
function formatMsgTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 消息操作栏 */
function MessageActions({
  msg,
  isUser,
  isLast,
  onEdit,
}: {
  msg: ChatMessage;
  isUser: boolean;
  isLast: boolean;
  onEdit?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { regenerateLastMessage, isStreaming } = useAIStore();

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [msg.content]);

  if (msg.streaming) return null;

  return (
    <div
      className={`flex items-center gap-1 mt-1 ${isUser ? "justify-end mr-10" : "justify-start ml-10"}`}
    >
      {/* 时间戳 */}
      <span className="text-[10px] text-[var(--color-text-secondary)] opacity-0 group-hover:opacity-50 transition-opacity select-none">
        {formatMsgTime(msg.timestamp)}
      </span>

      {/* 复制按钮 */}
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors opacity-0 group-hover:opacity-100"
        title="复制消息"
      >
        {copied ? (
          <Check className="w-3 h-3 text-green-400" />
        ) : (
          <Copy className="w-3 h-3" />
        )}
        <span>{copied ? "已复制" : "复制"}</span>
      </button>

      {/* 编辑按钮 - 仅用户消息 */}
      {isUser && onEdit && (
        <button
          onClick={onEdit}
          disabled={isStreaming}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-30 opacity-0 group-hover:opacity-100"
          title="编辑并重发"
        >
          <Pencil className="w-3 h-3" />
          <span>编辑</span>
        </button>
      )}

      {/* 重新生成按钮 - 仅最后一条 assistant 消息 */}
      {!isUser && isLast && (
        <button
          onClick={() => regenerateLastMessage()}
          disabled={isStreaming}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-30 opacity-0 group-hover:opacity-100"
          title="重新生成"
        >
          <RefreshCw className="w-3 h-3" />
          <span>重新生成</span>
        </button>
      )}
    </div>
  );
}

/** 高亮搜索关键词 */
function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQ = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let idx = lowerText.indexOf(lowerQ);
  while (idx !== -1) {
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    parts.push(
      <mark
        key={idx}
        className="bg-yellow-300/60 text-inherit rounded-sm px-0.5"
      >
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    lastIdx = idx + query.length;
    idx = lowerText.indexOf(lowerQ, lastIdx);
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return <>{parts}</>;
}

/** 单条消息气泡 */
export const MessageBubble = memo(function MessageBubble({
  msg,
  isLastAssistant = false,
  searchQuery,
}: {
  msg: ChatMessage;
  isLastAssistant?: boolean;
  searchQuery?: string;
}) {
  const isUser = msg.role === "user";
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(msg.content);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const { editAndResend, isStreaming } = useAIStore();
  const editRef = useRef<HTMLTextAreaElement>(null);

  const handleEditSubmit = () => {
    const trimmed = editText.trim();
    if (!trimmed || isStreaming) return;
    setEditing(false);
    editAndResend(msg.id, trimmed);
  };

  return (
    <div className={`group mb-0.5 ${isUser ? "" : ""}`}>
      <div
        className={`flex gap-1.5 mb-0.5 ${isUser ? "flex-row-reverse" : ""}`}
      >
        {/* 头像 */}
        <div
          className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border border-[var(--color-border)] shadow-sm ${
            isUser ? "bg-indigo-600" : "bg-[var(--color-bg)]"
          }`}
        >
          {isUser ? (
            <User className="w-5 h-5 text-white" />
          ) : (
            <Bot className="w-5 h-5 text-indigo-500" />
          )}
        </div>

        {/* 内容 */}
        <div
          className={`max-w-[85%] rounded-[20px] px-2.5 py-1.5 text-[13px] shadow-sm leading-relaxed ${
            isUser
              ? editing
                ? "bg-indigo-700 text-white rounded-tr-md"
                : "bg-indigo-600 text-white rounded-tr-md"
              : "bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)] rounded-tl-md"
          }`}
        >
          {!isUser ? (
            <div>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <ToolCallDisplay toolCalls={msg.toolCalls} />
              )}
              <div
                className={`prose prose-invert prose-base max-w-none [&_p]:leading-7 [&_p]:my-2 [&_li]:my-1 first:[&_p]:mt-0 last:[&_p]:mb-0 ${msg.streaming ? "min-h-[1.5rem]" : ""}`}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    code({ className, children, ...props }) {
                      const isInline = !className;
                      if (isInline) {
                        return (
                          <code
                            className="bg-[var(--color-code-bg)] px-1.5 py-0.5 rounded text-sm font-mono text-indigo-500"
                            {...props}
                          >
                            {children}
                          </code>
                        );
                      }
                      return (
                        <CodeBlock className={className} {...props}>
                          {children}
                        </CodeBlock>
                      );
                    },
                    img({ src, alt, ...props }) {
                      return (
                        <img
                          src={src}
                          alt={alt || "图片"}
                          className="max-w-full rounded-lg my-2 cursor-pointer hover:opacity-90 transition-opacity"
                          className="max-w-full rounded-lg my-2 cursor-zoom-in hover:opacity-90 transition-opacity"
                          onClick={() => src && setPreviewImage(src)}
                          loading="lazy"
                          {...props}
                        />
                      );
                    },
                  }}
                >
                  {msg.content || (msg.streaming ? "▌" : "")}
                </ReactMarkdown>
                {msg.streaming && (
                  <span className="inline-block w-1.5 h-4 bg-indigo-500 animate-pulse ml-1 align-middle" />
                )}
              </div>
            </div>
          ) : editing ? (
            <div className="space-y-2">
              <textarea
                ref={editRef}
                autoFocus
                className="w-full bg-white/10 text-white text-[13px] rounded-lg px-2 py-1.5 outline-none resize-none min-h-[40px] max-h-[160px] placeholder:text-white/50 leading-relaxed"
                value={editText}
                onChange={(e) => {
                  setEditText(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleEditSubmit();
                  }
                  if (e.key === "Escape") {
                    setEditing(false);
                    setEditText(msg.content);
                  }
                }}
              />
              <div className="flex justify-end gap-1.5">
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditText(msg.content);
                  }}
                  className="px-2.5 py-1 text-[11px] rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleEditSubmit}
                  disabled={!editText.trim() || isStreaming}
                  className="px-2.5 py-1 text-[11px] rounded-md bg-white/20 text-white hover:bg-white/30 disabled:opacity-40 transition-colors"
                >
                  发送
                </button>
              </div>
            </div>
          ) : (
            <div>
              {/* 用户消息图片 */}
              {msg.images && msg.images.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mb-1.5">
                  {msg.images.map((imgPath, i) => (
                    <img
                      key={i}
                      src={`mtplugin://localhost${imgPath}`}
                      alt={`图片 ${i + 1}`}
                      className="max-w-[200px] max-h-[200px] object-cover rounded-lg cursor-zoom-in hover:opacity-90 transition-opacity"
                      onClick={() =>
                        setPreviewImage(`mtplugin://localhost${imgPath}`)
                      }
                    />
                  ))}
                </div>
              )}
              <div className="leading-7 whitespace-pre-wrap">
                <HighlightText text={msg.content} query={searchQuery} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 操作栏 */}
      {msg.content && !editing && (
        <MessageActions
          msg={msg}
          isUser={isUser}
          isLast={isLastAssistant}
          onEdit={
            isUser
              ? () => {
                  setEditing(true);
                  setEditText(msg.content);
                }
              : undefined
          }
        />
      )}

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
            className="absolute top-6 right-6 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors shadow-lg"
            onClick={() => setPreviewImage(null)}
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
});
