/**
 * ToolErrorHandlingMiddleware — 对齐 DeerFlow 的工具异常降级语义
 *
 * 普通工具异常会被转换成结构化 error 结果，避免整轮 run 因单个工具崩掉。
 * 但 Clarification / wait_for_spawned_tasks / abort / timeout 这类控制流异常
 * 仍然继续向上抛出，由 ReActAgent 或 Actor runtime 接管。
 */

import { createLogger } from "@/core/logger";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { ClarificationInterrupt } from "./clarification-middleware";

const log = createLogger("ToolErrorHandling");
const MISSING_TOOL_NAME = "unknown_tool";

export interface HandledToolErrorResult {
  error: string;
  handledBy: "ToolErrorHandlingMiddleware";
  toolName: string;
  errorType: "runtime_error";
  recoverable: true;
}

function formatErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.trim() || (error instanceof Error ? error.name : "UnknownError");
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

function shouldRethrowToolError(error: unknown): boolean {
  if (error instanceof ClarificationInterrupt) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "WaitForSpawnedTasksInterrupt") return true;
  if (error.name === "AbortError") return true;
  if (error.name === "ToolTimeoutError") return true;
  if (error.message === "Aborted") return true;
  if (/execution timeout/i.test(error.message)) return true;
  return false;
}

export function isToolFailureResult(output: unknown): boolean {
  if (
    output &&
    typeof output === "object" &&
    typeof (output as Record<string, unknown>).error === "string"
  ) {
    return true;
  }

  if (
    output &&
    typeof output === "object"
    && (
      typeof (output as Record<string, unknown>).exit_code === "number"
      || typeof (output as Record<string, unknown>).exitCode === "number"
    )
  ) {
    const exitCode = typeof (output as Record<string, unknown>).exit_code === "number"
      ? Number((output as Record<string, unknown>).exit_code)
      : Number((output as Record<string, unknown>).exitCode);
    return exitCode !== 0;
  }

  return false;
}

export class ToolErrorHandlingMiddleware implements ActorMiddleware {
  readonly name = "ToolErrorHandling";

  async apply(ctx: ActorRunContext): Promise<void> {
    ctx.tools = ctx.tools.map((tool) => {
      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (params: Record<string, unknown>, signal?: AbortSignal) => {
          try {
            return await originalExecute(params, signal);
          } catch (error) {
            if (shouldRethrowToolError(error)) {
              throw error;
            }

            const toolName = tool.name || MISSING_TOOL_NAME;
            const detail = formatErrorDetail(error);
            log.warn("tool execution degraded to structured error", {
              actorId: ctx.actorId,
              toolName,
              error: detail,
            });
            const result: HandledToolErrorResult = {
              error: `Error: Tool '${toolName}' failed with ${error instanceof Error ? error.name : "Error"}: ${detail}. Continue with available context, or choose an alternative tool.`,
              handledBy: "ToolErrorHandlingMiddleware",
              toolName,
              errorType: "runtime_error",
              recoverable: true,
            };
            return result;
          }
        },
      };
    });
  }
}
