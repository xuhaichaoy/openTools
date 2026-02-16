// Workflow 核心类型定义

/** 触发方式 */
export interface WorkflowTrigger {
  type: 'manual' | 'keyword' | 'hotkey' | 'clipboard' | 'cron' | 'interval' | 'once'
  keyword?: string
  hotkey?: string
  /** Cron 表达式（type=cron 时使用，如 "0 9 * * 1-5" = 工作日早9点） */
  cron?: string
  /** 间隔秒数（type=interval 时使用） */
  intervalSeconds?: number
  /** 一次性触发时间 ISO 字符串（type=once 时使用） */
  onceAt?: string
  /** 定时任务是否启用 */
  enabled?: boolean
}

/** 变量定义 */
export interface WorkflowVariable {
  name: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'file'
  required: boolean
  default?: string
  options?: { label: string; value: string }[]
}

/** 步骤类型 */
export type StepType =
  | 'ai_chat'
  | 'script'
  | 'transform'
  | 'http'
  | 'clipboard_read'
  | 'clipboard_write'
  | 'file_read'
  | 'file_write'
  | 'user_input'
  | 'notification'
  | 'condition'
  | 'plugin_action'

/** 画布节点类型（包含特殊节点） */
export type NodeType = StepType | 'start' | 'end'

/** 步骤定义（向后兼容，线性格式） */
export interface WorkflowStep {
  id: string
  name: string
  type: StepType
  config: Record<string, unknown>
  output_var?: string
  condition?: string
  on_error?: 'stop' | 'skip' | 'retry'
}

/** 画布节点定义 */
export interface WorkflowNode {
  id: string
  type: NodeType
  label: string
  config: Record<string, unknown>
  output_var?: string
  on_error?: 'stop' | 'skip' | 'retry'
  position: { x: number; y: number }
}

/** 画布边定义 */
export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string  // condition 节点: 'true' | 'false'
}

/** 工作流定义 */
export interface Workflow {
  id: string
  name: string
  icon: string
  description: string
  category: string
  trigger: WorkflowTrigger
  steps: WorkflowStep[]            // 向后兼容线性格式
  nodes?: WorkflowNode[]           // 可视化画布节点
  edges?: WorkflowEdge[]           // 可视化画布连线
  variables?: WorkflowVariable[]
  builtin: boolean
  created_at: number
}

/** 步骤执行状态 */
export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

/** 执行中的步骤状态 */
export interface StepExecution {
  stepId: string
  status: StepStatus
  result?: string
  error?: string
  startTime?: number
  endTime?: number
}

/** 工作流执行实例 */
export interface WorkflowExecution {
  workflowId: string
  workflowName: string
  status: 'running' | 'done' | 'error'
  steps: StepExecution[]
  startTime: number
  endTime?: number
  finalResult?: string
}

/** 步骤类型描述 */
export const stepTypeInfo: Record<StepType, { label: string; icon: string; description: string; color: string }> = {
  ai_chat: { label: 'AI 对话', icon: '🤖', description: '发送提示词给 AI 并获取回复', color: '#6366f1' },
  script: { label: '运行脚本', icon: '📜', description: '执行 Python 或 Shell 脚本', color: '#f59e0b' },
  transform: { label: '数据转换', icon: '🔄', description: '正则、替换、模板等数据转换', color: '#8b5cf6' },
  http: { label: 'HTTP 请求', icon: '🌐', description: '发送 HTTP 请求获取数据', color: '#3b82f6' },
  clipboard_read: { label: '读取剪贴板', icon: '📋', description: '读取系统剪贴板内容', color: '#10b981' },
  clipboard_write: { label: '写入剪贴板', icon: '📋', description: '将内容写入系统剪贴板', color: '#10b981' },
  file_read: { label: '读取文件', icon: '📄', description: '读取本地文件内容', color: '#06b6d4' },
  file_write: { label: '写入文件', icon: '💾', description: '将内容写入本地文件', color: '#06b6d4' },
  user_input: { label: '用户输入', icon: '✏️', description: '等待用户输入内容', color: '#ec4899' },
  notification: { label: '发送通知', icon: '🔔', description: '发送系统通知', color: '#f97316' },
  condition: { label: '条件判断', icon: '❓', description: '根据条件决定是否执行', color: '#eab308' },
  plugin_action: { label: '插件动作', icon: '🧩', description: '调用内置插件暴露的 Action', color: '#f97316' },
}

/** 特殊节点类型描述 */
export const specialNodeInfo: Record<'start' | 'end', { label: string; icon: string; color: string }> = {
  start: { label: '开始', icon: '▶️', color: '#22c55e' },
  end: { label: '结束', icon: '⏹️', color: '#ef4444' },
}
