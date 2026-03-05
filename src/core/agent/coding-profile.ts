export interface CodingExecutionProfile {
  codingMode?: boolean;
  largeProjectMode?: boolean;
}

export interface NormalizedCodingExecutionProfile {
  codingMode: boolean;
  largeProjectMode: boolean;
}

export function normalizeCodingExecutionProfile(
  profile?: CodingExecutionProfile,
): NormalizedCodingExecutionProfile {
  const codingMode = !!profile?.codingMode;
  const largeProjectMode = codingMode && !!profile?.largeProjectMode;
  return { codingMode, largeProjectMode };
}

export function mergeSystemHints(
  baseHint?: string,
  extraHint?: string,
): string | undefined {
  const base = (baseHint || "").trim();
  const extra = (extraHint || "").trim();
  if (base && extra) return `${base}\n\n---\n\n${extra}`;
  if (base) return base;
  if (extra) return extra;
  return undefined;
}

export function buildAgentCodingSystemHint(
  profile?: CodingExecutionProfile,
): string | undefined {
  const normalized = normalizeCodingExecutionProfile(profile);
  if (!normalized.codingMode) return undefined;

  const scopeHint = normalized.largeProjectMode
    ? `
当前任务按大型项目处理：
- 先分阶段（探索 -> 设计 -> 实施 -> 验证）
- 每轮最多改动少量文件，完成后立即验证
- 明确记录已完成项与下一步计划，避免一次性大改`
    : "";

  return `## Coding Execution Policy
你正在执行 coding 任务。请严格遵守：
- 先读后改：先用 read_file / read_file_range / search_in_files 建立上下文
- 修改已有文件优先使用 str_replace_edit，避免整文件覆写
- 每次修改后立即验证：run_lint / run_shell_command（测试或构建）
- 输出结果必须包含：修改文件列表、关键变更点、验证结果、剩余风险${scopeHint}`;
}

export function getEnhancedAgentMaxIterations(
  baseIterations: number,
  profile?: CodingExecutionProfile,
): number {
  const normalized = normalizeCodingExecutionProfile(profile);
  if (!normalized.codingMode) return baseIterations;
  const extra = normalized.largeProjectMode ? 25 : 10;
  return Math.min(80, Math.max(5, baseIterations + extra));
}

export function getEnhancedClusterRoleIterations(
  baseIterations: number | undefined,
  roleId: string,
  profile?: CodingExecutionProfile,
): number {
  const normalized = normalizeCodingExecutionProfile(profile);
  const base = Math.max(3, baseIterations ?? 10);
  if (!normalized.codingMode) return base;

  const role = roleId.toLowerCase();
  const normalExtra =
    role === "coder"
      ? 12
      : role === "reviewer"
        ? 8
        : role === "planner"
          ? 5
          : 6;
  const largeExtra =
    role === "coder"
      ? 12
      : role === "reviewer"
        ? 8
        : 6;

  const extra = normalExtra + (normalized.largeProjectMode ? largeExtra : 0);
  return Math.min(90, base + extra);
}

export function getClusterPlannerCodingHint(
  profile?: CodingExecutionProfile,
): string {
  const normalized = normalizeCodingExecutionProfile(profile);
  if (!normalized.codingMode) return "";

  const largeHint = normalized.largeProjectMode
    ? `
- 这是大型项目：优先拆分为多阶段多步骤（探索/实现/验证/汇总）
- 每个 coder 步骤必须限定明确模块范围，避免多个步骤同时改同一文件
- 必须安排独立 reviewer 步骤做最终复核`
    : "";

  return `
## Coding Planning Constraint
- 任务涉及代码时，优先生成可验证、可回滚的步骤
- coder 步骤描述必须包含：目标文件范围、预期改动、验证命令
- 若存在跨模块依赖，优先使用 multi_role 并明确 dependencies${largeHint}`;
}

export function getClusterStepCodingHint(
  roleId: string,
  profile?: CodingExecutionProfile,
): string {
  const normalized = normalizeCodingExecutionProfile(profile);
  if (!normalized.codingMode) return "";

  const role = roleId.toLowerCase();
  const shared = `执行要求：先读取上下文再操作；修改后必须做验证并给出结论。`;
  const large = normalized.largeProjectMode
    ? `这是大型项目阶段任务，请仅处理当前步骤范围，不要越界修改。`
    : "";

  if (role === "coder") {
    return `${shared}
Coder 要求：
- 优先精确编辑（str_replace_edit），避免整文件覆盖
- 至少执行一次语法/类型/测试验证（run_lint 或 run_shell_command）
- 输出必须包含：修改文件、变更摘要、验证命令与结果
${large}`;
  }

  if (role === "reviewer") {
    return `${shared}
Reviewer 要求：
- 结论需基于实际文件内容，不接受纯口头说明
- 输出按 critical/warning/suggestion 分类，并附修复建议
${large}`;
  }

  return `${shared}\n${large}`.trim();
}

export function getClusterAggregateBudgets(profile?: CodingExecutionProfile): {
  totalBudget: number;
  coderBudget: number;
} {
  const normalized = normalizeCodingExecutionProfile(profile);
  if (!normalized.codingMode) {
    return { totalBudget: 12000, coderBudget: 20000 };
  }
  if (normalized.largeProjectMode) {
    return { totalBudget: 26000, coderBudget: 50000 };
  }
  return { totalBudget: 18000, coderBudget: 32000 };
}
