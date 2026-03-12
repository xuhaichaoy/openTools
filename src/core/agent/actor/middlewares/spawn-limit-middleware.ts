import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

const MAX_CONCURRENT_SPAWNS = 3;
const MIN_SPAWN_LIMIT = 2;
const MAX_SPAWN_LIMIT = 6;

function clampLimit(value: number): number {
  return Math.max(MIN_SPAWN_LIMIT, Math.min(MAX_SPAWN_LIMIT, value));
}

/**
 * SpawnLimitMiddleware — wraps the `spawn_task` tool to proactively reject
 * excess spawn requests before they reach ActorSystem.spawnTask().
 *
 * Inspired by deer-flow's SubagentLimitMiddleware which truncates excess
 * `task` tool calls from model output. This achieves the same goal in
 * 51ToolBox's ReAct loop by intercepting tool execution.
 *
 * Benefits over the current ActorSystem.MAX_CHILDREN_PER_AGENT check:
 * - Rejects immediately with a clear explanation (saves an LLM iteration)
 * - Per-run tracking (not just per-actor lifetime)
 * - Agent gets actionable feedback: "wait for X to finish, then retry"
 */
export class SpawnLimitMiddleware implements ActorMiddleware {
  readonly name = "SpawnLimit";
  private maxConcurrent: number;

  constructor(maxConcurrent: number = MAX_CONCURRENT_SPAWNS) {
    this.maxConcurrent = clampLimit(maxConcurrent);
  }

  async apply(ctx: ActorRunContext): Promise<void> {
    if (!ctx.actorSystem) return;

    const spawnToolIdx = ctx.tools.findIndex((t) => t.name === "spawn_task");
    if (spawnToolIdx < 0) return;

    const originalTool = ctx.tools[spawnToolIdx];
    const actorSystem = ctx.actorSystem;
    const actorId = ctx.actorId;
    const limit = this.maxConcurrent;

    const wrappedTool: AgentTool = {
      ...originalTool,
      execute: async (params) => {
        const activeCount = actorSystem.getActiveSpawnedTasks(actorId).length;
        if (activeCount >= limit) {
          const activeTasks = actorSystem.getActiveSpawnedTasks(actorId);
          const taskNames = activeTasks
            .map((t) => actorSystem.get(t.targetActorId)?.role.name ?? t.targetActorId)
            .join(", ");
          return {
            spawned: false,
            error: `已达到并发子任务上限 (${activeCount}/${limit})。等待以下任务完成后重试：${taskNames}`,
            hint: "用 agents(action='list') 查看当前任务状态，等待空位后再发起新任务。",
          };
        }
        return originalTool.execute(params);
      },
    };

    ctx.tools = [
      ...ctx.tools.slice(0, spawnToolIdx),
      wrappedTool,
      ...ctx.tools.slice(spawnToolIdx + 1),
    ];
  }
}
