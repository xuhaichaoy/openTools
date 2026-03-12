import { create } from "zustand";
import {
  addMemoryFromAgent,
  deleteMemory,
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
  /** Async version — must be awaited for fresh results */
  getMemoriesForPromptAsync: () => Promise<string>;
  /** Sync version — returns cached prompt (may be stale on first call) */
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
    if (!get().migrated) {
      await migrateAgentMemory();
      set({ migrated: true });
    }
    // Pre-warm prompt cache
    try {
      const memories = await recallMemories("", { topK: 20 });
      cachedPrompt = buildMemoryPromptBlock(memories);
      promptDirty = false;
    } catch (err) {
      console.warn("[AgentMemoryStore] Failed to pre-warm memory prompt:", err);
    }
    set({ loaded: true });
  },

  save: () => {
    // No-op: unified memory uses Tauri JSON storage via aiMemoryDb
  },

  addMemory: (key, value, category = "preference") => {
    promptDirty = true;
    addMemoryFromAgent(key, value, category).catch((err) => {
      console.warn("[AgentMemoryStore] addMemory failed:", err);
    });
  },

  removeMemory: (key: string) => {
    promptDirty = true;
    deleteMemory(key).catch((err) => {
      console.warn("[AgentMemoryStore] removeMemory failed:", err);
    });
  },

  getMemoriesForPromptAsync: async () => {
    if (!promptDirty && cachedPrompt) return cachedPrompt;
    try {
      const memories = await recallMemories("", { topK: 20 });
      cachedPrompt = buildMemoryPromptBlock(memories);
      promptDirty = false;
    } catch (err) {
      console.warn("[AgentMemoryStore] getMemoriesForPromptAsync failed:", err);
    }
    return cachedPrompt;
  },

  getMemoriesForPrompt: () => {
    if (!promptDirty && cachedPrompt) return cachedPrompt;
    // Trigger async refresh in background, return current cache
    recallMemories("", { topK: 20 })
      .then((memories) => {
        cachedPrompt = buildMemoryPromptBlock(memories);
        promptDirty = false;
      })
      .catch((err) => {
        console.warn("[AgentMemoryStore] background refresh failed:", err);
      });
    return cachedPrompt;
  },
}));
