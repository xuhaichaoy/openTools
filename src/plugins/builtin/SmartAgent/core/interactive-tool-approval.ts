import type { ExecutionPolicy } from "@/core/agent/actor/types";
import type {
  ToolApprovalAssessment,
  ToolApprovalRisk,
} from "@/core/agent/actor/tool-approval-policy";
import { detectSuspiciousShellCommand } from "@/core/agent/actor/tool-approval-policy";
import { createLogger } from "@/core/logger";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import type { AICenterMode } from "@/store/app-store";
import { useToolTrustStore } from "@/store/command-allowlist-store";
import type { ConfirmDialogSource } from "@/store/confirm-dialog-store";

const log = createLogger("InteractiveToolApproval");

type ModelReviewDecision = "allow" | "ask_human";
type ModelReviewConfidence = "high" | "medium" | "low";

interface ModelReviewResult {
  decision: ModelReviewDecision;
  confidence: ModelReviewConfidence;
  reason: string;
}

interface OpenConfirmDialogInput {
  source: ConfirmDialogSource;
  toolName: string;
  params: Record<string, unknown>;
  risk?: ToolApprovalRisk;
  reason?: string;
  reviewedByModel?: boolean;
}

interface ResolveInteractiveToolApprovalOptions {
  toolName: string;
  params: Record<string, unknown>;
  source: ConfirmDialogSource;
  openConfirmDialog: (params: OpenConfirmDialogInput) => Promise<boolean>;
  executionPolicy?: ExecutionPolicy;
  workspace?: string;
  ai?: MToolsAI;
  aiMode?: AICenterMode;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function toDisplayString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildCommandPreview(params: Record<string, unknown>): string {
  return normalizeWhitespace(toDisplayString(params.command ?? params.cmd));
}

function shouldUseModelReview(
  toolName: string,
  params: Record<string, unknown>,
  assessment: ToolApprovalAssessment,
  trustLevel: "always_ask" | "auto_approve_file" | "auto_approve",
): boolean {
  if (trustLevel !== "auto_approve_file") return false;
  if (assessment.decision !== "ask") return false;
  if (assessment.risk === "high") return false;

  if (toolName === "run_shell_command" || toolName === "persistent_shell") {
    const preview = buildCommandPreview(params);
    return preview.length > 0 && !detectSuspiciousShellCommand(preview);
  }

  if (assessment.risk !== "unknown") return false;
  return /(read|get|search|list|fetch|query|open|inspect|stat)/i.test(toolName);
}

function normalizeModelDecision(value: unknown): ModelReviewDecision | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "allow") return "allow";
  if (normalized === "ask_human" || normalized === "ask-human" || normalized === "ask") {
    return "ask_human";
  }
  return null;
}

function normalizeModelConfidence(value: unknown): ModelReviewConfidence {
  if (typeof value !== "string") return "low";
  const normalized = value.trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return "low";
}

function repairJsonString(text: string): string | null {
  let candidate = text.trim();
  candidate = candidate.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0) return null;
  candidate = end <= start
    ? `${candidate.slice(start)}}`
    : candidate.slice(start, end + 1);
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function extractBalancedJsonObjects(text: string, maxCandidates = 12): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, index + 1));
        start = -1;
        if (results.length >= maxCandidates) break;
      }
    }
  }

  return results;
}

