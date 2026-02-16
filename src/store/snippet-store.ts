/**
 * 快捷短语 / 文本片段 Store
 *
 * 数据模型:
 * - 静态片段：用户预设内容（邮箱签名、代码模板、常用回复）
 * - 动态片段：内容由 AI 实时生成（如「今天日期」「随机密码」）
 *
 * 持久化到 SyncableCollection（文件存储 + 同步元数据）
 */

import { create } from "zustand";
import { SyncableCollection, type SyncMeta } from "@/core/database/index";

export interface Snippet extends SyncMeta {
  id: string;
  /** 标题 */
  title: string;
  /** 内容（静态片段的文本内容） */
  content: string;
  /** 搜索框触发关键词 */
  keyword: string;
  /** 分类 */
  category: string;
  /** 是否为 AI 动态生成 */
  isDynamic: boolean;
  /** 动态片段的 AI 提示词模板（isDynamic=true 时使用） */
  dynamicPrompt: string;
  /** 创建时间 */
  createdAt: number;
  /** 最近使用时间 */
  lastUsedAt: number;
  /** 使用次数 */
  useCount: number;
  /** 版本号（同步用） */
  version: number;
  /** 是否已删除（软删除，同步用） */
  deleted: boolean;
  /** 更新时间 */
  updatedAt: number;
}

interface SnippetStore {
  snippets: Snippet[];
  loaded: boolean;

  loadSnippets: () => Promise<void>;
  addSnippet: (
    snippet: Omit<Snippet, "id" | "createdAt" | "lastUsedAt" | "useCount">,
  ) => Promise<string>;
  updateSnippet: (
    id: string,
    updates: Partial<Omit<Snippet, "id" | "createdAt">>,
  ) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;
  searchSnippets: (query: string) => Snippet[];
  matchByKeyword: (keyword: string) => Snippet | undefined;
  markUsed: (id: string) => Promise<void>;
  getCategories: () => string[];
  exportSnippets: () => string;
  importSnippets: (json: string) => Promise<number>;
}

export const snippetsDb = new SyncableCollection<Snippet>("snippets");

const OLD_STORAGE_KEY = "mtools-snippets";

function generateId(): string {
  return `sn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function fuzzyMatch(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export const useSnippetStore = create<SnippetStore>((set, get) => ({
  snippets: [],
  loaded: false,

  async loadSnippets() {
    if (get().loaded) return;
    let snippets = await snippetsDb.getAll();

    // 从 localStorage 迁移（一次性）
    if (snippets.length === 0) {
      try {
        const raw = localStorage.getItem(OLD_STORAGE_KEY);
        if (raw) {
          const legacy: Snippet[] = JSON.parse(raw);
          if (Array.isArray(legacy) && legacy.length > 0) {
            for (const s of legacy) {
              await snippetsDb.create({
                ...s,
                _version: s.version || Date.now(),
                _dirty: true,
              });
            }
            snippets = await snippetsDb.getAll();
            localStorage.removeItem(OLD_STORAGE_KEY);
          }
        }
      } catch (e) {
        console.warn("[snippet-store] localStorage 迁移失败:", e);
      }
    }

    set({ snippets, loaded: true });
  },

  async addSnippet(data) {
    const id = generateId();
    const snippet: Snippet = {
      ...data,
      id,
      createdAt: Date.now(),
      lastUsedAt: 0,
      useCount: 0,
      version: Date.now(),
      deleted: false,
      updatedAt: Date.now(),
    };
    await snippetsDb.create(snippet);
    set({ snippets: await snippetsDb.getAll() });
    return id;
  },

  async updateSnippet(id, updates) {
    await snippetsDb.update(id, {
      ...updates,
      version: Date.now(),
      updatedAt: Date.now(),
    } as Partial<Snippet>);
    set({ snippets: await snippetsDb.getAll() });
  },

  async deleteSnippet(id) {
    await snippetsDb.softDelete(id);
    set({ snippets: await snippetsDb.getAll() });
  },

  searchSnippets(query) {
    const all = get().snippets.filter((s) => !s.deleted);
    if (!query.trim()) return all;
    return all.filter(
      (s) =>
        fuzzyMatch(s.title, query) ||
        fuzzyMatch(s.keyword, query) ||
        fuzzyMatch(s.content, query) ||
        fuzzyMatch(s.category, query),
    );
  },

  matchByKeyword(keyword) {
    return get().snippets.find(
      (s) =>
        !s.deleted &&
        s.keyword &&
        s.keyword.toLowerCase() === keyword.toLowerCase(),
    );
  },

  async markUsed(id) {
    const sn = get().snippets.find((s) => s.id === id);
    if (!sn) return;
    await snippetsDb.update(id, {
      lastUsedAt: Date.now(),
      useCount: sn.useCount + 1,
      version: Date.now(),
      updatedAt: Date.now(),
    } as Partial<Snippet>);
    set({ snippets: await snippetsDb.getAll() });
  },

  getCategories() {
    const cats = new Set(
      get()
        .snippets.filter((s) => !s.deleted)
        .map((s) => s.category)
        .filter(Boolean),
    );
    return Array.from(cats);
  },

  exportSnippets() {
    return JSON.stringify(get().snippets, null, 2);
  },

  async importSnippets(json) {
    try {
      const imported: Snippet[] = JSON.parse(json);
      if (!Array.isArray(imported)) return 0;
      const existingIds = new Set(get().snippets.map((s) => s.id));
      const newSnippets = imported.filter(
        (s) => s.id && s.title && !existingIds.has(s.id),
      );
      if (newSnippets.length === 0) return 0;
      for (const s of newSnippets) {
        await snippetsDb.create({
          ...s,
          version: Date.now(),
          deleted: false,
          updatedAt: Date.now(),
        });
      }
      set({ snippets: await snippetsDb.getAll() });
      return newSnippets.length;
    } catch {
      return 0;
    }
  },
}));
