/**
 * SnippetService — 快捷短语业务逻辑层
 *
 * 从 snippet-store 抽取出非状态管理的逻辑：
 * - CRUD 操作
 * - localStorage 迁移
 * - 搜索/关键词匹配
 * - 导入/导出
 */

import { SyncableCollection, type SyncMeta } from "@/core/database/index";
import { handleError, ErrorLevel } from "@/core/errors";

// ── 类型定义 ──

export interface Snippet extends SyncMeta {
  id: string;
  title: string;
  content: string;
  keyword: string;
  category: string;
  isDynamic: boolean;
  dynamicPrompt: string;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  version: number;
  deleted: boolean;
  updatedAt: number;
}

export type CreateSnippetDTO = Omit<Snippet, "id" | "createdAt" | "lastUsedAt" | "useCount">;

// ── 数据库实例 ──

export const snippetsDb = new SyncableCollection<Snippet>("snippets");

// ── 工具函数 ──

export function generateSnippetId(): string {
  return `sn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function fuzzyMatch(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

// ── Service 类 ──

const OLD_STORAGE_KEY = "mtools-snippets";

export class SnippetService {
  /** 加载短语（含 localStorage 迁移） */
  async loadAll(): Promise<Snippet[]> {
    let snippets = await snippetsDb.getAll();

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
        handleError(e, { context: "短语 localStorage 迁移", level: ErrorLevel.Warning });
      }
    }

    return snippets;
  }

  /** 创建短语 */
  async create(data: CreateSnippetDTO): Promise<{ id: string; snippets: Snippet[] }> {
    const id = generateSnippetId();
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
    const snippets = await snippetsDb.getAll();
    return { id, snippets };
  }

  /** 更新短语 */
  async update(id: string, updates: Partial<Snippet>): Promise<Snippet[]> {
    await snippetsDb.update(id, {
      ...updates,
      version: Date.now(),
      updatedAt: Date.now(),
    });
    return snippetsDb.getAll();
  }

  /** 删除短语（软删除） */
  async remove(id: string): Promise<Snippet[]> {
    await snippetsDb.softDelete(id);
    return snippetsDb.getAll();
  }

  /** 标记使用 */
  async markUsed(id: string, currentUseCount: number): Promise<Snippet[]> {
    await snippetsDb.update(id, {
      lastUsedAt: Date.now(),
      useCount: currentUseCount + 1,
      version: Date.now(),
      updatedAt: Date.now(),
    });
    return snippetsDb.getAll();
  }

  /** 搜索短语 */
  search(snippets: Snippet[], query: string): Snippet[] {
    const all = snippets.filter((s) => !s.deleted);
    if (!query.trim()) return all;
    return all.filter(
      (s) =>
        fuzzyMatch(s.title, query) ||
        fuzzyMatch(s.keyword, query) ||
        fuzzyMatch(s.content, query) ||
        fuzzyMatch(s.category, query),
    );
  }

  /** 通过关键词精确匹配 */
  matchByKeyword(snippets: Snippet[], keyword: string): Snippet | undefined {
    return snippets.find(
      (s) =>
        !s.deleted &&
        s.keyword &&
        s.keyword.toLowerCase() === keyword.toLowerCase(),
    );
  }

  /** 获取分类列表 */
  getCategories(snippets: Snippet[]): string[] {
    const cats = new Set(
      snippets
        .filter((s) => !s.deleted)
        .map((s) => s.category)
        .filter(Boolean),
    );
    return Array.from(cats);
  }

  /** 导出为 JSON */
  export(snippets: Snippet[]): string {
    return JSON.stringify(snippets, null, 2);
  }

  /** 从 JSON 导入 */
  async importFromJSON(json: string, existingIds: Set<string>): Promise<{ count: number; snippets: Snippet[] }> {
    try {
      const imported: Snippet[] = JSON.parse(json);
      if (!Array.isArray(imported)) return { count: 0, snippets: await snippetsDb.getAll() };
      const newSnippets = imported.filter((s) => s.id && s.title && !existingIds.has(s.id));
      if (newSnippets.length === 0) return { count: 0, snippets: await snippetsDb.getAll() };
      for (const s of newSnippets) {
        await snippetsDb.create({
          ...s,
          version: Date.now(),
          deleted: false,
          updatedAt: Date.now(),
        });
      }
      const snippets = await snippetsDb.getAll();
      return { count: newSnippets.length, snippets };
    } catch (e) {
      handleError(e, { context: "导入短语" });
      return { count: 0, snippets: await snippetsDb.getAll() };
    }
  }
}

/** 单例 */
export const snippetService = new SnippetService();
