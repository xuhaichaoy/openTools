/**
 * AI 对话 Store — 纯状态层
 *
 * 流式监听/消息处理/持久化逻辑已抽取到 AIChatService（src/core/services/ai-chat-service.ts）。
 * Store 只负责：维护 React 响应式状态 + 委托 Service 执行操作。
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_TEMPERATURE,
} from "@/core/constants";
import { handleError } from "@/core/errors";
import {
  generateChatId,
  debouncedPersist,
  persistConversations,
  loadConversationHistory,
  prepareRegenerateMessages,
  prepareEditMessages,
  startStreamingChat,
} from "@/core/services/ai-chat-service";

import type {
  ToolCallInfo,
  ChatMessage,
  Conversation,
  AIConfig,
  PendingToolConfirm,
} from "@/core/ai/types";

export type {
  ToolCallInfo,
  ChatMessage,
  Conversation,
  AIConfig,
  PendingToolConfirm,
};

interface AIState {
  config: AIConfig;
  conversations: Conversation[];
  currentConversationId: string | null;
  isStreaming: boolean;
  historyLoaded: boolean;
  pendingToolConfirm: PendingToolConfirm | null;

  setConfig: (config: AIConfig) => void;
  loadConfig: () => Promise<void>;
  saveConfig: (config: AIConfig) => Promise<void>;

  createConversation: () => string;
  getCurrentConversation: () => Conversation | null;
  sendMessage: (content: string, images?: string[]) => Promise<void>;
  setCurrentConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  clearConversation: (id: string) => void;
  regenerateLastMessage: () => Promise<void>;
  editAndResend: (messageId: string, newContent: string) => Promise<void>;
  stopStreaming: () => void;
  confirmTool: (approved: boolean) => Promise<void>;
  loadHistory: () => Promise<void>;
  persistHistory: () => Promise<void>;
}

/** 触发防抖持久化的便捷函数 */
function triggerPersist() {
  debouncedPersist(() => useAIStore.getState().persistHistory());
}

export const useAIStore = create<AIState>((set, get) => ({
  config: {
    base_url: DEFAULT_AI_BASE_URL,
    api_key: "",
    model: DEFAULT_AI_MODEL,
    temperature: DEFAULT_AI_TEMPERATURE,
    max_tokens: null,
    enable_advanced_tools: false,
    system_prompt: "",
    enable_rag_auto_search: false,
    enable_native_tools: true,
    source: "own_key",
  },
  conversations: [],
  currentConversationId: null,
  isStreaming: false,
  historyLoaded: false,
  pendingToolConfirm: null,

  setConfig: (config) => set({ config }),

  loadConfig: async () => {
    try {
      const config = await invoke<AIConfig>("ai_get_config");
      set({ config });
    } catch (e) {
      handleError(e, { context: "加载 AI 配置", silent: true });
    }
  },

  saveConfig: async (config) => {
    try {
      await invoke("ai_set_config", { config });
      set({ config });
    } catch (e) {
      handleError(e, { context: "保存 AI 配置" });
    }
  },

  loadHistory: async () => {
    const conversations = await loadConversationHistory();
    if (conversations.length > 0) {
      set({
        conversations,
        currentConversationId: conversations[0]?.id || null,
        historyLoaded: true,
      });
    } else {
      set({ historyLoaded: true });
    }
  },

  persistHistory: async () => {
    await persistConversations(get().conversations);
  },

  createConversation: () => {
    const id = generateChatId();
    const conversation: Conversation = {
      id,
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
    };
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      currentConversationId: id,
    }));
    triggerPersist();
    return id;
  },

  getCurrentConversation: () => {
    const { conversations, currentConversationId } = get();
    return conversations.find((c) => c.id === currentConversationId) || null;
  },

  setCurrentConversation: (id) => set({ currentConversationId: id }),

  deleteConversation: (id) => {
    set((state) => {
      const remaining = state.conversations.filter((c) => c.id !== id);
      const needSwitch = state.currentConversationId === id;
      return {
        conversations: remaining,
        currentConversationId: needSwitch
          ? remaining[0]?.id || null
          : state.currentConversationId,
      };
    });
    triggerPersist();
  },

  renameConversation: (id, title) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title } : c,
      ),
    }));
    triggerPersist();
  },

  clearConversation: (id) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, messages: [] } : c,
      ),
    }));
    triggerPersist();
  },

  confirmTool: async (approved: boolean) => {
    try {
      await invoke("ai_confirm_tool", { approved });
    } catch (e) {
      handleError(e, { context: "确认工具" });
    }
    set({ pendingToolConfirm: null });
  },

  stopStreaming: () => {
    const { currentConversationId } = get();
    if (!currentConversationId) return;
    invoke("ai_stop_stream").catch(() => {});
    set((state) => ({
      isStreaming: false,
      conversations: state.conversations.map((c) =>
        c.id === currentConversationId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.streaming
                  ? { ...m, streaming: false, content: m.content || "（已停止生成）" }
                  : m,
              ),
            }
          : c,
      ),
    }));
    triggerPersist();
  },

  regenerateLastMessage: async () => {
    const state = get();
    const { currentConversationId, isStreaming } = state;
    if (!currentConversationId || isStreaming) return;

    const conversation = state.conversations.find(
      (c) => c.id === currentConversationId,
    );
    if (!conversation) return;

    const { keptMessages, lastUserContent } = prepareRegenerateMessages(
      conversation.messages,
    );
    if (!lastUserContent) return;

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === currentConversationId ? { ...c, messages: keptMessages } : c,
      ),
    }));

    await get().sendMessage(lastUserContent);
  },

  editAndResend: async (messageId: string, newContent: string) => {
    const state = get();
    const { currentConversationId, isStreaming } = state;
    if (!currentConversationId || isStreaming) return;

    const conversation = state.conversations.find(
      (c) => c.id === currentConversationId,
    );
    if (!conversation) return;

    const keptMessages = prepareEditMessages(conversation.messages, messageId);
    if (!keptMessages) return;

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === currentConversationId ? { ...c, messages: keptMessages } : c,
      ),
    }));

    await get().sendMessage(newContent);
  },

  sendMessage: async (content: string, images?: string[]) => {
    const state = get();
    let conversationId = state.currentConversationId;

    if (!conversationId) {
      conversationId = get().createConversation();
    }

    const userMessage: ChatMessage = {
      id: generateChatId(),
      role: "user",
      content,
      timestamp: Date.now(),
      ...(images && images.length > 0 ? { images } : {}),
    };

    const assistantMessage: ChatMessage = {
      id: generateChatId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    };

    set((state) => ({
      isStreaming: true,
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              title: c.messages.length === 0 ? content.slice(0, 30) : c.title,
              messages: [...c.messages, userMessage, assistantMessage],
            }
          : c,
      ),
    }));

    // 构造 API 消息
    const conversation = get().conversations.find(
      (c) => c.id === conversationId,
    );
    const apiMessages = (conversation?.messages || [])
      .filter((m) => !m.streaming)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
      }));

    // 委托 Service 处理流式监听
    await startStreamingChat({
      conversationId: conversationId!,
      assistantMessageId: assistantMessage.id,
      apiMessages,
      config: state.config,
      callbacks: {
        updateAssistant: (updater) => {
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === assistantMessage.id ? updater(m) : m,
                    ),
                  }
                : c,
            ),
          }));
        },
        setState: (partial) => set(partial),
        onPersist: triggerPersist,
      },
    });
  },
}));
