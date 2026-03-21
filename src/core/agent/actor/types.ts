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
  /** 附带的图片路径（本地文件路径） */
  images?: string[];
  /** 附带的文件列表（本地文件路径） */
  attachments?: { path: string; fileName?: string }[];
}

// ── Dialog Messages（UI 层使用） ──

export type DialogMessageKind =
  | "user_input"
  | "agent_message"
  | "agent_result"
  | "clarification_request"
  | "clarification_response"
  | "approval_request"
  | "approval_response"
  | "system_notice";

export type PendingInteractionType = "question" | "clarification" | "approval";
export type PendingInteractionStatus = "pending" | "answered" | "timed_out" | "cancelled";
export type PendingInteractionReplyMode = "single" | "broadcast";

export interface ApprovalRequestDetail {
  label: string;
  value: string;
  mono?: boolean;
}

export type ApprovalDecisionPolicy = "always-allow" | "ask-every-time" | "deny";

export interface ApprovalDecisionOption {
  label: string;
  policy: ApprovalDecisionPolicy;
  cacheKey?: string;
  description?: string;
}

export interface ApprovalRequest {
  toolName: string;
  title: string;
  summary: string;
  riskDescription?: string;
  targetPath?: string;
  preview?: string;
  fullContent?: string;
  previewLabel?: string;
  previewLanguage?: string;
  previewTruncated?: boolean;
  details?: ApprovalRequestDetail[];
  cacheScopeSummary?: string;
  decisionOptions?: ApprovalDecisionOption[];
}

export interface DialogExecutionPlanEdge {
  fromActorId: string;
  toActorId: string;
}

export interface DialogExecutionPlannedSpawn {
  id: string;
  targetActorId: string;
  targetActorName?: string;
  task: string;
  label?: string;
  context?: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
  createIfMissing?: boolean;
  childDescription?: string;
  childCapabilities?: AgentCapability[];
  childWorkspace?: string;
  childMaxIterations?: number;
}

export interface DialogExecutionPlan {
  id: string;
  routingMode: "direct" | "coordinator" | "smart" | "broadcast";
  summary: string;
  approvedAt: number;
  initialRecipientActorIds: string[];
  participantActorIds: string[];
  coordinatorActorId?: string;
  allowedMessagePairs: DialogExecutionPlanEdge[];
  allowedSpawnPairs: DialogExecutionPlanEdge[];
  plannedSpawns?: DialogExecutionPlannedSpawn[];
  state: "armed" | "active" | "completed" | "failed";
  activatedAt?: number;
  sourceMessageId?: string;
}

export interface DialogMessage extends InboxMessage {
  /** 接收方 actor id（undefined = 广播） */
  to?: string;
  /** UI 显示用的简短内容（附件摘要），完整上下文仍在 content 中发送给 Agent */
  _briefContent?: string;
  /** 外部 IM 来源通道类型（用于 runtime 展示） */
  externalChannelType?: "dingtalk" | "feishu";
  /** 外部 IM 来源通道 ID（用于回投提醒等长期任务） */
  externalChannelId?: string;
  /** 外部 IM 来源会话 ID（用于回投提醒等长期任务） */
  externalConversationId?: string;
  /** 外部 IM 会话类型（用于 runtime 展示） */
  externalConversationType?: "private" | "group";
  /** 外部 IM runtime session id（用于恢复展示上下文） */
  externalSessionId?: string;
  /** runtime 展示层标签（避免直接泄露内部模式名） */
  runtimeDisplayLabel?: string;
  /** runtime 展示层附加说明（如来源平台 / 会话类型） */
  runtimeDisplayDetail?: string;
  /** 对话协议中的消息类型 */
  kind?: DialogMessageKind;
  /** 与用户交互时的交互类型 */
  interactionType?: PendingInteractionType;
  /** 当前交互消息的状态 */
  interactionStatus?: PendingInteractionStatus;
  /** 可选项列表（用于澄清/审批） */
  options?: string[];
  /** 所属交互 ID */
  interactionId?: string;
  /** 审批请求的结构化摘要（供 UI 卡片渲染） */
  approvalRequest?: ApprovalRequest;
  /** 关联的子会话 runId（用于 thread-bound child session 聚焦） */
  relatedRunId?: string;
  memoryRecallAttempted?: boolean;
  appliedMemoryPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  appliedTranscriptPreview?: string[];
}

export type DialogArtifactSource =
  | "approval"
  | "message"
  | "tool_write"
  | "tool_edit"
  | "upload";

export interface DialogArtifactRecord {
  id: string;
  actorId: string;
  path: string;
  fileName: string;
  directory: string;
  source: DialogArtifactSource;
  toolName?: string;
  summary: string;
  preview?: string;
  fullContent?: string;
  language?: string;
  timestamp: number;
  relatedRunId?: string;
}

export type SessionUploadType = "image" | "text_file" | "document" | "folder";

export interface SessionUploadRecord {
  id: string;
  type: SessionUploadType;
  name: string;
  path?: string;
  size: number;
  addedAt: number;
  originalExt?: string;
  preview?: string;
  excerpt?: string;
  parsed?: boolean;
  truncated?: boolean;
  canReadFromPath?: boolean;
  multimodalEligible?: boolean;
}

