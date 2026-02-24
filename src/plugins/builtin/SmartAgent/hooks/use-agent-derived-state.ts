import { useMemo } from "react";
import type { AgentScheduledTask } from "@/core/ai/types";
import type { AgentTask } from "@/store/agent-store";
import {
  sortScheduledTasks,
  type ScheduledFilterMode,
  type ScheduledSortMode,
} from "../core/ui-state";

interface UseAgentDerivedStateParams {
  tasks: AgentTask[];
  running: boolean;
  scheduledTasks: AgentScheduledTask[];
  scheduledStatusFilter: ScheduledFilterMode;
  scheduledSortMode: ScheduledSortMode;
}

interface UseAgentDerivedStateResult {
  hasAnySteps: boolean;
  busy: boolean;
  visibleScheduledTasks: AgentScheduledTask[];
  scheduledStats: {
    total: number;
    running: number;
    error: number;
    skipped: number;
  };
}

export function useAgentDerivedState({
  tasks,
  running,
  scheduledTasks,
  scheduledStatusFilter,
  scheduledSortMode,
}: UseAgentDerivedStateParams): UseAgentDerivedStateResult {
  const hasAnySteps = tasks.some((task) => task.steps.length > 0);
  const busy = running;

  const visibleScheduledTasks = useMemo(() => {
    const filtered =
      scheduledStatusFilter === "all"
        ? scheduledTasks
        : scheduledStatusFilter === "attention"
          ? scheduledTasks.filter(
              (task) =>
                task.status === "error" || task.last_result_status === "skipped",
            )
          : scheduledTasks.filter((task) => task.status === scheduledStatusFilter);
    return sortScheduledTasks(filtered, scheduledSortMode);
  }, [scheduledTasks, scheduledStatusFilter, scheduledSortMode]);

  const scheduledStats = useMemo(() => ({
    total: scheduledTasks.length,
    running: scheduledTasks.filter((task) => task.status === "running").length,
    error: scheduledTasks.filter((task) => task.status === "error").length,
    skipped: scheduledTasks.filter((task) => task.last_result_status === "skipped").length,
  }), [scheduledTasks]);

  return {
    hasAnySteps,
    busy,
    visibleScheduledTasks,
    scheduledStats,
  };
}
