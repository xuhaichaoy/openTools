/**
 * PatchToolCallsMiddleware — 修复不同模型的 tool call 格式差异
 *
 * 灵感来源：Yuxi-Know 的 PatchToolCallsMiddleware
 *
 * 不同 LLM 对 function calling 的实现存在差异，常见问题：
 * 1. 参数以 string 而非 object 形式返回（需 JSON.parse）
 * 2. 工具名称大小写不一致
 * 3. 参数 key 使用 camelCase vs snake_case
 * 4. 多余的 wrapper 层（如 { "arguments": { ... } }）
 * 5. 部分模型返回的 JSON 带有 markdown code fence
 *
 * 与 FCCompatibilityMiddleware 互补：
 * - FCCompat 处理 function calling 协议层面的兼容
 * - PatchToolCalls 处理 tool call 参数层面的修复
 */

import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

function stripMarkdownCodeFence(input: string): string {
  return input.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

function tryParseJSON(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "string") return null;
  const cleaned = stripMarkdownCodeFence(input);
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* not valid JSON */ }
  return null;
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Unwrap nested "arguments" wrapper some models produce */
function unwrapArguments(params: Record<string, unknown>): Record<string, unknown> {
  if (
    Object.keys(params).length === 1 &&
    params.arguments &&
    typeof params.arguments === "object" &&
    !Array.isArray(params.arguments)
  ) {
    return params.arguments as Record<string, unknown>;
  }
  return params;
}

/**
 * Normalize parameter keys: try to match against the tool's declared parameter names.
 * Handles camelCase ↔ snake_case conversion.
 */
function normalizeParamKeys(
  params: Record<string, unknown>,
  declaredParams: Record<string, unknown>,
): Record<string, unknown> {
  const declaredKeys = Object.keys(declaredParams);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    // Direct match
    if (declaredKeys.includes(key)) {
      result[key] = value;
      continue;
    }
    // Try camelCase → snake_case
    const snakeKey = camelToSnake(key);
    if (declaredKeys.includes(snakeKey)) {
      result[snakeKey] = value;
      continue;
    }
    // Try snake_case → camelCase
    const camelKey = snakeToCamel(key);
    if (declaredKeys.includes(camelKey)) {
      result[camelKey] = value;
      continue;
    }
    // Case-insensitive match
    const lowerKey = key.toLowerCase();
    const matched = declaredKeys.find((k) => k.toLowerCase() === lowerKey);
    if (matched) {
      result[matched] = value;
      continue;
    }
    // Keep as-is
    result[key] = value;
  }

  return result;
}

export class PatchToolCallsMiddleware implements ActorMiddleware {
  readonly name = "PatchToolCalls";

  async apply(ctx: ActorRunContext): Promise<void> {
    // Build a name lookup (case-insensitive) for tool resolution
    const toolMap = new Map<string, AgentTool>();
    for (const tool of ctx.tools) {
      toolMap.set(tool.name.toLowerCase(), tool);
    }

    ctx.tools = ctx.tools.map((tool) => {
      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (params: Record<string, unknown>) => {
          let patched = { ...params };

          // 1. If params is a string (some models do this), parse it
          for (const [key, value] of Object.entries(patched)) {
            const parsed = tryParseJSON(value);
            if (parsed) {
              // If the value is a JSON string that parses to an object, inline it
              if (key === "arguments" || key === "params") {
                patched = { ...patched, ...parsed };
                delete patched[key];
              } else {
                patched[key] = parsed;
              }
            }
          }

          // 2. Unwrap nested "arguments" wrapper
          patched = unwrapArguments(patched);

          // 3. Normalize parameter keys to match tool's declared params
          if (tool.parameters) {
            patched = normalizeParamKeys(patched, tool.parameters);
          }

          // 4. Type coercion for known parameter types
          if (tool.parameters) {
            for (const [key, schema] of Object.entries(tool.parameters)) {
              if (patched[key] === undefined) continue;
              const paramSchema = schema as { type?: string };
              if (paramSchema.type === "number" && typeof patched[key] === "string") {
                const num = Number(patched[key]);
                if (!Number.isNaN(num)) patched[key] = num;
              }
              if (paramSchema.type === "boolean" && typeof patched[key] === "string") {
                patched[key] = patched[key] === "true";
              }
            }
          }

          return originalExecute(patched);
        },
      };
    });
  }
}
