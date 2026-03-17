import { memo, useCallback, useRef, useState, useEffect, useMemo } from "react";
import {
  User,
  Bot,
  Copy,
  Check,
  RefreshCw,
  Pencil,
  X,
  ArrowRight,
  Network,
  Users,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { readFile } from "@tauri-apps/plugin-fs";
import { useAIStore } from "@/store/ai-store";
import { stripReasoningTagsFromText } from "@/core/ai/reasoning-tag-stream";
import { buildAskAgentHandoff } from "@/core/ai/ask-agent-handoff";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { routeToAICenter } from "@/core/ai/ai-center-routing";
import type { ChatMessage } from "@/core/ai/types";

// ── 图片 blob URL LRU 缓存 ──
const IMAGE_CACHE_MAX = 60;
const _imageCache = new Map<string, string>();

function getCachedBlobUrl(path: string): string | undefined {
  const cached = _imageCache.get(path);
  if (cached) {
    _imageCache.delete(path);
    _imageCache.set(path, cached);
  }
  return cached;
}

function setCachedBlobUrl(path: string, url: string) {
  if (_imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = _imageCache.keys().next().value;
    if (oldest) {
      const oldUrl = _imageCache.get(oldest);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      _imageCache.delete(oldest);
    }
  }
  _imageCache.set(path, url);
}

function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
}

/** 用 Tauri FS 读文件转 blob URL，带 LRU 缓存 */
export function ChatImage({
  path,
  className,
  onClick,
}: {
  path: string;
  className?: string;
  onClick?: (blobUrl: string) => void;
}) {
  const [blobUrl, setBlobUrl] = useState(() => getCachedBlobUrl(path) ?? "");
  const [error, setError] = useState(false);

  useEffect(() => {
    const cached = getCachedBlobUrl(path);
    if (cached) {
      setBlobUrl(cached);
      return;
    }
    let cancelled = false;
    readFile(path)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes], { type: getMimeType(path) });
        const url = URL.createObjectURL(blob);
        setCachedBlobUrl(path, url);
        setBlobUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [path]);

  if (error)
    return (
      <div className={`bg-[var(--color-bg-secondary)] rounded-lg flex items-center justify-center text-[var(--color-text-secondary)] text-[10px] ${className ?? ""}`}>
        加载失败
      </div>
    );
  if (!blobUrl)
    return (
      <div
        className={`bg-[var(--color-bg-secondary)] animate-pulse rounded-lg ${className ?? ""}`}
        style={{ minWidth: 60, minHeight: 60 }}
      />
    );
  return (
    <img
      src={blobUrl}
      alt="附件图片"
      className={className}
      onClick={() => onClick?.(blobUrl)}
      loading="lazy"
    />
  );
}

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

