/**
 * AI 系统 — 核心类型定义
 */

/** AI 模型配置 */
export interface AIConfig {
  base_url: string
  api_key: string
  model: string
  temperature: number
  max_tokens: number | null
}

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
  streaming?: boolean
  toolCalls?: ToolCallInfo[]
}

/** 工具调用信息 */
export interface ToolCallInfo {
  id: string
  name: string
  arguments: string
  result?: string
  status: 'pending' | 'running' | 'done' | 'error'
}

/** 对话 */
export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  model?: string
}

/** AI 流式事件 */
export interface StreamChunkEvent {
  conversation_id: string
  content: string
}

export interface StreamDoneEvent {
  conversation_id: string
  full_content: string
}

export interface StreamToolCallsEvent {
  conversation_id: string
  tool_calls: Array<{
    id: string
    name: string
    arguments: string
  }>
}

export interface StreamToolResultEvent {
  conversation_id: string
  tool_call_id: string
  result: string
}

/** 上下文操作类型 */
export type ContextAction = 'translate' | 'polish' | 'explain' | 'summarize' | 'custom'

/** 预设模型 */
export interface PresetModel {
  id: string
  name: string
  provider: string
}

export const PRESET_MODELS: PresetModel[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI' },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'DeepSeek' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', provider: 'DeepSeek' },
  { id: 'glm-4-plus', name: 'GLM-4 Plus', provider: '智谱' },
  { id: 'qwen-max', name: 'Qwen Max', provider: '通义千问' },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
]
