import type {
  AccessMode,
  ApprovalLevel,
  ApprovalMode,
  ExecutionPolicy,
  ToolPolicy,
} from "./types";

export type ToolApprovalTrustMode = "strict_manual" | "auto_review" | "full_auto";
export type ToolApprovalDecision = "allow" | "ask" | "deny";
export type ToolApprovalRisk = "safe" | "low" | "medium" | "high" | "unknown";
export type ToolApprovalLayer = "policy" | "auto_review" | "human";

export interface ToolApprovalAssessment {
  decision: ToolApprovalDecision;
  risk: ToolApprovalRisk;
  layer: ToolApprovalLayer;
  reason: string;
}

export interface AssessToolApprovalOptions {
  trustMode?: ToolApprovalTrustMode;
  approvalLevel?: ApprovalLevel;
  approvalMode?: ApprovalMode;
  accessMode?: AccessMode;
  executionPolicy?: ExecutionPolicy;
  workspace?: string;
}

export interface NormalizedExecutionPolicy {
  accessMode: AccessMode;
  approvalMode: ApprovalMode;
}

export const DEFAULT_ACCESS_MODE: AccessMode = "auto";
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "normal";

const ACCESS_MODE_PRIORITY: AccessMode[] = ["read_only", "auto", "full_access"];
const APPROVAL_MODE_PRIORITY: ApprovalMode[] = ["strict", "normal", "permissive", "off"];

const READ_ONLY_ACCESS_POLICY: ToolPolicy = {
  deny: [
    "write_file",
    "str_replace_edit",
    "json_edit",
    "delete_file",
    "run_shell_command",
    "persistent_shell",
    "native_*",
    "database_execute",
    "ssh_*",
  ],
};

const SAFE_TOOLS = new Set([
  "read_file",
  "read_file_range",
  "list_directory",
  "search_in_files",
  "web_search",
  "web_fetch",
  "get_system_info",
  "get_current_time",
  "calculate",
  "sequential_thinking",
  "run_lint",
  "ask_user",
  "ask_clarification",
  "spawn_task",
  "task_done",
]);

const HIGH_RISK_TOOLS = new Set([
  "delete_file",
  "database_execute",
]);

const SHELL_TOOL_NAMES = new Set([
  "run_shell_command",
  "persistent_shell",
]);

const SAFE_SHELL_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "rg",
  "grep",
  "cat",
  "head",
  "tail",
  "sort",
  "uniq",
  "cut",
  "tr",
  "wc",
  "sed",
  "which",
  "whereis",
  "echo",
  "stat",
  "du",
  "basename",
  "dirname",
  "file",
  "realpath",
]);

const VALIDATION_SHELL_COMMANDS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "node",
  "python",
  "python3",
  "pytest",
  "mvn",
  "gradle",
  "gradlew",
  "java",
  "javac",
  "cargo",
  "go",
  "gofmt",
  "rustfmt",
  "tsc",
  "eslint",
  "vitest",
  "jest",
]);

const HIGH_RISK_SHELL_BASES = new Set([
  "rm",
  "sudo",
  "chmod",
  "chown",
  "kill",
  "pkill",
  "killall",
  "shutdown",
  "reboot",
  "launchctl",
  "systemctl",
  "service",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "docker",
  "kubectl",
  "helm",
  "terraform",
  "ansible",
  "psql",
  "mysql",
  "mongo",
  "redis-cli",
  "dd",
  "mkfs",
  "mount",
  "umount",
  "diskutil",
  "brew",
]);

const WRITE_SHELL_BASES = new Set([
  "mkdir",
  "touch",
  "cp",
  "mv",
  "tee",
  "patch",
  "git",
]);

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
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