function parseModelReviewResult(text: string): ModelReviewResult | null {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value?: string | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  push(text);
  push(text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim());

  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  for (const match of text.matchAll(fenceRegex)) {
    push(match[1]);
  }

  for (const balanced of extractBalancedJsonObjects(text)) {
    push(balanced);
    push(repairJsonString(balanced));
  }
  push(repairJsonString(text));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const decision = normalizeModelDecision(parsed.decision);
      if (!decision) continue;
      const reason = typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : "模型未提供明确说明";
      return {
        decision,
        confidence: normalizeModelConfidence(parsed.confidence),
        reason,
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function reviewToolApprovalWithModel(params: {
  ai: MToolsAI;
  toolName: string;
  toolParams: Record<string, unknown>;
  assessment: ToolApprovalAssessment;
  executionPolicy?: ExecutionPolicy;
  workspace?: string;
}): Promise<ModelReviewResult | null> {
  const { ai, toolName, toolParams, assessment, executionPolicy, workspace } = params;

  const messages = [
    {
      role: "system" as const,
      content: [
        "你是一个保守的工具安全复核器。",
        "系统规则已经未能自动放行这次工具调用，现在只允许你判断：是否可以在不打扰用户的情况下自动放行。",
        "只有在你高度确信该调用是纯只读、无副作用、不修改文件/系统/网络/外部状态时，才能返回 allow。",
        "如果存在任何不确定、语义含混、可能写入、可能联网、可能执行脚本、可能访问敏感信息的风险，一律返回 ask_human。",
        "不要重写参数，不要补全命令，只做风险判断。",
        "只返回 JSON：{\"decision\":\"allow\"|\"ask_human\",\"confidence\":\"high\"|\"medium\"|\"low\",\"reason\":\"...\"}",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        `tool_name: ${toolName}`,
        `tool_params: ${JSON.stringify(toolParams, null, 2)}`,
        `policy_assessment: ${JSON.stringify(assessment, null, 2)}`,
        executionPolicy ? `execution_policy: ${JSON.stringify(executionPolicy, null, 2)}` : "",
        workspace ? `workspace: ${workspace}` : "",
        toolName === "run_shell_command" || toolName === "persistent_shell"
          ? "额外要求：若 shell 命令明显是只读检查/统计，可 allow；若你不能高置信度确认其无副作用，则 ask_human。"
          : "",
      ].filter(Boolean).join("\n\n"),
    },
  ];

  const result = await ai.chat({
    messages,
    temperature: 0,
    requestPolicy: {
      ragMode: "off",
      forceProductRag: "off",
    },
    skipTools: true,
    skipMemory: true,
  });

  return parseModelReviewResult(result.content);
}

async function resolveReviewAI(
  ai: MToolsAI | undefined,
  aiMode: AICenterMode | undefined,
): Promise<MToolsAI | undefined> {
  if (ai) return ai;
  if (!aiMode) return undefined;
  const module = await import("@/core/ai/mtools-ai");
  return module.getMToolsAI(aiMode);
}

export async function resolveInteractiveToolApproval(
  options: ResolveInteractiveToolApprovalOptions,
): Promise<boolean> {
  const {
    toolName,
    params,
    source,
    openConfirmDialog,
    executionPolicy,
    workspace,
    ai,
    aiMode,
  } = options;

  const toolTrust = useToolTrustStore.getState();
  const cachedDecision = toolTrust.getCachedDecision(toolName, params);
  if (cachedDecision !== null) {
    return cachedDecision;
  }

  const assessment = toolTrust.assess(toolName, params, {
    executionPolicy,
    workspace,
  });

  if (assessment.decision === "deny") {
    log.warn("tool denied by policy", {
      toolName,
      risk: assessment.risk,
      reason: assessment.reason,
    });
    return false;
  }

  if (assessment.decision === "allow") {
    toolTrust.rememberDecision(toolName, params, true);
    return true;
  }

  let reviewedByModel = false;
  let promptReason = assessment.reason;

  if (shouldUseModelReview(toolName, params, assessment, toolTrust.trustLevel)) {
    reviewedByModel = true;
    try {
      const reviewAI = await resolveReviewAI(ai, aiMode);
      if (reviewAI) {
        const review = await reviewToolApprovalWithModel({
          ai: reviewAI,
          toolName,
          toolParams: params,
          assessment,
          executionPolicy,
          workspace,
        });

        if (review?.decision === "allow" && review.confidence === "high") {
          toolTrust.rememberDecision(toolName, params, true);
          return true;
        }

        promptReason = review
          ? review.reason
          : assessment.reason;
      }
    } catch (error) {
      log.warn("model review failed", {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      promptReason = assessment.reason;
    }
  }

  const confirmed = await openConfirmDialog({
    source,
    toolName,
    params,
    risk: assessment.risk,
    reason: promptReason,
    reviewedByModel,
  });
  toolTrust.rememberDecision(toolName, params, confirmed);
  return confirmed;
}
