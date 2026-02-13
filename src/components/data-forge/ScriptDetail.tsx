import { useRef } from 'react'
import { Play, Loader2, Clock, Tag, FileCode, ChevronLeft } from 'lucide-react'
import { useDataForgeStore } from '@/store/data-forge-store'
import { ParamForm } from './ParamForm'
import { ExecutionPanel } from './ExecutionPanel'
import { invoke } from '@tauri-apps/api/core'

const PARAM_FORM_ID = 'dataforge-param-form'

export function ScriptDetail() {
  const { selectedScript, setSelectedScript, runScript, currentExecution } = useDataForgeStore()
  const paramValuesRef = useRef<Record<string, unknown>>({})
  const isRunning = currentExecution?.script_id === selectedScript?.id

  if (!selectedScript) return null

  const handleParamChange = (values: Record<string, unknown>) => {
    paramValuesRef.current = values
  }

  const handleRun = (values: Record<string, unknown>) => {
    runScript(selectedScript.id, values)
  }

  return (
    <div className="flex flex-col h-full">
      {/* 脚本信息头 */}
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-start gap-3">
          <button
            onClick={() => setSelectedScript(null)}
            className="mt-0.5 p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] shrink-0"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-purple-400 shrink-0" />
              <h3 className="text-sm font-medium text-[var(--color-text)] truncate">
                {selectedScript.name}
              </h3>
            </div>
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              {selectedScript.description}
            </p>
            <div className="flex items-center gap-3 mt-2">
              <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
                <Tag className="w-3 h-3" />
                {selectedScript.category}
              </span>
              {selectedScript.estimated_time && (
                <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
                  <Clock className="w-3 h-3" />
                  {selectedScript.estimated_time}
                </span>
              )}
              {selectedScript.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 参数表单 */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <h4 className="text-xs font-medium text-[var(--color-text)] mb-3">执行参数</h4>
        <ParamForm
          key={selectedScript.id}
          params={selectedScript.params}
          onSubmit={handleRun}
          onChange={handleParamChange}
          isRunning={isRunning}
          formId={PARAM_FORM_ID}
        />
      </div>

      {/* 执行面板 */}
      {currentExecution && currentExecution.script_id === selectedScript.id && (
        <div className="border-t border-[var(--color-border)] px-4 py-2">
          <ExecutionPanel
            scriptId={currentExecution.script_id}
            scriptName={currentExecution.script_name}
            status={
              currentExecution.status === 'running' ? 'running'
                : currentExecution.status === 'success' ? 'success'
                : currentExecution.status === 'failed' ? 'error'
                : 'idle'
            }
            logs={currentExecution.logs
              ? currentExecution.logs.split('\n').filter(Boolean).map((line) => ({
                  timestamp: currentExecution.started_at,
                  level: 'stdout' as const,
                  message: line,
                }))
              : []
            }
            outputFiles={currentExecution.output_files}
            duration={currentExecution.duration_ms}
            recordCount={currentExecution.record_count}
            errorMsg={currentExecution.error}
            onRetry={() => handleRun(paramValuesRef.current)}
            onOpenFile={async (filePath) => {
              try { await invoke('open_file_location', { filePath }) } catch (e) { console.error('打开文件失败:', e) }
            }}
          />
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="px-4 py-3 border-t border-[var(--color-border)] shrink-0">
        <button
          type="submit"
          form={PARAM_FORM_ID}
          disabled={isRunning}
          className="w-full flex items-center justify-center gap-2 bg-purple-500 text-white text-sm font-medium rounded-lg px-4 py-2.5 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              执行中...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              执行脚本
            </>
          )}
        </button>
      </div>
    </div>
  )
}
