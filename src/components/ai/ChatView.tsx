import { useState, useRef, useEffect, useCallback } from "react";
import {
  Plus,
  Loader2,
  Bot,
  ArrowLeft,
  History,
  Square,
  ArrowDown,
  Download,
  Zap,
  Search,
  X,
  ImagePlus,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAIStore } from "@/store/ai-store";
import { useToast } from "@/components/ui/Toast";
import { ModelSelector } from "./ModelSelector";
import { MessageBubble } from "./MessageBubble";
import { ConversationList } from "./ConversationList";
import { ToolConfirmDialog } from "./ToolConfirmDialog";
import { useDragWindow } from "@/hooks/useDragWindow";

export function ChatView({ onBack }: { onBack?: () => void }) {
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [pendingImagePreviews, setPendingImagePreviews] = useState<string[]>(
    [],
  );
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const prevMessagesLengthRef = useRef(0);
  const scrollThrottleRef = useRef(0);
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

  // 初次进入自动聚焦输入框
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // 自动滚动到底部：发送后延迟一帧再滚确保 DOM 已更新；流式时直接设 scrollTop 并节流，避免抖动
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
      // 新消息（含发送后新增两条）：等布局完成再滚到底
      const t = setTimeout(doScroll, 80);
      return () => clearTimeout(t);
    }

    if (!shouldScroll) return;

    // 流式时节流，避免每字都滚导致抖动
    if (streaming) {
      const now = Date.now();
      if (now - scrollThrottleRef.current < 60) return;
      scrollThrottleRef.current = now;
    }

    const id = requestAnimationFrame(doScroll);
    return () => cancelAnimationFrame(id);
  }, [messages]);

  // 自动滚动到底部
  useEffect(() => {
    scrollToBottom();
  }, [messages, pendingImages, pendingImagePreviews]);

  // 进入页面时自动滚动到底部
  useEffect(() => {
    scrollToBottom();
  }, []);

  // 监听滚动位置，控制"滚动到底部"按钮显示
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

  // 切换对话时重置搜索状态
  useEffect(() => {
    setShowSearch(false);
    setSearchQuery("");
  }, [currentConversationId]);

  // 键盘快捷键
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl + N → 新对话
      if (isMod && e.key === "n") {
        e.preventDefault();
        createConversation();
        setInput("");
        setShowSearch(false);
        setSearchQuery("");
        inputRef.current?.focus();
      }
      // Cmd/Ctrl + F → 切换搜索栏
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

  // 点击外部关闭 Prompt 模板菜单
  const templateRef = useRef<HTMLDivElement>(null);
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
      console.error("导出失败:", e);
      toast("warning", "导出失败");
    }
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if ((!trimmed && pendingImages.length === 0) || isStreaming) return;

    if (!config.api_key) {
      toast("warning", "请先在设置中配置 AI API Key");
      return;
    }

    const imagesToSend =
      pendingImages.length > 0 ? [...pendingImages] : undefined;
    setInput("");
    setPendingImages([]);
    setPendingImagePreviews([]);
    // 重置 textarea 高度
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    await sendMessage(trimmed || "请描述这张图片", imagesToSend);
  };

  // 粘贴图片处理
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          // 生成预览
          setPendingImagePreviews((prev) => [...prev, dataUrl]);
          // 提取 base64 数据并保存到文件
          const base64 = dataUrl.split(",")[1];
          const ext = blob.type.split("/")[1] || "png";
          const fileName = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const filePath = await invoke<string>("ai_save_chat_image", {
              imageData: base64,
              fileName,
            });
            setPendingImages((prev) => [...prev, filePath]);
          } catch (err) {
            console.error("保存图片失败:", err);
            toast("warning", "图片保存失败");
            // 恢复预览
            setPendingImagePreviews((prev) => prev.slice(0, -1));
          }
        };
        reader.readAsDataURL(blob);
      }
    }
  };

  const removeImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
    setPendingImagePreviews((prev) => prev.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // keyCode 229 = IME 正在处理；isComposingRef = 输入法组合中
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !isComposingRef.current &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full bg-[var(--color-bg)] relative">
      {/* 工具确认对话框 */}
      <ToolConfirmDialog />

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

          <div className="flex-1 flex justify-end items-center gap-1">
            <ModelSelector />
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
                  {
                    icon: "💻",
                    text: "帮我写一段代码",
                    prompt: "帮我写一段代码：",
                  },
                  {
                    icon: "📖",
                    text: "搜索知识库",
                    prompt: "在知识库中搜索：",
                  },
                  {
                    icon: "🌐",
                    text: "翻译一段文字",
                    prompt: "帮我翻译以下内容为英文：\n",
                  },
                  {
                    icon: "📝",
                    text: "润色一段文字",
                    prompt: "帮我润色以下文字，使其更加通顺：\n",
                  },
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

        {/* 停止生成按钮 + token 计数 */}
        {isStreaming &&
          (() => {
            const streamingMsg = messages.find((m) => m.streaming);
            const charCount = streamingMsg?.content?.length || 0;
            // 粗略估算 token：中文字符≈1.5token，ascii≈0.25token
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
                    {[
                      {
                        icon: "🌐",
                        label: "翻译为英文",
                        prompt: "请将以下内容翻译为英文，保持原意和语气：\n\n",
                      },
                      {
                        icon: "🇨🇳",
                        label: "翻译为中文",
                        prompt: "请将以下内容翻译为中文，保持原意和语气：\n\n",
                      },
                      {
                        icon: "📝",
                        label: "润色文字",
                        prompt: "请帮我润色以下文字，使其更加通顺专业：\n\n",
                      },
                      {
                        icon: "📋",
                        label: "总结内容",
                        prompt: "请帮我总结以下内容的要点：\n\n",
                      },
                      {
                        icon: "💻",
                        label: "代码审查",
                        prompt:
                          "请审查以下代码，指出问题并给出优化建议：\n\n```\n\n```",
                      },
                      {
                        icon: "🐛",
                        label: "修复代码Bug",
                        prompt:
                          "以下代码存在 bug，请帮我找到并修复：\n\n```\n\n```",
                      },
                      {
                        icon: "📖",
                        label: "解释代码",
                        prompt: "请逐行解释以下代码的功能：\n\n```\n\n```",
                      },
                      {
                        icon: "✍️",
                        label: "写正则表达式",
                        prompt: "请帮我写一个正则表达式，要求：",
                      },
                    ].map((t) => (
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
              {/* 图片预览区 - 放在顶部 */}
              {pendingImagePreviews.length > 0 && (
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
                        onClick={() => removeImage(i)}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm z-10"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                className="w-full bg-transparent text-[var(--color-text)] text-[14px] px-2 outline-none resize-none min-h-[32px] max-h-[160px] placeholder:text-[var(--color-text-secondary)]/50 leading-relaxed py-2"
                placeholder={
                  pendingImages.length > 0
                    ? "输入描述（可省略）..."
                    : "输入消息..."
                }
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
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
              onClick={handleSend}
              disabled={
                isStreaming || (!input.trim() && pendingImages.length === 0)
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
    </div>
  );
}
