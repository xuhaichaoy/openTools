import { useState, useEffect } from 'react'
import { ArrowLeft, Plus, Play, Pencil, Trash2, RefreshCw, Loader2, Share2, Download } from 'lucide-react'
import { useWorkflowStore } from '@/store/workflow-store'
import { useAuthStore } from '@/store/auth-store'
import { useTeamStore, type SharedResource } from '@/store/team-store'
import { useToast } from '@/components/ui/Toast'
import { WorkflowEditor } from './WorkflowEditor'
import { WorkflowRunner } from './WorkflowRunner'
import type { Workflow } from '@/core/workflows/types'
import { useDragWindow } from '@/hooks/useDragWindow'

export function WorkflowList({ onBack }: { onBack?: () => void }) {
  const { workflows, loadWorkflows, createWorkflow, updateWorkflow, deleteWorkflow, executeWorkflow, currentExecution, clearExecution } = useWorkflowStore()
  const { isLoggedIn } = useAuthStore()
  const { teams, activeTeamId, loadTeams, shareResource, listSharedResources } = useTeamStore()
  const [mode, setMode] = useState<'list' | 'create' | 'edit' | 'team-templates'>('list')
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null)
  const [loading, setLoading] = useState(false)
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const [sharingId, setSharingId] = useState<string | null>(null)
  const [teamTemplates, setTeamTemplates] = useState<SharedResource[]>([])
  const [importingId, setImportingId] = useState<string | null>(null)
  const { toast } = useToast()
  const { onMouseDown } = useDragWindow()

  useEffect(() => {
    handleRefresh()
    if (isLoggedIn) loadTeams()
  }, [isLoggedIn])

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

  const handleShareToTeam = async (workflow: Workflow) => {
    if (!activeTeamId) return
    setSharingId(workflow.id)
    try {
      await shareResource(activeTeamId, 'workflow', workflow.id, workflow.name)
      toast('success', `已分享「${workflow.name}」到团队`)
    } catch (e) {
      toast('warning', '分享失败')
      console.error('Share workflow failed:', e)
    } finally {
      setSharingId(null)
    }
  }

  const handleShowTeamTemplates = async () => {
    if (!activeTeamId) return
    try {
      const resources = await listSharedResources(activeTeamId, 'workflow')
      setTeamTemplates(resources)
      setMode('team-templates')
    } catch (e) {
      toast('warning', '获取团队模板失败')
      console.error('Load team templates failed:', e)
    }
  }

  const handleImportTemplate = async (template: SharedResource) => {
    setImportingId(template.id)
    try {
      // 从团队模板创建一个私有副本
      const newWorkflow: Omit<Workflow, 'id' | 'builtin' | 'created_at'> = {
        name: `${template.resource_name ?? '团队模板'}（副本）`,
        description: `从团队模板导入 - by ${template.username}`,
        icon: '📋',
        category: '导入',
        trigger: { type: 'keyword', keyword: '' },
        steps: [],
        nodes: [],
        edges: [],
      }
      await createWorkflow(newWorkflow)
      toast('success', `已导入「${template.resource_name}」`)
    } catch (e) {
      toast('warning', '导入失败')
      console.error('Import template failed:', e)
    } finally {
      setImportingId(null)
    }
  }

  if (mode === 'create') {
    return <WorkflowEditor onSave={handleCreate} onBack={() => setMode('list')} />
  }
  if (mode === 'edit' && editingWorkflow) {
    return <WorkflowEditor workflow={editingWorkflow} onSave={handleUpdate} onBack={() => { setMode('list'); setEditingWorkflow(null) }} />
  }

  // 团队模板列表视图
  if (mode === 'team-templates') {
    return (
      <div className="flex flex-col h-full bg-[var(--color-bg)]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
          <div className="flex items-center gap-2">
            <button onClick={() => setMode('list')} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium text-[var(--color-text)]">团队工作流模板</span>
            <span className="text-[10px] text-[var(--color-text-secondary)]">{teamTemplates.length} 个</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {teamTemplates.length === 0 && (
            <div className="text-center py-8 text-[var(--color-text-secondary)]">
              <span className="text-3xl opacity-30 block mb-2">📋</span>
              <p className="text-xs">团队暂无共享的工作流模板</p>
            </div>
          )}
          {teamTemplates.map((tpl) => (
            <div key={tpl.id} className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-[#F28F36]/30 transition-colors">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[var(--color-text)] truncate">{tpl.resource_name ?? tpl.resource_id}</div>
                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  分享者: {tpl.username} · {new Date(tpl.shared_at).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={() => handleImportTemplate(tpl)}
                disabled={importingId === tpl.id}
                className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-[#F28F36]/10 text-[#F28F36] hover:bg-[#F28F36]/20 transition-colors disabled:opacity-40"
              >
                {importingId === tpl.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                导入副本
              </button>
            </div>
          ))}
        </div>
      </div>
    )
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
          {isLoggedIn && teams.length > 0 && (
            <button
              onClick={handleShowTeamTemplates}
              className="flex items-center gap-1 px-2 py-1.5 text-[10px] rounded-lg text-[#F28F36] hover:bg-[#F28F36]/10 transition-colors"
              title="团队模板"
            >
              <Download className="w-3 h-3" />
              团队模板
            </button>
          )}
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
                  {workflow.trigger.type === 'cron' && (
                    <span className="ml-2 text-amber-400">⏰ Cron: <code className="bg-amber-400/10 px-1 rounded">{workflow.trigger.cron}</code></span>
                  )}
                  {workflow.trigger.type === 'interval' && (
                    <span className="ml-2 text-blue-400">🔄 每 {workflow.trigger.intervalSeconds}s</span>
                  )}
                  {workflow.trigger.type === 'once' && workflow.trigger.onceAt && (
                    <span className="ml-2 text-green-400">📅 {new Date(workflow.trigger.onceAt).toLocaleString()}</span>
                  )}
                  {(workflow.trigger.type === 'cron' || workflow.trigger.type === 'interval' || workflow.trigger.type === 'once') && (
                    <span className={`ml-1 px-1 rounded text-[10px] ${workflow.trigger.enabled !== false ? 'text-green-400 bg-green-400/10' : 'text-gray-400 bg-gray-400/10'}`}>
                      {workflow.trigger.enabled !== false ? '已启用' : '已停用'}
                    </span>
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
                {!workflow.builtin && isLoggedIn && teams.length > 0 && (
                  <button
                    onClick={() => handleShareToTeam(workflow)}
                    disabled={sharingId === workflow.id}
                    className="p-1.5 rounded hover:bg-[#F28F36]/10 text-[var(--color-text-secondary)] hover:text-[#F28F36]"
                    title="公开到团队"
                  >
                    {sharingId === workflow.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Share2 className="w-3 h-3" />}
                  </button>
                )}
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
