import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

const MAX_CONCURRENT_SPAWNS = 3;
const MIN_SPAWN_LIMIT = 2;
const MAX_SPAWN_LIMIT = 6;

function clampLimit(value: number): number {
  return Math.max(MIN_SPAWN_LIMIT, Math.min(MAX_SPAWN_LIMIT, value));
}

/**
 * SpawnLimitMiddleware — wraps the `spawn_task` tool to proactively divert
 * excess spawn requests into Dialog 的待派发队列。
 *
 * Inspired by deer-flow's SubagentLimitMiddleware which truncates excess
 * `task` tool calls from model output. This achieves the same goal in
 * HiClow's ReAct loop by intercepting tool execution.
 *
 * Benefits over the current ActorSystem.MAX_CHILDREN_PER_AGENT check:
 * - Saves an extra LLM 轮次：模型无需自己撞上限再重试
 * - Per-run tracking (not just per-actor lifetime)
 * - Keeps planned subtasks alive: overflow requests become queued dispatches
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
    const limit = this.maxConcurrent;

    const wrappedTool: AgentTool = {
      ...originalTool,
      execute: async (params) => originalTool.execute({
        ...params,
        __queue_if_busy: true,
        __spawn_limit: limit,
      }),
    };

    ctx.tools = [
      ...ctx.tools.slice(0, spawnToolIdx),
      wrappedTool,
      ...ctx.tools.slice(spawnToolIdx + 1),
    ];
  }
}
