export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status?: "pending" | "running" | "done" | "error";
}

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  streaming?: boolean;
  toolCalls?: ToolCallInfo[];
  images?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt?: number;
  model?: string;
}

export interface AIConfig {
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens: number | null;
  enable_advanced_tools: boolean;
  system_prompt: string;
  enable_rag_auto_search: boolean;
  /** 启用本机原生应用工具（日历、提醒事项、备忘录、邮件、快捷指令等） */
  enable_native_tools: boolean;
  source?: "own_key" | "team" | "platform";
  team_id?: string;
  /** API 协议：openai 或 anthropic */
  protocol?: "openai" | "anthropic";
  /** 当前激活的自有 Key 配置 ID */
  active_own_key_id?: string;
}

/** 自有 Key 模型配置项 */
export interface OwnKeyModelConfig {
  id: string;
  /** 显示名称，如 "GPT-4o" */
  name: string;
  /** API 协议 */
  protocol: "openai" | "anthropic";
  /** API Base URL */
  base_url: string;
  /** API Key */
  api_key: string;
  /** 模型标识，如 "gpt-4o" */
  model: string;
  temperature: number;
  max_tokens: number | null;
}

export interface PendingToolConfirm {
  name: string;
  arguments: string;
}

export interface StreamChunkEvent {
  conversation_id: string;
  content: string;
}

export interface StreamDoneEvent {
  conversation_id: string;
}

export interface StreamToolCallsEvent {
  conversation_id: string;
  tool_calls: ToolCallInfo[];
}

export interface StreamToolResultEvent {
  conversation_id: string;
  tool_call_id: string;
  name: string;
  result: string;
}
