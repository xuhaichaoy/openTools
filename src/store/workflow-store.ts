import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Workflow, WorkflowExecution } from '@/core/workflows/types'
import { builtinWorkflows } from '@/core/workflows/builtin-workflows'
import type { PluginInstance } from '@/core/plugin-system/types'

interface WorkflowState {
  workflows: Workflow[]
  currentExecution: WorkflowExecution | null
  isLoading: boolean

  loadWorkflows: () => Promise<void>
  createWorkflow: (workflow: Omit<Workflow, 'id' | 'builtin' | 'created_at'>) => Promise<Workflow>
  updateWorkflow: (workflow: Workflow) => Promise<void>
  deleteWorkflow: (id: string) => Promise<void>
  executeWorkflow: (id: string, vars?: Record<string, string>) => Promise<void>
  clearExecution: () => void
  matchByKeyword: (input: string) => Workflow | null
}

const generateId = () => 'wf-' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36)

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  workflows: [],
  currentExecution: null,
  isLoading: false,

  loadWorkflows: async () => {
    set({ isLoading: true })
    try {
      const customWorkflows = await invoke<Workflow[]>('workflow_list')

      // 从已安装插件中提取工作流
      let pluginWorkflows: Workflow[] = []
      try {
        const plugins = await invoke<PluginInstance[]>('plugin_list')
        pluginWorkflows = plugins.flatMap((plugin) => {
          const manifest = plugin.manifest as any
          if (!manifest.workflows || !Array.isArray(manifest.workflows)) return []
          return manifest.workflows.map((def: any, i: number) => ({
            id: `plugin-${plugin.id}-wf-${i}`,
            name: def.name,
            icon: def.icon || '🔌',
            description: def.description || '',
            category: def.category || '插件',
            trigger: def.trigger || { type: 'manual' },
            steps: def.steps || [],
            builtin: true,
            created_at: Date.now(),
          } as Workflow))
        })
      } catch { /* 插件系统可能未就绪 */ }

      const allWorkflows = [...builtinWorkflows, ...pluginWorkflows, ...customWorkflows]
      set({ workflows: allWorkflows, isLoading: false })
    } catch (e) {
      console.error('加载工作流失败:', e)
      set({ workflows: [...builtinWorkflows], isLoading: false })
    }
  },

  createWorkflow: async (data) => {
    const workflow: Workflow = {
      ...data,
      id: generateId(),
      builtin: false,
      created_at: Date.now(),
    }
    try {
      await invoke('workflow_create', { workflow })
      set((state) => ({ workflows: [...state.workflows, workflow] }))
      // 通知调度器重新加载此工作流
      invoke('workflow_scheduler_reload', { workflowId: workflow.id }).catch(() => {})
      return workflow
    } catch (e) {
      console.error('创建工作流失败:', e)
      throw e
    }
  },

  updateWorkflow: async (workflow) => {
    if (workflow.builtin) return
    try {
      await invoke('workflow_update', { workflow })
      set((state) => ({
        workflows: state.workflows.map((w) => (w.id === workflow.id ? workflow : w)),
      }))
      // 通知调度器重新加载此工作流（触发器可能变更）
      invoke('workflow_scheduler_reload', { workflowId: workflow.id }).catch(() => {})
    } catch (e) {
      console.error('更新工作流失败:', e)
      throw e
    }
  },

  deleteWorkflow: async (id) => {
    const workflow = get().workflows.find((w) => w.id === id)
    if (!workflow || workflow.builtin) return
    try {
      await invoke('workflow_delete', { id })
      set((state) => ({
        workflows: state.workflows.filter((w) => w.id !== id),
      }))
      // 通知调度器移除此工作流的定时任务
      invoke('workflow_scheduler_reload', { workflowId: id }).catch(() => {})
    } catch (e) {
      console.error('删除工作流失败:', e)
      throw e
    }
  },

  executeWorkflow: async (id, vars = {}) => {
    const workflow = get().workflows.find((w) => w.id === id)
    if (!workflow) return

    const stepEntries =
      workflow.nodes && workflow.nodes.length > 0
        ? workflow.nodes
            .filter((n) => n.type !== 'start' && n.type !== 'end')
            .map((n) => ({ stepId: n.id, status: 'pending' as const }))
        : workflow.steps.map((s) => ({ stepId: s.id, status: 'pending' as const }))

    const execution: WorkflowExecution = {
      workflowId: id,
      workflowName: workflow.name,
      status: 'running',
      steps: stepEntries,
      startTime: Date.now(),
    }
    set({ currentExecution: execution })

    // 监听步骤事件
    const unlistenStart = await listen<{ workflowId: string; stepId: string; name: string }>(
      'workflow-step-start',
      (event) => {
        if (event.payload.workflowId === id) {
          set((state) => {
            if (!state.currentExecution) return state
            return {
              currentExecution: {
                ...state.currentExecution,
                steps: state.currentExecution.steps.map((s) =>
                  s.stepId === event.payload.stepId
                    ? { ...s, status: 'running' as const, startTime: Date.now() }
                    : s
                ),
              },
            }
          })
        }
      }
    )

    const unlistenDone = await listen<{ workflowId: string; stepId: string; result: string }>(
      'workflow-step-done',
      (event) => {
        if (event.payload.workflowId === id) {
          set((state) => {
            if (!state.currentExecution) return state
            return {
              currentExecution: {
                ...state.currentExecution,
                steps: state.currentExecution.steps.map((s) =>
                  s.stepId === event.payload.stepId
                    ? { ...s, status: 'done' as const, result: event.payload.result, endTime: Date.now() }
                    : s
                ),
              },
            }
          })
        }
      }
    )

    const unlistenError = await listen<{ workflowId: string; stepId: string; error: string }>(
      'workflow-step-error',
      (event) => {
        if (event.payload.workflowId === id) {
          set((state) => {
            if (!state.currentExecution) return state
            return {
              currentExecution: {
                ...state.currentExecution,
                steps: state.currentExecution.steps.map((s) =>
                  s.stepId === event.payload.stepId
                    ? { ...s, status: 'error' as const, error: event.payload.error, endTime: Date.now() }
                    : s
                ),
              },
            }
          })
        }
      }
    )

    const unlistenSkipped = await listen<{ workflowId: string; stepId: string }>(
      'workflow-step-skipped',
      (event) => {
        if (event.payload.workflowId === id) {
          set((state) => {
            if (!state.currentExecution) return state
            return {
              currentExecution: {
                ...state.currentExecution,
                steps: state.currentExecution.steps.map((s) =>
                  s.stepId === event.payload.stepId ? { ...s, status: 'skipped' as const } : s
                ),
              },
            }
          })
        }
      }
    )

    const unlistenWorkflowDone = await listen<{ workflowId: string; result: string }>(
      'workflow-done',
      (event) => {
        if (event.payload.workflowId === id) {
          const result = event.payload.result
          // 后端已跳过 notification/clipboard_write 对 prev.output 的覆盖，
          // 所以 result 就是最后一个有意义步骤的输出（如 AI 翻译/润色/摘要）
          if (result && typeof result === 'string') {
            navigator.clipboard.writeText(result).catch(() => {})
          }
          set((state) => ({
            currentExecution: state.currentExecution
              ? { ...state.currentExecution, status: 'done', endTime: Date.now(), finalResult: result }
              : null,
          }))
        }
      }
    )

    try {
      await invoke('workflow_execute', { workflow, vars })
    } catch (e) {
      set((state) => ({
        currentExecution: state.currentExecution
          ? { ...state.currentExecution, status: 'error', endTime: Date.now() }
          : null,
      }))
    } finally {
      unlistenStart()
      unlistenDone()
      unlistenError()
      unlistenSkipped()
      unlistenWorkflowDone()
    }
  },

  clearExecution: () => set({ currentExecution: null }),

  matchByKeyword: (input: string) => {
    const { workflows } = get()
    const lower = input.toLowerCase()
    return workflows.find((w) =>
      w.trigger.type === 'keyword' && w.trigger.keyword && lower.includes(w.trigger.keyword.toLowerCase())
    ) || null
  },
}))
