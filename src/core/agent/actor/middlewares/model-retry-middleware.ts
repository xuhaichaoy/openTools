/**
 * ModelRetryMiddleware — LLM 调用重试与降级中间件
 *
 * 灵感来源：Yuxi-Know 的 ModelRetryMiddleware
 *
 * 将重试配置注入 ActorRunContext，供 ReActAgent 在 LLM 调用层使用。
 * 同时为工具执行添加超时保护（不重试工具本身）。
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { createLogger } from "@/core/logger";
import { useAIStore } from "@/store/ai-store";

const log = createLogger("ModelRetry");

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  fallbackModels?: string[];
  /** 工具执行超时（ms），超时自动中止 */
  toolTimeoutMs?: number;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  fallbackModels: [],
  toolTimeoutMs: 120_000,
};

export const RETRYABLE_ERROR_PATTERNS = [
  /\b429\b/,
  /rate[\s_-]?limit/i,
  /too[\s_]?many[\s_]?requests/i,
  /\b5\d{2}\b/,
  /server[\s_]?error/i,
  /internal[\s_]?server/i,
  /service[\s_]?unavailable/i,
  /gateway[\s_]?timeout/i,
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH)\b/i,
  /network[\s_]?error/i,
  /fetch[\s_]?failed/i,
  /request[\s_]?timeout/i,
  /error[\s_]+sending[\s_]+request/i,
  /sendrequest/i,
  /incomplete[\s_]?message/i,
  /unexpected[\s_]?eof/i,
  /connection.*closed/i,
  /connection[\s_]?refused/i,
  /socket[\s_]?hang[\s_]?up/i,
];

export const NON_RETRYABLE_PATTERNS = [
  /\b(401|403)\b/,
  /unauthorized/i,
  /forbidden/i,
  /invalid[_\s-]?parameter/i,
  /invalid[_\s-]?request/i,
  /invalid[\s_]?api[\s_]?key/i,
  /quota[\s_]?exceeded/i,
  /billing/i,
  /content[\s_]?filter/i,
  /content[\s_]?policy/i,
  /tool name cannot exceed\s*64/i,
  /function name cannot exceed\s*64/i,
  /length of the tool name cannot exceed\s*64/i,
];

export function isRetryableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (NON_RETRYABLE_PATTERNS.some((p) => p.test(msg))) return false;
  return RETRYABLE_ERROR_PATTERNS.some((p) => p.test(msg));
}

export function extractRetryAfter(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/retry[\s-]?after[\s:]*(\d+)/i);
  return match ? parseInt(match[1], 10) * 1000 : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with retry logic.
 * Designed for wrapping LLM API calls (not tool executions).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Required<RetryConfig>,
  label = "LLM call",
): Promise<T> {
  let lastError: unknown;
  let delay = config.initialDelayMs;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryableError(err) || attempt === config.maxRetries) {
        throw err;
      }

      const retryAfter = extractRetryAfter(err);
      const waitMs = retryAfter
        ? Math.min(retryAfter, config.maxDelayMs)
        : Math.min(delay, config.maxDelayMs);

      log.warn(
        `${label} failed (attempt ${attempt + 1}/${config.maxRetries + 1}), ` +
        `retrying in ${waitMs}ms: ${err instanceof Error ? err.message : String(err)}`,
      );

      await sleep(waitMs);
      delay *= config.backoffMultiplier;
    }
  }
  throw lastError;
}

export class ModelRetryMiddleware implements ActorMiddleware {
  readonly name = "ModelRetry";
  private baseConfig: Required<RetryConfig>;

  constructor(config?: RetryConfig) {
    this.baseConfig = { ...DEFAULT_CONFIG, ...config };
  }

  private resolveConfig(): Required<RetryConfig> {
    const aiConfig = useAIStore.getState().config;
    const initialDelayMs = Math.max(
      500,
      Math.min(60000, aiConfig.agent_retry_backoff_ms ?? this.baseConfig.initialDelayMs),
    );
    const maxRetries = Math.max(
      0,
      Math.min(10, aiConfig.agent_retry_max ?? this.baseConfig.maxRetries),
    );

    return {
      ...this.baseConfig,
      maxRetries,
      initialDelayMs,
      maxDelayMs: Math.max(this.baseConfig.maxDelayMs, initialDelayMs * 4),
    };
  }

  async apply(ctx: ActorRunContext): Promise<void> {
    const config = this.resolveConfig();
    ctx.retryConfig = config;
    ctx.withRetry = withRetry as ActorRunContext["withRetry"];

    // Add tool execution timeout protection (no retry — just timeout)
    const toolTimeoutMs = config.toolTimeoutMs;
    if (toolTimeoutMs > 0) {
      ctx.tools = ctx.tools.map((tool) => {
        const originalExecute = tool.execute;
        return {
          ...tool,
          execute: async (params: Record<string, unknown>) => {
            return Promise.race([
              originalExecute(params),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Tool "${tool.name}" execution timeout (${toolTimeoutMs}ms)`)),
                  toolTimeoutMs,
                ),
              ),
            ]);
          },
        };
      });
    }
  }
}
