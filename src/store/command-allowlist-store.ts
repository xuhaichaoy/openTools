import { create } from "zustand";
import {
  assessToolApproval,
  buildToolApprovalCacheKey,
  type ToolApprovalAssessment,
  type ToolApprovalTrustMode,
} from "@/core/agent/actor/tool-approval-policy";
import type {
  AccessMode,
  ApprovalLevel,
  ApprovalMode,
  ExecutionPolicy,
} from "@/core/agent/actor/types";

const PERSIST_KEY = "mtools-tool-trust-level";

export type TrustLevel = "always_ask" | "auto_approve_file" | "auto_approve";

export const TRUST_LEVEL_OPTIONS: {
  value: TrustLevel;
  label: string;
  description: string;
}[] = [
  {
    value: "always_ask",
    label: "严格确认",
    description: "自动放行只读操作；工程修改与执行命令默认更谨慎，需要更频繁人工确认",
  },
  {
    value: "auto_approve_file",
    label: "自动审核",
    description: "先做风险审查，常规代码修改和只读命令自动通过，高风险或不确定操作才确认",
  },
  {
    value: "auto_approve",
    label: "全部放行",
    description: "跳过自动审核和人工确认，所有操作直接执行",
  },
];

function loadTrustLevel(): TrustLevel {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw && ["always_ask", "auto_approve_file", "auto_approve"].includes(raw)) {
      return raw as TrustLevel;
    }
  } catch { /* ignore */ }
  return "auto_approve_file";
}

function mapTrustLevelToMode(level: TrustLevel): ToolApprovalTrustMode {
  switch (level) {
    case "auto_approve":
      return "full_auto";
    case "always_ask":
      return "strict_manual";
    default:
      return "auto_review";
  }
}

const DECISION_CACHE_TTL_MS = 10_000;
const sessionDecisionCache = new Map<string, { confirmed: boolean; expiresAt: number }>();
const sessionScopedDecisionCache = new Map<string, boolean>();

export type SessionDecisionScope =
  | "shell_command_in_cwd"
  | "cwd"
  | "command"
  | "path"
  | "dir"
  | "tool";

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

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) return normalized.startsWith("/") ? "/" : "";
  return `${normalized.startsWith("/") ? "/" : ""}${segments.slice(0, -1).join("/")}`;
}

