import { useState, useEffect } from 'react'
import { ArrowLeft, Plus, Play, Pencil, Trash2, RefreshCw, Loader2 } from 'lucide-react'
import { useWorkflowStore } from '@/store/workflow-store'
import { useToast } from '@/components/ui/Toast'
import { WorkflowEditor } from './WorkflowEditor'
import { WorkflowRunner } from './WorkflowRunner'
import type { Workflow } from '@/core/workflows/types'
import { useDragWindow } from '@/hooks/useDragWindow'

export function WorkflowList({ onBack }: { onBack?: () => void }) {
  const { workflows, loadWorkflows, createWorkflow, updateWorkflow, deleteWorkflow, executeWorkflow, currentExecution, clearExecution } = useWorkflowStore()
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list')
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null)
  const [loading, setLoading] = useState(false)
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const { toast } = useToast()
  const { onMouseDown } = useDragWindow()

  useEffect(() => {
    handleRefresh()
  }, [])

  const handleRefresh = async () => {
    setLoading(true)
    await loadWorkflows()
    setLoading(false)
  }

  const handleCreate = async (data: Omit<Workflow, 'id' | 'builtin' | 'created_at'>) => {
    try {
      await createWorkflow(data)
      toast('success', '工作流创建成功')
      setMode('list')
    } catch {
      toast('warning', '创建失败')
    }
  }

  const handleUpdate = async (data: Omit<Workflow, 'id' | 'builtin' | 'created_at'>) => {
    if (!editingWorkflow) return
    try {
      await updateWorkflow({ ...editingWorkflow, ...data })
      toast('success', '工作流已更新')
      setMode('list')
      setEditingWorkflow(null)
    } catch {
      toast('warning', '更新失败')
    }
  }

  const handleDelete = async (workflow: Workflow) => {
    if (workflow.builtin) return
    try {
      await deleteWorkflow(workflow.id)
      toast('success', '工作流已删除')
    } catch {
      toast('warning', '删除失败')
    }
  }

  const handleExecute = async (workflow: Workflow) => {
    try {
      await executeWorkflow(workflow.id)
    } catch (e) {
      toast('warning', `执行失败: ${e}`)
    }
  }

  if (mode === 'create') {
    return <WorkflowEditor onSave={handleCreate} onBack={() => setMode('list')} />
  }
  if (mode === 'edit' && editingWorkflow) {
    return <WorkflowEditor workflow={editingWorkflow} onSave={handleUpdate} onBack={() => { setMode('list'); setEditingWorkflow(null) }} />
  }

  const categories = [...new Set(workflows.map((w) => w.category))]
  const filtered = filterCategory === 'all' ? workflows : workflows.filter((w) => w.category === filterCategory)

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <div className="flex items-center gap-2">
          {onBack && (
            <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {onBack && <span className="text-lg">🔄</span>}
          {onBack && <span className="text-sm font-medium text-[var(--color-text)]">工作流</span>}
          <span className="text-[10px] text-[var(--color-text-secondary)] ml-1">{workflows.length} 个</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={handleRefresh} disabled={loading} className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]" title="刷新">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setMode('create')}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-3 h-3" />
            新建
          </button>
        </div>
      </div>

      {/* 分类筛选 */}
      <div className="flex gap-1 px-4 pt-2 pb-1 overflow-x-auto">
        <button
          onClick={() => setFilterCategory('all')}
          className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors shrink-0 ${
            filterCategory === 'all'
              ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
              : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
          }`}
        >
          全部
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilterCategory(cat)}
            className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors shrink-0 ${
              filterCategory === cat
                ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
                : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* 执行进度 */}
      {currentExecution && (() => {
        const w = workflows.find((w) => w.id === currentExecution.workflowId)
        const stepNames = w?.nodes && w.nodes.length > 0
          ? Object.fromEntries(
              w.nodes.filter((n) => n.type !== 'start' && n.type !== 'end').map((n) => [n.id, n.label])
            )
          : Object.fromEntries((w?.steps || []).map((s) => [s.id, s.name]))
        return (
          <div className="px-4 pt-2">
            <WorkflowRunner
              execution={currentExecution}
              stepNames={stepNames}
              onClose={clearExecution}
            />
          </div>
        )
      })()}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading && (
          <div className="text-center py-8">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-[var(--color-text-secondary)]" />
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <span className="text-3xl opacity-30 block mb-2">🔄</span>
            <p className="text-xs">暂无工作流</p>
            <p className="text-[10px] mt-1 opacity-50">点击右上角"新建"创建自动化工作流</p>
          </div>
        )}

        {filtered.map((workflow) => (
          <div
            key={workflow.id}
            className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-indigo-500/30 transition-colors group"
          >
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <span className="text-2xl shrink-0">{workflow.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--color-text)] truncate">{workflow.name}</span>
                  {workflow.builtin && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400">内置</span>
                  )}
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
                    {workflow.category}
                  </span>
                </div>
                <div className="text-[10px] text-[var(--color-text-secondary)] truncate mt-0.5">
                  {workflow.description}
                </div>
                <div className="text-[9px] text-[var(--color-text-secondary)] opacity-50 mt-0.5">
                  {(workflow.nodes && workflow.nodes.length > 0
                    ? workflow.nodes.filter((n) => n.type !== 'start' && n.type !== 'end').length
                    : workflow.steps.length)} 个步骤
                  {workflow.trigger.keyword && (
                    <span className="ml-2">关键词: <code className="bg-[var(--color-bg-hover)] px-1 rounded">{workflow.trigger.keyword}</code></span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-0.5 ml-2">
              <button
                onClick={() => handleExecute(workflow)}
                disabled={currentExecution?.status === 'running'}
                className="p-1.5 rounded hover:bg-green-500/10 text-green-400 disabled:opacity-30"
                title="运行"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {!workflow.builtin && (
                  <>
                    <button
                      onClick={() => { setEditingWorkflow(workflow); setMode('edit') }}
                      className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
                      title="编辑"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDelete(workflow)}
                      className="p-1.5 rounded hover:bg-red-500/10 text-[var(--color-text-secondary)] hover:text-red-400"
                      title="删除"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
