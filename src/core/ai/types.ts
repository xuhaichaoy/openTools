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

/**
 * AI IPC 请求使用的消息类型（与 UI ChatMessage 分离，避免耦合 id/timestamp 等展示字段）。
 */
export interface AIRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ToolCallInfo[];
  tool_call_id?: string;
  name?: string;
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
  /** 启用长期记忆能力（总开关） */
  enable_long_term_memory: boolean;
  /** 对话前自动召回长期记忆 */
  enable_memory_auto_recall: boolean;
  /** 对话后自动提取长期记忆候选 */
  enable_memory_auto_save: boolean;
  /** 允许长期记忆参与云同步 */
  enable_memory_sync: boolean;
  source?: "own_key" | "team" | "platform";
  team_id?: string;
  team_config_id?: string;
  /** API 协议：openai 或 anthropic */
  protocol?: "openai" | "anthropic";
  /** 当前激活的自有 Key 配置 ID */
  active_own_key_id?: string;
  /** Agent 运行时模式（Sprint1 默认 host） */
  agent_runtime_mode?: "host" | "hybrid" | "container_preferred";
  /** Agent 最大并发任务数 */
  agent_max_concurrency?: number;
  /** Agent 失败重试次数上限 */
  agent_retry_max?: number;
  /** Agent 重试退避基准毫秒（指数退避） */
  agent_retry_backoff_ms?: number;
  /** 本次请求的 RAG 行为覆盖（仅运行时，不持久化） */
  request_rag_mode?: "inherit" | "off" | "on";
  /** 禁用产品名触发的 RAG 兜底（仅运行时，不持久化） */
  disable_force_rag?: boolean;
}

export type AgentRuntimeMode = "host" | "hybrid" | "container_preferred";
export type AgentScheduleType = "once" | "interval" | "cron";
export type AgentTaskStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "paused"
  | "cancelled";
export type AgentTaskResultStatus = "success" | "error" | "skipped";

export interface AgentScheduledTask {
  id: string;
  session_id?: string;
  query: string;
  schedule_type?: AgentScheduleType;
  schedule_value?: string;
  status: AgentTaskStatus;
  retry_count: number;
  next_run_at?: number;
  last_error?: string;
  last_started_at?: number;
  last_finished_at?: number;
  last_duration_ms?: number;
  last_result_status?: AgentTaskResultStatus;
  last_skip_reason?: string;
  created_at: number;
  updated_at: number;
}

export interface AgentTaskStatusPatch {
  task_id: string;
  status: AgentTaskStatus;
  retry_count: number;
  next_run_at?: number;
  last_error?: string;
  last_started_at?: number;
  last_finished_at?: number;
  last_duration_ms?: number;
  last_result_status?: AgentTaskResultStatus;
  last_skip_reason?: string;
  updated_at: number;
}

export interface AgentTaskSkippedEvent {
  task_id: string;
  reason: "overlap_running";
  skipped_at: number;
  next_run_at?: number;
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
