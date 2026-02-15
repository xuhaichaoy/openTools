/**
 * Marks 数据模型 — 快速录入的核心数据结构
 * 来源: note-gen 的 Marks 概念
 */

import { JsonCollection } from "./index";

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
export interface Mark {
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
}

/** 标签 */
export interface Tag {
  id: string;
  name: string;
  color?: string;
  createdAt: number;
}

/** 生成唯一 ID */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── 数据库集合实例 ──

export const marksDb = new JsonCollection<Mark>("marks");
export const tagsDb = new JsonCollection<Tag>("tags");

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
  };
  return marksDb.create(mark);
}

/** 按标签查询 Marks */
export async function getMarksByTag(tag: string): Promise<Mark[]> {
  return marksDb.query((m) => m.tags.includes(tag));
}

/** 按类型查询 Marks */
export async function getMarksByType(type: MarkType): Promise<Mark[]> {
  return marksDb.query((m) => m.type === type);
}

/** 搜索 Marks（简单文本匹配） */
export async function searchMarks(keyword: string): Promise<Mark[]> {
  const lower = keyword.toLowerCase();
  return marksDb.query(
    (m) =>
      m.content.toLowerCase().includes(lower) ||
      (m.title?.toLowerCase().includes(lower) ?? false) ||
      m.tags.some((t) => t.toLowerCase().includes(lower)),
  );
}

/** 获取所有未归档的 Marks */
export async function getActiveMarks(): Promise<Mark[]> {
  return marksDb.query((m) => !m.archived);
}

/** 获取所有标签 */
export async function getAllTags(): Promise<Tag[]> {
  return tagsDb.getAll();
}

/** 创建新标签 */
export async function createTag(
  name: string,
  color?: string,
): Promise<Tag> {
  const tag: Tag = {
    id: generateId(),
    name,
    color,
    createdAt: Date.now(),
  };
  return tagsDb.create(tag);
}
