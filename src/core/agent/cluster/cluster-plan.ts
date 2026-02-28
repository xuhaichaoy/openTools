import type { ClusterPlan, ClusterStep, ClusterMode } from "./types";

function generatePlanId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `plan-${ts}-${rand}`;
}

export function createClusterPlan(
  mode: ClusterMode,
  steps: ClusterStep[],
  sharedContext?: Record<string, unknown>,
): ClusterPlan {
  return {
    id: generatePlanId(),
    mode,
    steps,
    sharedContext: sharedContext ?? {},
  };
}

/**
 * 拓扑排序：将 DAG 步骤按依赖关系分层。
 * 同一层内的步骤可以并行执行。
 * 返回 ClusterStep[][] — 每个子数组是一个可并行的层。
 */
export function topologicalSort(steps: ClusterStep[]): ClusterStep[][] {
  if (steps.length === 0) return [];

  const stepMap = new Map<string, ClusterStep>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    stepMap.set(step.id, step);
    inDegree.set(step.id, 0);
    dependents.set(step.id, []);
  }

  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (stepMap.has(dep)) {
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
        dependents.get(dep)?.push(step.id);
      }
    }
  }

  const layers: ClusterStep[][] = [];
  const visited = new Set<string>();

  while (visited.size < steps.length) {
    const layer: ClusterStep[] = [];
    for (const [id, degree] of inDegree) {
      if (!visited.has(id) && degree === 0) {
        layer.push(stepMap.get(id)!);
      }
    }

    if (layer.length === 0) {
      const remaining = steps.filter((s) => !visited.has(s.id));
      if (remaining.length > 0) {
        console.warn(
          `[ClusterPlan] topologicalSort: ${remaining.length} steps have unresolved dependencies (possible cycle), forcing parallel execution:`,
          remaining.map((s) => s.id),
        );
        layers.push(remaining);
      }
      break;
    }

    layers.push(layer);
    for (const step of layer) {
      visited.add(step.id);
      for (const depId of dependents.get(step.id) ?? []) {
        inDegree.set(depId, (inDegree.get(depId) ?? 0) - 1);
      }
    }
  }

  return layers;
}

/**
 * 仅返回步骤 ID 的拓扑分层（供 UI 组件使用，避免重复实现）。
 */
export function topologicalSortIds(steps: ClusterStep[]): string[][] {
  return topologicalSort(steps).map((layer) => layer.map((s) => s.id));
}

/**
 * 验证 ClusterPlan 合法性
 */
export function validatePlan(plan: ClusterPlan): string[] {
  const errors: string[] = [];
  const stepIds = new Set(plan.steps.map((s) => s.id));

  if (plan.steps.length === 0) {
    errors.push("计划不包含任何步骤");
    return errors;
  }

  const idCounts = new Map<string, number>();
  for (const step of plan.steps) {
    idCounts.set(step.id, (idCounts.get(step.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push(`步骤 ID "${id}" 重复出现 ${count} 次`);
  }

  for (const step of plan.steps) {
    if (!step.task.trim()) {
      errors.push(`步骤 "${step.id}" 缺少任务描述`);
    }
    for (const dep of step.dependencies) {
      if (!stepIds.has(dep)) {
        errors.push(`步骤 "${step.id}" 依赖不存在的步骤 "${dep}"`);
      }
      if (dep === step.id) {
        errors.push(`步骤 "${step.id}" 不能依赖自身`);
      }
    }
  }

  if (hasCycle(plan.steps)) {
    errors.push("步骤之间存在循环依赖");
  }

  return errors;
}

function hasCycle(steps: ClusterStep[]): boolean {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const adj = new Map<string, string[]>();

  for (const step of steps) {
    adj.set(step.id, [...step.dependencies]);
  }

  function dfs(id: string): boolean {
    visited.add(id);
    inStack.add(id);
    for (const dep of adj.get(id) ?? []) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true;
      } else if (inStack.has(dep)) {
        return true;
      }
    }
    inStack.delete(id);
    return false;
  }

  for (const step of steps) {
    if (!visited.has(step.id)) {
      if (dfs(step.id)) return true;
    }
  }
  return false;
}
