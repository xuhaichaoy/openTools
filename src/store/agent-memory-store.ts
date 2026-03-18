import { create } from "zustand";
import {
  deleteMemory,
  recallMemories,
  buildMemoryPromptBlock,
  migrateAgentMemory,
  queueMemoryCandidateFromAgent,
} from "@/core/ai/memory-store";
import {
  buildAssistantMemoryPromptBundleForQuery,
  type AssistantMemoryPromptBundle,
} from "@/core/ai/assistant-memory";

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
  getMemoriesForQueryPromptAsync: (
    query: string,
    options?: {
      topK?: number;
      conversationId?: string;
      workspaceId?: string;
      preferSemantic?: boolean;
    },
  ) => Promise<string>;
  getMemoryRecallBundleAsync: (
    query: string,
    options?: {
      topK?: number;
      conversationId?: string;
      workspaceId?: string;
      preferSemantic?: boolean;
    },
  ) => Promise<AssistantMemoryPromptBundle>;
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
    queueMemoryCandidateFromAgent(key, value, category, {
      sourceMode: "agent",
      reason: "Agent 建议记录这条用户偏好，等待确认后生效",
    }).catch((err) => {
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

  getMemoriesForQueryPromptAsync: async (query, options) => {
    const bundle = await buildAssistantMemoryPromptBundleForQuery(query, {
      topK: options?.topK ?? 6,
      conversationId: options?.conversationId,
      workspaceId: options?.workspaceId,
      preferSemantic: options?.preferSemantic ?? true,
      enableTranscriptFallback: true,
    });
    return bundle.prompt;
  },

  getMemoryRecallBundleAsync: async (query, options) => {
    return buildAssistantMemoryPromptBundleForQuery(query, {
      topK: options?.topK ?? 6,
      conversationId: options?.conversationId,
      workspaceId: options?.workspaceId,
      preferSemantic: options?.preferSemantic ?? true,
      enableTranscriptFallback: true,
    });
  },
}));
