/**
 * TaskCenter Store — 任务中心 Zustand 状态
 *
 * 连接 TaskQueue 引擎与 React UI，提供任务列表、过滤和操作。
 */

import { create } from "zustand";
import type { TaskRecord, TaskFilter, TaskStats, TaskEvent, TaskDefinition } from "@/core/task-center/types";
import { getTaskQueue } from "@/core/task-center/task-queue";

interface TaskCenterState {
  tasks: TaskRecord[];
  stats: TaskStats;
  filter: TaskFilter;
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
  /** 选中任务 */
  selectTask: (id: string | null) => void;
  /** 订阅任务事件 */
  subscribe: () => () => void;
}

export const useTaskCenterStore = create<TaskCenterState>((set, get) => {
  const queue = getTaskQueue();

  return {
    tasks: queue.list(),
    stats: queue.getStats(),
    filter: {},
    selectedTaskId: null,

    refresh: () => {
      const { filter } = get();
      set({
        tasks: queue.list(filter),
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

    selectTask: (id) => set({ selectedTaskId: id }),

    subscribe: () => {
      const unsub = queue.onEvent((_event: TaskEvent) => {
        get().refresh();
      });
      return unsub;
    },
  };
});
