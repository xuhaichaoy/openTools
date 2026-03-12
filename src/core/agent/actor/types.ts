import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { AgentRole } from "@/core/agent/cluster/types";

// ── Actor Lifecycle ──

export type ActorStatus = "idle" | "running" | "waiting" | "paused" | "stopped";

/** 思维深度控制（对标 OpenClaw thinkingLevel / reasoningLevel） */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

// ── Inbox ──

export type InboxMessagePriority = "normal" | "urgent";

export interface InboxMessage {
  id: string;
  from: string;
  content: string;
  timestamp: number;
  priority: InboxMessagePriority;
  /** 是否期望回复（接收方会被提示需要回应） */
  expectReply?: boolean;
  /** 如果这条消息是对某条消息的回复 */
  replyTo?: string;
}

// ── Dialog Messages（UI 层使用） ──

export interface DialogMessage extends InboxMessage {
  /** 接收方 actor id（undefined = 广播） */
  to?: string;
  /** UI 显示用的简短内容（附件摘要），完整上下文仍在 content 中发送给 Agent */
  _briefContent?: string;
}

// ── Agent Configuration ──

/** Agent 协作能力标签（用于智能路由） */
export type AgentCapability =
  | "coordinator"        // 协调者：擅长分解任务、协调其他 Agent
  | "code_review"        // 代码审查
  | "code_write"         // 代码编写
  | "code_analysis"      // 代码分析
  | "security"           // 安全评估
  | "performance"        // 性能优化
  | "architecture"       // 架构设计
  | "debugging"          // 调试排错
  | "research"           // 调研搜索
  | "documentation"      // 文档撰写
  | "testing"           // 测试编写
  | "devops"            // DevOps/部署
  | "data_analysis"      // 数据分析
  | "creative"           // 创意头脑风暴
  | "synthesis"          // 综合分析/整合
  // 操作类能力（与 DIALOG_FULL_ROLE 对齐）
  | "file_write"         // 文件写入
  | "shell_execute"      // Shell 命令执行
  | "information_retrieval" // 信息检索
  | "web_search";        // Web 搜索

/** Agent 能力描述 */
export interface AgentCapabilities {
  /** 能力标签列表 */
  tags: AgentCapability[];
  /** 能力描述（可选，用于更详细的说明） */
  description?: string;
  /** 擅长处理的任务类型关键词 */
  expertise?: string[];
}

export interface ToolPolicy {
  /** 允许的工具名称（glob 模式），空数组 = 全部允许 */
  allow?: string[];
  /** 禁止的工具名称（glob 模式） */
  deny?: string[];
}

/** HumanApproval 策略级别 */
export type ApprovalLevel = "strict" | "normal" | "permissive" | "off";

/** 中间件覆盖配置 */
export interface MiddlewareOverrides {
  /** 禁用的中间件名称列表 */
  disable?: string[];
  /** HumanApproval 策略级别（覆盖默认） */
  approvalLevel?: ApprovalLevel;
}

export interface ActorConfig {
  id: string;
  role: AgentRole;
  /** 是否持久化保留（默认 true）。持久 Agent 不应被 spawn_task 清理删除。 */
  persistent?: boolean;
  modelOverride?: string;
  /** 覆盖默认 maxIterations */
  maxIterations?: number;
  /** 自定义 system prompt（覆盖 role.systemPrompt） */
  systemPromptOverride?: string;
  /** 工具策略：控制此 Agent 可用的工具 */
  toolPolicy?: ToolPolicy;
  /** 全局超时（秒），超时后 assignTask 自动 abort */
  timeoutSeconds?: number;
  /** Agent 工作目录（独立 workspace，shell 执行时使用） */
  workspace?: string;
  /** 上下文 Token 预算，用于智能裁剪对话历史 */
  contextTokens?: number;
  /** 思维深度控制（对标 OpenClaw thinkingLevel） */
  thinkingLevel?: ThinkingLevel;
  /** 协作能力（用于智能路由和展示） */
  capabilities?: AgentCapabilities;
  /**
   * 中间件链覆盖配置。
   * 支持禁用特定中间件或调整 HumanApproval 策略。
   * 例如 Agent Shell 模式设置 approvalLevel: "off" 跳过所有审批。
   */
  middlewareOverrides?: MiddlewareOverrides;
}

// ── Subagent Spawn Configuration ──

/** spawn_task 时可动态覆盖的 Subagent 配置 */
export interface SpawnTaskOverrides {
  /** 覆盖 subagent 使用的 LLM 模型 */
  model?: string;
  /** 覆盖最大迭代次数 */
  maxIterations?: number;
  /** 覆盖工具策略（白名单/黑名单） */
  toolPolicy?: ToolPolicy;
  /** 覆盖 context token 预算 */
  contextTokens?: number;
  /** 覆盖思维深度 */
  thinkingLevel?: ThinkingLevel;
  /** 追加系统提示（不替换原有 role systemPrompt，而是附加指令） */
  systemPromptAppend?: string;
  /** 覆盖中间件配置 */
  middlewareOverrides?: MiddlewareOverrides;
  /** 覆盖温度 */
  temperature?: number;
}

// ── Actor Events ──

export type ActorEventType =
  | "status_change"
  | "message_received"
  | "message_sent"
  | "task_started"
  | "task_completed"
  | "task_error"
  | "step"
  // Spawned task lifecycle events (inspired by deer-flow SSE stream_writer)
  | "spawned_task_started"
  | "spawned_task_running"
  | "spawned_task_completed"
  | "spawned_task_failed"
  | "spawned_task_timeout"
  | "session_title_updated";

export interface ActorEvent {
  type: ActorEventType;
  actorId: string;
  timestamp: number;
  detail?: unknown;
}

/**
 * Structured detail for spawned task lifecycle events.
 * Mirrors deer-flow's task_started / task_running / task_completed / task_failed SSE events.
 */
export interface SpawnedTaskEventDetail {
  runId: string;
  spawnerActorId: string;
  targetActorId: string;
  targetName: string;
  spawnerName: string;
  label?: string;
  task: string;
  status: SpawnedTaskStatus;
  /** Elapsed time in ms since spawn */
  elapsed?: number;
  /** Result content (only for completed) */
  result?: string;
  /** Error message (only for failed/timeout) */
  error?: string;
}

// ── Actor Task ──

export interface ActorTask {
  id: string;
  query: string;
  status: "pending" | "running" | "completed" | "error" | "aborted";
  result?: string;
  error?: string;
  steps: AgentStep[];
  startedAt?: number;
  finishedAt?: number;
}

// ── Ask-and-Wait ──

export interface PendingReply {
  fromActorId: string;
  messageId: string;
  resolve: (reply: InboxMessage) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

// ── Spawned Tasks (OpenClaw-style) ──

export type SpawnedTaskStatus = "running" | "completed" | "error" | "aborted";

/** Spawn 模式：对标 OpenClaw sessions_spawn mode */
export type SpawnMode = "run" | "session";

/** SpawnedTaskRecord：对标 OpenClaw subagent registry entry */
export interface SpawnedTaskRecord {
  runId: string;
  spawnerActorId: string;
  targetActorId: string;
  task: string;
  label?: string;
  /** 任务状态 */
  status: SpawnedTaskStatus;
  spawnedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  timeoutId?: ReturnType<typeof setTimeout>;
  /** Spawn 模式：run=一次性任务，session=保持会话 */
  mode: SpawnMode;
  /** 期望完成消息（对标 expectsCompletionMessage） */
  expectsCompletionMessage: boolean;
  /** 清理策略：delete=完成后删除，keep=保持 */
  cleanup: "delete" | "keep";
}
