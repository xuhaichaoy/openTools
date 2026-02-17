/**
 * 快捷短语 Store — 纯状态层
 *
 * 业务逻辑已抽取到 SnippetService（src/core/services/snippet-service.ts）。
 * Store 只负责：维护 React 响应式状态 + 委托 Service 执行操作。
 */

import { create } from "zustand";
import {
  snippetService,
  snippetsDb,
  type Snippet,
  type CreateSnippetDTO,
} from "@/core/services/snippet-service";

// 重导出类型，保持外部引用兼容
export type { Snippet, CreateSnippetDTO };
export { snippetsDb };

interface SnippetStore {
  snippets: Snippet[];
  loaded: boolean;

  loadSnippets: () => Promise<void>;
  addSnippet: (snippet: CreateSnippetDTO) => Promise<string>;
  updateSnippet: (
    id: string,
    updates: Partial<Snippet>,
  ) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;
  searchSnippets: (query: string) => Snippet[];
  matchByKeyword: (keyword: string) => Snippet | undefined;
  markUsed: (id: string) => Promise<void>;
  getCategories: () => string[];
  exportSnippets: () => string;
  importSnippets: (json: string) => Promise<number>;
}

export const useSnippetStore = create<SnippetStore>((set, get) => ({
  snippets: [],
  loaded: false,

  async loadSnippets() {
    if (get().loaded) return;
    const snippets = await snippetService.loadAll();
    set({ snippets, loaded: true });
  },

  async addSnippet(data) {
    const { id, snippets } = await snippetService.create(data);
    set({ snippets });
    return id;
  },

  async updateSnippet(id, updates) {
    const snippets = await snippetService.update(id, updates);
    set({ snippets });
  },

  async deleteSnippet(id) {
    const snippets = await snippetService.remove(id);
    set({ snippets });
  },

  searchSnippets(query) {
    return snippetService.search(get().snippets, query);
  },

  matchByKeyword(keyword) {
    return snippetService.matchByKeyword(get().snippets, keyword);
  },

  async markUsed(id) {
    const sn = get().snippets.find((s) => s.id === id);
    if (!sn) return;
    const snippets = await snippetService.markUsed(id, sn.useCount);
    set({ snippets });
  },

  getCategories() {
    return snippetService.getCategories(get().snippets);
  },

  exportSnippets() {
    return snippetService.export(get().snippets);
  },

  async importSnippets(json) {
    const existingIds = new Set(get().snippets.map((s) => s.id));
    const { count, snippets } = await snippetService.importFromJSON(json, existingIds);
    set({ snippets });
    return count;
  },
}));
