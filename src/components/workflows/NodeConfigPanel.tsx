import { X } from 'lucide-react'
import type { WorkflowNode, StepType } from '@/core/workflows/types'
import { stepTypeInfo } from '@/core/workflows/types'

interface NodeConfigPanelProps {
  node: WorkflowNode
  onUpdate: (updates: Partial<WorkflowNode>) => void
  onClose: () => void
}

export function NodeConfigPanel({ node, onUpdate, onClose }: NodeConfigPanelProps) {
  const info = node.type !== 'start' && node.type !== 'end'
    ? stepTypeInfo[node.type as StepType]
    : null

  const updateConfig = (key: string, value: unknown) => {
    onUpdate({ config: { ...node.config, [key]: value } })
  }

  return (
    <div className="w-[260px] shrink-0 border-l border-[var(--color-border)] bg-[var(--color-bg)] overflow-y-auto">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 min-w-0">
          {info && <span className="text-sm">{info.icon}</span>}
          <span className="text-[11px] font-semibold text-[var(--color-text)] truncate">
            {info?.label || node.label}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* 节点名称 */}
        <Field label="名称">
          <input
            type="text"
            value={node.label}
            onChange={(e) => onUpdate({ label: e.target.value })}
            className="w-full bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text)] rounded-lg px-2.5 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50"
          />
        </Field>

        {/* 输出变量 */}
        {node.type !== 'start' && node.type !== 'end' && node.type !== 'notification' && node.type !== 'clipboard_write' && (
          <Field label="输出变量">
            <input
              type="text"
              value={node.output_var || ''}
              onChange={(e) => onUpdate({ output_var: e.target.value || undefined })}
              placeholder="如 step_result"
              className="w-full bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text)] rounded-lg px-2.5 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50 font-mono"
            />
          </Field>
        )}

        {/* 错误处理 */}
        {node.type !== 'start' && node.type !== 'end' && (
          <Field label="错误处理">
            <select
              value={node.on_error || 'stop'}
              onChange={(e) => onUpdate({ on_error: e.target.value as 'stop' | 'skip' | 'retry' })}
              className="w-full bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text)] rounded-lg px-2.5 py-1.5 border border-[var(--color-border)] outline-none"
            >
              <option value="stop">停止执行</option>
              <option value="skip">跳过继续</option>
              <option value="retry">重试一次</option>
            </select>
          </Field>
        )}

        {/* 类型特定配置 */}
        <StepConfigFields type={node.type} config={node.config} onChange={updateConfig} />
      </div>
    </div>
  )
}

// ── 字段容器 ──

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-medium text-[var(--color-text-secondary)] mb-1">{label}</label>
      {children}
    </div>
  )
}

// ── 各类型配置表单 ──

