import {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useMemo,
} from "react";
import {
  Plus,
  Bot,
  ArrowLeft,
  History,
  ArrowDown,
  Download,
  Search,
  X,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAIStore } from "@/store/ai-store";
import { useToast } from "@/components/ui/Toast";
import { handleError } from "@/core/errors";
import { useInputAttachments } from "@/hooks/use-input-attachments";
import { ModelSelector } from "./ModelSelector";
import { MessageBubble } from "./MessageBubble";
import { ToolConfirmDialog } from "./ToolConfirmDialog";
import { ChatInput } from "./ChatInput";
import { ChatHistory } from "./ChatHistory";
import { useDragWindow } from "@/hooks/useDragWindow";

export interface ChatViewHandle {
  toggleHistory: () => void;
  toggleSearch: () => void;
  exportChat: () => void;
  newChat: () => void;
  hasMessages: () => boolean;
}

export const ChatView = forwardRef<ChatViewHandle, { onBack?: () => void; hideModelSelector?: boolean; headless?: boolean }>(function ChatView({ onBack, hideModelSelector, headless }, ref) {
  const [input, setInput] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const {
    attachments,
    imagePaths,
    imagePreviews,
    fileContextBlock,
    handlePaste,
    handleFileSelect,
    handleFolderSelect,
    removeAttachment,
    clearAttachments,
  } = useInputAttachments();
  const [showHistory, setShowHistory] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const prevMessagesLengthRef = useRef(0);
  const scrollThrottleRef = useRef(0);
  const handleExportRef = useRef<(() => void) | null>(null);
  const {
    getCurrentConversation,
    sendMessage,
    isStreaming,
    config,
    conversations,
    currentConversationId,
    createConversation,
    stopStreaming,
    memoryCandidates,
    loadMemoryCandidates,
    confirmMemoryCandidate,
    dismissMemoryCandidate,
  } = useAIStore();

  const { toast } = useToast();
  const { onMouseDown } = useDragWindow();
  const conversation = getCurrentConversation();
  const messages = useMemo(() => conversation?.messages ?? [], [conversation]);
  const visibleMemoryCandidates = useMemo(() => {
    const filtered = memoryCandidates.filter(
      (candidate) =>
        !candidate.conversation_id ||
        candidate.conversation_id === currentConversationId,
    );
    return filtered.slice(0, 3);
  }, [currentConversationId, memoryCandidates]);

  // 暴露控制接口给父组件
  useImperativeHandle(ref, () => ({
    toggleHistory: () => setShowHistory((v) => !v),
    toggleSearch: () => {
      setShowSearch((v) => {
        if (v) setSearchQuery("");
        return !v;
      });
    },
    exportChat: () => handleExportRef.current?.(),
    newChat: () => {
      createConversation();
      setInput("");
      setShowSearch(false);
      setSearchQuery("");
      inputRef.current?.focus();
    },
    hasMessages: () => messages.length > 0,
  }));

  // 初次进入自动聚焦输入框
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  useEffect(() => {
    loadMemoryCandidates();
  }, [loadMemoryCandidates]);

  // 自动滚动到底部
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const lastMsg = messages[messages.length - 1];
    const streaming = lastMsg?.role === "assistant" && lastMsg?.streaming;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distanceFromBottom < 150;
    const shouldScroll = streaming || isNearBottom;
    const lengthIncreased = messages.length > prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = messages.length;

    const doScroll = () => {
      container.scrollTop = container.scrollHeight;
    };

    if (lengthIncreased) {
      const t = setTimeout(doScroll, 80);
      return () => clearTimeout(t);
    }

    if (!shouldScroll) return;

    if (streaming) {
      const now = Date.now();
      if (now - scrollThrottleRef.current < 60) return;
      scrollThrottleRef.current = now;
    }

    const id = requestAnimationFrame(doScroll);
    return () => cancelAnimationFrame(id);
  }, [messages]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, attachments]);

  useEffect(() => {
    scrollToBottom();
  }, []);

  // 监听滚动位置
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollBtn(distanceFromBottom > 200);
    };
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // 切换对话时重置搜索
  useEffect(() => {
    setShowSearch(false);
    setSearchQuery("");
  }, [currentConversationId]);

  // 键盘快捷键
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === "n") {
        e.preventDefault();
        createConversation();
        setInput("");
        setShowSearch(false);
        setSearchQuery("");
        inputRef.current?.focus();
      }
      if (isMod && e.key === "f" && messages.length > 0) {
        e.preventDefault();
        setShowSearch((v) => {
          if (v) setSearchQuery("");
          return !v;
        });
      }
    };
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, [messages.length, createConversation]);

  const handleExport = async () => {
    if (!conversation || messages.length === 0) return;
    const lines: string[] = [`# ${conversation.title}`, ""];
    for (const msg of messages) {
      if (msg.role === "user") {
        lines.push(`## 用户`, "", msg.content, "");
      } else if (msg.role === "assistant") {
        lines.push(`## AI 助手`, "");
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            lines.push(`> 工具调用: **${tc.name}**  `);
            lines.push(`> 参数: \`${tc.arguments}\`  `);
            if (tc.result)
              lines.push(
                `> 结果: ${tc.result.slice(0, 200)}${tc.result.length > 200 ? "..." : ""}  `,
              );
            lines.push("");
          }
        }
        if (msg.content) lines.push(msg.content, "");
      }
    }
    const md = lines.join("\n");
    try {
      const filePath = await save({
        defaultPath: `${conversation.title.replace(/[/\\?%*:|"<>]/g, "_")}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (filePath) {
        await writeTextFile(filePath, md);
        toast("success", "对话已导出");
      }
    } catch (e) {
      handleError(e, { context: "导出对话", silent: true });
      toast("warning", "导出失败");
    }
  };
  handleExportRef.current = handleExport;

  const handleSend = async () => {
    const trimmed = input.trim();
    const hasAttachments = attachments.length > 0;
    if ((!trimmed && !hasAttachments) || isStreaming) return;

    const source = config.source || "own_key";
    if (source === "own_key" && !config.api_key) {
      toast("warning", "请先在设置中配置 AI API Key");
      return;
    }
    if (source === "team" && !config.team_id) {
      toast("warning", "请先在设置中选择团队");
      return;
    }

    const imagesToSend = imagePaths.length > 0 ? [...imagePaths] : undefined;
    const content = fileContextBlock
      ? `${fileContextBlock}\n\n---\n\n${trimmed || "请根据以上附件内容回答。"}`
      : (trimmed || "请描述这张图片");
    setInput("");
    clearAttachments();
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    await sendMessage(content, imagesToSend);
  };

  return (
    <div className="flex h-full bg-[var(--color-bg)] relative">
      {/* 工具确认对话框 */}
      <ToolConfirmDialog />

      {/* 对话历史侧边栏 */}
      <ChatHistory show={showHistory} onClose={() => setShowHistory(false)} />

      {/* 主体 */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* 头部 */}
        {!headless && (
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

          <div className="flex-1 flex justify-end items-center gap-1">
            {!hideModelSelector && <ModelSelector />}
            {messages.length > 0 && (
              <>
                <button
                  onClick={() => {
                    setShowSearch(!showSearch);
                    if (showSearch) setSearchQuery("");
                  }}
                  className={`p-2 rounded-xl hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors ${showSearch ? "text-indigo-500 bg-indigo-500/5" : ""}`}
                  title="搜索对话"
                >
                  <Search className="w-4 h-4" />
                </button>
                <button
                  onClick={handleExport}
                  className="p-2 rounded-xl hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
                  title="导出对话"
                >
                  <Download className="w-4 h-4" />
                </button>
              </>
            )}
            <button
              onClick={() => {
                createConversation();
                setInput("");
                setShowSearch(false);
                setSearchQuery("");
                inputRef.current?.focus();
              }}
              className="p-2 rounded-xl hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              title="新对话"
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>
        </div>
        )}

        {/* 搜索栏 */}
        {showSearch && (
          <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-[var(--color-text-secondary)] shrink-0" />
            <input
              autoFocus
              type="text"
              className="flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-secondary)]/50"
              placeholder="搜索当前对话..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setShowSearch(false);
                  setSearchQuery("");
                }
              }}
            />
            {searchQuery && (
              <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
                {
                  messages.filter((m) =>
                    m.content.toLowerCase().includes(searchQuery.toLowerCase()),
                  ).length
                }{" "}
                条匹配
              </span>
            )}
            <button
              onClick={() => {
                setShowSearch(false);
                setSearchQuery("");
              }}
              className="p-1 rounded-md hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 消息区域 */}
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-2 py-2 space-y-6 scroll-smooth relative"
        >
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)]">
              <Bot className="w-14 h-14 mb-3 text-[var(--color-border)] opacity-50" />
              <p className="text-base font-medium opacity-50">
                有什么可以帮你的吗？
              </p>
              <p className="text-[11px] mt-1 opacity-40">
                支持 Markdown、代码高亮、工具调用
              </p>
              <div className="grid grid-cols-2 gap-2 mt-5 w-full max-w-[340px]">
                {[
                  { icon: "💻", text: "帮我写一段代码", prompt: "帮我写一段代码：" },
                  { icon: "📖", text: "搜索知识库", prompt: "在知识库中搜索：" },
                  { icon: "🌐", text: "翻译一段文字", prompt: "帮我翻译以下内容为英文：\n" },
                  { icon: "📝", text: "润色一段文字", prompt: "帮我润色以下文字，使其更加通顺：\n" },
                ].map((item) => (
                  <button
                    key={item.text}
                    onClick={() => {
                      setInput(item.prompt);
                      inputRef.current?.focus();
                    }}
                    className="flex items-center gap-2 px-3 py-2.5 text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] rounded-xl transition-colors text-left"
                  >
                    <span className="text-base">{item.icon}</span>
                    <span>{item.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => {
            const isLastAssistant =
              msg.role === "assistant" &&
              !messages.slice(idx + 1).some((m) => m.role === "assistant");
            const isSearchMatch =
              !searchQuery ||
              msg.content.toLowerCase().includes(searchQuery.toLowerCase());
            return (
              <div
                key={msg.id}
                className={
                  searchQuery && !isSearchMatch
                    ? "opacity-20 transition-opacity"
                    : "transition-opacity"
                }
              >
                <MessageBubble
                  msg={msg}
                  isLastAssistant={isLastAssistant}
                  searchQuery={searchQuery}
                />
              </div>
            );
          })}
          <div ref={messagesEndRef} />

          {/* 滚动到底部按钮 */}
          {showScrollBtn && (
            <button
              onClick={scrollToBottom}
              className="sticky bottom-2 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-lg flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-all z-10"
              title="滚动到底部"
            >
              <ArrowDown className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* 输入区域 — 提取为独立组件 */}
        {visibleMemoryCandidates.length > 0 && (
          <div className="px-2 pb-1">
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 space-y-2">
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                检测到可保存的长期记忆（需你确认）
              </div>
              {visibleMemoryCandidates.map((candidate) => (
                <div
                  key={candidate.id}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                >
                  <div className="text-xs text-[var(--color-text)] break-words">
                    {candidate.content}
                  </div>
                  <div className="flex justify-end gap-2 mt-1">
                    <button
                      onClick={async () => {
                        await dismissMemoryCandidate(candidate.id);
                      }}
                      className="text-[10px] px-2 py-0.5 rounded-md border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]"
                    >
                      忽略
                    </button>
                    <button
                      onClick={async () => {
                        await confirmMemoryCandidate(candidate.id);
                        toast("success", "已保存为长期记忆");
                      }}
                      className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-500 text-white hover:bg-indigo-600"
                    >
                      记住
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <ChatInput
          input={input}
          setInput={setInput}
          onSend={handleSend}
          isStreaming={isStreaming}
          stopStreaming={stopStreaming}
          pendingImages={imagePaths}
          pendingImagePreviews={imagePreviews}
          onPaste={handlePaste}
          onRemoveImage={() => {}}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          onFileSelect={handleFileSelect}
          onFolderSelect={handleFolderSelect}
          previewImage={previewImage}
          setPreviewImage={setPreviewImage}
          inputRef={inputRef}
          isComposingRef={isComposingRef}
          messages={messages}
        />
      </div>
    </div>
  );
});
