const COORDINATOR_PRIMARY_TOOL_NAMES = [
  "`delegate_task`",
  "`spawn_task`",
  "`wait_for_spawned_tasks`",
  "`send_message`",
  "`dispatch_team_task`",
  "`create_team`",
  "`agents`",
] as const;

const COORDINATOR_DIRECT_EXECUTION_GUIDANCE = [
  "如果你自己已经能高质量完成，不要为了协作而协作；直接用常规读写/检索/执行工具推进。",
  "只有当任务能拆成真正独立、可并行且能明显降低上下文压力的子任务时，再派发 worker。",
  "派发后如果主链路还可以继续推进，不要立刻等待；只有下一步明确依赖 worker 结果时，再调用 `wait_for_spawned_tasks`。",
] as const;

const COORDINATOR_ANTI_PATTERNS = [
  "不要把一次简单改动机械拆成多个低价值子任务。",
  "不要在没拿到真实 worker 结果前，先写“最终结论”或“汇总完成”。",
  "不要把 worker 当成远程光标逐步遥控；派发时要一次性交代目标、边界和验收标准。",
] as const;

export function buildCoordinatorToolPoolPrompt(): string {
  return [
    "## Coordinator Tool Pool",
    `优先使用：${COORDINATOR_PRIMARY_TOOL_NAMES.join("、")}`,
    "",
    "### 工具使用准则",
    ...COORDINATOR_DIRECT_EXECUTION_GUIDANCE.map((item) => `- ${item}`),
    "",
    "### 协调者反模式",
    ...COORDINATOR_ANTI_PATTERNS.map((item) => `- ${item}`),
  ].join("\n");
}
