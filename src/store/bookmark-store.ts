/**
 * 网页书签管理 Store — 纯状态层
 *
 * 业务逻辑已抽取到 BookmarkService（src/core/services/bookmark-service.ts）。
 * Store 只负责：维护 React 响应式状态 + 委托 Service 执行操作。
 */

import { create } from "zustand";
import {
  bookmarkService,
  bookmarksDb,
  type Bookmark,
  type CreateBookmarkDTO,
} from "@/core/services/bookmark-service";

// 重导出类型，保持外部引用兼容
export type { Bookmark, CreateBookmarkDTO };
export { bookmarksDb };

interface BookmarkStore {
  bookmarks: Bookmark[];
  loaded: boolean;

  loadBookmarks: () => Promise<void>;
  addBookmark: (data: CreateBookmarkDTO) => Promise<string>;
  updateBookmark: (
    id: string,
    updates: Partial<Bookmark>,
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

export const useBookmarkStore = create<BookmarkStore>((set, get) => ({
  bookmarks: [],
  loaded: false,

  async loadBookmarks() {
    if (get().loaded) return;
    const bookmarks = await bookmarkService.loadAll();
    set({ bookmarks, loaded: true });
  },

  async addBookmark(data) {
    const { id, bookmarks } = await bookmarkService.create(data);
    set({ bookmarks });
    return id;
  },

  async updateBookmark(id, updates) {
    const bookmarks = await bookmarkService.update(id, updates);
    set({ bookmarks });
  },

  async deleteBookmark(id) {
    const bookmarks = await bookmarkService.remove(id);
    set({ bookmarks });
  },

  searchBookmarks(query) {
    return bookmarkService.search(get().bookmarks, query);
  },

  async markVisited(id) {
    const bm = get().bookmarks.find((b) => b.id === id);
    if (!bm) return;
    const bookmarks = await bookmarkService.markVisited(id, bm.visitCount);
    set({ bookmarks });
  },

  getCategories() {
    return bookmarkService.getCategories(get().bookmarks);
  },

  exportBookmarks() {
    return bookmarkService.export(get().bookmarks);
  },

  async importBookmarks(json) {
    const existingUrls = new Set(get().bookmarks.map((b) => b.url));
    const { count, bookmarks } = await bookmarkService.importFromJSON(json, existingUrls);
    set({ bookmarks });
    return count;
  },

  async importFromBrowserHTML(html) {
    const existingUrls = new Set(get().bookmarks.map((b) => b.url));
    const { count, bookmarks } = await bookmarkService.importFromBrowserHTML(html, existingUrls);
    set({ bookmarks });
    return count;
  },

  async importFromChromeJSON(json) {
    const existingUrls = new Set(get().bookmarks.map((b) => b.url));
    const { count, bookmarks } = await bookmarkService.importFromChromeJSON(json, existingUrls);
    set({ bookmarks });
    return count;
  },
}));
