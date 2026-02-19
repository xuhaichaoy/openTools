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
  OwnKeyModelConfig,
} from "@/core/ai/types";

export type {
  ToolCallInfo,
  ChatMessage,
  Conversation,
  AIConfig,
  PendingToolConfirm,
  OwnKeyModelConfig,
};

// Agent Store 作为 AI 的子模式，从此处统一导出
export { useAgentStore } from "./agent-store";
export type { AgentTask, AgentSession } from "./agent-store";

interface AIState {
  config: AIConfig;
  conversations: Conversation[];
  currentConversationId: string | null;
  isStreaming: boolean;
  historyLoaded: boolean;
  pendingToolConfirm: PendingToolConfirm | null;

  /** 自有 Key 模型列表 */
  ownKeys: OwnKeyModelConfig[];

  setConfig: (config: AIConfig) => void;
  loadConfig: () => Promise<void>;
  saveConfig: (config: AIConfig) => Promise<void>;

  /** 加载自有 Key 列表（含存量迁移） */
  loadOwnKeys: () => Promise<void>;
  /** 保存自有 Key 列表 */
  saveOwnKeys: (keys: OwnKeyModelConfig[]) => Promise<void>;
  /** 选中某个自有 Key 模型，将其配置写入 config */
  selectOwnKeyModel: (id: string) => void;

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

function normalizeConfig(config: AIConfig): AIConfig {
  const source = config.source || "own_key";
  const normalized: AIConfig = { ...config, source };

  if (source !== "team") {
    normalized.team_id = undefined;
    normalized.team_config_id = undefined;
  } else if (!normalized.team_id) {
    normalized.team_config_id = undefined;
  }

  return normalized;
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
    enable_rag_auto_search: true,
    enable_native_tools: true,
    source: "own_key",
  },
  conversations: [],
  currentConversationId: null,
  isStreaming: false,
  historyLoaded: false,
  pendingToolConfirm: null,
  ownKeys: [],

  setConfig: (config) => set({ config: normalizeConfig(config) }),

  loadConfig: async () => {
    try {
      const config = await invoke<AIConfig>("ai_get_config");
      set({ config: normalizeConfig(config) });
    } catch (e) {
      handleError(e, { context: "加载 AI 配置", silent: true });
    }
  },

  saveConfig: async (config) => {
    try {
      const normalized = normalizeConfig(config);
      await invoke("ai_set_config", { config: normalized });
      set({ config: normalized });
    } catch (e) {
      handleError(e, { context: "保存 AI 配置" });
    }
  },

  loadOwnKeys: async () => {
    try {
      let keys = await invoke<OwnKeyModelConfig[]>("ai_get_own_keys");

      // 存量迁移：如果 ownKeys 为空但 ai_config 有 api_key，自动创建第一条
      if (keys.length === 0) {
        const { config } = get();
        if (config.api_key && config.source !== "team" && config.source !== "platform") {
          const migrated: OwnKeyModelConfig = {
            id: generateChatId(),
            name: config.model || "Default",
            protocol: (config.protocol as "openai" | "anthropic") || "openai",
            base_url: config.base_url || DEFAULT_AI_BASE_URL,
            api_key: config.api_key,
            model: config.model || DEFAULT_AI_MODEL,
            temperature: config.temperature ?? DEFAULT_AI_TEMPERATURE,
            max_tokens: config.max_tokens ?? null,
          };
          keys = [migrated];
          await invoke("ai_set_own_keys", { keys });
          // 将 active_own_key_id 指向迁移的 key
          const newConfig = { ...config, active_own_key_id: migrated.id };
          await invoke("ai_set_config", { config: newConfig });
          set({ config: newConfig });
        }
      }

      set({ ownKeys: keys });
    } catch (e) {
      handleError(e, { context: "加载自有 Key 列表", silent: true });
    }
  },

  saveOwnKeys: async (keys) => {
    try {
      await invoke("ai_set_own_keys", { keys });
      set({ ownKeys: keys });
    } catch (e) {
      handleError(e, { context: "保存自有 Key 列表" });
    }
  },

  selectOwnKeyModel: (id) => {
    const { ownKeys, config } = get();
    const key = ownKeys.find((k) => k.id === id);
    if (!key) return;

    const newConfig: AIConfig = {
      ...config,
      source: "own_key",
      team_id: undefined,
      team_config_id: undefined,
      protocol: key.protocol,
      base_url: key.base_url,
      api_key: key.api_key,
      model: key.model,
      temperature: key.temperature,
      max_tokens: key.max_tokens,
      active_own_key_id: id,
    };

    const normalized = normalizeConfig(newConfig);
    set({ config: normalized });
    invoke("ai_set_config", { config: normalized }).catch((e) =>
      handleError(e, { context: "保存 AI 配置" }),
    );
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

    if (!conversationId) {
      handleError(new Error("Failed to create conversation"), { context: "AI" });
      return;
    }

    // 委托 Service 处理流式监听
    await startStreamingChat({
      conversationId,
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
