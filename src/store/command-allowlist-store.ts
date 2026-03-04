import { create } from "zustand";

const PERSIST_KEY = "mtools-tool-trust-level";

export type TrustLevel = "always_ask" | "auto_approve_file" | "auto_approve";

export const TRUST_LEVEL_OPTIONS: {
  value: TrustLevel;
  label: string;
  description: string;
}[] = [
  {
    value: "always_ask",
    label: "全部确认",
    description: "所有危险操作（Shell 命令、文件写入等）均需手动确认",
  },
  {
    value: "auto_approve_file",
    label: "仅 Shell 需确认",
    description: "文件读写操作自动放行，仅执行 Shell 命令时弹出确认",
  },
  {
    value: "auto_approve",
    label: "全部放行",
    description: "所有操作自动执行，不再弹出确认对话框（请确保你信任 AI 的行为）",
  },
];

const SHELL_TOOL_PATTERNS = [
  "shell",
  "run_shell",
  "persistent_shell",
  "command",
];

function isShellTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return SHELL_TOOL_PATTERNS.some((p) => name.includes(p));
}

function loadTrustLevel(): TrustLevel {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw && ["always_ask", "auto_approve_file", "auto_approve"].includes(raw)) {
      return raw as TrustLevel;
    }
  } catch { /* ignore */ }
  return "always_ask";
}

interface ToolTrustState {
  trustLevel: TrustLevel;
  setTrustLevel: (level: TrustLevel) => void;
  /** 给定工具名，是否需要弹出确认对话框 */
  shouldConfirm: (toolName: string) => boolean;
}

export const useToolTrustStore = create<ToolTrustState>((set, get) => ({
  trustLevel: loadTrustLevel(),

  setTrustLevel: (level) => {
    localStorage.setItem(PERSIST_KEY, level);
    set({ trustLevel: level });
  },

  shouldConfirm: (toolName) => {
    const { trustLevel } = get();
    if (trustLevel === "auto_approve") return false;
    if (trustLevel === "auto_approve_file") return isShellTool(toolName);
    return true;
  },
}));

/** @deprecated 兼容旧代码，迁移完毕后可删除 */
export const useCommandAllowlistStore = useToolTrustStore;
