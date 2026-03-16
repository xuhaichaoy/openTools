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
import { useAuthStore } from "@/store/auth-store";
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
import {
  confirmMemoryCandidate as confirmAIMemoryCandidate,
  dismissMemoryCandidate as dismissAIMemoryCandidate,
  listMemoryCandidates,
  type AIMemoryCandidate,
} from "@/core/ai/memory-store";
import {
  buildAssistantMemoryPromptForQuery,
  queueAssistantMemoryCandidates,
} from "@/core/ai/assistant-memory";
import { applyAILocalConfigOverrides } from "@/core/ai/local-ai-config-preferences";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { loadAndResolveSkills } from "@/store/skill-store";
import { useMcpStore, executeMcpTool } from "@/store/mcp-store";
import { useAISessionRuntimeStore } from "@/store/ai-session-runtime-store";

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
  memoryCandidates: AIMemoryCandidate[];

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
  sendMessage: (
    content: string,
    images?: string[],
    contextPrefix?: string,
    attachmentPaths?: string[],
  ) => Promise<void>;
  setCurrentConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  clearConversation: (id: string) => void;
  regenerateLastMessage: () => Promise<void>;
  editAndResend: (messageId: string, newContent: string) => Promise<void>;
  stopStreaming: () => void;
  confirmTool: (approved: boolean) => Promise<void>;
  loadMemoryCandidates: () => Promise<void>;
  confirmMemoryCandidate: (
    id: string,
    options?: { replaceConflicts?: boolean },
  ) => Promise<void>;
  dismissMemoryCandidate: (id: string) => Promise<void>;
  loadHistory: () => Promise<void>;
  persistHistory: () => Promise<void>;
}

/** 触发防抖持久化的便捷函数 */
function triggerPersist() {
  debouncedPersist(() => useAIStore.getState().persistHistory());
}

/** 保存当前流式会话的 cleanup 引用,用于 stopStreaming 时清理事件监听 */
let _streamCleanup: (() => void) | null = null;

function nativeToolsSupportedOnCurrentPlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.platform.toLowerCase().includes("mac");
}

function normalizeConfig(config: AIConfig): AIConfig {
  const source = config.source || "own_key";
  const normalizedConcurrency =
    typeof config.agent_max_concurrency === "number"
      ? Math.max(1, Math.min(8, Math.floor(config.agent_max_concurrency)))
      : 2;
  const normalizedRetryMax =
    typeof config.agent_retry_max === "number"
      ? Math.max(0, Math.min(10, Math.floor(config.agent_retry_max)))
      : 3;
  const normalizedBackoffMs =
    typeof config.agent_retry_backoff_ms === "number"
      ? Math.max(500, Math.min(60000, Math.floor(config.agent_retry_backoff_ms)))
      : 5000;
  const normalizedMaxIterations =
    typeof config.agent_max_iterations === "number"
      ? Math.max(5, Math.min(50, Math.floor(config.agent_max_iterations)))
      : 25;
  const normalized: AIConfig = {
    ...config,
    source,
    thinking_level: undefined,
    enable_long_term_memory: config.enable_long_term_memory ?? true,
    enable_memory_auto_recall: config.enable_memory_auto_recall ?? true,
    enable_memory_auto_save: config.enable_memory_auto_save ?? true,
    enable_memory_sync: config.enable_memory_sync ?? true,
    agent_runtime_mode: config.agent_runtime_mode || "host",
    agent_max_concurrency: normalizedConcurrency,
    agent_retry_max: normalizedRetryMax,
    agent_retry_backoff_ms: normalizedBackoffMs,
    agent_max_iterations: normalizedMaxIterations,
    request_rag_mode: undefined,
    disable_force_rag: undefined,
  };

  const finalConfig = applyAILocalConfigOverrides(normalized);
  if (source !== "team") {
    finalConfig.team_id = undefined;
    finalConfig.team_config_id = undefined;
  } else if (!finalConfig.team_id) {
    finalConfig.team_config_id = undefined;
  }
  if (source !== "own_key") {
    finalConfig.active_own_key_id = undefined;
  }
  if (!nativeToolsSupportedOnCurrentPlatform()) {
    finalConfig.enable_native_tools = false;
  }

  return finalConfig;
}

const DEFAULT_AI_CONFIG: AIConfig = normalizeConfig({
  base_url: DEFAULT_AI_BASE_URL,
  api_key: "",
  model: DEFAULT_AI_MODEL,
  temperature: DEFAULT_AI_TEMPERATURE,
  max_tokens: null,
  enable_advanced_tools: false,
  system_prompt: "",
  enable_rag_auto_search: true,
  enable_native_tools: nativeToolsSupportedOnCurrentPlatform(),
  enable_long_term_memory: true,
  enable_memory_auto_recall: true,
  enable_memory_auto_save: true,
  enable_memory_sync: true,
  source: "own_key",
  agent_runtime_mode: "host",
  agent_max_concurrency: 2,
  agent_retry_max: 3,
  agent_retry_backoff_ms: 5000,
  agent_max_iterations: 25,
});

