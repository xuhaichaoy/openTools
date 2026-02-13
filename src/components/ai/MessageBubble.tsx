import { memo, useCallback, useRef } from "react";
import { User, Bot, Copy, Check, RefreshCw } from "lucide-react";
import { useState } from "react";
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
  if (Array.isArray(children)) return children.map(getTextFromChildren).join("");
  if (typeof children === "object" && "props" in children && children.props != null) {
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

/** 消息操作栏 */
function MessageActions({ msg, isUser, isLast }: { msg: ChatMessage; isUser: boolean; isLast: boolean }) {
  const [copied, setCopied] = useState(false);
  const { regenerateLastMessage, isStreaming } = useAIStore();

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [msg.content]);

  if (msg.streaming) return null;

  return (
    <div className={`flex items-center gap-1 mt-1 ${isUser ? "justify-end" : "justify-start ml-12"}`}>
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

/** 单条消息气泡 */
export const MessageBubble = memo(function MessageBubble({
  msg,
  isLastAssistant = false,
}: {
  msg: ChatMessage;
  isLastAssistant?: boolean;
}) {
  const isUser = msg.role === "user";

  return (
    <div className={`group ${isUser ? "" : ""}`}>
      <div className={`flex gap-1.5 mb-0.5 ${isUser ? "flex-row-reverse" : ""}`}>
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
              ? "bg-indigo-600 text-white rounded-tr-md"
              : "bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)] rounded-tl-md"
          }`}
        >
          {!isUser ? (
            <div>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <ToolCallDisplay toolCalls={msg.toolCalls} />
              )}
              <div className="prose prose-invert prose-base max-w-none [&_p]:leading-7 [&_p]:my-2 [&_li]:my-1 first:[&_p]:mt-0 last:[&_p]:mb-0">
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
                  }}
                >
                  {msg.content || (msg.streaming ? "▌" : "")}
                </ReactMarkdown>
                {msg.streaming && (
                  <span className="inline-block w-1.5 h-4 bg-indigo-500 animate-pulse ml-1 align-middle" />
                )}
              </div>
            </div>
          ) : (
            <div className="leading-7 whitespace-pre-wrap">{msg.content}</div>
          )}
        </div>
      </div>

      {/* 操作栏 */}
      {msg.content && <MessageActions msg={msg} isUser={isUser} isLast={isLastAssistant} />}
    </div>
  );
});
