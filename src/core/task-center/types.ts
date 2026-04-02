/**
 * TaskCenter 类型定义
 *
 * 任务中心 — 持久化任务队列 + 生命周期管理。
 * 支持延迟任务、定期任务、依赖关系和优先级排序。
 */

export type TaskStatus = "pending" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface TaskDefinition {
  /** 任务唯一 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 任务详细描述 */
  description?: string;
  /** 任务类型（用于路由） */
  type: TaskType;
  /** 优先级 */
  priority: TaskPriority;
  /** 任务参数（JSON 序列化的） */
  params: Record<string, unknown>;
  /** 创建者（用户或 agent ID） */
  createdBy: string;
  /** 目标执行者（agent ID，可选，空则自动路由） */
  assignee?: string;
  /** 依赖的任务 ID 列表（前置任务全部完成后才执行） */
  dependencies?: string[];
  /** 延迟执行时间（Unix timestamp） */
  scheduledAt?: number;
  /** 重复规则（cron 表达式） */
  cronExpression?: string;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 超时（秒） */
  timeoutSeconds?: number;
  /** 标签（用于过滤和分组） */
  tags?: string[];
}

export type TaskType =
  | "agent_chat"      // Agent 对话任务
  | "agent_spawn"     // Agent 子任务
  | "code_analysis"   // 代码分析
  | "file_operation"  // 文件操作
  | "web_search"      // Web 搜索
  | "scheduled"       // 定时任务
  | "custom";         // 自定义

export interface TaskRecord extends TaskDefinition {
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** 结果（完成时） */
  result?: string;
  /** 错误信息（失败时） */
  error?: string;
  /** 进度（0-100） */
  progress?: number;
  /** 进度描述 */
  progressLabel?: string;
  /** 已重试次数 */
  retryCount: number;
  /** 关联的 ActorSystem session ID */
  sessionId?: string;
  /** 关联的 spawnTask runId */
  runId?: string;
  /** 子任务 ID 列表 */
  subtasks?: string[];
}

/** 任务队列事件 */
export type TaskEvent =
  | { type: "task_created"; task: TaskRecord }
  | { type: "task_updated"; taskId: string; patch: Partial<TaskRecord> }
  | { type: "task_started"; taskId: string }
  | { type: "task_progress"; taskId: string; progress: number; label?: string }
  | { type: "task_completed"; taskId: string; result?: string }
  | { type: "task_failed"; taskId: string; error: string }
  | { type: "task_cancelled"; taskId: string }
  | { type: "task_deleted"; taskId: string }
  | { type: "task_retrying"; taskId: string; retryCount: number };

export type TaskEventHandler = (event: TaskEvent) => void;

/** 任务过滤条件 */
export interface TaskFilter {
  status?: TaskStatus[];
  type?: TaskType[];
  priority?: TaskPriority[];
  tags?: string[];
  createdBy?: string;
  assignee?: string;
  /** 时间范围（Unix timestamp） */
  since?: number;
  until?: number;
}

/** 任务统计 */
export interface TaskStats {
  total: number;
  byStatus: Record<TaskStatus, number>;
  byPriority: Record<TaskPriority, number>;
  avgCompletionTimeMs: number;
  failureRate: number;
}
