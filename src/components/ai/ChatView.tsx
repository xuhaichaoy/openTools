import {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useMemo,
  useCallback,
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
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAIStore } from "@/store/ai-store";
import { useToast } from "@/components/ui/Toast";
import { handleError } from "@/core/errors";
import { modelSupportsImageInput } from "@/core/ai/model-capabilities";
import { buildAskAgentHandoff } from "@/core/ai/ask-agent-handoff";
import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import {
  buildAICenterHandoffScopedFileRefs,
  normalizeAICenterHandoff,
  pickVisualAttachmentPaths,
} from "@/core/ai/ai-center-handoff";
import { useInputAttachments } from "@/hooks/use-input-attachments";
import { ModelSelector } from "./ModelSelector";
import { MessageBubble } from "./MessageBubble";
import { ToolConfirmDialog } from "./ToolConfirmDialog";
import { ChatInput } from "./ChatInput";
import { ChatHistory } from "./ChatHistory";
import { useDragWindow } from "@/hooks/useDragWindow";
import { routeToAICenter } from "@/core/ai/ai-center-routing";
import { useShallow } from "zustand/shallow";

export interface ChatViewHandle {
  toggleHistory: () => void;
  toggleSearch: () => void;
  exportChat: () => void;
  newChat: () => void;
  hasMessages: () => boolean;
  /** 将当前 Ask 对话上下文传递到 Agent 模式继续 */
  continueInAgent: () => void;
  /** 将当前 Ask 对话上下文传递到 Cluster 模式继续 */
  continueInCluster: () => void;
  /** 将当前 Ask 对话上下文传递到 Dialog 模式继续 */
  continueInDialog: () => void;
}

