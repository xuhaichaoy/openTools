/**
 * Marks 数据模型 — 快速录入的核心数据结构
 * 来源: note-gen 的 Marks 概念
 */

import { SyncableCollection, type SyncMeta } from "./index";

/** 录入类型 */
export type MarkType =
  | "text"
  | "image"
  | "link"
  | "file"
  | "recording"
  | "todo"
  | "scan";

/** 录入条目 */
export interface Mark extends SyncMeta {
  id: string;
  /** 录入类型 */
  type: MarkType;
  /** 内容（文本、URL、文件路径等） */
  content: string;
  /** 标签列表 */
  tags: string[];
  /** 创建时间 (毫秒时间戳) */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 标题（可选） */
  title?: string;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
  /** 是否已归档 */
  archived?: boolean;
  /** 是否已用于生成笔记 */
  usedInNote?: boolean;
  /** 版本号（同步用，兼容旧字段） */
  version: number;
  /** 是否已删除（软删除，同步用） */
  deleted: boolean;
}

/** 标签 */
export interface Tag extends SyncMeta {
  id: string;
  name: string;
  color?: string;
  createdAt: number;
  /** 版本号（同步用，兼容旧字段） */
  version: number;
  /** 是否已删除（软删除，同步用） */
  deleted: boolean;
}

/** 生成唯一 ID */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── 数据库集合实例 ──

export const marksDb = new SyncableCollection<Mark>("marks");
export const tagsDb = new SyncableCollection<Tag>("tags");

// ── 便捷操作方法 ──

/** 创建一条新的 Mark */
export async function createMark(
  type: MarkType,
  content: string,
  options?: {
    tags?: string[];
    title?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<Mark> {
  const now = Date.now();
  const mark: Mark = {
    id: generateId(),
    type,
    content,
    tags: options?.tags ?? [],
    createdAt: now,
    updatedAt: now,
    title: options?.title,
    metadata: options?.metadata,
    version: now,
    deleted: false,
  };
  return marksDb.create(mark);
}

/** 更新 Mark */
export async function updateMark(
  id: string,
  updates: Partial<Mark>,
): Promise<Mark | undefined> {
  return marksDb.update(id, {
    ...updates,
    version: Date.now(),
    updatedAt: Date.now(),
  });
}

/** 归档 Mark (软更新) */
export async function archiveMark(id: string): Promise<Mark | undefined> {
  return updateMark(id, { archived: true });
}

/** 删除 Mark (软删除) */
export async function deleteMark(id: string): Promise<Mark | undefined> {
  return updateMark(id, { deleted: true });
}

/** 删除 Tag (软删除) */
export async function deleteTag(id: string): Promise<Tag | undefined> {
  return tagsDb.update(id, {
    deleted: true,
    version: Date.now(),
  });
}

/** 按标签查询 Marks */
export async function getMarksByTag(tag: string): Promise<Mark[]> {
  return marksDb.query((m) => !m.deleted && m.tags.includes(tag));
}

/** 按类型查询 Marks */
export async function getMarksByType(type: MarkType): Promise<Mark[]> {
  return marksDb.query((m) => !m.deleted && m.type === type);
}

/** 搜索 Marks（简单文本匹配） */
export async function searchMarks(keyword: string): Promise<Mark[]> {
  const lower = keyword.toLowerCase();
  return marksDb.query(
    (m) =>
      !m.deleted &&
      (m.content.toLowerCase().includes(lower) ||
        (m.title?.toLowerCase().includes(lower) ?? false) ||
        m.tags.some((t) => t.toLowerCase().includes(lower))),
  );
}

/** 获取所有未归档的 Marks */
export async function getActiveMarks(): Promise<Mark[]> {
  return marksDb.query((m) => !m.deleted && !m.archived);
}

/** 获取所有标签 */
export async function getAllTags(): Promise<Tag[]> {
  return tagsDb.query((t) => !t.deleted);
}

/** 创建新标签 */
export async function createTag(name: string, color?: string): Promise<Tag> {
  const tag: Tag = {
    id: generateId(),
    name,
    color,
    createdAt: Date.now(),
    version: Date.now(),
    deleted: false,
  };
  return tagsDb.create(tag);
}
