/**
 * HumanApprovalMiddleware — Human-in-the-Loop 审批机制
 *
 * 灵感来源：Yuxi-Know 的 Human-in-the-loop approval 机制
 *
 * 在高危工具执行前拦截，弹出确认对话框或通过 askUserInChat 获取用户批准。
 * 支持三级策略：
 *   - always-allow: 始终允许（已确认过的工具）
 *   - ask-every-time: 每次都询问
 *   - deny: 始终禁止
 */

import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import type { ApprovalDecisionOption, ApprovalRequest, ApprovalRequestDetail } from "../types";

export type ApprovalPolicy = "always-allow" | "ask-every-time" | "deny";

export interface ApprovalRule {
  /** Tool name pattern (glob-like: "shell_*", "write_file", etc.) */
  pattern: string;
  /** 策略 */
  policy: ApprovalPolicy;
  /** 用户友好的风险描述 */
  riskDescription?: string;
}

const DEFAULT_DANGEROUS_RULES: ApprovalRule[] = [
  { pattern: "run_shell_command", policy: "ask-every-time", riskDescription: "执行 Shell 命令（可能修改系统文件或执行危险操作）" },
  { pattern: "write_file", policy: "ask-every-time", riskDescription: "写入文件（可能覆盖重要文件）" },
  { pattern: "native_*", policy: "ask-every-time", riskDescription: "原生系统操作（可能影响系统状态）" },
  { pattern: "database_execute", policy: "ask-every-time", riskDescription: "执行数据库写操作" },
  { pattern: "delete_file", policy: "ask-every-time", riskDescription: "删除文件" },
  { pattern: "ssh_*", policy: "ask-every-time", riskDescription: "远程 SSH 操作" },
];

/** Session-scoped approval memory: tools approved once stay approved for the session */
const sessionApprovals = new Map<string, ApprovalPolicy>();