export interface DialogQueuedFollowUp {
  id: string;
  displayText: string;
  content: string;
  briefContent?: string;
  images?: string[];
  attachmentPaths?: string[];
  uploadRecords?: SessionUploadRecord[];
  routingMode: "direct" | "coordinator" | "smart" | "broadcast";
  contractState?: "none" | "sealed" | "needs_reapproval";
  contractStatus?: "ready" | "needs_reapproval" | "missing";
  createdAt: number;
}

export interface DialogContextSummary {
  summary: string;
  summarizedMessageCount: number;
  updatedAt: number;
}

export interface DialogRoomCompactionState {
  summary: string;
  compactedMessageCount: number;
  compactedSpawnedTaskCount: number;
  compactedArtifactCount: number;
  preservedIdentifiers: string[];
  triggerReasons?: string[];
  memoryFlushNoteId?: string;
  memoryConfirmedCount?: number;
  memoryQueuedCount?: number;
  updatedAt: number;
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
  | "web_search"         // Web 搜索
  | "vision";            // 视觉识别

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

/** 访问权限级别：控制是否允许读写执行环境。 */
export type AccessMode = "read_only" | "auto" | "full_access";

/** HumanApproval 策略级别 */
export type ApprovalMode = "strict" | "normal" | "permissive" | "off";
export type ApprovalLevel = ApprovalMode;

/** 统一执行策略：对齐 access mode + approval mode 控制面。 */
export interface ExecutionPolicy {
  accessMode?: AccessMode;
  approvalMode?: ApprovalMode;
}

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
  /** 一等执行策略：访问权限 + 审批模式 */
  executionPolicy?: ExecutionPolicy;
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
  /** 覆盖执行策略 */
  executionPolicy?: ExecutionPolicy;
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

/** 单次运行级别的覆盖配置，避免污染 Actor 常驻实例状态 */
export interface ActorRunOverrides extends SpawnTaskOverrides {}

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
  | "session_title_updated"
  | "dialog_plan_finalized"
  | "session_stalled";

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
  /** Latest progress message (for running events) */
  message?: string;
  /** Latest step type (for running events) */
  stepType?: AgentStep["type"];
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
  memoryRecallAttempted?: boolean;
  appliedMemoryPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  appliedTranscriptPreview?: string[];
}

// ── Ask-and-Wait ──

export interface PendingReply {
  fromActorId: string;
  messageId: string;
  resolve: (reply: InboxMessage) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export interface PendingInteractionResult {
  interactionId: string;
  interactionType: PendingInteractionType;
  status: "answered" | "timed_out" | "cancelled";
  content: string;
  message?: InboxMessage;
}

export interface PendingInteraction {
  id: string;
  fromActorId: string;
  messageId: string;
  question: string;
  type: PendingInteractionType;
  replyMode: PendingInteractionReplyMode;
  status: PendingInteractionStatus;
  createdAt: number;
  expiresAt?: number;
  options?: string[];
  approvalRequest?: ApprovalRequest;
  resolve: (result: PendingInteractionResult) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

// ── Spawned Tasks (OpenClaw-style) ──

export type SpawnedTaskStatus = "running" | "completed" | "error" | "aborted";

/** Spawn 模式：对标 OpenClaw sessions_spawn mode */
export type SpawnMode = "run" | "session";
export type SpawnedTaskRoleBoundary = "reviewer" | "validator" | "executor" | "general";

/** SpawnedTaskRecord：对标 OpenClaw subagent registry entry */
export interface SpawnedTaskRecord {
  runId: string;
  spawnerActorId: string;
  targetActorId: string;
  /** 关联的父 execution contract；无 contract 的手动派工可为空 */
  contractId?: string;
  /** 关联的已批准委派建议；纯手动派工可为空 */
  plannedDelegationId?: string;
  /** 这次派工来自显式建议委派还是纯手动决定 */
  dispatchSource: "manual" | "contract_suggestion";
  /** 父任务 runId；直接子任务为空，嵌套子任务会显式指向上游任务 */
  parentRunId?: string;
  /** 当前任务所在协作子树的根任务 runId */
  rootRunId?: string;
  /** 临时子 Agent 的默认职责边界；常驻 Agent 默认为 general */
  roleBoundary?: SpawnedTaskRoleBoundary;
  task: string;
  label?: string;
  /** 任务启动时继承的图片附件（如截图、设计稿） */
  images?: string[];
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
  /** 目标 Agent 会话历史切片起点（用于 UI 聚焦子任务） */
  sessionHistoryStartIndex?: number;
  /** 目标 Agent 会话历史切片终点（任务结束后写入） */
  sessionHistoryEndIndex?: number;
  /** session 模式下该子会话是否仍处于可继续交互的打开状态 */
  sessionOpen?: boolean;
  /** 最近一次收到会话输入或产生会话输出的时间 */
  lastActiveAt?: number;
  /** 子会话关闭时间（手动关闭 / reset / actor 销毁） */
  sessionClosedAt?: number;
}
