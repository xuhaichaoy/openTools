import { create } from "zustand";
import {
  addMemoryFromAgent,
  recallMemories,
  buildMemoryPromptBlock,
  migrateAgentMemory,
} from "@/core/ai/memory-store";

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
  migrated: boolean;

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

let cachedPrompt = "";
let promptDirty = true;

export const useAgentMemoryStore = create<AgentMemoryState>((set, get) => ({
  memories: [],
  loaded: false,
  migrated: false,

  load: async () => {
    if (get().loaded) return;
    // Migrate any remaining localStorage memories to unified store
    if (!get().migrated) {
      await migrateAgentMemory();
      set({ migrated: true });
    }
    set({ loaded: true });
  },

  save: () => {
    // No-op: unified memory uses Tauri JSON storage via aiMemoryDb
  },

  addMemory: (key, value, category = "preference") => {
    promptDirty = true;
    addMemoryFromAgent(key, value, category).catch(() => {});
  },

  removeMemory: (_key: string) => {
    promptDirty = true;
  },

  getMemoriesForPrompt: () => {
    if (!promptDirty && cachedPrompt) return cachedPrompt;
    // Synchronous fallback: return cached or empty, trigger async refresh
    recallMemories("", { topK: 20 })
      .then((memories) => {
        cachedPrompt = buildMemoryPromptBlock(memories);
        promptDirty = false;
      })
      .catch(() => {});
    return cachedPrompt;
  },
}));
