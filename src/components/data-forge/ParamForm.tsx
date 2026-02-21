import { useState, useEffect } from 'react'
import type { ScriptParam } from '@/core/data-forge/types'

interface ParamFormProps {
  params: ScriptParam[]
  onSubmit: (values: Record<string, unknown>) => void
  onChange?: (values: Record<string, unknown>) => void
  isRunning: boolean
  formId?: string
}

function buildInitialValues(params: ScriptParam[]): Record<string, unknown> {
  const initial: Record<string, unknown> = {}
  for (const param of params) {
    if (param.default !== undefined) {
      initial[param.name] = param.default
    } else {
      initial[param.name] = ''
    }
  }
  return initial
}

export function ParamForm({ params, onSubmit, onChange, formId }: ParamFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => buildInitialValues(params))

  // 当 params 变化时（切换脚本）重置表单值
  useEffect(() => {
    const newValues = buildInitialValues(params)
    queueMicrotask(() => {
      setValues(newValues)
      onChange?.(newValues)
    })
  }, [params, onChange])

  const updateValue = (name: string, value: unknown) => {
    setValues((prev) => {
      const next = { ...prev, [name]: value }
      onChange?.(next)
      return next
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(values)
  }

  const renderField = (param: ScriptParam) => {
    const baseClass =
      'w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]'

    switch (param.type) {
      case 'textarea':
        return (
          <textarea
            className={`${baseClass} min-h-[60px] resize-y`}
            value={String(values[param.name] || '')}
            onChange={(e) => updateValue(param.name, e.target.value)}
            placeholder={param.placeholder || param.description}
          />
        )

      case 'select':
        return (
          <select
            className={baseClass}
            value={String(values[param.name] || '')}
            onChange={(e) => updateValue(param.name, e.target.value)}
          >
            <option value="">请选择...</option>
            {param.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )

      case 'boolean':
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 rounded accent-[var(--color-accent)]"
              checked={Boolean(values[param.name])}
              onChange={(e) => updateValue(param.name, e.target.checked)}
            />
            <span className="text-xs text-[var(--color-text-secondary)]">{param.description}</span>
          </label>
        )

      case 'number':
        return (
          <input
            type="number"
            className={baseClass}
            value={String(values[param.name] || '')}
            onChange={(e) => updateValue(param.name, e.target.value ? Number(e.target.value) : '')}
            placeholder={param.placeholder || param.description}
          />
        )

      case 'date':
        return (
          <input
            type="date"
            className={baseClass}
            value={String(values[param.name] || '')}
            onChange={(e) => updateValue(param.name, e.target.value)}
          />
        )

      default: // string, file, daterange
        return (
          <input
            type="text"
            className={baseClass}
            value={String(values[param.name] || '')}
            onChange={(e) => updateValue(param.name, e.target.value)}
            placeholder={param.placeholder || param.description}
          />
        )
    }
  }

  if (params.length === 0) {
    return (
      <div className="text-xs text-[var(--color-text-secondary)] text-center py-3">
        该脚本无需参数
      </div>
    )
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-3">
      {params.map((param) => (
        <div key={param.name}>
          <label className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] mb-1">
            <span>{param.label}</span>
            {param.required && <span className="text-red-400">*</span>}
          </label>
          {renderField(param)}
          {param.description && param.type !== 'boolean' && (
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 opacity-60">
              {param.description}
            </p>
          )}
        </div>
      ))}
    </form>
  )
}