function StepConfigFields({
  type,
  config,
  onChange,
}: {
  type: string
  config: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}) {
  const inputClass = "w-full bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text)] rounded-lg px-2.5 py-1.5 border border-[var(--color-border)] outline-none focus:border-indigo-500/50"
  const textareaClass = `${inputClass} resize-none font-mono`

  switch (type) {
    case 'ai_chat':
      return (
        <>
          <Field label="提示词">
            <textarea
              value={(config.prompt as string) || ''}
              onChange={(e) => onChange('prompt', e.target.value)}
              placeholder="支持 {{变量}} 插值"
              rows={4}
              className={textareaClass}
            />
          </Field>
          <Field label="系统提示词">
            <input
              type="text"
              value={(config.system_prompt as string) || ''}
              onChange={(e) => onChange('system_prompt', e.target.value)}
              placeholder="可选"
              className={inputClass}
            />
          </Field>
          <Field label="温度">
            <input
              type="number"
              min={0} max={2} step={0.1}
              value={(config.temperature as number) ?? 0.7}
              onChange={(e) => onChange('temperature', parseFloat(e.target.value))}
              className={inputClass}
            />
          </Field>
        </>
      )

    case 'script':
      return (
        <>
          <Field label="脚本类型">
            <select
              value={(config.type as string) || 'shell'}
              onChange={(e) => onChange('type', e.target.value)}
              className={inputClass}
            >
              <option value="shell">Shell</option>
              <option value="python">Python</option>
            </select>
          </Field>
          <Field label="脚本内容">
            <textarea
              value={(config.script as string) || ''}
              onChange={(e) => onChange('script', e.target.value)}
              rows={5}
              className={textareaClass}
            />
          </Field>
        </>
      )

    case 'transform':
      return (
        <>
          <Field label="转换类型">
            <select
              value={(config.type as string) || 'template'}
              onChange={(e) => onChange('type', e.target.value)}
              className={inputClass}
            >
              <option value="template">模板</option>
              <option value="replace">替换</option>
              <option value="split">分割</option>
            </select>
          </Field>
          {(config.type as string) === 'replace' ? (
            <>
              <Field label="匹配模式">
                <input
                  type="text"
                  value={(config.pattern as string) || ''}
                  onChange={(e) => onChange('pattern', e.target.value)}
                  className={`${inputClass} font-mono`}
                />
              </Field>
              <Field label="替换为">
                <input
                  type="text"
                  value={(config.replacement as string) || ''}
                  onChange={(e) => onChange('replacement', e.target.value)}
                  className={`${inputClass} font-mono`}
                />
              </Field>
            </>
          ) : (
            <Field label="模板">
              <textarea
                value={(config.template as string) || ''}
                onChange={(e) => onChange('template', e.target.value)}
                placeholder="如 Result: {{prev.output}}"
                rows={3}
                className={textareaClass}
              />
            </Field>
          )}
        </>
      )

    case 'http':
      return (
        <>
          <Field label="方法">
            <select
              value={(config.method as string) || 'GET'}
              onChange={(e) => onChange('method', e.target.value)}
              className={inputClass}
            >
              {['GET', 'POST', 'PUT', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="URL">
            <input
              type="text"
              value={(config.url as string) || ''}
              onChange={(e) => onChange('url', e.target.value)}
              placeholder="https://..."
              className={`${inputClass} font-mono`}
            />
          </Field>
          <Field label="请求体">
            <textarea
              value={(config.body as string) || ''}
              onChange={(e) => onChange('body', e.target.value)}
              rows={3}
              placeholder="JSON body (可选)"
              className={textareaClass}
            />
          </Field>
        </>
      )

    case 'clipboard_write':
      return (
        <Field label="写入内容">
          <input
            type="text"
            value={(config.text as string) || ''}
            onChange={(e) => onChange('text', e.target.value)}
            placeholder="如 {{prev.output}}"
            className={`${inputClass} font-mono`}
          />
        </Field>
      )

    case 'file_read':
      return (
        <Field label="文件路径">
          <input
            type="text"
            value={(config.path as string) || ''}
            onChange={(e) => onChange('path', e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </Field>
      )

    case 'file_write':
      return (
        <>
          <Field label="文件路径">
            <input
              type="text"
              value={(config.path as string) || ''}
              onChange={(e) => onChange('path', e.target.value)}
              className={`${inputClass} font-mono`}
            />
          </Field>
          <Field label="写入内容">
            <textarea
              value={(config.content as string) || ''}
              onChange={(e) => onChange('content', e.target.value)}
              placeholder="如 {{prev.output}}"
              rows={3}
              className={textareaClass}
            />
          </Field>
        </>
      )

    case 'notification':
      return (
        <Field label="通知内容">
          <input
            type="text"
            value={(config.message as string) || ''}
            onChange={(e) => onChange('message', e.target.value)}
            className={inputClass}
          />
        </Field>
      )

    case 'condition':
      return (
        <Field label="条件表达式">
          <textarea
            value={(config.expression as string) || ''}
            onChange={(e) => onChange('expression', e.target.value)}
            placeholder="如 {{clipboard_text}} 不为空则为 true"
            rows={3}
            className={textareaClass}
          />
        </Field>
      )

    case 'user_input':
      return (
        <Field label="变量名">
          <input
            type="text"
            value={(config.variable as string) || 'input'}
            onChange={(e) => onChange('variable', e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </Field>
      )

    default:
      return null
  }
}
