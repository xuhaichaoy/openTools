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

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

function findMatchingRule(toolName: string, rules: ApprovalRule[]): ApprovalRule | undefined {
  return rules.find((r) => matchesPattern(toolName, r.pattern));
}

function buildApprovalPrompt(toolName: string, params: Record<string, unknown>, rule: ApprovalRule): string {
  const paramsPreview = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `  - ${k}: ${String(v).slice(0, 200)}`)
    .join("\n");

  return [
    `⚠️ **需要您的批准**`,
    ``,
    `Agent 请求执行高风险操作：`,
    `- **工具**: \`${toolName}\``,
    rule.riskDescription ? `- **风险**: ${rule.riskDescription}` : "",
    paramsPreview ? `- **参数**:\n${paramsPreview}` : "",
    ``,
    `请回复：`,
    `- **允许** / **y** — 本次允许执行`,
    `- **始终允许** — 本会话内不再询问此工具`,
    `- **拒绝** / **n** — 拒绝执行`,
  ].filter(Boolean).join("\n");
}

function parseApprovalResponse(response: string): ApprovalPolicy {
  const normalized = response.trim().toLowerCase();
  if (/^(允许|y|yes|ok|可以|同意|确认|approve|allow)$/i.test(normalized)) {
    return "ask-every-time";
  }
  if (/^(始终允许|always|always[\s-]?allow|总是允许)$/i.test(normalized)) {
    return "always-allow";
  }
  return "deny";
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
          // Check session-level approvals
          const sessionKey = `${actorId}:${tool.name}`;
          const cachedPolicy = sessionApprovals.get(sessionKey);
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
          const prompt = buildApprovalPrompt(tool.name, params, effectiveRule);
          const response = await actorSystem.askUserInChat(actorId, prompt, 60_000);
          const decision = parseApprovalResponse(response);

          if (decision === "always-allow") {
            sessionApprovals.set(sessionKey, "always-allow");
            return originalExecute(params);
          }
          if (decision === "ask-every-time") {
            return originalExecute(params);
          }

          sessionApprovals.set(sessionKey, "deny");
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

/** Pre-approve a tool for the session */
export function preApproveToolForSession(actorId: string, toolName: string): void {
  sessionApprovals.set(`${actorId}:${toolName}`, "always-allow");
}
