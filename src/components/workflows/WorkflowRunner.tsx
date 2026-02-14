import { useState, useEffect } from 'react'
import { Loader2, CheckCircle2, XCircle, Circle } from 'lucide-react'
import type { WorkflowExecution } from '@/core/workflows/types'

interface WorkflowRunnerProps {
  execution: WorkflowExecution
  stepNames: Record<string, string>
  onClose: () => void
}

export function WorkflowRunner({ execution, stepNames, onClose }: WorkflowRunnerProps) {
  const [elapsedTick, setElapsedTick] = useState(0)
  const isRunning = execution.status === 'running'

  useEffect(() => {
    if (!isRunning) return
    const t = setInterval(() => setElapsedTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [isRunning])

  const elapsed = execution.endTime
    ? ((execution.endTime - execution.startTime) / 1000).toFixed(1)
    : ((Date.now() - execution.startTime) / 1000).toFixed(1)

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {execution.status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />}
          {execution.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-400" />}
          {execution.status === 'error' && <XCircle className="w-4 h-4 text-red-400" />}
          <span className="text-xs font-medium text-[var(--color-text)]">
            {execution.status === 'running' ? '正在运行' : execution.status === 'done' ? '执行完成' : '执行失败'}
            : {execution.workflowName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-text-secondary)]">{elapsed}s</span>
          {execution.status !== 'running' && (
            <button
              onClick={onClose}
              className="text-[10px] px-2 py-0.5 rounded bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              关闭
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        {execution.steps.map((step) => {
          const stepElapsed = step.endTime && step.startTime
            ? ((step.endTime - step.startTime) / 1000).toFixed(1) + 's'
            : ''

          return (
            <div key={step.stepId} className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">
                {step.status === 'pending' && <Circle className="w-3.5 h-3.5 text-[var(--color-text-secondary)] opacity-30" />}
                {step.status === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />}
                {step.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />}
                {step.status === 'error' && <XCircle className="w-3.5 h-3.5 text-red-400" />}
                {step.status === 'skipped' && <Circle className="w-3.5 h-3.5 text-yellow-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] ${step.status === 'pending' ? 'opacity-40' : ''} text-[var(--color-text)]`}>
                    {stepNames[step.stepId] || step.stepId}
                  </span>
                  {stepElapsed && (
                    <span className="text-[9px] text-[var(--color-text-secondary)] opacity-50">{stepElapsed}</span>
                  )}
                </div>
                {step.result && step.status === 'done' && (
                  <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 truncate max-w-[300px]">
                    {step.result.length > 100 ? step.result.slice(0, 100) + '...' : step.result}
                  </div>
                )}
                {step.error && (
                  <div className="text-[10px] text-red-400 mt-0.5">{step.error}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {execution.finalResult && execution.status === 'done' && (
        <div className="pt-2 border-t border-[var(--color-border)]">
          <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">最终结果</div>
          <div className="text-xs text-[var(--color-text)] bg-[var(--color-bg)] rounded-lg p-2 max-h-[80px] overflow-y-auto font-mono">
            {execution.finalResult}
          </div>
        </div>
      )}
    </div>
  )
}
