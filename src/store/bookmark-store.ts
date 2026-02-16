/**
 * 网页书签管理 Store
 *
 * 功能:
 * - 书签 CRUD、分类管理
 * - 拼音 / 模糊搜索
 * - 从 Chrome / Firefox / Edge 导入书签
 * - 导出 JSON
 *
 * 持久化到 SyncableCollection（文件存储 + 同步元数据）
 */

import { create } from "zustand";
import { SyncableCollection, type SyncMeta } from "@/core/database/index";

export interface Bookmark extends SyncMeta {
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
  /** 版本号（同步用） */
  version: number;
  /** 是否已删除（软删除，同步用） */
  deleted: boolean;
  /** 更新时间 */
  updatedAt: number;
}

interface BookmarkStore {
  bookmarks: Bookmark[];
  loaded: boolean;

  loadBookmarks: () => Promise<void>;
  addBookmark: (
    data: Omit<Bookmark, "id" | "createdAt" | "lastVisitedAt" | "visitCount">,
  ) => Promise<string>;
  updateBookmark: (
    id: string,
    updates: Partial<Omit<Bookmark, "id" | "createdAt">>,
  ) => Promise<void>;
  deleteBookmark: (id: string) => Promise<void>;
  searchBookmarks: (query: string) => Bookmark[];
  markVisited: (id: string) => Promise<void>;
  getCategories: () => string[];
  exportBookmarks: () => string;
  importBookmarks: (json: string) => Promise<number>;
  importFromBrowserHTML: (html: string) => Promise<number>;
  importFromChromeJSON: (json: string) => Promise<number>;
}

export const bookmarksDb = new SyncableCollection<Bookmark>("bookmarks");

const OLD_STORAGE_KEY = "mtools-bookmarks";

function generateId(): string {
  return `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function fuzzyMatch(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

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

  async loadBookmarks() {
    if (get().loaded) return;
    let bookmarks = await bookmarksDb.getAll();

    // 从 localStorage 迁移（一次性）
    if (bookmarks.length === 0) {
      try {
        const raw = localStorage.getItem(OLD_STORAGE_KEY);
        if (raw) {
          const legacy: Bookmark[] = JSON.parse(raw);
          if (Array.isArray(legacy) && legacy.length > 0) {
            for (const b of legacy) {
              await bookmarksDb.create({
                ...b,
                _version: b.version || Date.now(),
                _dirty: true,
              });
            }
            bookmarks = await bookmarksDb.getAll();
            localStorage.removeItem(OLD_STORAGE_KEY);
          }
        }
      } catch (e) {
        console.warn("[bookmark-store] localStorage 迁移失败:", e);
      }
    }

    set({ bookmarks, loaded: true });
  },

  async addBookmark(data) {
    const id = generateId();
    const bookmark: Bookmark = {
      ...data,
      id,
      favicon: data.favicon || getFaviconUrl(data.url),
      createdAt: Date.now(),
      lastVisitedAt: 0,
      visitCount: 0,
      version: Date.now(),
      deleted: false,
      updatedAt: Date.now(),
    };
    await bookmarksDb.create(bookmark);
    set({ bookmarks: await bookmarksDb.getAll() });
    return id;
  },

  async updateBookmark(id, updates) {
    await bookmarksDb.update(id, {
      ...updates,
      version: Date.now(),
      updatedAt: Date.now(),
    } as Partial<Bookmark>);
    set({ bookmarks: await bookmarksDb.getAll() });
  },

  async deleteBookmark(id) {
    await bookmarksDb.softDelete(id);
    set({ bookmarks: await bookmarksDb.getAll() });
  },

  searchBookmarks(query) {
    const all = get().bookmarks.filter((b) => !b.deleted);
    if (!query.trim()) return all;
    return all.filter(
      (b) =>
        fuzzyMatch(b.title, query) ||
        fuzzyMatch(b.url, query) ||
        fuzzyMatch(b.keyword, query) ||
        fuzzyMatch(b.category, query),
    );
  },

  async markVisited(id) {
    const bm = get().bookmarks.find((b) => b.id === id);
    if (!bm) return;
    await bookmarksDb.update(id, {
      lastVisitedAt: Date.now(),
      visitCount: bm.visitCount + 1,
      version: Date.now(),
      updatedAt: Date.now(),
    } as Partial<Bookmark>);
    set({ bookmarks: await bookmarksDb.getAll() });
  },

  getCategories() {
    const cats = new Set(
      get()
        .bookmarks.filter((b) => !b.deleted)
        .map((b) => b.category)
        .filter(Boolean),
    );
    return Array.from(cats);
  },

  exportBookmarks() {
    return JSON.stringify(get().bookmarks, null, 2);
  },

  async importBookmarks(json) {
    try {
      const imported: Bookmark[] = JSON.parse(json);
      if (!Array.isArray(imported)) return 0;
      const existingUrls = new Set(get().bookmarks.map((b) => b.url));
      const newBookmarks = imported.filter(
        (b) => b.url && b.title && !existingUrls.has(b.url),
      );
      if (newBookmarks.length === 0) return 0;
      for (const b of newBookmarks) {
        await bookmarksDb.create({
          ...b,
          id: b.id || generateId(),
          createdAt: b.createdAt || Date.now(),
          lastVisitedAt: b.lastVisitedAt || 0,
          visitCount: b.visitCount || 0,
          version: Date.now(),
          deleted: false,
          updatedAt: Date.now(),
        });
      }
      set({ bookmarks: await bookmarksDb.getAll() });
      return newBookmarks.length;
    } catch {
      return 0;
    }
  },

  async importFromBrowserHTML(html) {
    const parsed = parseBookmarkHTML(html);
    if (parsed.length === 0) return 0;
    const existingUrls = new Set(get().bookmarks.map((b) => b.url));
    const newEntries = parsed.filter((p) => !existingUrls.has(p.url));
    if (newEntries.length === 0) return 0;
    for (const p of newEntries) {
      await bookmarksDb.create({
        id: generateId(),
        title: p.title,
        url: p.url,
        keyword: "",
        category: p.category,
        favicon: getFaviconUrl(p.url),
        createdAt: Date.now(),
        lastVisitedAt: 0,
        visitCount: 0,
        version: Date.now(),
        deleted: false,
        updatedAt: Date.now(),
      });
    }
    set({ bookmarks: await bookmarksDb.getAll() });
    return newEntries.length;
  },

  async importFromChromeJSON(json) {
    try {
      const root = JSON.parse(json);
      const allEntries: { title: string; url: string; category: string }[] = [];
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
      for (const e of newEntries) {
        await bookmarksDb.create({
          id: generateId(),
          title: e.title,
          url: e.url,
          keyword: "",
          category: e.category,
          favicon: getFaviconUrl(e.url),
          createdAt: Date.now(),
          lastVisitedAt: 0,
          visitCount: 0,
          version: Date.now(),
          deleted: false,
          updatedAt: Date.now(),
        });
      }
      set({ bookmarks: await bookmarksDb.getAll() });
      return newEntries.length;
    } catch {
      return 0;
    }
  },
}));
