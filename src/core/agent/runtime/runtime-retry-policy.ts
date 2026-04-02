import type { ActorRunContext } from "@/core/agent/actor/actor-middleware";

export interface RuntimeRetryExecutionResult<T> {
  result: T;
  attempts: number;
}

export async function executeRuntimeWithRetry<T>(params: {
  execute: () => Promise<T>;
  retryConfig?: ActorRunContext["retryConfig"];
  withRetry?: ActorRunContext["withRetry"];
  retryLabel?: string;
  onAttemptStarted?: (attempt: number) => void;
}): Promise<RuntimeRetryExecutionResult<T>> {
  let attempts = 0;
  const executeWithAttemptTracking = async () => {
    attempts += 1;
    params.onAttemptStarted?.(attempts);
    return params.execute();
  };

  if (params.withRetry && params.retryConfig) {
    const result = await params.withRetry(
      executeWithAttemptTracking,
      params.retryConfig as NonNullable<ActorRunContext["retryConfig"]> & Record<string, unknown>,
      params.retryLabel,
    );
    return { result, attempts };
  }

  const result = await executeWithAttemptTracking();
  return { result, attempts };
}
