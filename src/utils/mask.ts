/**
 * API Key 脱敏：显示前缀 + **** + 后缀
 * 例如 "sk-abc123456789wxyz" → "sk-abc****wxyz"
 */
export function maskApiKey(
  key: string,
  prefixLen = 6,
  suffixLen = 4,
): string {
  if (!key) return "";
  if (key.length <= prefixLen + suffixLen + 2) return "****";
  return `${key.slice(0, prefixLen)}****${key.slice(-suffixLen)}`;
}