function getShellCommandBase(params: Record<string, unknown>): string {
  const command = normalizeWhitespace(toDisplayString(params.command ?? params.cmd));
  if (!command) return "";
  const firstToken = command.split(" ")[0] ?? "";
  const normalizedToken = firstToken.replace(/^["'`]+|["'`]+$/g, "");
  const parts = normalizedToken.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? normalizedToken).toLowerCase();
}

function buildScopedDecisionKey(
  toolName: string,
  params: Record<string, unknown>,
  scope: SessionDecisionScope,
): string | null {
  if (scope === "tool") {
    return `${toolName}::scope::tool`;
  }

  if (toolName === "run_shell_command" || toolName === "persistent_shell") {
    const cwd = normalizePath(toDisplayString(params.cwd ?? params.workdir));
    const commandBase = getShellCommandBase(params);
    if (scope === "shell_command_in_cwd") {
      if (!cwd || !commandBase) return null;
      return `${toolName}::scope::cwd_cmd::${cwd}::${commandBase}`;
    }
    if (scope === "cwd") {
      return cwd ? `${toolName}::scope::cwd::${cwd}` : null;
    }
    if (scope === "command") {
      return commandBase ? `${toolName}::scope::command::${commandBase}` : null;
    }
    return null;
  }

  const path = normalizePath(toDisplayString(params.path ?? params.filePath));
  if (scope === "path") {
    return path ? `${toolName}::scope::path::${path}` : null;
  }
  if (scope === "dir") {
    const dir = path ? dirname(path) : "";
    return dir ? `${toolName}::scope::dir::${dir}` : null;
  }

  return null;
}

function buildScopedLookupKeys(toolName: string, params: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (toolName === "run_shell_command" || toolName === "persistent_shell") {
    const combined = buildScopedDecisionKey(toolName, params, "shell_command_in_cwd");
    const cwd = buildScopedDecisionKey(toolName, params, "cwd");
    const command = buildScopedDecisionKey(toolName, params, "command");
    if (combined) keys.push(combined);
    if (cwd) keys.push(cwd);
    if (command) keys.push(command);
  } else {
    const path = buildScopedDecisionKey(toolName, params, "path");
    const dir = buildScopedDecisionKey(toolName, params, "dir");
    if (path) keys.push(path);
    if (dir) keys.push(dir);
  }
  const tool = buildScopedDecisionKey(toolName, params, "tool");
  if (tool) keys.push(tool);
  return keys;
}

export interface ToolTrustAssessmentOptions {
  executionPolicy?: ExecutionPolicy;
  approvalMode?: ApprovalMode;
  approvalLevel?: ApprovalLevel;
  accessMode?: AccessMode;
  workspace?: string;
}

interface ToolTrustState {
  trustLevel: TrustLevel;
  setTrustLevel: (level: TrustLevel) => void;
  assess: (
    toolName: string,
    params?: Record<string, unknown>,
    options?: ToolTrustAssessmentOptions,
  ) => ToolApprovalAssessment;
  /** 给定工具名，是否需要弹出确认对话框 */
  shouldConfirm: (
    toolName: string,
    params?: Record<string, unknown>,
    options?: ToolTrustAssessmentOptions,
  ) => boolean;
  getCachedDecision: (toolName: string, params?: Record<string, unknown>) => boolean | null;
  rememberDecision: (toolName: string, params: Record<string, unknown> | undefined, confirmed: boolean) => void;
  rememberSessionDecision: (
    toolName: string,
    params: Record<string, unknown> | undefined,
    scope: SessionDecisionScope,
    confirmed?: boolean,
  ) => void;
  clearDecisionCache: () => void;
}

export const useToolTrustStore = create<ToolTrustState>((set, get) => ({
  trustLevel: loadTrustLevel(),

  setTrustLevel: (level) => {
    localStorage.setItem(PERSIST_KEY, level);
    sessionDecisionCache.clear();
    sessionScopedDecisionCache.clear();
    set({ trustLevel: level });
  },

  assess: (toolName, params = {}, options) => {
    const { trustLevel } = get();
    return assessToolApproval(toolName, params, {
      trustMode: mapTrustLevelToMode(trustLevel),
      ...options,
    });
  },

  shouldConfirm: (toolName, params = {}, options) => get().assess(toolName, params, options).decision === "ask",

  getCachedDecision: (toolName, params = {}) => {
    const key = buildToolApprovalCacheKey(toolName, params);
    const cached = sessionDecisionCache.get(key);
    if (cached) {
      if (cached.expiresAt <= Date.now()) {
        sessionDecisionCache.delete(key);
      } else {
        return cached.confirmed;
      }
    }

    for (const scopedKey of buildScopedLookupKeys(toolName, params)) {
      const scopedDecision = sessionScopedDecisionCache.get(scopedKey);
      if (typeof scopedDecision === "boolean") {
        return scopedDecision;
      }
    }
    return null;
  },

  rememberDecision: (toolName, params = {}, confirmed) => {
    sessionDecisionCache.set(buildToolApprovalCacheKey(toolName, params), {
      confirmed,
      expiresAt: Date.now() + DECISION_CACHE_TTL_MS,
    });
  },

  rememberSessionDecision: (toolName, params = {}, scope, confirmed = true) => {
    const key = buildScopedDecisionKey(toolName, params, scope);
    if (!key) return;
    sessionScopedDecisionCache.set(key, confirmed);
  },

  clearDecisionCache: () => {
    sessionDecisionCache.clear();
    sessionScopedDecisionCache.clear();
  },
}));

/** @deprecated 兼容旧代码，迁移完毕后可删除 */
export const useCommandAllowlistStore = useToolTrustStore;
