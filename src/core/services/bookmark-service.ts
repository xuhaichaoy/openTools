/**
 * BookmarkService — 书签业务逻辑层
 *
 * 从 bookmark-store 抽取出所有非状态管理的逻辑：
 * - 解析 Chrome/Firefox/Edge 书签格式
 * - 导入/导出
 * - localStorage 迁移
 * - favicon 获取
 * - 搜索/过滤
 */

import { SyncableCollection, type SyncMeta } from "@/core/database/index";
import { handleError, ErrorLevel } from "@/core/errors";

// ── 类型定义 ──

export interface Bookmark extends SyncMeta {
  id: string;
  title: string;
  url: string;
  keyword: string;
  category: string;
  favicon: string;
  createdAt: number;
  lastVisitedAt: number;
  visitCount: number;
  version: number;
  deleted: boolean;
  updatedAt: number;
}

export interface CreateBookmarkDTO {
  title: string;
  url: string;
  keyword?: string;
  category?: string;
  favicon?: string;
}

// ── 数据库实例 ──

export const bookmarksDb = new SyncableCollection<Bookmark>("bookmarks");

// ── 工具函数 ──

export function generateBookmarkId(): string {
  return `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function getFaviconUrl(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return "";
  }
}

function fuzzyMatch(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

// ── Chrome JSON 解析 ──

interface ChromeBookmarkNode {
  name?: string;
  url?: string;
  type?: string;
  children?: ChromeBookmarkNode[];
}

interface BookmarkImportEntry {
  title: string;
  url: string;
  category: string;
}

function flattenChromeNodes(
  node: ChromeBookmarkNode,
  category: string,
): BookmarkImportEntry[] {
  const results: BookmarkImportEntry[] = [];
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

function findDirectChildByTagName(
  element: Element,
  tagName: string,
): Element | null {
  const target = tagName.toUpperCase();
  for (const child of Array.from(element.children)) {
    if (child.tagName === target) return child;
  }
  return null;
}

function filterNewBookmarkEntries(
  entries: BookmarkImportEntry[],
  existingUrls: Set<string>,
): BookmarkImportEntry[] {
  const seenUrls = new Set(existingUrls);
  return entries.filter((entry) => {
    if (!entry.url || !entry.title) return false;
    if (seenUrls.has(entry.url)) return false;
    seenUrls.add(entry.url);
    return true;
  });
}

// ── 浏览器 HTML 解析 ──

function parseBookmarkHTML(
  html: string,
): BookmarkImportEntry[] {
  const results: BookmarkImportEntry[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  function walkDL(dl: Element, category: string) {
    const items = dl.children;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.tagName === "DT") {
        const anchor = findDirectChildByTagName(item, "a");
        if (anchor) {
          const url = anchor.getAttribute("href") || "";
          const title = anchor.textContent?.trim() || "";
          if (url && title && url.startsWith("http")) {
            results.push({ title, url, category });
          }
        }
        const subH3 = findDirectChildByTagName(item, "h3");
        const subDL =
          findDirectChildByTagName(item, "dl") ||
          (item.nextElementSibling?.tagName === "DL"
            ? item.nextElementSibling
            : null);
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

// ── Service 类 ──

const OLD_STORAGE_KEY = "mtools-bookmarks";

export class BookmarkService {
  /** 加载书签（含 localStorage 迁移） */
  async loadAll(): Promise<Bookmark[]> {
    let bookmarks = await bookmarksDb.getAll();

    // 一次性 localStorage 迁移
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
        handleError(e, { context: "书签 localStorage 迁移", level: ErrorLevel.Warning });
      }
    }

    return bookmarks;
  }

  /** 创建书签 */
  async create(data: CreateBookmarkDTO): Promise<{ id: string; bookmarks: Bookmark[] }> {
    const id = generateBookmarkId();
    const bookmark: Bookmark = {
      id,
      title: data.title,
      url: data.url,
      keyword: data.keyword ?? "",
      category: data.category ?? "",
      favicon: data.favicon || getFaviconUrl(data.url),
      createdAt: Date.now(),
      lastVisitedAt: 0,
      visitCount: 0,
      version: Date.now(),
      deleted: false,
      updatedAt: Date.now(),
    };
    await bookmarksDb.create(bookmark);
    const bookmarks = await bookmarksDb.getAll();
    return { id, bookmarks };
  }

  /** 更新书签 */
  async update(id: string, updates: Partial<Bookmark>): Promise<Bookmark[]> {
    await bookmarksDb.update(id, {
      ...updates,
      version: Date.now(),
      updatedAt: Date.now(),
    });
    return bookmarksDb.getAll();
  }

  /** 删除书签（软删除） */
  async remove(id: string): Promise<Bookmark[]> {
    await bookmarksDb.softDelete(id);
    return bookmarksDb.getAll();
  }

  /** 标记访问 */
  async markVisited(id: string, currentVisitCount: number): Promise<Bookmark[]> {
    await bookmarksDb.update(id, {
      lastVisitedAt: Date.now(),
      visitCount: currentVisitCount + 1,
      version: Date.now(),
      updatedAt: Date.now(),
    });
    return bookmarksDb.getAll();
  }

  /** 搜索书签（纯逻辑，不访问 DB） */
  search(bookmarks: Bookmark[], query: string): Bookmark[] {
    const all = bookmarks.filter((b) => !b.deleted);
    if (!query.trim()) return all;
    return all.filter(
      (b) =>
        fuzzyMatch(b.title, query) ||
        fuzzyMatch(b.url, query) ||
        fuzzyMatch(b.keyword, query) ||
        fuzzyMatch(b.category, query),
    );
  }

  /** 获取分类列表（纯逻辑） */
  getCategories(bookmarks: Bookmark[]): string[] {
    const cats = new Set(
      bookmarks
        .filter((b) => !b.deleted)
        .map((b) => b.category)
        .filter(Boolean),
    );
    return Array.from(cats);
  }

  /** 导出为 JSON */
  export(bookmarks: Bookmark[]): string {
    return JSON.stringify(bookmarks, null, 2);
  }

  /** 从 JSON 导入 */
  async importFromJSON(json: string, existingUrls: Set<string>): Promise<{ count: number; bookmarks: Bookmark[] }> {
    try {
      const imported: Bookmark[] = JSON.parse(json);
      if (!Array.isArray(imported)) return { count: 0, bookmarks: await bookmarksDb.getAll() };
      const newBookmarks = filterNewBookmarkEntries(
        imported.map((b) => ({
          title: b.title,
          url: b.url,
          category: b.category ?? "",
        })),
        existingUrls,
      );
      if (newBookmarks.length === 0) return { count: 0, bookmarks: await bookmarksDb.getAll() };
      for (const entry of newBookmarks) {
        const source =
          imported.find(
            (item) => item.url === entry.url && item.title === entry.title,
          ) ?? imported.find((item) => item.url === entry.url);
        if (!source) continue;
        await bookmarksDb.create({
          ...source,
          id: source.id || generateBookmarkId(),
          createdAt: source.createdAt || Date.now(),
          lastVisitedAt: source.lastVisitedAt || 0,
          visitCount: source.visitCount || 0,
          version: Date.now(),
          deleted: false,
          updatedAt: Date.now(),
        });
      }
      const bookmarks = await bookmarksDb.getAll();
      return { count: newBookmarks.length, bookmarks };
    } catch (e) {
      handleError(e, { context: "导入书签" });
      return { count: 0, bookmarks: await bookmarksDb.getAll() };
    }
  }

  /** 从浏览器 HTML 导入 */
  async importFromBrowserHTML(html: string, existingUrls: Set<string>): Promise<{ count: number; bookmarks: Bookmark[] }> {
    const parsed = parseBookmarkHTML(html);
    if (parsed.length === 0) return { count: 0, bookmarks: await bookmarksDb.getAll() };
    const newEntries = filterNewBookmarkEntries(parsed, existingUrls);
    if (newEntries.length === 0) return { count: 0, bookmarks: await bookmarksDb.getAll() };
    for (const p of newEntries) {
      await bookmarksDb.create({
        id: generateBookmarkId(),
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
    const bookmarks = await bookmarksDb.getAll();
    return { count: newEntries.length, bookmarks };
  }

  /** 从 Chrome JSON 导入 */
  async importFromChromeJSON(json: string, existingUrls: Set<string>): Promise<{ count: number; bookmarks: Bookmark[] }> {
    try {
      const root = JSON.parse(json);
      const allEntries: { title: string; url: string; category: string }[] = [];
      const roots = root.roots || root;
      for (const key of Object.keys(roots)) {
        if (typeof roots[key] === "object" && roots[key] !== null) {
          allEntries.push(...flattenChromeNodes(roots[key], key));
        }
      }
      if (allEntries.length === 0) return { count: 0, bookmarks: await bookmarksDb.getAll() };
      const newEntries = filterNewBookmarkEntries(
        allEntries.filter((e) => e.url.startsWith("http")),
        existingUrls,
      );
      if (newEntries.length === 0) return { count: 0, bookmarks: await bookmarksDb.getAll() };
      for (const e of newEntries) {
        await bookmarksDb.create({
          id: generateBookmarkId(),
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
      const bookmarks = await bookmarksDb.getAll();
      return { count: newEntries.length, bookmarks };
    } catch (e) {
      handleError(e, { context: "导入 Chrome 书签" });
      return { count: 0, bookmarks: await bookmarksDb.getAll() };
    }
  }
}

/** 单例 */
export const bookmarkService = new BookmarkService();
