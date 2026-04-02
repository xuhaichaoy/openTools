import { detectSuspiciousShellCommand, type ToolApprovalRisk } from "@/core/agent/actor/tool-approval-policy";
import type { SessionDecisionScope } from "@/store/command-allowlist-store";

export interface ToolApprovalDialogDetail {
  label: string;
  value: string;
  mono?: boolean;
}

export interface ToolApprovalDialogAction {
  label: string;
  description: string;
  scope: SessionDecisionScope;
}

export interface ToolApprovalDialogModel {
  title: string;
  subtitle: string;
  toolTag: string;
  riskLabel?: string;
  previewLabel?: string;
  preview?: string;
  previewLanguage?: string;
  warning?: string;
  reason?: string;
  details: ToolApprovalDialogDetail[];
  sessionAction?: ToolApprovalDialogAction;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return normalized.startsWith("/") ? "/" : "";
  return `${normalized.startsWith("/") ? "/" : ""}${parts.slice(0, -1).join("/")}`;
}

function shortPath(path: string, maxLength = 42): string {
  if (path.length <= maxLength) return path;
  const fileName = basename(path);
  const prefixLength = Math.max(10, maxLength - fileName.length - 4);
  return `${path.slice(0, prefixLength)}…/${fileName}`;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function trimPreview(text: string, maxChars = 800): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n…`;
}

function getShellBase(command: string): string {
  const normalized = normalizeWhitespace(command);
  if (!normalized) return "";
  const token = normalized.split(" ")[0] ?? "";
  const cleaned = token.replace(/^["'`]+|["'`]+$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? cleaned).toLowerCase();
}

function inferPreviewLanguage(toolName: string, targetPath?: string): string | undefined {
  if (toolName.includes("shell")) return "bash";
  const ext = targetPath?.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
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
    case "css":
      return "css";
    case "html":
      return "html";
    default:
      return undefined;
  }
}

function formatRiskLabel(risk?: ToolApprovalRisk): string | undefined {
  switch (risk) {
    case "high":
      return "高风险";
    case "medium":
      return "需确认";
    case "unknown":
      return "待确认";
    case "low":
      return "低风险";
    default:
      return undefined;
  }
}

function dedupeReason(reason?: string, warning?: string): string | undefined {
  const normalizedReason = normalizeWhitespace(reason ?? "");
  const normalizedWarning = normalizeWhitespace(warning ?? "");
  if (!normalizedReason) return undefined;
  if (normalizedWarning && normalizedReason === normalizedWarning) return undefined;
  return normalizedReason;
}

export function buildToolApprovalDialogModel(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
  risk?: ToolApprovalRisk;
  reason?: string;
  reviewedByModel?: boolean;
}): ToolApprovalDialogModel {
  const {
    toolName,
    toolParams,
    risk,
    reason,
    reviewedByModel = false,
  } = params;

  const subtitle = reviewedByModel
    ? "已自动审核，仍需要你确认。"
    : "继续前需要你的确认。";
  const riskLabel = formatRiskLabel(risk);

  if (
    toolName === "run_shell_command"
    || toolName === "persistent_shell"
    || toolName === "run_shell_command_host_fallback"
  ) {
    const command = normalizeWhitespace(toDisplayString(toolParams.command ?? toolParams.cmd));
    const cwd = toDisplayString(toolParams.cwd ?? toolParams.workdir);
    const commandBase = getShellBase(command);
    const warning = detectSuspiciousShellCommand(command) ?? undefined;

    return {
      title: toolName === "run_shell_command_host_fallback" ? "允许在宿主环境执行命令？" : "允许执行命令？",
      subtitle,
      toolTag: toolName === "persistent_shell" ? "Shell 会话" : "Shell 命令",
      riskLabel,
      previewLabel: "命令",
      preview: command || "（未提供命令）",
      previewLanguage: "bash",
      warning,
      reason: dedupeReason(reason, warning),
      details: [
        ...(cwd ? [{ label: "工作目录", value: cwd, mono: true }] : []),
      ],
      sessionAction: cwd && commandBase
        ? {
            label: "本会话允许类似命令",
            description: `在 ${shortPath(cwd)} 中执行 ${commandBase} 类命令时不再询问`,
            scope: "shell_command_in_cwd",
          }
        : cwd
          ? {
              label: "本会话允许此目录",
              description: `当前会话内在 ${shortPath(cwd)} 执行命令时不再询问`,
              scope: "cwd",
            }
          : commandBase
            ? {
                label: `本会话允许 ${commandBase}`,
                description: `当前会话内 ${commandBase} 类命令不再询问`,
                scope: "command",
              }
            : undefined,
    };
  }

  if (
    toolName === "write_file"
    || toolName === "str_replace_edit"
    || toolName === "json_edit"
    || toolName === "export_document"
    || toolName === "write_file_host_fallback"
  ) {
    const path = toDisplayString(toolParams.path ?? toolParams.filePath);
    const content = toDisplayString(toolParams.content);
    const dir = path ? dirname(path) : "";
    const fileName = path ? basename(path) : "";

    return {
      title: toolName === "write_file_host_fallback" ? "允许在宿主环境写入文件？" : "允许修改文件？",
      subtitle,
      toolTag: "文件修改",
      riskLabel,
      previewLabel: "内容预览",
      preview: content ? trimPreview(content) : undefined,
      previewLanguage: inferPreviewLanguage(toolName, path),
      reason,
      details: [
        ...(fileName ? [{ label: "文件", value: fileName }] : []),
        ...(dir ? [{ label: "目录", value: dir, mono: true }] : []),
        ...(content ? [{ label: "内容规模", value: `${countLines(content)} 行 · ${content.length} 字符` }] : []),
      ],
      sessionAction: dir
        ? {
            label: "本会话允许此目录",
            description: `当前会话内对 ${shortPath(dir)} 的修改不再询问`,
            scope: "dir",
          }
        : undefined,
    };
  }

  if (toolName === "delete_file") {
    const path = toDisplayString(toolParams.path ?? toolParams.filePath);
    const dir = path ? dirname(path) : "";
    const fileName = path ? basename(path) : "";
    return {
      title: "允许删除文件？",
      subtitle,
      toolTag: "文件删除",
      riskLabel,
      reason,
      details: [
        ...(fileName ? [{ label: "文件", value: fileName }] : []),
        ...(dir ? [{ label: "目录", value: dir, mono: true }] : []),
      ],
    };
  }

  if (toolName === "abort_child_session") {
    const actor = toDisplayString(toolParams.actor);
    const childSession = toDisplayString(toolParams.childSession ?? toolParams.runId);
    return {
      title: "终止子会话？",
      subtitle: "这会立即中断该子会话及其后续协作。",
      toolTag: "会话控制",
      riskLabel,
      reason,
      details: [
        ...(childSession ? [{ label: "子会话", value: childSession }] : []),
        ...(actor ? [{ label: "Agent", value: actor }] : []),
      ],
    };
  }

  return {
    title: "允许继续执行该操作？",
    subtitle,
    toolTag: toolName,
    riskLabel,
    reason,
    details: Object.entries(toolParams)
      .filter(([, value]) => value !== undefined && value !== null)
      .slice(0, 4)
      .map(([label, value]) => ({
        label,
        value: toDisplayString(value).slice(0, 240),
        mono: typeof value === "string" && /[/{\\]/.test(value),
      })),
    sessionAction: {
      label: "本会话允许此工具",
      description: "当前会话内同类操作不再询问",
      scope: "tool",
    },
  };
}