export const useAIStore = create<AIState>((set, get) => ({
  config: DEFAULT_AI_CONFIG,
  conversations: [],
  currentConversationId: null,
  isStreaming: false,
  historyLoaded: false,
  pendingToolConfirm: null,
  ownKeys: [],
  memoryCandidates: [],

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
      // 自有 Key 下若无选中或选中已失效，默认选第一个并持久化（在 loadConfig 之后调用时生效）
      if (keys.length > 0) {
        const { config: c } = get();
        if (c.source === "own_key" && (!c.active_own_key_id || !keys.some((k) => k.id === c.active_own_key_id))) {
          const key = keys[0];
          const newConfig: AIConfig = {
            ...c,
            source: "own_key",
            team_id: undefined,
            team_config_id: undefined,
            protocol: key.protocol,
            base_url: key.base_url,
            api_key: key.api_key,
            model: key.model,
            temperature: key.temperature,
            max_tokens: key.max_tokens,
            active_own_key_id: key.id,
          };
          const normalized = normalizeConfig(newConfig);
          set({ config: normalized });
          invoke("ai_set_config", { config: normalized }).catch((e) =>
            handleError(e, { context: "保存 AI 配置" }),
          );
        }
      }
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
      useAISessionRuntimeStore.getState().syncSessions(
        conversations.map((conversation) => ({
          mode: "ask" as const,
          externalSessionId: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt
            ?? conversation.messages[conversation.messages.length - 1]?.timestamp
            ?? conversation.createdAt,
          summary: summarizeAISessionRuntimeText(
            conversation.messages[conversation.messages.length - 1]?.content,
            140,
          ),
        })),
      );
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
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title: "新对话",
      messages: [],
      createdAt: now,
    };
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      currentConversationId: id,
    }));
    useAISessionRuntimeStore.getState().ensureSession({
      mode: "ask",
      externalSessionId: id,
      title: conversation.title,
      createdAt: now,
      updatedAt: now,
    });
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
    useAISessionRuntimeStore.getState().touchSession("ask", id, { title });
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

  loadMemoryCandidates: async () => {
    try {
      const candidates = await listMemoryCandidates();
      set({ memoryCandidates: candidates });
    } catch (e) {
      handleError(e, { context: "加载长期记忆候选", silent: true });
    }
  },

  confirmMemoryCandidate: async (id: string, options) => {
    try {
      await confirmAIMemoryCandidate(id, options);
      const candidates = await listMemoryCandidates();
      set({ memoryCandidates: candidates });
    } catch (e) {
      handleError(e, { context: "确认长期记忆候选" });
    }
  },

  dismissMemoryCandidate: async (id: string) => {
    try {
      await dismissAIMemoryCandidate(id);
      const candidates = await listMemoryCandidates();
      set({ memoryCandidates: candidates });
    } catch (e) {
      handleError(e, { context: "忽略长期记忆候选", silent: true });
    }
  },

  stopStreaming: () => {
    const { currentConversationId } = get();
    if (!currentConversationId) return;
    invoke("ai_stop_stream", { conversationId: currentConversationId }).catch((err) => {
      console.warn("[AIStore] ai_stop_stream failed:", err);
    });
    if (_streamCleanup) {
      _streamCleanup();
      _streamCleanup = null;
    }
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

    const { keptMessages, lastUserMessage } = prepareRegenerateMessages(
      conversation.messages,
    );
    if (!lastUserMessage?.content) return;

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === currentConversationId ? { ...c, messages: keptMessages } : c,
      ),
    }));

    await get().sendMessage(
      lastUserMessage.content,
      lastUserMessage.images,
      lastUserMessage.contextPrefix,
      lastUserMessage.attachmentPaths,
    );
  },

  editAndResend: async (messageId: string, newContent: string) => {
    const state = get();
    const { currentConversationId, isStreaming } = state;
    if (!currentConversationId || isStreaming) return;

    const conversation = state.conversations.find(
      (c) => c.id === currentConversationId,
    );
    if (!conversation) return;

    const prepared = prepareEditMessages(conversation.messages, messageId);
    if (!prepared?.targetMessage || prepared.targetMessage.role !== "user") return;
    const { keptMessages, targetMessage } = prepared;

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === currentConversationId ? { ...c, messages: keptMessages } : c,
      ),
    }));

    await get().sendMessage(
      newContent,
      targetMessage.images,
      targetMessage.contextPrefix,
      targetMessage.attachmentPaths,
    );
  },

  sendMessage: async (
    content: string,
    images?: string[],
    contextPrefix?: string,
    attachmentPaths?: string[],
  ) => {
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
      ...(contextPrefix ? { contextPrefix } : {}),
      ...(attachmentPaths && attachmentPaths.length > 0 ? { attachmentPaths } : {}),
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
    useAISessionRuntimeStore.getState().touchSession("ask", conversationId, {
      title: content.slice(0, 30) || undefined,
    });

    // 记忆候选提取（非阻塞，不影响 API 请求速度）
    if (state.config.enable_long_term_memory && state.config.enable_memory_auto_save) {
      const candidateConvId = conversationId ?? undefined;
      Promise.resolve().then(async () => {
        try {
          await queueAssistantMemoryCandidates(content, {
            conversationId: candidateConvId,
          });
        } catch (e) {
          handleError(e, { context: "提取长期记忆候选", silent: true });
        }
      });
    }

    // 构造 API 消息（同步，极快）
    const conversation = get().conversations.find(
      (c) => c.id === conversationId,
    );
    const apiMessages = (conversation?.messages || [])
      .filter((m) => !m.streaming)
      .map((m) => {
        const isCurrentUser = m.id === userMessage.id;
        const msgContent = isCurrentUser && m.contextPrefix
          ? `${m.contextPrefix}\n\n---\n\n${m.content}`
          : m.content;
        return {
          role: m.role,
          content: msgContent,
          ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
        };
      });

    // 记忆召回和 API 请求并行执行：不让记忆召回阻塞请求发出
    const memoryRecallPromise = (state.config.enable_long_term_memory && state.config.enable_memory_auto_recall)
      ? buildAssistantMemoryPromptForQuery(content, {
          conversationId: conversationId ?? undefined,
          topK: 6,
          timeoutMs: 500,
          preferSemantic: true,
        }).catch((e) => {
          handleError(e, { context: "召回长期记忆", silent: true });
          return "";
        })
      : Promise.resolve("");

    const memoryPrompt = await memoryRecallPromise;
    if (memoryPrompt) {
      apiMessages.unshift({ role: "system", content: memoryPrompt });
    }

    if (!conversationId) {
      handleError(new Error("Failed to create conversation"), { context: "AI" });
      return;
    }

    // Skills 注入（与 Agent/Cluster 保持一致）
    try {
      const skillCtx = await loadAndResolveSkills(content);
      if (skillCtx.mergedSystemPrompt) {
        apiMessages.unshift({ role: "system", content: skillCtx.mergedSystemPrompt });
      }
    } catch { /* skills 加载失败不阻塞对话 */ }

    // 收集 MCP 工具定义（转为 OpenAI function calling 格式）
    const mcpTools = useMcpStore.getState().getAllMcpTools();
    const extraTools = mcpTools.map((def) => ({
      type: "function",
      function: {
        name: def.name,
        description: def.description ?? def.name,
        parameters: def.input_schema ?? { type: "object", properties: {} },
      },
    }));

    // 委托 Service 处理流式监听
    const cleanup = await startStreamingChat({
      conversationId,
      assistantMessageId: assistantMessage.id,
      apiMessages,
      config: state.config,
      extraTools: extraTools.length > 0 ? extraTools : undefined,
      onFrontendToolCall: extraTools.length > 0
        ? async (name, args) => executeMcpTool(name, args)
        : undefined,
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
        onPersist: () => {
          _streamCleanup = null;
          triggerPersist();
        },
        onDone: (assistantContent) => {
          const currentConfig = useAIStore.getState().config;
          if (!currentConfig.enable_long_term_memory || !currentConfig.enable_memory_auto_save) {
            return;
          }
          Promise.resolve().then(async () => {
            try {
              const { autoExtractMemories } = await import("@/core/agent/actor/actor-memory");
              await autoExtractMemories(`${content}\n${assistantContent}`, conversationId, {
                sourceMode: "ask",
              });
            } catch (e) {
              handleError(e, { context: "沉淀 Ask 会话记忆", silent: true });
            }
          });
        },
      },
    });
    _streamCleanup = cleanup;
  },
}));

useAuthStore.subscribe((state, prev) => {
  if (prev.isLoggedIn && !state.isLoggedIn) {
    const { config } = useAIStore.getState();
    if (config.source === "team" || config.team_id) {
      const cleared = {
        ...config,
        source: "own_key" as const,
        team_id: undefined,
        team_config_id: undefined,
      };
      useAIStore.getState().saveConfig(cleared);
    }
  }
});
