import type { SpawnedTaskRoleBoundary } from "./types";

export interface SpawnedTaskRoleBoundaryMeta {
  label: string;
  shortLabel: string;
  description: string;
}

const ROLE_BOUNDARY_META: Record<SpawnedTaskRoleBoundary, SpawnedTaskRoleBoundaryMeta> = {
  reviewer: {
    label: "独立审查",
    shortLabel: "审查",
    description: "负责独立评审边界条件、回归风险、副作用和修复建议。",
  },
  validator: {
    label: "验证回归",
    shortLabel: "验证",
    description: "负责复现、测试、构建、验收和回归检查。",
  },
  executor: {
    label: "执行实现",
    shortLabel: "执行",
    description: "负责实现、修复、探索和具体落地。",
  },
  general: {
    label: "通用支援",
    shortLabel: "支援",
    description: "负责补充分析、资料整理或临时协作支援。",
  },
};

export function getSpawnedTaskRoleBoundaryMeta(
  roleBoundary?: SpawnedTaskRoleBoundary | null,
): SpawnedTaskRoleBoundaryMeta {
  return ROLE_BOUNDARY_META[roleBoundary ?? "general"] ?? ROLE_BOUNDARY_META.general;
}

