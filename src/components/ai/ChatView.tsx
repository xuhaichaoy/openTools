import { useState, useRef, useEffect } from "react";
import { Plus, Loader2, Bot, ArrowLeft, History, Square } from "lucide-react";
import { useAIStore } from "@/store/ai-store";
import { useToast } from "@/components/ui/Toast";
import { ModelSelector } from "./ModelSelector";
import { MessageBubble } from "./MessageBubble";
import { ConversationList } from "./ConversationList";
import { useDragWindow } from "@/hooks/useDragWindow";

export function ChatView({ onBack }: { onBack?: () => void }) {
  const [input, setInput] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const {
    getCurrentConversation,
    sendMessage,
    isStreaming,
    config,
    conversations,
    currentConversationId,
    createConversation,
    stopStreaming,
  } = useAIStore();

  const { toast } = useToast();
  const { onMouseDown } = useDragWindow();
  const conversation = getCurrentConversation();
  const messages = conversation?.messages || [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    if (!config.api_key) {
      toast("warning", "请先在设置中配置 AI API Key");
      return;
    }

    setInput("");
    // 重置 textarea 高度
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    await sendMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full bg-[var(--color-bg)] relative">
      {/* 对话历史侧边栏 */}
      {showHistory && (
        <>
          {/* 遮罩 */}
          <div
            className="absolute inset-0 bg-black/20 z-20"
            onClick={() => setShowHistory(false)}
          />
          {/* 侧边栏 */}
          <div className="absolute left-0 top-0 bottom-0 w-[280px] bg-[var(--color-bg)] border-r border-[var(--color-border)] z-30 shadow-2xl animate-in slide-in-from-left duration-200">
            <ConversationList onClose={() => setShowHistory(false)} />
          </div>
        </>
      )}

      {/* 主体 */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* 头部 */}
        <div
          className="flex items-center justify-between px-6 h-12 border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-md sticky top-0 z-10 cursor-grab active:cursor-grabbing"
          onMouseDown={onMouseDown}
        >
          <div className="flex-1 flex justify-start items-center gap-1">
            {onBack && (
              <button
                onClick={onBack}
                className="p-2 -ml-2 rounded-xl hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            {/* 对话历史按钮 */}
            <button
              onClick={() => setShowHistory(true)}
              className="p-2 rounded-xl hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors relative"
              title="对话历史"
            >
              <History className="w-4.5 h-4.5" />
              {conversations.length > 1 && (
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-indigo-500 text-white text-[8px] rounded-full flex items-center justify-center font-medium">
                  {conversations.length > 99 ? "99+" : conversations.length}
                </span>
              )}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-500">
              <Bot className="w-5 h-5" />
            </div>
            <div className="flex flex-col items-center">
              <span className="text-base font-semibold text-[var(--color-text)]">
                AI 助手
              </span>
            </div>
          </div>

          <div className="flex-1 flex justify-end items-center gap-2">
            <ModelSelector />
            <button
              onClick={() => {
                createConversation();
                setInput("");
                inputRef.current?.focus();
              }}
              className="p-2 rounded-xl hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              title="新对话"
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 消息区域 */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-6 scroll-smooth">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)] opacity-50">
              <Bot className="w-16 h-16 mb-4 text-[var(--color-border)]" />
              <p className="text-base font-medium">有什么可以帮你的吗？</p>
              <p className="text-xs mt-2 opacity-60">
                支持 Markdown、代码高亮、工具调用
              </p>
            </div>
          )}

          {messages.map((msg, idx) => {
            const isLastAssistant =
              msg.role === "assistant" &&
              !messages.slice(idx + 1).some((m) => m.role === "assistant");
            return (
              <MessageBubble
                key={msg.id}
                msg={msg}
                isLastAssistant={isLastAssistant}
              />
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* 停止生成按钮 */}
        {isStreaming && (
          <div className="flex justify-center py-1">
            <button
              onClick={stopStreaming}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:border-red-500/30 hover:bg-red-500/5 transition-all shadow-sm"
            >
              <Square className="w-3 h-3" />
              停止生成
            </button>
          </div>
        )}

        {/* 输入区域 */}
        <div className="p-2 pb-1">
          <div className="relative flex items-center gap-3 bg-[var(--color-bg-secondary)] p-1 px-2 rounded-xl border border-[var(--color-border)] shadow-sm focus-within:shadow-md focus-within:border-indigo-500/30 transition-all">
            <textarea
              ref={inputRef}
              className="flex-1 bg-transparent text-[var(--color-text)] text-[14px] px-2 outline-none resize-none min-h-[24px] max-h-[160px] placeholder:text-[var(--color-text-secondary)]/50 leading-relaxed py-1"
              placeholder="输入消息..."
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              style={{ height: "auto" }}
            />
            <button
              onClick={handleSend}
              disabled={isStreaming || !input.trim()}
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
            Enter 发送 · Shift+Enter 换行
          </div>
        </div>
      </div>
    </div>
  );
}
