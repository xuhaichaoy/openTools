import { create } from "zustand";

const PERSIST_KEY = "mtools-command-allowlist";

/** 从 toolName + params 提取用于匹配的"命令关键字" */
export function extractCommandKey(
  toolName: string,
  params: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  // Shell 命令：提取第一个 token（如 cat, ls, grep …）
  if (name.includes("shell") || name.includes("run_shell") || name.includes("command")) {
    const cmd = String(params.command || params.cmd || "").trim();
    const firstToken = cmd.split(/\s+/)[0]?.replace(/^.*\//, ""); // 去掉路径前缀
    if (firstToken) return `shell:${firstToken}`;
    return `tool:${toolName}`;
  }

  // 其他工具直接用 toolName
  return `tool:${toolName}`;
}

interface CommandAllowlistState {
  /** 本次会话允许的命令 key 集合（关闭应用后清空） */
  sessionAllowed: Set<string>;
  /** 永久允许的命令 key 集合（持久化到 localStorage） */
  persistAllowed: Set<string>;

  /** 检查某个命令是否已被放行 */
  isAllowed: (key: string) => boolean;
  /** 本次会话允许 */
  allowSession: (key: string) => void;
  /** 永久允许 */
  allowPersist: (key: string) => void;
  /** 撤销某个命令的放行（同时移除 session 和 persist） */
  revoke: (key: string) => void;
  /** 获取所有已放行的命令列表（用于设置页面展示） */
  getAllAllowed: () => { key: string; level: "session" | "persist" }[];
}

function loadPersisted(): Set<string> {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function savePersisted(set: Set<string>) {
  localStorage.setItem(PERSIST_KEY, JSON.stringify([...set]));
}

export const useCommandAllowlistStore = create<CommandAllowlistState>(
  (set, get) => ({
    sessionAllowed: new Set(),
    persistAllowed: loadPersisted(),

    isAllowed: (key) => {
      const { sessionAllowed, persistAllowed } = get();
      return sessionAllowed.has(key) || persistAllowed.has(key);
    },

    allowSession: (key) =>
      set((s) => {
        const next = new Set(s.sessionAllowed);
        next.add(key);
        return { sessionAllowed: next };
      }),

    allowPersist: (key) =>
      set((s) => {
        const next = new Set(s.persistAllowed);
        next.add(key);
        savePersisted(next);
        // 同时从 session 中移除（已升级为永久）
        const sess = new Set(s.sessionAllowed);
        sess.delete(key);
        return { persistAllowed: next, sessionAllowed: sess };
      }),

    revoke: (key) =>
      set((s) => {
        const sess = new Set(s.sessionAllowed);
        const pers = new Set(s.persistAllowed);
        sess.delete(key);
        pers.delete(key);
        savePersisted(pers);
        return { sessionAllowed: sess, persistAllowed: pers };
      }),

    getAllAllowed: () => {
      const { sessionAllowed, persistAllowed } = get();
      const result: { key: string; level: "session" | "persist" }[] = [];
      for (const k of persistAllowed) result.push({ key: k, level: "persist" });
      for (const k of sessionAllowed) {
        if (!persistAllowed.has(k)) result.push({ key: k, level: "session" });
      }
      return result;
    },
  }),
);
