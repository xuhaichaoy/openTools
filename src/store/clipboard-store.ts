import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ClipboardEntry {
  id: number;
  content: string;
  content_type: string; // "text" | "image_path"
  timestamp: number;
  preview: string;
}

interface ClipboardState {
  entries: ClipboardEntry[];
  search: string;
  loading: boolean;

  // actions
  setSearch: (s: string) => void;
  load: (search?: string, limit?: number) => Promise<void>;
  deleteEntry: (id: number) => Promise<void>;
  clearAll: () => Promise<void>;
  writeToClipboard: (content: string) => Promise<void>;
}

export const useClipboardStore = create<ClipboardState>((set, get) => ({
  entries: [],
  search: "",
  loading: false,

  setSearch: (s: string) => {
    set({ search: s });
    get().load(s);
  },

  load: async (search?: string, limit?: number) => {
    set({ loading: true });
    try {
      const entries = await invoke<ClipboardEntry[]>("clipboard_history_list", {
        search: search ?? (get().search || null),
        limit: limit ?? 50,
      });
      set({ entries });
    } catch (e) {
      console.error("clipboard load error:", e);
    } finally {
      set({ loading: false });
    }
  },

  deleteEntry: async (id: number) => {
    try {
      await invoke("clipboard_history_delete", { id });
      set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
    } catch (e) {
      console.error("clipboard delete error:", e);
    }
  },

  clearAll: async () => {
    try {
      await invoke("clipboard_history_clear");
      set({ entries: [] });
    } catch (e) {
      console.error("clipboard clear error:", e);
    }
  },

  writeToClipboard: async (content: string) => {
    try {
      await invoke("clipboard_history_write", { content });
    } catch (e) {
      console.error("clipboard write error:", e);
    }
  },
}));

// ── 实时更新监听 ──

let unlistenFn: UnlistenFn | null = null;

export function startClipboardListener() {
  if (unlistenFn) return; // 已监听
  listen<{ entry: ClipboardEntry; total: number }>(
    "clipboard-history-update",
    (event) => {
      const { entry } = event.payload;
      useClipboardStore.setState((s) => {
        // 去重
        const filtered = s.entries.filter((e) => e.id !== entry.id);
        return { entries: [entry, ...filtered].slice(0, 50) };
      });
    }
  ).then((fn) => {
    unlistenFn = fn;
  });
}

export function stopClipboardListener() {
  unlistenFn?.();
  unlistenFn = null;
}