const MEMORY_KIND_META: Record<string, { label: string; className: string }> = {
  preference: { label: "偏好", className: "bg-blue-500/10 text-blue-600 dark:text-blue-300" },
  fact: { label: "事实", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
  goal: { label: "目标", className: "bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  constraint: { label: "约束", className: "bg-red-500/10 text-red-600 dark:text-red-300" },
  project_context: { label: "项目", className: "bg-violet-500/10 text-violet-600 dark:text-violet-300" },
  conversation_summary: { label: "摘要", className: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-300" },
  session_note: { label: "会话笔记", className: "bg-slate-500/10 text-slate-600 dark:text-slate-300" },
  knowledge: { label: "知识", className: "bg-teal-500/10 text-teal-600 dark:text-teal-300" },
  behavior: { label: "行为", className: "bg-orange-500/10 text-orange-600 dark:text-orange-300" },
};

const MEMORY_SCOPE_LABELS: Record<string, string> = {
  global: "全局",
  conversation: "会话",
  workspace: "工作区",
};

const ASK_MEMORY_DOCK_COLLAPSED_KEY = "ask_memory_candidate_dock_collapsed";

export const ChatView = forwardRef<ChatViewHandle, { onBack?: () => void; hideModelSelector?: boolean; headless?: boolean }>(function ChatView({ onBack, hideModelSelector, headless }, ref) {
  const [input, setInput] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const {
    attachments,
    imagePaths,
    imagePreviews,
    fileContextBlock,
    attachmentSummary,
    handlePaste,
    handleFileSelect,
    handleFileSelectNative,
    handleFolderSelect,
    handleDrop,
    handleDragOver,
    removeAttachment,
    clearAttachments,
    addAttachmentFromPath,
  } = useInputAttachments();
  const [showHistory, setShowHistory] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [memoryDockCollapsed, setMemoryDockCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ASK_MEMORY_DOCK_COLLAPSED_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const prevMessagesLengthRef = useRef(0);
  const scrollThrottleRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const streamStartTimeRef = useRef<number | null>(null);
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
  } = useAIStore(
    useShallow((s) => ({
      getCurrentConversation: s.getCurrentConversation,
      sendMessage: s.sendMessage,
      isStreaming: s.isStreaming,
      config: s.config,
      conversations: s.conversations,
      currentConversationId: s.currentConversationId,
      createConversation: s.createConversation,
      stopStreaming: s.stopStreaming,
      memoryCandidates: s.memoryCandidates,
      loadMemoryCandidates: s.loadMemoryCandidates,
      confirmMemoryCandidate: s.confirmMemoryCandidate,
      dismissMemoryCandidate: s.dismissMemoryCandidate,
    })),
  );

  const { toast } = useToast();
  const { onMouseDown } = useDragWindow();
  const conversation = getCurrentConversation();
  const messages = useMemo(() => conversation?.messages ?? [], [conversation]);
  const matchedIndices = useMemo(() => {
    if (!searchQuery.trim()) return [] as number[];
    const q = searchQuery.toLowerCase();
    return messages.reduce<number[]>((acc, m, i) => {
      if (m.content.toLowerCase().includes(q)) acc.push(i);
      return acc;
    }, []);
  }, [messages, searchQuery]);

  // 搜索词变化时重置到第一个匹配
  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [searchQuery]);

  // 导航到当前匹配消息
  useEffect(() => {
    if (matchedIndices.length === 0 || !messagesContainerRef.current) return;
    const msgIdx = matchedIndices[currentMatchIdx];
    const el = messagesContainerRef.current.querySelector(`[data-msg-index="${msgIdx}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentMatchIdx, matchedIndices]);

  const relevantMemoryCandidates = useMemo(() => {
    const filtered = memoryCandidates.filter(
      (candidate) =>
        candidate.review_surface !== "background"
        && candidate.kind !== "session_note"
        && candidate.scope !== "workspace"
        && (
          !candidate.conversation_id
          || candidate.conversation_id === currentConversationId
        )
    );
    return filtered.slice(0, 3);
  }, [currentConversationId, memoryCandidates]);
  const backgroundMemoryCandidateCount = useMemo(() => {
    return memoryCandidates.filter(
      (candidate) =>
        candidate.review_surface === "background"
        && (
          !candidate.conversation_id
          || candidate.conversation_id === currentConversationId
        ),
    ).length;
  }, [currentConversationId, memoryCandidates]);
  const memoryDockPreview = relevantMemoryCandidates[0]?.content ?? "";

  useEffect(() => {
    try {
      localStorage.setItem(ASK_MEMORY_DOCK_COLLAPSED_KEY, memoryDockCollapsed ? "1" : "0");
    } catch {
      // ignore local preference write failures
    }
  }, [memoryDockCollapsed]);

  const lastAssistantIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  }, [messages]);

  const buildAskModeHandoff = useCallback((options?: { maxMessages?: number; maxCharsPerMessage?: number }) => {
    const conversationHandoff = buildAskAgentHandoff(conversation, options);
    const draftText = input.trim();
    const draftAttachmentPaths = Array.from(
      new Set(
        attachments
          .map((attachment) => attachment.path)
          .filter((path): path is string => typeof path === "string" && path.trim().length > 0),
      ),
    );
    const draftVisualAttachmentPaths = pickVisualAttachmentPaths(draftAttachmentPaths, 12) ?? [];
    const hasDraft = !!draftText || draftAttachmentPaths.length > 0;
    if (!conversationHandoff && !hasDraft) return null;

    const fallbackText = fileContextBlock.trim()
      ? "请先阅读我从 Ask 带入的附件/目录，再继续处理。"
      : imagePaths.length > 0
        ? "请先查看我从 Ask 带入的图片，再继续处理。"
        : "请继续处理我在 Ask 中准备的草稿。";
    const draftQuery = attachmentSummary
      ? `${attachmentSummary}\n${draftText || fallbackText}`
      : (draftText || fallbackText);
    const inferredDraftCoding = inferCodingExecutionProfile({
      query: draftQuery,
      fileContextBlock,
      attachmentPaths: draftAttachmentPaths,
    });

    if (!conversationHandoff) {
      return normalizeAICenterHandoff({
        query: draftQuery,
        ...(draftAttachmentPaths.length > 0 ? { attachmentPaths: draftAttachmentPaths } : {}),
        ...(draftVisualAttachmentPaths.length > 0 ? { visualAttachmentPaths: draftVisualAttachmentPaths } : {}),
        title: "延续 Ask 草稿",
        goal: draftText || "继续处理 Ask 草稿里的当前任务",
        intent: inferredDraftCoding.profile.codingMode ? "coding" : "general",
        keyPoints: [
          draftText ? "带入尚未发送的 Ask 草稿" : "带入尚未发送的 Ask 附件",
          draftAttachmentPaths.length > 0 ? `包含 ${draftAttachmentPaths.length} 个草稿附件` : "",
          draftVisualAttachmentPaths.length > 0 ? `包含 ${draftVisualAttachmentPaths.length} 张视觉参考图` : "",
        ].filter(Boolean),
        nextSteps: [
          "先阅读 Ask 草稿，再决定直接回答、继续执行，还是切换工作方式",
          draftVisualAttachmentPaths.length > 0 ? "优先利用草稿里已带入的视觉参考图" : "",
        ],
        files: buildAICenterHandoffScopedFileRefs({
          attachmentPaths: draftAttachmentPaths,
          visualAttachmentPaths: draftVisualAttachmentPaths,
          visualReason: "Ask 草稿视觉参考图",
          attachmentReason: draftAttachmentPaths.length > 0 ? "Ask 草稿附件" : undefined,
        }),
        sourceMode: "ask" as const,
        ...(conversation?.id ? { sourceSessionId: conversation.id } : {}),
        sourceLabel: "Ask 草稿",
        summary: draftAttachmentPaths.length > 0
          ? `Ask 草稿，附带 ${draftAttachmentPaths.length} 个文件/图片/目录${draftVisualAttachmentPaths.length > 0 ? `，其中 ${draftVisualAttachmentPaths.length} 张为视觉参考图` : ""}`
          : "Ask 草稿",
      });
    }

    if (!hasDraft) return conversationHandoff;

    const attachmentPaths = Array.from(
      new Set([
        ...(conversationHandoff.attachmentPaths || []),
        ...draftAttachmentPaths,
      ]),
    );
    const visualAttachmentPaths = Array.from(
      new Set([
        ...(conversationHandoff.visualAttachmentPaths || []),
        ...draftVisualAttachmentPaths,
      ]),
    );
    const draftBlock = [
      "以下是我在 Ask 中尚未发送、但希望一起带过去的当前草稿/附件：",
      "",
      draftQuery,
    ].join("\n");

    return normalizeAICenterHandoff({
      ...conversationHandoff,
      query: `${conversationHandoff.query}\n\n---\n\n${draftBlock}`,
      ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
      ...(visualAttachmentPaths.length > 0 ? { visualAttachmentPaths } : {}),
      title: conversationHandoff.title || "延续 Ask 对话与草稿",
      goal: draftText || conversationHandoff.goal,
      intent: conversationHandoff.intent === "coding" || inferredDraftCoding.profile.codingMode
        ? "coding"
        : conversationHandoff.intent,
      keyPoints: [
        ...(conversationHandoff.keyPoints || []),
        "额外带入了当前未发送草稿",
        draftAttachmentPaths.length > 0 ? `新增 ${draftAttachmentPaths.length} 个草稿附件` : "",
        draftVisualAttachmentPaths.length > 0 ? `新增 ${draftVisualAttachmentPaths.length} 张视觉参考图` : "",
      ].filter(Boolean),
      nextSteps: [
        ...(conversationHandoff.nextSteps || []),
        "结合最新草稿一起继续处理，不要忽略未发送部分",
        draftVisualAttachmentPaths.length > 0 ? "先查看新带入的视觉参考图，再继续执行" : "",
      ],
      files: buildAICenterHandoffScopedFileRefs({
        attachmentPaths,
        visualAttachmentPaths,
        visualReason: "Ask 视觉参考图",
        attachmentReason: "Ask 附件/目录上下文",
      }),
      summary: attachmentPaths.length > 0
        ? `Ask 对话上下文 + 当前草稿，附带 ${attachmentPaths.length} 个文件/图片/目录${visualAttachmentPaths.length > 0 ? `，其中 ${visualAttachmentPaths.length} 张为视觉参考图` : ""}`
        : "Ask 对话上下文 + 当前草稿",
    });
  }, [attachmentSummary, attachments, conversation, fileContextBlock, imagePaths.length, input]);

  const continueAskInMode = useCallback((mode: "agent" | "cluster" | "dialog") => {
    const handoff = buildAskModeHandoff();
    routeToAICenter({
      mode,
      source: mode === "agent"
        ? "ask_continue_to_agent"
        : mode === "cluster"
          ? "ask_continue_to_cluster"
          : "ask_continue_to_dialog",
      ...(handoff ? { handoff } : {}),
      navigate: false,
    });
  }, [buildAskModeHandoff]);

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
    continueInAgent: () => continueAskInMode("agent"),
    continueInCluster: () => continueAskInMode("cluster"),
    continueInDialog: () => continueAskInMode("dialog"),
  }), [continueAskInMode, createConversation, messages.length]);

  // 初次进入自动聚焦输入框
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  useEffect(() => {
    loadMemoryCandidates();
  }, [loadMemoryCandidates]);

  const scrollToBottom = useCallback((instant?: boolean) => {
    const container = messagesContainerRef.current;
    if (!container) return;
    if (instant) {
      container.scrollTop = container.scrollHeight;
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    userScrolledUpRef.current = false;
  }, []);

  // 监听滚动位置 + 检测用户主动上滑
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollBtn(distanceFromBottom > 200);
      if (distanceFromBottom > 300) {
        userScrolledUpRef.current = true;
      } else if (distanceFromBottom < 50) {
        userScrolledUpRef.current = false;
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // 自动滚动到底部（合并后的唯一滚动 effect）
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const lastMsg = messages[messages.length - 1];
    const streaming = lastMsg?.role === "assistant" && lastMsg?.streaming;
    const lengthIncreased = messages.length > prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = messages.length;

    // 记录流式开始时间
    if (streaming && !streamStartTimeRef.current) {
      streamStartTimeRef.current = Date.now();
    } else if (!streaming) {
      streamStartTimeRef.current = null;
    }

    // 用户发送新消息时（消息数量增加）总是滚动到底部
    if (lengthIncreased) {
      const t = setTimeout(() => {
        container.scrollTop = container.scrollHeight;
        userScrolledUpRef.current = false;
      }, 80);
      return () => clearTimeout(t);
    }

    // 用户主动上滑或正在选择文本时不自动滚动
    if (userScrolledUpRef.current) return;
    const hasSelection = window.getSelection()?.toString();
    if (hasSelection) return;

    if (!streaming) return;

    // 流式节流 150ms
    const now = Date.now();
    if (now - scrollThrottleRef.current < 150) return;
    scrollThrottleRef.current = now;

    const id = requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

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
    if (
      imagesToSend
      && imagesToSend.length > 0
      && !modelSupportsImageInput(config.model, config.protocol)
    ) {
      toast(
        "warning",
        "当前模型不支持图片识别，本次会自动降级为文本提示；如需看图，请切换到支持视觉输入的模型。",
      );
    }
    const defaultPrompt = fileContextBlock
      ? "请阅读以上文件内容，等待我的下一步指令。"
      : "请描述这张图片";
    const userText = trimmed || defaultPrompt;
    const content = attachmentSummary ? `${attachmentSummary}\n${userText}` : userText;
    const contextPrefix = fileContextBlock.trim() || undefined;
    const attachmentPathsToSend = attachments
      .filter((attachment) => attachment.type !== "image")
      .map((attachment) => attachment.path)
      .filter((path): path is string => !!path);
    setInput("");
    clearAttachments();
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    await sendMessage(
      content,
      imagesToSend,
      contextPrefix,
      attachmentPathsToSend.length > 0 ? attachmentPathsToSend : undefined,
    );
  };

  return (
    <div className="flex h-full bg-[var(--color-bg)] relative" onDrop={handleDrop} onDragOver={handleDragOver}>
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
            {!hideModelSelector && <ModelSelector scopeMode="ask" />}
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
                } else if (e.key === "Enter" && matchedIndices.length > 0) {
                  e.preventDefault();
                  if (e.shiftKey) {
                    setCurrentMatchIdx((prev) => (prev - 1 + matchedIndices.length) % matchedIndices.length);
                  } else {
                    setCurrentMatchIdx((prev) => (prev + 1) % matchedIndices.length);
                  }
                }
              }}
            />
            {searchQuery && (
              <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">
                {matchedIndices.length > 0
                  ? `${currentMatchIdx + 1}/${matchedIndices.length}`
                  : "0 条匹配"}
              </span>
            )}
            <button
              onClick={() =>
                setCurrentMatchIdx((prev) =>
                  matchedIndices.length === 0 ? 0 : (prev - 1 + matchedIndices.length) % matchedIndices.length,
                )
              }
              disabled={matchedIndices.length === 0}
              className="p-1 rounded-md hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] disabled:opacity-30"
              title="上一个匹配"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() =>
                setCurrentMatchIdx((prev) =>
                  matchedIndices.length === 0 ? 0 : (prev + 1) % matchedIndices.length,
                )
              }
              disabled={matchedIndices.length === 0}
              className="p-1 rounded-md hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] disabled:opacity-30"
              title="下一个匹配"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
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
            const isLastAssistant = idx === lastAssistantIdx;
            const isSearchMatch =
              !searchQuery ||
              msg.content.toLowerCase().includes(searchQuery.toLowerCase());
            const isCurrentMatch =
              searchQuery && matchedIndices[currentMatchIdx] === idx;
            return (
              <div
                key={msg.id}
                data-msg-index={idx}
                className={
                  isCurrentMatch
                    ? "ring-1 ring-[var(--color-accent)] rounded-lg transition-all"
                    : searchQuery && !isSearchMatch
                      ? "opacity-20 transition-opacity"
                      : "transition-opacity"
                }
              >
                <MessageBubble
                  msg={msg}
                  isLastAssistant={isLastAssistant}
                  searchQuery={searchQuery}
                  onContinueAskMode={continueAskInMode}
                />
              </div>
            );
          })}
          <ToolConfirmDialog />
          <div ref={messagesEndRef} />

          {/* 滚动到底部按钮 */}
          {showScrollBtn && (
            <button
              onClick={() => scrollToBottom()}
              className="sticky bottom-2 left-1/2 -translate-x-1/2 w-7 h-7 rounded-full bg-[var(--color-bg)]/60 border border-[var(--color-border)]/40 shadow-sm flex items-center justify-center text-[var(--color-text-secondary)]/50 hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]/80 transition-all z-10 backdrop-blur-sm"
              title="滚动到底部"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 输入区域 — 提取为独立组件 */}
        {relevantMemoryCandidates.length > 0 && (
          <div className="px-2 pb-1">
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
              <button
                type="button"
                onClick={() => setMemoryDockCollapsed((value) => !value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="shrink-0 text-[11px] font-medium text-[var(--color-text)]">
                  长期记忆候选 {relevantMemoryCandidates.length}
                </span>
                {backgroundMemoryCandidateCount > 0 && (
                  <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                    后台 {backgroundMemoryCandidateCount}
                  </span>
                )}
                {memoryDockCollapsed && memoryDockPreview && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]">
                    {memoryDockPreview}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[var(--color-text-tertiary)]">
                  {memoryDockCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </span>
              </button>

              {!memoryDockCollapsed && (
                <div className="space-y-2 px-2 pb-2">
                  <div className="px-1 text-[10px] text-[var(--color-text-secondary)]">
                    自动提取的候选会先收在这里，确认后才会进入正式长期记忆。
                  </div>
                  {relevantMemoryCandidates.map((candidate) => (
                    <div
                      key={candidate.id}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                    >
                      <div className="text-xs text-[var(--color-text)] break-words">
                        {candidate.content}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {candidate.kind && MEMORY_KIND_META[candidate.kind] && (
                          <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${MEMORY_KIND_META[candidate.kind].className}`}>
                            {MEMORY_KIND_META[candidate.kind].label}
                          </span>
                        )}
                        <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                          {(candidate.scope && MEMORY_SCOPE_LABELS[candidate.scope]) || (candidate.conversation_id ? "会话" : "全局")}
                        </span>
                        <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                          {candidate.review_surface === "inline" ? "建议确认" : "后台候选"}
                        </span>
                        {candidate.conflict_memory_ids && candidate.conflict_memory_ids.length > 0 && (
                          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                            有冲突
                          </span>
                        )}
                      </div>
                      {candidate.conflict_summary && (
                        <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                          {candidate.conflict_summary}
                        </div>
                      )}
                      <div className="mt-1 flex justify-end gap-2">
                        <button
                          onClick={async () => {
                            await dismissMemoryCandidate(candidate.id);
                          }}
                          className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-bg-hover)]"
                        >
                          忽略
                        </button>
                        {!!candidate.conflict_memory_ids?.length && (
                          <button
                            onClick={async () => {
                              await confirmMemoryCandidate(candidate.id, { replaceConflicts: true });
                              toast("success", "已替换旧记忆并保存新记忆");
                            }}
                            className="rounded-md bg-amber-500 px-2 py-0.5 text-[10px] text-white hover:bg-amber-600"
                          >
                            替换旧项
                          </button>
                        )}
                        <button
                          onClick={async () => {
                            await confirmMemoryCandidate(candidate.id);
                            toast("success", "已保存为长期记忆");
                          }}
                          className="rounded-md bg-indigo-500 px-2 py-0.5 text-[10px] text-white hover:bg-indigo-600"
                        >
                          {!!candidate.conflict_memory_ids?.length ? "保留并记住" : "记住"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
          onFileSelectNative={handleFileSelectNative}
          onFolderSelect={handleFolderSelect}
          onAddFilePath={addAttachmentFromPath}
          previewImage={previewImage}
          setPreviewImage={setPreviewImage}
          inputRef={inputRef}
          isComposingRef={isComposingRef}
          messages={messages}
          streamStartTime={streamStartTimeRef.current}
        />
      </div>
    </div>
  );
});
