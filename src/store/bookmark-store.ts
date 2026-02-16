/**
 * 网页书签管理 Store
 *
 * 功能:
 * - 书签 CRUD、分类管理
 * - 拼音 / 模糊搜索
 * - 从 Chrome / Firefox / Edge 导入书签
 * - 导出 JSON
 *
 * 持久化到 localStorage
 */

import { create } from "zustand";

export interface Bookmark {
  id: string;
  /** 书签标题 */
  title: string;
  /** 网址 */
  url: string;
  /** 搜索触发关键词（可选） */
  keyword: string;
  /** 分类 */
  category: string;
  /** 网站图标 URL（可选） */
  favicon: string;
  /** 创建时间 */
  createdAt: number;
  /** 最近访问时间 */
  lastVisitedAt: number;
  /** 访问次数 */
  visitCount: number;
}

interface BookmarkStore {
  bookmarks: Bookmark[];
  loaded: boolean;

  loadBookmarks: () => void;
  addBookmark: (
    data: Omit<Bookmark, "id" | "createdAt" | "lastVisitedAt" | "visitCount">,
  ) => string;
  updateBookmark: (
    id: string,
    updates: Partial<Omit<Bookmark, "id" | "createdAt">>,
  ) => void;
  deleteBookmark: (id: string) => void;
  /** 模糊搜索（标题、URL、关键词、分类） */
  searchBookmarks: (query: string) => Bookmark[];
  /** 标记访问 */
  markVisited: (id: string) => void;
  /** 获取所有分类 */
  getCategories: () => string[];
  /** 导出为 JSON */
  exportBookmarks: () => string;
  /** 从 JSON 导入 */
  importBookmarks: (json: string) => number;
  /** 从浏览器书签文件（HTML）导入 */
  importFromBrowserHTML: (html: string) => number;
  /** 从 Chrome Bookmarks JSON 导入 */
  importFromChromeJSON: (json: string) => number;
}

const STORAGE_KEY = "mtools-bookmarks";

