import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { handleError } from "@/core/errors";

export interface SshConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key" | "agent";
  password?: string;
  private_key_path?: string;
  passphrase?: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified?: number;
  permissions?: string;
}

interface SshSessionState {
  connected: boolean;
  shellOpen: boolean;
}

interface SshState {
  connections: SshConnectionConfig[];
  sessions: Record<string, SshSessionState>;
  activeSessionId: string | null;
  sftpCurrentPath: Record<string, string>;
  sftpFiles: Record<string, SftpEntry[]>;
  sftpLoading: Record<string, boolean>;
  isLoading: boolean;

  loadConnections: () => Promise<void>;
  saveConnections: () => Promise<void>;
  addConnection: (config: SshConnectionConfig) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  updateConnection: (id: string, partial: Partial<SshConnectionConfig>) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  openShell: (id: string, cols: number, rows: number) => Promise<void>;
  writeShell: (id: string, data: string) => Promise<void>;
  resizeShell: (id: string, cols: number, rows: number) => Promise<void>;
  sftpNavigate: (id: string, path: string) => Promise<void>;
  sftpMkdir: (id: string, path: string) => Promise<void>;
  sftpRemove: (id: string, path: string, isDir: boolean) => Promise<void>;
  sftpRename: (id: string, oldPath: string, newPath: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  markShellClosed: (id: string) => void;
}

export const useSshStore = create<SshState>((set, get) => ({
  connections: [],
  sessions: {},
  activeSessionId: null,
  sftpCurrentPath: {},
  sftpFiles: {},
  sftpLoading: {},
  isLoading: false,

  loadConnections: async () => {
    set({ isLoading: true });
    try {
      const conns = await invoke<SshConnectionConfig[]>("ssh_load_connections");
      set({ connections: conns });
    } catch (e) {
      handleError(e, { context: "加载 SSH 连接" });
    }
    set({ isLoading: false });
  },

  saveConnections: async () => {
    try {
      await invoke("ssh_save_connections", { connections: get().connections });
    } catch (e) {
      handleError(e, { context: "保存 SSH 连接" });
    }
  },

  addConnection: async (config) => {
    const next = [...get().connections, config];
    set({ connections: next });
    await invoke("ssh_save_connections", { connections: next }).catch(() => {});
  },

  removeConnection: async (id) => {
    await get().disconnect(id).catch(() => {});
    const next = get().connections.filter((c) => c.id !== id);
    set({ connections: next });
    await invoke("ssh_save_connections", { connections: next }).catch(() => {});
  },

  updateConnection: async (id, partial) => {
    const next = get().connections.map((c) =>
      c.id === id ? { ...c, ...partial } : c,
    );
    set({ connections: next });
    await invoke("ssh_save_connections", { connections: next }).catch(() => {});
  },

  connect: async (id) => {
    const config = get().connections.find((c) => c.id === id);
    if (!config) throw new Error("Connection not found");

    await invoke("ssh_connect", { config });
    set((s) => ({
      sessions: { ...s.sessions, [id]: { connected: true, shellOpen: false } },
      activeSessionId: id,
    }));
  },

  disconnect: async (id) => {
    try {
      await invoke("ssh_disconnect", { sessionId: id });
    } catch { /* ignore */ }
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return {
        sessions,
        activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
      };
    });
  },

  openShell: async (id, cols, rows) => {
    await invoke("ssh_shell_open", { sessionId: id, cols, rows });
    set((s) => ({
      sessions: {
        ...s.sessions,
        [id]: { ...s.sessions[id], shellOpen: true },
      },
    }));
  },

  writeShell: async (id, data) => {
    await invoke("ssh_shell_write", { sessionId: id, data });
  },

  resizeShell: async (id, cols, rows) => {
    await invoke("ssh_shell_resize", { sessionId: id, cols, rows });
  },

  sftpNavigate: async (id, path) => {
    set((s) => ({
      sftpCurrentPath: { ...s.sftpCurrentPath, [id]: path },
      sftpLoading: { ...s.sftpLoading, [id]: true },
    }));
    try {
      const files = await invoke<SftpEntry[]>("ssh_sftp_list", {
        sessionId: id,
        path,
      });
      set((s) => ({
        sftpFiles: { ...s.sftpFiles, [id]: files },
        sftpLoading: { ...s.sftpLoading, [id]: false },
      }));
    } catch (e) {
      set((s) => ({
        sftpLoading: { ...s.sftpLoading, [id]: false },
      }));
      handleError(e, { context: "SFTP 浏览" });
    }
  },

  sftpMkdir: async (id, path) => {
    await invoke("ssh_sftp_mkdir", { sessionId: id, path });
    const parentPath = get().sftpCurrentPath[id] ?? "/";
    await get().sftpNavigate(id, parentPath);
  },

  sftpRemove: async (id, path, isDir) => {
    await invoke("ssh_sftp_remove", { sessionId: id, path, isDir });
    const parentPath = get().sftpCurrentPath[id] ?? "/";
    await get().sftpNavigate(id, parentPath);
  },

  sftpRename: async (id, oldPath, newPath) => {
    await invoke("ssh_sftp_rename", { sessionId: id, oldPath, newPath });
    const parentPath = get().sftpCurrentPath[id] ?? "/";
    await get().sftpNavigate(id, parentPath);
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  markShellClosed: (id) =>
    set((s) => {
      const existing = s.sessions[id];
      if (!existing) return s;
      return {
        sessions: {
          ...s.sessions,
          [id]: { ...existing, connected: false, shellOpen: false },
        },
      };
    }),
}));

export function listenSshOutput(
  sessionId: string,
  callback: (data: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`ssh-output-${sessionId}`, (event) => {
    callback(event.payload);
  });
}

export function listenSshClosed(
  sessionId: string,
  callback: () => void,
): Promise<UnlistenFn> {
  return listen(`ssh-closed-${sessionId}`, () => {
    callback();
  });
}