interface ApprovalCacheContext {
  lookupKeys: string[];
  denyCacheKey?: string;
  decisionOptions: ApprovalDecisionOption[];
  cacheScopeSummary?: string;
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

function findMatchingRule(toolName: string, rules: ApprovalRule[]): ApprovalRule | undefined {
  return rules.find((r) => matchesPattern(toolName, r.pattern));
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function dirname(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) return path.startsWith("/") ? "/" : "";
  return `${path.startsWith("/") ? "/" : ""}${segments.slice(0, -1).join("/")}`;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function toDisplayString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizePathValue(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function normalizeChoiceLabel(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function makeToolScopeKey(actorId: string, toolName: string): string {
  return `${actorId}:${toolName}`;
}

function makeScopedApprovalKey(actorId: string, toolName: string, scope: string, value: string): string {
  return `${actorId}:${toolName}:${scope}:${value}`;
}

function extractShellCommandBase(command: string): string {
  const normalized = normalizeWhitespace(command);
  if (!normalized) return "";
  const first = normalized.split(" ")[0] ?? "";
  return basename(first);
}

function resolveCachedApproval(lookupKeys: readonly string[]): ApprovalPolicy | undefined {
  for (const key of lookupKeys) {
    const cached = sessionApprovals.get(key);
    if (cached) return cached;
  }
  return undefined;
}

function buildApprovalCacheContext(
  actorId: string,
  toolName: string,
  params: Record<string, unknown>,
): ApprovalCacheContext {
  const toolScopeKey = makeToolScopeKey(actorId, toolName);

  if (toolName === "write_file" || toolName === "delete_file") {
    const path = normalizePathValue(toDisplayString(params.path || params.filePath));
    const directory = path ? normalizePathValue(dirname(path)) : "";
    const lookupKeys = [
      path ? makeScopedApprovalKey(actorId, toolName, "path", path) : "",
      directory ? makeScopedApprovalKey(actorId, toolName, "dir", directory) : "",
      toolScopeKey,
    ].filter(Boolean);

    const decisionOptions: ApprovalDecisionOption[] = [
      { label: "允许一次", policy: "ask-every-time", description: "只允许本次操作" },
    ];
    if (path) {
      decisionOptions.push({
        label: "本会话允许此文件",
        policy: "always-allow",
        cacheKey: makeScopedApprovalKey(actorId, toolName, "path", path),
        description: basename(path),
      });
    }
    if (directory) {
      decisionOptions.push({
        label: "本会话允许此目录",
        policy: "always-allow",
        cacheKey: makeScopedApprovalKey(actorId, toolName, "dir", directory),
        description: directory,
      });
    }
    decisionOptions.push({
      label: "拒绝",
      policy: "deny",
      cacheKey: lookupKeys[0] ?? toolScopeKey,
      description: path || directory || toolName,
    });

    return {
      lookupKeys,
      denyCacheKey: lookupKeys[0] ?? toolScopeKey,
      decisionOptions,
      cacheScopeSummary: path
        ? `可记住到此文件或所在目录`
        : directory
          ? `可记住到目录 ${directory}`
          : "可记住到该工具",
    };
  }

  if (toolName === "run_shell_command" || toolName === "persistent_shell") {
    const command = normalizeWhitespace(toDisplayString(params.command || params.cmd));
    const commandBase = extractShellCommandBase(command);
    const cwd = normalizePathValue(toDisplayString(params.cwd || params.workdir));
    const lookupKeys = [
      cwd ? makeScopedApprovalKey(actorId, toolName, "cwd", cwd) : "",
      commandBase ? makeScopedApprovalKey(actorId, toolName, "cmd", commandBase) : "",
      toolScopeKey,
    ].filter(Boolean);

    const decisionOptions: ApprovalDecisionOption[] = [
      { label: "允许一次", policy: "ask-every-time", description: "只允许本次命令" },
    ];
    if (cwd) {
      decisionOptions.push({
        label: "本会话允许当前目录",
        policy: "always-allow",
        cacheKey: makeScopedApprovalKey(actorId, toolName, "cwd", cwd),
        description: cwd,
      });
    }
    if (commandBase) {
      decisionOptions.push({
        label: `本会话允许 ${commandBase} 命令`,
        policy: "always-allow",
        cacheKey: makeScopedApprovalKey(actorId, toolName, "cmd", commandBase),
        description: commandBase,
      });
    }
    decisionOptions.push({
      label: "拒绝",
      policy: "deny",
      cacheKey: lookupKeys[0] ?? toolScopeKey,
      description: cwd || commandBase || toolName,
    });

    return {
      lookupKeys,
      denyCacheKey: lookupKeys[0] ?? toolScopeKey,
      decisionOptions,
      cacheScopeSummary: cwd && commandBase
        ? `可记住到当前目录或 ${commandBase} 命令`
        : cwd
          ? `可记住到当前目录 ${cwd}`
          : commandBase
            ? `可记住到 ${commandBase} 命令`
            : "可记住到该工具",
    };
  }

  const genericAllowKey = toolScopeKey;
  return {
    lookupKeys: [genericAllowKey],
    denyCacheKey: genericAllowKey,
    cacheScopeSummary: "可记住到该工具",
    decisionOptions: [
      { label: "允许一次", policy: "ask-every-time", description: "只允许本次操作" },
      { label: "本会话允许", policy: "always-allow", cacheKey: genericAllowKey, description: toolName },
      { label: "拒绝", policy: "deny", cacheKey: genericAllowKey, description: toolName },
    ],
  };
}

function trimPreview(text: string, maxChars = 1600): { value: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { value: text, truncated: false };
  }

  return {
    value: `${text.slice(0, maxChars).trimEnd()}\n...`,
    truncated: true,
  };
}

function inferPreviewLanguage(toolName: string, targetPath?: string): string | undefined {
  if (toolName === "run_shell_command" || toolName === "persistent_shell") {
    return "bash";
  }
  if (!targetPath) return undefined;

  const ext = targetPath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "html":
      return "html";
    case "css":
      return "css";
    case "js":
    case "cjs":
    case "mjs":
      return "javascript";
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "jsx":
      return "jsx";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "sh":
      return "bash";
    default:
      return undefined;
  }
}

function summarizeDetails(params: Record<string, unknown>, skipKeys: string[] = []): ApprovalRequestDetail[] {
  const skip = new Set(skipKeys);
  return Object.entries(params)
    .filter(([key, value]) => !skip.has(key) && value !== undefined && value !== null)
    .slice(0, 4)
    .map(([key, value]) => ({
      label: key,
      value: toDisplayString(value).slice(0, 240),
      mono: typeof value === "string" && (String(value).includes("/") || String(value).includes("{")),
    }));
}

function buildApprovalRequest(
  toolName: string,
  params: Record<string, unknown>,
  rule: ApprovalRule,
  cacheContext: ApprovalCacheContext,
): ApprovalRequest {
  if (toolName === "write_file") {
    const path = toDisplayString(params.path || params.filePath);
    const content = toDisplayString(params.content);
    const preview = trimPreview(content);
    const details: ApprovalRequestDetail[] = [];

    if (path) {
      details.push({ label: "文件名", value: basename(path) });
      details.push({ label: "目录", value: dirname(path), mono: true });
    }
    if (content) {
      details.push({ label: "内容规模", value: `${countLines(content)} 行 · ${content.length} 字符` });
    }

    return {
      toolName,
      title: "请求写入文件",
      summary: path ? `代码已生成，等待你批准后写入 ${basename(path)}` : "代码已生成，等待你批准后写入本地文件",
      riskDescription: rule.riskDescription,
      targetPath: path || undefined,
      preview: preview.value,
      fullContent: content || undefined,
      previewLabel: "代码预览",
      previewLanguage: inferPreviewLanguage(toolName, path),
      previewTruncated: preview.truncated,
      details,
      cacheScopeSummary: cacheContext.cacheScopeSummary,
      decisionOptions: cacheContext.decisionOptions,
    };
  }

  if (toolName === "run_shell_command" || toolName === "persistent_shell") {
    const command = toDisplayString(params.command || params.cmd);
    const cwd = toDisplayString(params.cwd || params.workdir);
    const preview = trimPreview(command);
    const details: ApprovalRequestDetail[] = [];

    if (cwd) {
      details.push({ label: "工作目录", value: cwd, mono: true });
    }
    if (params.timeout_ms != null || params.timeout != null) {
      details.push({ label: "超时", value: `${String(params.timeout_ms ?? params.timeout)} ms` });
    }

    return {
      toolName,
      title: "请求执行命令",
      summary: command ? "Agent 准备在本机执行一条 Shell 命令" : "Agent 准备执行系统命令",
      riskDescription: rule.riskDescription,
      preview: preview.value,
      fullContent: command || undefined,
      previewLabel: "命令预览",
      previewLanguage: inferPreviewLanguage(toolName),
      previewTruncated: preview.truncated,
      details,
      cacheScopeSummary: cacheContext.cacheScopeSummary,
      decisionOptions: cacheContext.decisionOptions,
    };
  }

  if (toolName === "delete_file") {
    const path = toDisplayString(params.path || params.filePath);
    return {
      toolName,
      title: "请求删除文件",
      summary: path ? `准备删除 ${basename(path)}` : "准备删除一个本地文件",
      riskDescription: rule.riskDescription,
      targetPath: path || undefined,
      cacheScopeSummary: cacheContext.cacheScopeSummary,
      decisionOptions: cacheContext.decisionOptions,
      details: path
        ? [
            { label: "文件名", value: basename(path) },
            { label: "目录", value: dirname(path), mono: true },
          ]
        : undefined,
    };
  }

  return {
    toolName,
    title: "请求执行受限操作",
    summary: `Agent 想调用 ${toolName}，需要你的批准后继续`,
    riskDescription: rule.riskDescription,
    details: summarizeDetails(params),
    cacheScopeSummary: cacheContext.cacheScopeSummary,
    decisionOptions: cacheContext.decisionOptions,
  };
}

function buildApprovalPrompt(request: ApprovalRequest): string {
  const detailLines = (request.details ?? [])
    .slice(0, 3)
    .map((detail) => `- **${detail.label}**: ${detail.value}`)
    .join("\n");
  const decisionLines = (request.decisionOptions ?? [])
    .map((option) => `- **${option.label}**${option.description ? `: ${option.description}` : ""}`)
    .join("\n");

  return [
    `⚠️ **需要您的批准**`,
    ``,
    `${request.summary}`,
    `- **工具**: \`${request.toolName}\``,
    request.riskDescription ? `- **风险**: ${request.riskDescription}` : "",
    request.targetPath ? `- **目标**: \`${request.targetPath}\`` : "",
    detailLines,
    request.cacheScopeSummary ? `- **记住范围**: ${request.cacheScopeSummary}` : "",
    ``,
    `可直接使用审批卡片按钮，或手动回复：`,
    decisionLines || `- **允许一次** / **允许** / **y** — 本次允许执行`,
    !decisionLines ? `- **本会话允许** / **始终允许** — 本会话内记住此许可` : "",
    !decisionLines ? `- **拒绝** / **n** — 拒绝执行` : "",
  ].filter(Boolean).join("\n");
}

function parseApprovalResponse(
  response: string,
  request: ApprovalRequest,
  cacheContext: ApprovalCacheContext,
): { policy: ApprovalPolicy; cacheKey?: string } {
  const normalized = response.trim().toLowerCase();
  const matchedDecision = (request.decisionOptions ?? []).find(
    (option) => normalizeChoiceLabel(option.label) === normalizeChoiceLabel(response),
  );
  if (matchedDecision) {
    return {
      policy: matchedDecision.policy,
      cacheKey: matchedDecision.cacheKey,
    };
  }

  if (/^(允许|允许一次|本次允许|仅此一次|y|yes|ok|可以|同意|确认|approve|allow)$/i.test(normalized)) {
    return { policy: "ask-every-time" };
  }
  if (/^(始终允许|本会话允许|always|always[\s-]?allow|总是允许)$/i.test(normalized)) {
    const preferredAllow = (request.decisionOptions ?? []).find(
      (option) => option.policy === "always-allow" && option.cacheKey,
    );
    return {
      policy: "always-allow",
      cacheKey: preferredAllow?.cacheKey ?? cacheContext.lookupKeys[0],
    };
  }
  if (/^(拒绝|n|no|deny|reject)$/i.test(normalized)) {
    return {
      policy: "deny",
      cacheKey: cacheContext.denyCacheKey,
    };
  }

  return {
    policy: "deny",
    cacheKey: cacheContext.denyCacheKey,
  };
}

export class HumanApprovalMiddleware implements ActorMiddleware {
  readonly name = "HumanApproval";
  private rules: ApprovalRule[];

  constructor(rules?: ApprovalRule[]) {
    this.rules = rules ?? DEFAULT_DANGEROUS_RULES;
  }

  async apply(ctx: ActorRunContext): Promise<void> {
    if (!ctx.actorSystem) return;

    // Respect per-actor approval level override
    const approvalLevel = ctx.middlewareOverrides?.approvalLevel ?? "normal";
    if (approvalLevel === "off") return;

    // "permissive" mode: only block explicitly denied tools, skip interactive approval
    const skipInteractive = approvalLevel === "permissive";

    const actorSystem = ctx.actorSystem;
    const actorId = ctx.actorId;

    // "strict" mode: treat ALL tools as needing approval (unless already session-approved)
    const isStrict = approvalLevel === "strict";

    ctx.tools = ctx.tools.map((tool) => {
      const rule = findMatchingRule(tool.name, this.rules);

      // In non-strict mode, tools without matching rules pass through
      if (!isStrict && !rule) return tool;
      if (rule?.policy === "always-allow") return tool;
      if (rule?.policy === "deny") {
        return {
          ...tool,
          execute: async () => ({
            error: `工具 ${tool.name} 已被安全策略禁止使用。原因：${rule.riskDescription ?? "高风险操作"}`,
          }),
        };
      }

      // In strict mode without explicit rule, create a generic approval rule
      const effectiveRule: ApprovalRule = rule ?? {
        pattern: tool.name,
        policy: "ask-every-time",
        riskDescription: "严格模式下所有工具调用都需要确认",
      };

      // ask-every-time: wrap with approval gate (unless permissive mode)
      if (skipInteractive) return tool;

      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (params: Record<string, unknown>) => {
          const cacheContext = buildApprovalCacheContext(actorId, tool.name, params);
          const cachedPolicy = resolveCachedApproval(cacheContext.lookupKeys);
          if (cachedPolicy === "always-allow") {
            return originalExecute(params);
          }
          if (cachedPolicy === "deny") {
            return { error: `工具 ${tool.name} 已被用户拒绝` };
          }

          // Use confirmDangerousAction callback if available (for dialog/popup mode)
          if (ctx.confirmDangerousAction) {
            const approved = await ctx.confirmDangerousAction(tool.name, params);
            if (!approved) {
              return { error: `用户拒绝了 ${tool.name} 的执行请求` };
            }
            return originalExecute(params);
          }

          // Use askUserInChat for chat-based approval
          const approvalRequest = buildApprovalRequest(tool.name, params, effectiveRule, cacheContext);
          const prompt = buildApprovalPrompt(approvalRequest);
          const interaction = await actorSystem.askUserInChat(actorId, prompt, {
            timeoutMs: 60_000,
            interactionType: "approval",
            options: approvalRequest.decisionOptions?.map((option) => option.label) ?? ["允许一次", "本会话允许", "拒绝"],
            approvalRequest,
          });
          const decision = interaction.status === "answered"
            ? parseApprovalResponse(interaction.content, approvalRequest, cacheContext)
            : { policy: "deny" as const, cacheKey: cacheContext.denyCacheKey };

          if (decision.policy === "always-allow") {
            if (decision.cacheKey) {
              sessionApprovals.set(decision.cacheKey, "always-allow");
            }
            return originalExecute(params);
          }
          if (decision.policy === "ask-every-time") {
            return originalExecute(params);
          }

          if (decision.cacheKey) {
            sessionApprovals.set(decision.cacheKey, "deny");
          }
          return { error: `用户拒绝了 ${tool.name} 的执行请求` };
        },
      };
    });
  }
}

/** Clear session approvals (call on session reset) */
export function clearSessionApprovals(): void {
  sessionApprovals.clear();
}

/** Export current session approvals for persistence */
export function getSessionApprovalsSnapshot(): Record<string, ApprovalPolicy> {
  return Object.fromEntries(sessionApprovals.entries());
}

/** Restore session approvals from persistence */
export function restoreSessionApprovals(snapshot?: Record<string, ApprovalPolicy>): void {
  sessionApprovals.clear();
  if (!snapshot) return;

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === "always-allow" || value === "ask-every-time" || value === "deny") {
      sessionApprovals.set(key, value);
    }
  }
}

/** Pre-approve a tool for the session */
export function preApproveToolForSession(actorId: string, toolName: string): void {
  sessionApprovals.set(makeToolScopeKey(actorId, toolName), "always-allow");
}
