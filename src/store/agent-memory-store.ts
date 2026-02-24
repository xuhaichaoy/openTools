import { create } from "zustand";

const STORAGE_KEY = "agent_user_memory";
const MAX_MEMORIES = 50;
const SAVE_DEBOUNCE_MS = 500;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export interface UserMemory {
  key: string;
  value: string;
  category: "preference" | "fact" | "pattern";
  createdAt: number;
  usedCount: number;
}

interface AgentMemoryState {
  memories: UserMemory[];
  loaded: boolean;

  load: () => Promise<void>;
  save: () => void;
  addMemory: (
    key: string,
    value: string,
    category?: UserMemory["category"],
  ) => void;
  removeMemory: (key: string) => void;
  getMemoriesForPrompt: () => string;
}

export const useAgentMemoryStore = create<AgentMemoryState>((set, get) => ({
  memories: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        set({ memories: JSON.parse(raw) as UserMemory[], loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },

  save: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(get().memories));
      } catch {
        // silently ignore storage errors
      }
    }, SAVE_DEBOUNCE_MS);
  },

  addMemory: (key, value, category = "preference") => {
    const { memories } = get();
    const existing = memories.findIndex((m) => m.key === key);
    let updated: UserMemory[];

    if (existing >= 0) {
      updated = [...memories];
      updated[existing] = {
        ...updated[existing],
        value,
        usedCount: updated[existing].usedCount + 1,
      };
    } else {
      const newMemory: UserMemory = {
        key,
        value,
        category,
        createdAt: Date.now(),
        usedCount: 1,
      };
      updated = [...memories, newMemory];
      if (updated.length > MAX_MEMORIES) {
        updated.sort((a, b) => b.usedCount - a.usedCount);
        updated = updated.slice(0, MAX_MEMORIES);
      }
    }

    set({ memories: updated });
    get().save();
  },

  removeMemory: (key) => {
    set({ memories: get().memories.filter((m) => m.key !== key) });
    get().save();
  },

  getMemoriesForPrompt: () => {
    const { memories } = get();
    if (memories.length === 0) return "";

    const sorted = [...memories].sort((a, b) => b.usedCount - a.usedCount);
    const top = sorted.slice(0, 20);

    const lines = top.map(
      (m) => `- [${m.category}] ${m.key}: ${m.value}`,
    );
    return `\n## 用户偏好记忆\n以下是从历史交互中学到的用户偏好，请参考但不要主动提及：\n${lines.join("\n")}`;
  },
}));
