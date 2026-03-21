export function isContextPressureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    /maximum context length/i,
    /context length/i,
    /prompt is too long/i,
    /too many input tokens/i,
    /context window/i,
    /request too large/i,
    /max(?:imum)? tokens/i,
  ].some((pattern) => pattern.test(message));
}
