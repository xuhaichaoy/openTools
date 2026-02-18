/**
 * 统一集合 Store — 合并 bookmark-store + snippet-store
 *
 * 为保持向后兼容，此文件作为统一入口 re-export 所有子 Store。
 * 新代码应从此文件导入；旧代码的导入路径仍然有效。
 */

export { useBookmarkStore, bookmarksDb } from "./bookmark-store";
export type { Bookmark, CreateBookmarkDTO } from "./bookmark-store";

export { useSnippetStore, snippetsDb } from "./snippet-store";
export type { Snippet, CreateSnippetDTO } from "./snippet-store";
