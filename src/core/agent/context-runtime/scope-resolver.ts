import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import { resolveBootstrapWorkspaceRoot } from "@/core/ai/bootstrap-context";
import type { AICenterHandoff } from "@/store/app-store";
import type {
  AgentQueryIntent,
  ResolveTaskScopeParams,
  TaskScopeSnapshot,
} from "./types";

const EXPLICIT_RESET_PATTERNS: RegExp[] = [
  /另一个(目录|文件夹|项目|页面|任务)/,
  /新的?(目录|文件夹|项目|页面|任务)/,
  /完全无关|不相关|与之前无关|不要参考之前|重新开始|从头开始/,
  /new project|different project|another folder|different folder|separate folder|from scratch/i,
];

const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'`([{])((?:\/[^\s"'`<>|，。；,]+|[A-Za-z]:\/[^\s"'`<>|，。；,]+))/g;

function inferQueryIntent(query: string): AgentQueryIntent {
  const normalized = query.trim();
  if (!normalized) return "general";
  if (inferCodingExecutionProfile({ query: normalized }).profile.codingMode) {
    return "coding";
  }
  if (/(搜索|查找|资料|调研|research|investigate|analyze)/i.test(normalized)) {
    return "research";
  }
  if (/(总结|汇总|文档|方案|报告|交付|deliver|draft|write up)/i.test(normalized)) {
    return "delivery";
  }
  return "general";
}

export function normalizeContextPath(path: string): string {
  return String(path || "").trim().replace(/\\/g, "/");
}

function isAbsoluteContextPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

export function uniqueContextPaths(paths: readonly string[]): string[] {
  return [
    ...new Set(paths.map((path) => normalizeContextPath(path)).filter(Boolean)),
  ];
}

function collectAbsolutePathHints(text?: string): string[] {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  return [...normalized.matchAll(ABSOLUTE_PATH_PATTERN)]
    .map((match) => normalizeContextPath(match[1] || ""))
    .filter((item) => isAbsoluteContextPath(item));
}

export function collectContextPathHints(
  value: unknown,
  maxResults = 24,
): string[] {
  const results: string[] = [];
  const visited = new Set<object>();

  const push = (candidate: string) => {
    if (results.length >= maxResults) return;
    const normalized = normalizeContextPath(candidate);
    if (!normalized || !isAbsoluteContextPath(normalized)) return;
    if (results.includes(normalized)) return;
    results.push(normalized);
  };

  const visit = (input: unknown, depth: number) => {
    if (results.length >= maxResults || depth > 3 || input == null) return;
    if (typeof input === "string") {
      for (const hint of collectAbsolutePathHints(input.slice(0, 8_000))) {
        push(hint);
      }
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input.slice(0, 16)) {
        visit(item, depth + 1);
        if (results.length >= maxResults) break;
      }
      return;
    }
    if (typeof input !== "object") return;
    if (visited.has(input as object)) return;
    visited.add(input as object);

    for (const [key, val] of Object.entries(input as Record<string, unknown>).slice(0, 24)) {
      if (
        typeof val === "string"
        && /(path|file|dir|directory|workspace|repo|root|artifact|attachment)/i.test(key)
      ) {
        push(val);
      }
      visit(val, depth + 1);
      if (results.length >= maxResults) break;
    }
  };

  visit(value, 0);
  return uniqueContextPaths(results);
}

export function collectHandoffPaths(
  handoff?: AICenterHandoff | null,
): string[] {
  if (!handoff) return [];
  return uniqueContextPaths([
    ...(handoff.attachmentPaths ?? []),
    ...(handoff.visualAttachmentPaths ?? []),
    ...((handoff.files ?? []).map((file) => file.path)),
  ]);
}

export async function resolveTaskScopeSnapshot(
  params: ResolveTaskScopeParams,
): Promise<TaskScopeSnapshot> {
  const attachmentPaths = uniqueContextPaths(params.attachmentPaths ?? []);
  const imagePaths = uniqueContextPaths(params.images ?? []);
  const handoffPaths = collectHandoffPaths(params.sourceHandoff);
  const pathHints = uniqueContextPaths([
    ...attachmentPaths,
    ...imagePaths,
    ...handoffPaths,
  ]);

  const workspaceRoot = await resolveBootstrapWorkspaceRoot({
    explicitWorkspace: normalizeContextPath(params.explicitWorkspaceRoot || "") || undefined,
    filePaths: pathHints,
    handoffPaths,
    query: params.query,
  }).catch(() => undefined);

  return {
    previousWorkspaceRoot: normalizeContextPath(
      params.previousWorkspaceRoot || "",
    ) || undefined,
    workspaceRoot,
    attachmentPaths,
    imagePaths,
    handoffPaths,
    pathHints,
    queryIntent: inferQueryIntent(params.query),
    explicitReset: EXPLICIT_RESET_PATTERNS.some((pattern) =>
      pattern.test(params.query),
    ),
  };
}
