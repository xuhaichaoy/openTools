/**
 * 快捷短语 / 文本片段 Store
 *
 * 数据模型:
 * - 静态片段：用户预设内容（邮箱签名、代码模板、常用回复）
 * - 动态片段：内容由 AI 实时生成（如「今天日期」「随机密码」）
 *
 * 持久化到 localStorage
 */

import { create } from "zustand";

export interface Snippet {
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
}

interface SnippetStore {
  snippets: Snippet[];
  /** 是否已加载 */
  loaded: boolean;

  /** 加载所有片段 */
  loadSnippets: () => void;
  /** 添加片段 */
  addSnippet: (snippet: Omit<Snippet, "id" | "createdAt" | "lastUsedAt" | "useCount">) => string;
  /** 更新片段 */
  updateSnippet: (id: string, updates: Partial<Omit<Snippet, "id" | "createdAt">>) => void;
  /** 删除片段 */
  deleteSnippet: (id: string) => void;
  /** 搜索片段（标题、关键词、内容模糊匹配） */
  searchSnippets: (query: string) => Snippet[];
  /** 按关键词精确匹配 */
  matchByKeyword: (keyword: string) => Snippet | undefined;
  /** 标记使用（更新使用时间和次数） */
  markUsed: (id: string) => void;
  /** 按分类获取 */
  getCategories: () => string[];
  /** 导出所有片段为 JSON */
  exportSnippets: () => string;
  /** 从 JSON 导入片段 */
  importSnippets: (json: string) => number;
}

const STORAGE_KEY = "mtools-snippets";

function generateId(): string {
  return `sn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function persist(snippets: Snippet[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snippets));
  } catch (e) {
    console.warn("[snippet-store] 持久化失败:", e);
  }
}

function loadFromStorage(): Snippet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("[snippet-store] 读取失败:", e);
  }
  return [];
}

/** 简单的拼音/模糊搜索（大小写不敏感） */
function fuzzyMatch(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export const useSnippetStore = create<SnippetStore>((set, get) => ({
  snippets: [],
  loaded: false,

  loadSnippets() {
    if (get().loaded) return;
    const snippets = loadFromStorage();
    set({ snippets, loaded: true });
  },

  addSnippet(data) {
    const id = generateId();
    const snippet: Snippet = {
      ...data,
      id,
      createdAt: Date.now(),
      lastUsedAt: 0,
      useCount: 0,
    };
    const snippets = [...get().snippets, snippet];
    set({ snippets });
    persist(snippets);
    return id;
  },

  updateSnippet(id, updates) {
    const snippets = get().snippets.map((s) =>
      s.id === id ? { ...s, ...updates } : s,
    );
    set({ snippets });
    persist(snippets);
  },

  deleteSnippet(id) {
    const snippets = get().snippets.filter((s) => s.id !== id);
    set({ snippets });
    persist(snippets);
  },

  searchSnippets(query) {
    if (!query.trim()) return get().snippets;
    return get().snippets.filter(
      (s) =>
        fuzzyMatch(s.title, query) ||
        fuzzyMatch(s.keyword, query) ||
        fuzzyMatch(s.content, query) ||
        fuzzyMatch(s.category, query),
    );
  },

  matchByKeyword(keyword) {
    return get().snippets.find(
      (s) => s.keyword && s.keyword.toLowerCase() === keyword.toLowerCase(),
    );
  },

  markUsed(id) {
    const snippets = get().snippets.map((s) =>
      s.id === id
        ? { ...s, lastUsedAt: Date.now(), useCount: s.useCount + 1 }
        : s,
    );
    set({ snippets });
    persist(snippets);
  },

  getCategories() {
    const cats = new Set(get().snippets.map((s) => s.category).filter(Boolean));
    return Array.from(cats);
  },

  exportSnippets() {
    return JSON.stringify(get().snippets, null, 2);
  },

  importSnippets(json) {
    try {
      const imported: Snippet[] = JSON.parse(json);
      if (!Array.isArray(imported)) return 0;
      const existingIds = new Set(get().snippets.map((s) => s.id));
      const newSnippets = imported.filter((s) => s.id && s.title && !existingIds.has(s.id));
      if (newSnippets.length === 0) return 0;
      const snippets = [...get().snippets, ...newSnippets];
      set({ snippets });
      persist(snippets);
      return newSnippets.length;
    } catch {
      return 0;
    }
  },
}));
