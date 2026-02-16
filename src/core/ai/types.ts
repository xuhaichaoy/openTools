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
  source?: "own_key" | "team" | "platform";
  team_id?: string;
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
