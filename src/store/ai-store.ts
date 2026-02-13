import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface ToolCallInfo {
  id: string
  name: string
  arguments: string
  result?: string
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  timestamp: number
  streaming?: boolean
  toolCalls?: ToolCallInfo[]  // assistant 消息中的工具调用
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
}

export interface AIConfig {
  base_url: string
  api_key: string
  model: string
  temperature: number
  max_tokens: number | null
}

interface AIState {
  config: AIConfig
  conversations: Conversation[]
  currentConversationId: string | null
  isStreaming: boolean
  historyLoaded: boolean

  setConfig: (config: AIConfig) => void
  loadConfig: () => Promise<void>
  saveConfig: (config: AIConfig) => Promise<void>

  createConversation: () => string
  getCurrentConversation: () => Conversation | null
  sendMessage: (content: string) => Promise<void>
  setCurrentConversation: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  clearConversation: (id: string) => void
  regenerateLastMessage: () => Promise<void>
  stopStreaming: () => void
  loadHistory: () => Promise<void>
  persistHistory: () => Promise<void>
}

const generateId = () => Math.random().toString(36).substring(2, 15) + Date.now().toString(36)

export const useAIStore = create<AIState>((set, get) => ({
  config: {
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-4o',
    temperature: 0.7,
    max_tokens: null,
  },
  conversations: [],
  currentConversationId: null,
  isStreaming: false,
  historyLoaded: false,

  setConfig: (config) => set({ config }),

  loadConfig: async () => {
    try {
      const config = await invoke<AIConfig>('ai_get_config')
      set({ config })
    } catch (e) {
      console.error('加载 AI 配置失败:', e)
    }
  },

  saveConfig: async (config) => {
    try {
      await invoke('ai_set_config', { config })
      set({ config })
    } catch (e) {
      console.error('保存 AI 配置失败:', e)
    }
  },

  loadHistory: async () => {
    try {
      const json = await invoke<string>('load_chat_history')
      const conversations = JSON.parse(json) as Conversation[]
      if (conversations.length > 0) {
        set({
          conversations,
          currentConversationId: conversations[0]?.id || null,
          historyLoaded: true,
        })
      } else {
        set({ historyLoaded: true })
      }
    } catch (e) {
      console.error('加载对话历史失败:', e)
      set({ historyLoaded: true })
    }
  },

  persistHistory: async () => {
    try {
      const { conversations } = get()
      const MAX_PERSIST_CONVERSATIONS = 50
      const MAX_PERSIST_MESSAGES = 100
      const trimmed = conversations.slice(0, MAX_PERSIST_CONVERSATIONS).map((c) => ({
        ...c,
        messages: c.messages.slice(-MAX_PERSIST_MESSAGES).map((m) => ({
          ...m,
          streaming: false, // 清除 streaming 状态
        })),
      }))
      await invoke('save_chat_history', { conversations: JSON.stringify(trimmed) })
    } catch (e) {
      console.error('保存对话历史失败:', e)
    }
  },

  createConversation: () => {
    const id = generateId()
    const conversation: Conversation = {
      id,
      title: '新对话',
      messages: [],
      createdAt: Date.now(),
    }
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      currentConversationId: id,
    }))
    // 异步持久化
    setTimeout(() => get().persistHistory(), 100)
    return id
  },

  getCurrentConversation: () => {
    const { conversations, currentConversationId } = get()
    return conversations.find((c) => c.id === currentConversationId) || null
  },

  setCurrentConversation: (id) => set({ currentConversationId: id }),

  deleteConversation: (id) => {
    set((state) => {
      const remaining = state.conversations.filter((c) => c.id !== id)
      const needSwitch = state.currentConversationId === id
      return {
        conversations: remaining,
        currentConversationId: needSwitch ? (remaining[0]?.id || null) : state.currentConversationId,
      }
    })
    setTimeout(() => get().persistHistory(), 100)
  },

  renameConversation: (id, title) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title } : c
      ),
    }))
    setTimeout(() => get().persistHistory(), 100)
  },

  clearConversation: (id) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, messages: [] } : c
      ),
    }))
    setTimeout(() => get().persistHistory(), 100)
  },

  stopStreaming: () => {
    const { conversations, currentConversationId } = get()
    if (!currentConversationId) return
    set((state) => ({
      isStreaming: false,
      conversations: state.conversations.map((c) =>
        c.id === currentConversationId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.streaming ? { ...m, streaming: false, content: m.content || '（已停止生成）' } : m
              ),
            }
          : c
      ),
    }))
    setTimeout(() => get().persistHistory(), 200)
  },

  regenerateLastMessage: async () => {
    const state = get()
    const { currentConversationId, isStreaming } = state
    if (!currentConversationId || isStreaming) return

    const conversation = state.conversations.find((c) => c.id === currentConversationId)
    if (!conversation) return

    const messages = [...conversation.messages]
    // 移除尾部的 assistant 消息
    while (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
      messages.pop()
    }
    // 记录最后一条 user 消息内容，然后也移除它（sendMessage 会重新添加）
    const lastUserMsg = messages.length > 0 && messages[messages.length - 1].role === 'user'
      ? messages.pop()
      : null
    if (!lastUserMsg) return

    // 更新对话消息
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === currentConversationId ? { ...c, messages } : c
      ),
    }))

    // 重新发送
    await get().sendMessage(lastUserMsg.content)
  },

  sendMessage: async (content: string) => {
    const state = get()
    let conversationId = state.currentConversationId

    if (!conversationId) {
      conversationId = get().createConversation()
    }

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    const assistantMessage: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    }

    set((state) => ({
      isStreaming: true,
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              title: c.messages.length === 0 ? content.slice(0, 30) : c.title,
              messages: [...c.messages, userMessage, assistantMessage],
            }
          : c
      ),
    }))

    // helper: 更新当前 assistant 消息
    const updateAssistant = (updater: (m: ChatMessage) => ChatMessage) => {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: c.messages.map((m) => m.id === assistantMessage.id ? updater(m) : m) }
            : c
        ),
      }))
    }

    // 监听流式 chunks（普通文本内容）
    const unlisten = await listen<{ conversation_id: string; content: string }>(
      'ai-stream-chunk',
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          updateAssistant((m) => ({ ...m, content: m.content + event.payload.content }))
        }
      }
    )

    // 监听工具调用
    const unlistenToolCalls = await listen<{ conversation_id: string; tool_calls: ToolCallInfo[] }>(
      'ai-stream-tool-calls',
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          updateAssistant((m) => ({
            ...m,
            content: m.content || '正在调用工具...',
            toolCalls: event.payload.tool_calls.map((tc: any) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            })),
          }))
        }
      }
    )

    // 监听工具结果
    const unlistenToolResult = await listen<{ conversation_id: string; tool_call_id: string; name: string; result: string }>(
      'ai-stream-tool-result',
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          updateAssistant((m) => ({
            ...m,
            toolCalls: m.toolCalls?.map((tc) =>
              tc.id === event.payload.tool_call_id
                ? { ...tc, result: event.payload.result }
                : tc
            ),
          }))
        }
      }
    )

    const cleanup = () => {
      unlisten()
      unlistenToolCalls()
      unlistenToolResult()
      unlistenDone()
      unlistenError()
    }

    const unlistenDone = await listen<{ conversation_id: string }>(
      'ai-stream-done',
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          updateAssistant((m) => ({ ...m, streaming: false }))
          set({ isStreaming: false })
          cleanup()
          // 对话完成后持久化
          setTimeout(() => get().persistHistory(), 200)
        }
      }
    )

    const unlistenError = await listen<{ conversation_id: string; error: string }>(
      'ai-stream-error',
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          updateAssistant((m) => ({ ...m, content: `❌ ${event.payload.error}`, streaming: false }))
          set({ isStreaming: false })
          cleanup()
        }
      }
    )

    // 构造发送给 API 的消息（过滤掉正在流式填充的消息）
    const conversation = get().conversations.find((c) => c.id === conversationId)
    const apiMessages = (conversation?.messages || [])
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }))

    try {
      await invoke('ai_chat_stream', {
        messages: apiMessages,
        config: state.config,
        conversationId,
      })
    } catch (e) {
      console.error('AI 对话失败:', e)
      set({ isStreaming: false })
      cleanup()
    }
  },
}))
