/**
 * AI 服务层 — 封装与 Rust 后端的通信
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AIConfig,
  StreamChunkEvent,
  StreamDoneEvent,
  StreamToolCallsEvent,
  StreamToolResultEvent,
} from './types'

/** 获取 AI 配置 */
export async function getAIConfig(): Promise<AIConfig> {
  return invoke<AIConfig>('ai_get_config')
}

/** 保存 AI 配置 */
export async function setAIConfig(config: AIConfig): Promise<void> {
  await invoke('ai_set_config', { config })
}

/** 非流式 AI 对话 */
export async function aiChat(
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  return invoke<string>('ai_chat', { messages })
}

/** 带记忆注入 + 配置路由的快捷对话（供 ContextActionPanel 等轻量场景使用） */
export async function quickChat(
  messages: Array<{ role: string; content: string }>,
  options?: { config?: AIConfig },
): Promise<string> {
  const { resolveRoutedConfig } = await import('./router')
  const {
    buildAssistantMemoryPromptForQuery,
    queueAssistantMemoryCandidates,
  } = await import('./assistant-memory')

  const config = options?.config ?? (await getAIConfig())
  const routedConfig = await resolveRoutedConfig(config)

  let enriched = [...messages]

  if (config.enable_long_term_memory) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.content?.trim())
    if (lastUser) {
      if (config.enable_memory_auto_save) {
        await queueAssistantMemoryCandidates(lastUser.content.trim())
      }
      if (config.enable_memory_auto_recall) {
        const prompt = await buildAssistantMemoryPromptForQuery(lastUser.content.trim(), {
          topK: 6,
          preferSemantic: true,
        })
        if (prompt) enriched = [{ role: 'system', content: prompt }, ...enriched]
      }
    }
  }

  const result = await invoke<string>('ai_chat', { messages: enriched, config: routedConfig })

  if (config.enable_long_term_memory && config.enable_memory_auto_save) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.content?.trim())
    if (lastUser?.content?.trim()) {
      Promise.resolve().then(async () => {
        try {
          const { autoExtractMemories } = await import('@/core/agent/actor/actor-memory')
          await autoExtractMemories(`${lastUser.content.trim()}\n${result}`, undefined, {
            sourceMode: 'ask',
          })
        } catch {
          // best-effort only
        }
      })
    }
  }

  return result
}

/** 流式 AI 对话（带 Function Calling） */
export async function aiChatStream(
  conversationId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  await invoke('ai_chat_stream', { conversationId, messages })
}

/** 监听流式事件 */
export interface StreamListeners {
  onChunk?: (event: StreamChunkEvent) => void
  onDone?: (event: StreamDoneEvent) => void
  onToolCalls?: (event: StreamToolCallsEvent) => void
  onToolResult?: (event: StreamToolResultEvent) => void
  onError?: (error: string) => void
}

export async function listenStreamEvents(
  listeners: StreamListeners,
): Promise<UnlistenFn[]> {
  const unlisteners: UnlistenFn[] = []

  if (listeners.onChunk) {
    const fn = await listen<StreamChunkEvent>('ai-stream-chunk', (e) =>
      listeners.onChunk!(e.payload),
    )
    unlisteners.push(fn)
  }

  if (listeners.onDone) {
    const fn = await listen<StreamDoneEvent>('ai-stream-done', (e) =>
      listeners.onDone!(e.payload),
    )
    unlisteners.push(fn)
  }

  if (listeners.onToolCalls) {
    const fn = await listen<StreamToolCallsEvent>('ai-stream-tool-calls', (e) =>
      listeners.onToolCalls!(e.payload),
    )
    unlisteners.push(fn)
  }

  if (listeners.onToolResult) {
    const fn = await listen<StreamToolResultEvent>('ai-stream-tool-result', (e) =>
      listeners.onToolResult!(e.payload),
    )
    unlisteners.push(fn)
  }

  if (listeners.onError) {
    const fn = await listen<string>('ai-stream-error', (e) =>
      listeners.onError!(e.payload),
    )
    unlisteners.push(fn)
  }

  return unlisteners
}

/** 保存对话历史到本地存储 */
export async function saveConversationHistory(
  conversations: Array<{ id: string; title: string; messages: any[]; createdAt: number; updatedAt: number }>,
): Promise<void> {
  await invoke('save_chat_history', { conversations: JSON.stringify(conversations) })
}

/** 加载对话历史 */
export async function loadConversationHistory(): Promise<any[]> {
  try {
    const json = await invoke<string>('load_chat_history')
    return JSON.parse(json)
  } catch {
    return []
  }
}
