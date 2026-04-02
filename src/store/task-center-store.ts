/**
 * TaskCenter Store — 任务中心 Zustand 状态
 *
 * 连接 TaskQueue 与 AgentTaskManager，为任务中心提供统一读取入口。
 */

import { create } from "zustand";
import type { TaskRecord, TaskFilter, TaskStats, TaskEvent, TaskDefinition } from "@/core/task-center/types";
import { getTaskQueue } from "@/core/task-center/task-queue";
import type { AgentTask, AgentTaskFilter, AgentTaskNotification } from "@/core/task-center";
import { getAgentTaskManager } from "@/core/task-center";

interface TaskCenterState {
  tasks: TaskRecord[];
  agentTasks: AgentTask[];
  agentNotifications: AgentTaskNotification[];
  stats: TaskStats;
  filter: TaskFilter;
  agentFilter: AgentTaskFilter;
  selectedTaskId: string | null;

  /** 刷新任务列表 */
  refresh: () => void;
  /** 创建任务 */
  createTask: (def: Omit<TaskDefinition, "id">) => TaskRecord;
  /** 取消任务 */
  cancelTask: (id: string) => boolean;
  /** 清理旧任务 */
  cleanup: () => number;
  /** 设置过滤条件 */
  setFilter: (filter: TaskFilter) => void;
  /** 设置 AgentTask 过滤条件 */
  setAgentFilter: (filter: AgentTaskFilter) => void;
  /** 选中任务 */
  selectTask: (id: string | null) => void;
  /** 订阅任务事件 */
  subscribe: () => () => void;
}

export const useTaskCenterStore = create<TaskCenterState>((set, get) => {
  const queue = getTaskQueue();
  const agentTaskManager = getAgentTaskManager();

  return {
    tasks: queue.list(),
    agentTasks: agentTaskManager.list(),
    agentNotifications: agentTaskManager.listNotifications(),
    stats: queue.getStats(),
    filter: {},
    agentFilter: {},
    selectedTaskId: null,

    refresh: () => {
      const { filter, agentFilter } = get();
      set({
        tasks: queue.list(filter),
        agentTasks: agentTaskManager.list(agentFilter),
        agentNotifications: agentTaskManager.listNotifications(),
        stats: queue.getStats(),
      });
    },

    createTask: (def) => {
      const task = queue.create(def);
      get().refresh();
      return task;
    },

    cancelTask: (id) => {
      const ok = queue.cancel(id);
      if (ok) get().refresh();
      return ok;
    },

    cleanup: () => {
      const removed = queue.cleanup();
      if (removed > 0) get().refresh();
      return removed;
    },

    setFilter: (filter) => {
      set({ filter });
      set({ tasks: queue.list(filter) });
    },

    setAgentFilter: (agentFilter) => {
      set({ agentFilter });
      set({ agentTasks: agentTaskManager.list(agentFilter) });
    },

    selectTask: (id) => set({ selectedTaskId: id }),

    subscribe: () => {
      const unsubQueue = queue.onEvent((_event: TaskEvent) => {
        get().refresh();
      });
      const unsubAgentTasks = agentTaskManager.onEvent(() => {
        get().refresh();
      });
      return () => {
        unsubQueue();
        unsubAgentTasks();
      };
    },
  };
});