const MARKDOWN_PATTERN = /[#*`\[\]|>!\-\d+\.\n]{2,}|```|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>/m;

// 记忆化 ReactMarkdown 插件和组件配置，避免每次渲染创建新对象
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

function MdCode({ className, children, ...props }: any) {
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
}

/** 单条消息气泡 */
export const MessageBubble = memo(function MessageBubble({
  msg,
  isLastAssistant = false,
  searchQuery,
  onContinueAskMode,
}: {
  msg: ChatMessage;
  isLastAssistant?: boolean;
  searchQuery?: string;
  onContinueAskMode?: (mode: "agent" | "cluster" | "dialog") => void;
}) {
  const isUser = msg.role === "user";
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(msg.content);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const { editAndResend, isStreaming } = useAIStore();
  const editRef = useRef<HTMLTextAreaElement>(null);

  const TRUNCATE_LENGTH = 2000;
  const sanitizedAssistantContent = useMemo(
    () =>
      isUser
        ? msg.content
        : stripReasoningTagsFromText(msg.content, {
            mode: "strict",
            trim: "none",
          }),
    [isUser, msg.content],
  );
  const shouldTruncate =
    !isUser &&
    !expanded &&
    sanitizedAssistantContent.length > TRUNCATE_LENGTH &&
    !msg.streaming;
  const displayContent = shouldTruncate
    ? sanitizedAssistantContent.slice(0, TRUNCATE_LENGTH) + "\n\n..."
    : sanitizedAssistantContent;

  // 简单文本检测：不含 Markdown 语法且不在流式中时跳过 ReactMarkdown
  const isPlainText = useMemo(() => {
    if (msg.streaming) return false;
    return !MARKDOWN_PATTERN.test(displayContent);
  }, [displayContent, msg.streaming]);
  const hasThinking = Boolean(msg.thinkingContent?.trim());
  const appliedMemoryPreview = msg.appliedMemoryPreview ?? [];
  const appliedMemoryCount = msg.appliedMemoryIds?.length ?? appliedMemoryPreview.length;

  useEffect(() => {
    if (msg.thinkingStreaming && msg.thinkingContent?.trim()) {
      setShowThinking(true);
    }
  }, [msg.thinkingContent, msg.thinkingStreaming]);

  const mdComponents = useMemo(() => ({
    code: MdCode,
    img({ src, alt, ...props }: any) {
      return (
        <img
          src={src}
          alt={alt || "图片"}
          className="max-w-full rounded-lg my-2 cursor-zoom-in hover:opacity-90 transition-opacity"
          onClick={() => src && setPreviewImage(src)}
          loading="lazy"
          {...props}
        />
      );
    },
  }), []);

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
              {hasThinking && (
                <div className="mb-2 rounded-2xl border border-indigo-500/15 bg-indigo-500/5 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowThinking((v) => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] hover:bg-indigo-500/5 transition-colors"
                  >
                    <span>{msg.thinkingStreaming ? "思考中" : "思考过程"}</span>
                    {showThinking ? (
                      <ChevronUp className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                    )}
                  </button>
                  {showThinking && (
                    <div className="px-3 pb-3 text-[12px] leading-6 whitespace-pre-wrap text-[var(--color-text-secondary)] border-t border-indigo-500/10">
                      {msg.thinkingContent}
                      {msg.thinkingStreaming && (
                        <span className="inline-block w-1.5 h-3 bg-indigo-400 animate-pulse ml-1 align-middle" />
                      )}
                    </div>
                  )}
                </div>
              )}
              {appliedMemoryPreview.length > 0 && (
                <div className="mb-2 rounded-2xl border border-emerald-500/15 bg-emerald-500/5 px-3 py-2">
                  <div className="text-[11px] text-[var(--color-text-secondary)]">
                    已用记忆 {appliedMemoryCount} 条
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {appliedMemoryPreview.map((item, index) => (
                      <span
                        key={`${msg.id}-memory-${index}`}
                        className="inline-flex max-w-full rounded-full border border-emerald-500/20 bg-[var(--color-bg)]/70 px-2 py-0.5 text-[11px] leading-5 text-[var(--color-text-secondary)]"
                        title={item}
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div
                className={`prose prose-invert prose-base max-w-none [&_p]:leading-7 [&_p]:my-2 [&_li]:my-1 first:[&_p]:mt-0 last:[&_p]:mb-0 ${msg.streaming ? "min-h-[1.5rem]" : ""}`}
              >
                {msg.streaming && !displayContent ? (
                  <div className="flex items-center gap-2 py-1">
                    <div className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                    <span className="text-xs text-[var(--color-text-secondary)] animate-pulse">思考中...</span>
                  </div>
                ) : isPlainText && displayContent ? (
                  <p className="whitespace-pre-wrap leading-7 my-0">{displayContent}</p>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={rehypePlugins}
                    components={mdComponents}
                  >
                    {displayContent || ""}
                  </ReactMarkdown>
                )}
                {msg.streaming && displayContent && (
                  <span className="inline-block w-1.5 h-4 bg-indigo-500 animate-pulse ml-1 align-middle" />
                )}
                {shouldTruncate && (
                  <button
                    onClick={() => setExpanded(true)}
                    className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors underline"
                  >
                    展开全部 ({msg.content.length.toLocaleString()} 字符)
                  </button>
                )}
                {!shouldTruncate && expanded && msg.content.length > TRUNCATE_LENGTH && (
                  <button
                    onClick={() => setExpanded(false)}
                    className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors underline"
                  >
                    收起
                  </button>
                )}
              </div>
              {msg.suggestAgentUpgrade && !msg.streaming && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <button
                    onClick={() => {
                      if (onContinueAskMode) {
                        onContinueAskMode("agent");
                        return;
                      }
                      const aiState = useAIStore.getState();
                      const currentConversation = aiState.conversations.find(
                        (conversation) => conversation.id === aiState.currentConversationId,
                      ) || null;
                      const handoff = buildAskAgentHandoff(currentConversation, {
                        maxMessages: 6,
                        maxCharsPerMessage: 400,
                      });
                      routeToAICenter({
                        mode: "agent",
                        source: "ask_continue_to_agent",
                        ...(handoff ? { handoff } : {}),
                        navigate: false,
                      });
                    }}
                    className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    <ArrowRight className="w-3 h-3" />
                    转 Agent 落地
                  </button>
                  <button
                    onClick={() => {
                      if (onContinueAskMode) {
                        onContinueAskMode("cluster");
                        return;
                      }
                      const aiState = useAIStore.getState();
                      const currentConversation = aiState.conversations.find(
                        (conversation) => conversation.id === aiState.currentConversationId,
                      ) || null;
                      const handoff = buildAskAgentHandoff(currentConversation, {
                        maxMessages: 6,
                        maxCharsPerMessage: 400,
                      });
                      routeToAICenter({
                        mode: "cluster",
                        source: "ask_continue_to_cluster",
                        ...(handoff ? { handoff } : {}),
                        navigate: false,
                      });
                    }}
                    className="flex items-center gap-1 text-cyan-500 hover:text-cyan-400 transition-colors"
                  >
                    <Network className="w-3 h-3" />
                    转 Cluster 拆解
                  </button>
                  <button
                    onClick={() => {
                      if (onContinueAskMode) {
                        onContinueAskMode("dialog");
                        return;
                      }
                      const aiState = useAIStore.getState();
                      const currentConversation = aiState.conversations.find(
                        (conversation) => conversation.id === aiState.currentConversationId,
                      ) || null;
                      const handoff = buildAskAgentHandoff(currentConversation, {
                        maxMessages: 6,
                        maxCharsPerMessage: 400,
                      });
                      routeToAICenter({
                        mode: "dialog",
                        source: "ask_continue_to_dialog",
                        ...(handoff ? { handoff } : {}),
                        navigate: false,
                      });
                    }}
                    className="flex items-center gap-1 text-amber-500 hover:text-amber-400 transition-colors"
                  >
                    <Users className="w-3 h-3" />
                    转 Dialog 协作
                  </button>
                </div>
              )}
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
                  {msg.images.map((imgPath: string, i: number) => (
                    <ChatImage
                      key={i}
                      path={imgPath}
                      className="max-w-[200px] max-h-[200px] object-cover rounded-lg cursor-zoom-in hover:opacity-90 transition-opacity"
                      onClick={(url) => setPreviewImage(url)}
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
