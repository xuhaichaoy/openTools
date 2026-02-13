// 数据工坊 — 核心类型定义

/** 脚本参数类型 */
export type ParamType = 'string' | 'number' | 'boolean' | 'select' | 'date' | 'daterange' | 'file' | 'textarea'

/** 脚本参数定义 */
export interface ScriptParam {
  name: string
  label: string
  type: ParamType
  required: boolean
  description?: string
  default?: string | number | boolean
  options?: { label: string; value: string }[] // type=select 时的选项
  placeholder?: string
}

/** 脚本输出配置 */
export interface ScriptOutput {
  type: 'excel' | 'csv' | 'json' | 'text'
  filename_pattern: string
}

/** 脚本元数据 (对应 script.meta.json) */
export interface ScriptMeta {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
  script: string             // 相对于 scripts/ 的路径
  params: ScriptParam[]
  output?: ScriptOutput
  dependencies?: string[]
  estimated_time?: string
  requires_auth?: string[]
}

/** 脚本分类 */
export interface ScriptCategory {
  name: string
  count: number
  scripts: ScriptMeta[]
}

/** 执行状态 */
export type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'

/** 执行记录 */
export interface ExecutionRecord {
  id: string
  script_id: string
  script_name: string
  category: string
  params: Record<string, unknown>
  status: ExecutionStatus
  started_at: number
  finished_at?: number
  duration_ms?: number
  output_files: string[]
  record_count?: number
  logs: string
  error?: string
}

/** 凭证信息 */
export interface Credential {
  key: string
  label: string
  description?: string
  has_value: boolean
}