function isPathWithinWorkspace(path: string, workspace?: string): boolean {
  if (!path || !workspace) return false;
  const normalizedPath = normalizePath(path).toLowerCase();
  const normalizedWorkspace = normalizePath(workspace).toLowerCase();
  return normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}/`);
}

function isSensitivePath(path: string, workspace?: string): boolean {
  if (!path) return true;
  const normalizedPath = normalizePath(path);
  const normalized = normalizedPath.toLowerCase();
  if (/\/(\.ssh|\.gnupg|\.aws|\.config|library|application support)\//i.test(normalized)) return true;
  if (/\/\.git\//i.test(normalized)) return true;
  if (/\/etc\//i.test(normalized)) return true;
  if (/(^|\/)\.env(\.|$)/i.test(normalized)) return true;
  if (/(^|\/)\.(npmrc|yarnrc|bashrc|zshrc|profile|gitconfig)$/i.test(normalized)) return true;
  if (/(^|\/)(id_rsa|id_ed25519|known_hosts|credentials?|secrets?)(\.|$)/i.test(normalized)) return true;
  if (normalized.startsWith("/users/") || normalized.startsWith("/home/")) {
    return !isPathWithinWorkspace(normalizedPath, workspace);
  }
  return false;
}

function assessPathMutation(path: string, workspace?: string): { risk: ToolApprovalRisk; reason: string } {
  const normalized = normalizePath(path);
  if (!normalized) {
    return { risk: "unknown", reason: "缺少目标路径，自动审核无法判断影响范围" };
  }
  if (isSensitivePath(normalized, workspace)) {
    return { risk: "high", reason: "目标路径位于敏感位置或工作区之外，需要人工确认" };
  }
  if (isPathWithinWorkspace(normalized, workspace)) {
    return { risk: "low", reason: "目标路径位于当前工作区内，自动审核判定为常规工程修改" };
  }
  if (normalized.startsWith("/")) {
    return { risk: "medium", reason: "目标路径为绝对路径，自动审核建议谨慎确认" };
  }
  return { risk: "low", reason: "目标路径为相对工程文件，自动审核判定为常规修改" };
}

function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/g)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);
}

function getShellBase(segment: string): string {
  const parts = segment.split(" ").filter(Boolean);
  if (parts[0] === "cd") return "cd";
  return parts[0] ?? "";
}

function assessGitCommand(parts: string[]): { risk: ToolApprovalRisk; reason: string } {
  const subcommand = parts[1] ?? "";
  if (["status", "diff", "show", "log", "branch"].includes(subcommand)) {
    return { risk: "low", reason: "Git 只读查询命令由自动审核直接放行" };
  }
  if (["reset", "checkout", "clean", "stash"].includes(subcommand)) {
    return { risk: "high", reason: "Git 命令可能回滚或清理工作区，需要人工确认" };
  }
  if (["apply", "commit", "merge", "rebase", "cherry-pick"].includes(subcommand)) {
    return { risk: "high", reason: "Git 命令会直接修改代码历史或工作区，需要人工确认" };
  }
  return { risk: "medium", reason: "Git 命令影响范围不明确，自动审核建议谨慎确认" };
}

function assessPackageManagerCommand(parts: string[]): { risk: ToolApprovalRisk; reason: string } {
  const subcommand = parts[1] ?? "";
  if (["test", "lint", "typecheck", "check", "build"].includes(subcommand)) {
    return { risk: "medium", reason: "验证或构建命令默认允许自动审核处理" };
  }
  if (["install", "add", "remove", "uninstall", "update", "upgrade", "publish"].includes(subcommand)) {
    return { risk: "high", reason: "包管理命令会修改依赖或发布产物，需要人工确认" };
  }
  return { risk: "medium", reason: "命令可能执行项目脚本，自动审核建议谨慎确认" };
}

function assessShellCommand(command: string): { risk: ToolApprovalRisk; reason: string } {
  const normalized = normalizeWhitespace(command);
  if (!normalized) {
    return { risk: "unknown", reason: "命令为空，自动审核无法判断风险" };
  }

  const lowered = normalized.toLowerCase();
  if (/curl.+\|\s*(sh|bash)|wget.+\|\s*(sh|bash)/i.test(lowered)) {
    return { risk: "high", reason: "检测到远程脚本直连执行，这是高风险命令" };
  }
  if (/(^|[^\w])(sudo|rm\s+-rf|git\s+reset\s+--hard|git\s+checkout\s+--|git\s+clean\s+-fd)/i.test(lowered)) {
    return { risk: "high", reason: "命令包含破坏性操作，需要人工确认" };
  }
  if (/(^|[^\w])(>|>>|tee\b|sed\s+-i|perl\s+-i|python\s+-c|node\s+-e)/i.test(lowered)) {
    return { risk: "high", reason: "命令包含直接写盘或脚本执行行为，需要人工确认" };
  }

  const segments = splitShellSegments(normalized);
  if (segments.length === 0) {
    return { risk: "unknown", reason: "命令结构无法解析，自动审核无法判断" };
  }

  let maxRisk: ToolApprovalRisk = "low";
  let reason = "命令以只读检索为主，自动审核可直接放行";

  for (const segment of segments) {
    const parts = segment.split(" ").filter(Boolean);
    const base = getShellBase(segment).toLowerCase();
    if (!base || base === "cd") continue;

    if (HIGH_RISK_SHELL_BASES.has(base)) {
      return { risk: "high", reason: `检测到 ${base} 命令，属于高风险系统操作` };
    }
    if (base === "git") {
      const gitRisk = assessGitCommand(parts);
      if (gitRisk.risk === "high") return gitRisk;
      if (gitRisk.risk === "medium") {
        maxRisk = "medium";
        reason = gitRisk.reason;
      }
      continue;
    }
    if (VALIDATION_SHELL_COMMANDS.has(base)) {
      const validationRisk = assessPackageManagerCommand(parts);
      if (validationRisk.risk === "high") return validationRisk;
      if (validationRisk.risk === "medium") {
        maxRisk = "medium";
        reason = validationRisk.reason;
      }
      continue;
    }
    if (WRITE_SHELL_BASES.has(base)) {
      maxRisk = "medium";
      reason = `${base} 命令会修改文件或工作区，自动审核建议谨慎确认`;
      continue;
    }
    if (!SAFE_SHELL_COMMANDS.has(base)) {
      return { risk: "unknown", reason: `自动审核无法确认 ${base} 是否安全，需要人工确认` };
    }
  }

  return { risk: maxRisk, reason };
}

function riskRank(risk: ToolApprovalRisk): number {
  switch (risk) {
    case "safe":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    default:
      return 4;
  }
}

function accessModeRank(mode: AccessMode): number {
  const index = ACCESS_MODE_PRIORITY.indexOf(mode);
  return index >= 0 ? index : ACCESS_MODE_PRIORITY.indexOf(DEFAULT_ACCESS_MODE);
}

function approvalModeRank(mode: ApprovalMode): number {
  const index = APPROVAL_MODE_PRIORITY.indexOf(mode);
  return index >= 0 ? index : APPROVAL_MODE_PRIORITY.indexOf(DEFAULT_APPROVAL_MODE);
}

export function clampAccessMode(
  ...modes: Array<AccessMode | undefined>
): AccessMode {
  const normalized = modes.filter((mode): mode is AccessMode => Boolean(mode));
  if (normalized.length === 0) return DEFAULT_ACCESS_MODE;
  return normalized.reduce((mostRestrictive, current) => (
    accessModeRank(current) < accessModeRank(mostRestrictive) ? current : mostRestrictive
  ));
}

export function clampApprovalMode(
  ...modes: Array<ApprovalMode | undefined>
): ApprovalMode {
  const normalized = modes.filter((mode): mode is ApprovalMode => Boolean(mode));
  if (normalized.length === 0) return DEFAULT_APPROVAL_MODE;
  return normalized.reduce((mostRestrictive, current) => (
    approvalModeRank(current) < approvalModeRank(mostRestrictive) ? current : mostRestrictive
  ));
}

export function normalizeExecutionPolicy(
  policy?: ExecutionPolicy | null,
  legacy?: { approvalLevel?: ApprovalLevel | null; accessMode?: AccessMode | null },
): NormalizedExecutionPolicy {
  return {
    accessMode: policy?.accessMode ?? legacy?.accessMode ?? DEFAULT_ACCESS_MODE,
    approvalMode: policy?.approvalMode ?? legacy?.approvalLevel ?? DEFAULT_APPROVAL_MODE,
  };
}

export function resolveExecutionPolicyInheritance(params: {
  parentPolicy?: ExecutionPolicy | null;
  boundaryPolicy?: ExecutionPolicy | null;
  overridePolicy?: ExecutionPolicy | null;
  parentApprovalLevel?: ApprovalLevel | null;
  overrideApprovalLevel?: ApprovalLevel | null;
}): NormalizedExecutionPolicy {
  const parent = normalizeExecutionPolicy(params.parentPolicy, {
    approvalLevel: params.parentApprovalLevel,
  });
  return {
    accessMode: clampAccessMode(
      parent.accessMode,
      params.boundaryPolicy?.accessMode,
      params.overridePolicy?.accessMode,
    ),
    approvalMode: clampApprovalMode(
      parent.approvalMode,
      params.boundaryPolicy?.approvalMode,
      params.overridePolicy?.approvalMode ?? params.overrideApprovalLevel ?? undefined,
    ),
  };
}

export function deriveToolPolicyForAccessMode(
  accessMode?: AccessMode,
): ToolPolicy | undefined {
  switch (accessMode ?? DEFAULT_ACCESS_MODE) {
    case "read_only":
      return {
        deny: [...(READ_ONLY_ACCESS_POLICY.deny ?? [])],
      };
    default:
      return undefined;
  }
}

function isToolDeniedByReadOnlyAccess(
  toolName: string,
): string | null {
  if (
    toolName === "write_file"
    || toolName === "str_replace_edit"
    || toolName === "json_edit"
    || toolName === "delete_file"
    || SHELL_TOOL_NAMES.has(toolName)
    || toolName === "database_execute"
    || toolName.startsWith("native_")
    || toolName.startsWith("ssh_")
  ) {
    return `当前 access mode=${"read_only"}，禁止执行修改文件、Shell 或系统级操作`;
  }
  return null;
}

function trustThreshold(mode: ToolApprovalTrustMode): number {
  switch (mode) {
    case "full_auto":
      return Number.POSITIVE_INFINITY;
    case "strict_manual":
      return 2;
    default:
      return 3;
  }
}

function approvalThreshold(level: ApprovalLevel): number {
  switch (level) {
    case "off":
      return Number.POSITIVE_INFINITY;
    case "strict":
      return 2;
    case "normal":
      return 3;
    default:
      return 3;
  }
}

function assessByToolName(
  toolName: string,
  params: Record<string, unknown>,
  workspace?: string,
): { risk: ToolApprovalRisk; reason: string } {
  if (SAFE_TOOLS.has(toolName)) {
    return { risk: "safe", reason: "该工具属于只读或协作控制操作，可直接执行" };
  }
  if (HIGH_RISK_TOOLS.has(toolName)) {
    return { risk: "high", reason: "该工具属于高风险变更类操作，需要人工确认" };
  }
  if (SHELL_TOOL_NAMES.has(toolName)) {
    return assessShellCommand(toDisplayString(params.command ?? params.cmd));
  }
  if (toolName === "write_file" || toolName === "str_replace_edit" || toolName === "json_edit") {
    return assessPathMutation(toDisplayString(params.path ?? params.filePath), workspace);
  }
  if (toolName === "open_path") {
    return { risk: "low", reason: "打开文件或目录属于低风险本地操作" };
  }
  if (toolName.startsWith("native_") || toolName.startsWith("ssh_")) {
    return { risk: "high", reason: "原生系统或远程操作默认需要人工确认" };
  }
  if (toolName.includes("read") || toolName.includes("search") || toolName.includes("list")) {
    return { risk: "safe", reason: "工具名称表明这是只读检索操作，可直接执行" };
  }
  if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("delete")) {
    return { risk: "medium", reason: "工具会修改本地状态，自动审核建议谨慎确认" };
  }
  return { risk: "unknown", reason: "自动审核无法识别该工具的影响范围" };
}

export function assessToolApproval(
  toolName: string,
  params: Record<string, unknown>,
  options: AssessToolApprovalOptions = {},
): ToolApprovalAssessment {
  const executionPolicy = normalizeExecutionPolicy(options.executionPolicy, {
    approvalLevel: options.approvalMode ?? options.approvalLevel,
    accessMode: options.accessMode,
  });
  const trustMode = options.trustMode ?? "auto_review";
  const approvalLevel = executionPolicy.approvalMode;

  const accessDeniedReason = executionPolicy.accessMode === "read_only"
    ? isToolDeniedByReadOnlyAccess(toolName)
    : null;
  if (accessDeniedReason) {
    return {
      decision: "deny",
      risk: "high",
      layer: "policy",
      reason: accessDeniedReason,
    };
  }

  if (trustMode === "full_auto" || approvalLevel === "off") {
    return {
      decision: "allow",
      risk: "safe",
      layer: "policy",
      reason: "当前策略允许直接执行，无需额外审批",
    };
  }

  const assessment = assessByToolName(toolName, params, options.workspace);
  const effectiveThreshold = Math.min(trustThreshold(trustMode), approvalThreshold(approvalLevel));

  if (assessment.risk === "safe") {
    return {
      decision: "allow",
      risk: assessment.risk,
      layer: "policy",
      reason: assessment.reason,
    };
  }

  if (riskRank(assessment.risk) >= effectiveThreshold) {
    return {
      decision: "ask",
      risk: assessment.risk,
      layer: "human",
      reason: assessment.reason,
    };
  }

  return {
    decision: "allow",
    risk: assessment.risk,
    layer: "auto_review",
    reason: assessment.reason,
  };
}

export function buildToolApprovalCacheKey(
  toolName: string,
  params: Record<string, unknown>,
): string {
  if (SHELL_TOOL_NAMES.has(toolName)) {
    const command = normalizeWhitespace(toDisplayString(params.command ?? params.cmd));
    const cwd = normalizePath(toDisplayString(params.cwd ?? params.workdir));
    return `${toolName}::${cwd}::${command}`;
  }
  const path = normalizePath(toDisplayString(params.path ?? params.filePath));
  if (path) {
    return `${toolName}::${path}`;
  }
  return `${toolName}::${JSON.stringify(params)}`;
}
