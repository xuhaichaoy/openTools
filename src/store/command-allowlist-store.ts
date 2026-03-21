import { create } from "zustand";
import {
  assessToolApproval,
  buildToolApprovalCacheKey,
  type ToolApprovalAssessment,
  type ToolApprovalTrustMode,
} from "@/core/agent/actor/tool-approval-policy";
import type { ApprovalLevel } from "@/core/agent/actor/types";

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

interface ToolTrustState {
  trustLevel: TrustLevel;
  setTrustLevel: (level: TrustLevel) => void;
  assess: (
    toolName: string,
    params?: Record<string, unknown>,
    options?: { approvalLevel?: ApprovalLevel; workspace?: string },
  ) => ToolApprovalAssessment;
  /** 给定工具名，是否需要弹出确认对话框 */
  shouldConfirm: (
    toolName: string,
    params?: Record<string, unknown>,
    options?: { approvalLevel?: ApprovalLevel; workspace?: string },
  ) => boolean;
  getCachedDecision: (toolName: string, params?: Record<string, unknown>) => boolean | null;
  rememberDecision: (toolName: string, params: Record<string, unknown> | undefined, confirmed: boolean) => void;
  clearDecisionCache: () => void;
}

export const useToolTrustStore = create<ToolTrustState>((set, get) => ({
  trustLevel: loadTrustLevel(),

  setTrustLevel: (level) => {
    localStorage.setItem(PERSIST_KEY, level);
    sessionDecisionCache.clear();
    set({ trustLevel: level });
  },

  assess: (toolName, params = {}, options) => {
    const { trustLevel } = get();
    return assessToolApproval(toolName, params, {
      trustMode: mapTrustLevelToMode(trustLevel),
      approvalLevel: options?.approvalLevel,
      workspace: options?.workspace,
    });
  },

  shouldConfirm: (toolName, params = {}, options) => get().assess(toolName, params, options).decision === "ask",

  getCachedDecision: (toolName, params = {}) => {
    const key = buildToolApprovalCacheKey(toolName, params);
    const cached = sessionDecisionCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      sessionDecisionCache.delete(key);
      return null;
    }
    return cached.confirmed;
  },

  rememberDecision: (toolName, params = {}, confirmed) => {
    sessionDecisionCache.set(buildToolApprovalCacheKey(toolName, params), {
      confirmed,
      expiresAt: Date.now() + DECISION_CACHE_TTL_MS,
    });
  },

  clearDecisionCache: () => {
    sessionDecisionCache.clear();
  },
}));

/** @deprecated 兼容旧代码，迁移完毕后可删除 */
export const useCommandAllowlistStore = useToolTrustStore;