function generateId(): string {
  return `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function persist(bookmarks: Bookmark[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch (e) {
    console.warn("[bookmark-store] 持久化失败:", e);
  }
}

function loadFromStorage(): Bookmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("[bookmark-store] 读取失败:", e);
  }
  return [];
}

function fuzzyMatch(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

/** 从 URL 提取域名作为 favicon 的来源 */
function getFaviconUrl(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return "";
  }
}

// ── Chrome Bookmarks JSON 解析 ──

interface ChromeBookmarkNode {
  name?: string;
  url?: string;
  type?: string;
  children?: ChromeBookmarkNode[];
}

function flattenChromeNodes(
  node: ChromeBookmarkNode,
  category: string,
): { title: string; url: string; category: string }[] {
  const results: { title: string; url: string; category: string }[] = [];
  if (node.type === "url" && node.url && node.name) {
    results.push({ title: node.name, url: node.url, category });
  }
  if (node.children) {
    const folder = node.name || category;
    for (const child of node.children) {
      results.push(...flattenChromeNodes(child, folder));
    }
  }
  return results;
}

// ── 浏览器导出 HTML 解析（Netscape Bookmark File） ──

function parseBookmarkHTML(
  html: string,
): { title: string; url: string; category: string }[] {
  const results: { title: string; url: string; category: string }[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  function walkDL(dl: Element, category: string) {
    const items = dl.children;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.tagName === "DT") {
        const anchor = item.querySelector("a");
        if (anchor) {
          const url = anchor.getAttribute("href") || "";
          const title = anchor.textContent?.trim() || "";
          if (url && title && url.startsWith("http")) {
            results.push({ title, url, category });
          }
        }
        const subDL = item.querySelector("dl");
        const subH3 = item.querySelector("h3");
        if (subDL) {
          const folderName = subH3?.textContent?.trim() || category;
          walkDL(subDL, folderName);
        }
      }
    }
  }

  const rootDL = doc.querySelector("dl");
  if (rootDL) walkDL(rootDL, "导入");
  return results;
}

export const useBookmarkStore = create<BookmarkStore>((set, get) => ({
  bookmarks: [],
  loaded: false,

  loadBookmarks() {
    if (get().loaded) return;
    const bookmarks = loadFromStorage();
    set({ bookmarks, loaded: true });
  },

  addBookmark(data) {
    const id = generateId();
    const bookmark: Bookmark = {
      ...data,
      id,
      favicon: data.favicon || getFaviconUrl(data.url),
      createdAt: Date.now(),
      lastVisitedAt: 0,
      visitCount: 0,
    };
    const bookmarks = [...get().bookmarks, bookmark];
    set({ bookmarks });
    persist(bookmarks);
    return id;
  },

  updateBookmark(id, updates) {
    const bookmarks = get().bookmarks.map((b) =>
      b.id === id ? { ...b, ...updates } : b,
    );
    set({ bookmarks });
    persist(bookmarks);
  },

  deleteBookmark(id) {
    const bookmarks = get().bookmarks.filter((b) => b.id !== id);
    set({ bookmarks });
    persist(bookmarks);
  },

  searchBookmarks(query) {
    if (!query.trim()) return get().bookmarks;
    return get().bookmarks.filter(
      (b) =>
        fuzzyMatch(b.title, query) ||
        fuzzyMatch(b.url, query) ||
        fuzzyMatch(b.keyword, query) ||
        fuzzyMatch(b.category, query),
    );
  },

  markVisited(id) {
    const bookmarks = get().bookmarks.map((b) =>
      b.id === id
        ? { ...b, lastVisitedAt: Date.now(), visitCount: b.visitCount + 1 }
        : b,
    );
    set({ bookmarks });
    persist(bookmarks);
  },

  getCategories() {
    const cats = new Set(
      get()
        .bookmarks.map((b) => b.category)
        .filter(Boolean),
    );
    return Array.from(cats);
  },

  exportBookmarks() {
    return JSON.stringify(get().bookmarks, null, 2);
  },

  importBookmarks(json) {
    try {
      const imported: Bookmark[] = JSON.parse(json);
      if (!Array.isArray(imported)) return 0;
      const existingUrls = new Set(get().bookmarks.map((b) => b.url));
      const newBookmarks = imported.filter(
        (b) => b.url && b.title && !existingUrls.has(b.url),
      );
      if (newBookmarks.length === 0) return 0;
      // 确保有 ID
      const withIds = newBookmarks.map((b) => ({
        ...b,
        id: b.id || generateId(),
        createdAt: b.createdAt || Date.now(),
        lastVisitedAt: b.lastVisitedAt || 0,
        visitCount: b.visitCount || 0,
      }));
      const bookmarks = [...get().bookmarks, ...withIds];
      set({ bookmarks });
      persist(bookmarks);
      return withIds.length;
    } catch {
      return 0;
    }
  },

  importFromBrowserHTML(html) {
    const parsed = parseBookmarkHTML(html);
    if (parsed.length === 0) return 0;
    const existingUrls = new Set(get().bookmarks.map((b) => b.url));
    const newEntries = parsed.filter((p) => !existingUrls.has(p.url));
    if (newEntries.length === 0) return 0;
    const newBookmarks: Bookmark[] = newEntries.map((p) => ({
      id: generateId(),
      title: p.title,
      url: p.url,
      keyword: "",
      category: p.category,
      favicon: getFaviconUrl(p.url),
      createdAt: Date.now(),
      lastVisitedAt: 0,
      visitCount: 0,
    }));
    const bookmarks = [...get().bookmarks, ...newBookmarks];
    set({ bookmarks });
    persist(bookmarks);
    return newBookmarks.length;
  },

  importFromChromeJSON(json) {
    try {
      const root = JSON.parse(json);
      const allEntries: { title: string; url: string; category: string }[] = [];
      // Chrome Bookmarks JSON 的 roots 下有 bookmark_bar / other / synced 等
      const roots = root.roots || root;
      for (const key of Object.keys(roots)) {
        if (typeof roots[key] === "object" && roots[key] !== null) {
          allEntries.push(...flattenChromeNodes(roots[key], key));
        }
      }
      if (allEntries.length === 0) return 0;
      const existingUrls = new Set(get().bookmarks.map((b) => b.url));
      const newEntries = allEntries.filter(
        (e) => e.url.startsWith("http") && !existingUrls.has(e.url),
      );
      if (newEntries.length === 0) return 0;
      const newBookmarks: Bookmark[] = newEntries.map((e) => ({
        id: generateId(),
        title: e.title,
        url: e.url,
        keyword: "",
        category: e.category,
        favicon: getFaviconUrl(e.url),
        createdAt: Date.now(),
        lastVisitedAt: 0,
        visitCount: 0,
      }));
      const bookmarks = [...get().bookmarks, ...newBookmarks];
      set({ bookmarks });
      persist(bookmarks);
      return newBookmarks.length;
    } catch {
      return 0;
    }
  },
}));
