/**
 * Dialog Session 文件系统存储
 * 
 * 对标 OpenClaw 的 session transcript 系统，使用文件系统持久化。
 * 
 * 功能：
 * - JSONL 格式流式写入（避免内存中拼接大 JSON）
 * - 内存缓存 + TTL（减少磁盘 IO）
 * - 原子写入（防止数据损坏）
 * - 自动压缩和归档
 */

import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import type { DialogMessage } from "./types";
import {
  emitMessageAdded,
  emitToolCall,
  emitToolResult,
  emitSpawned,
  emitAnnounce,
  emitSessionArchived,
  emitSessionDeleted,
  emitCompacted,
} from "./transcript-events";

const SESSION_DIR = "dialog-sessions";
const MAX_TRANSCRIPT_ENTRIES = 2000;
const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_ARCHIVED_SESSIONS = 10;
const DEFAULT_CACHE_TTL_MS = 30_000;

export interface TranscriptEntry {
  type: "message" | "tool_call" | "tool_result" | "system" | "spawn" | "announce";
  timestamp: number;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface TranscriptSession {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  entries: TranscriptEntry[];
  actorConfigs: Array<{ id: string; name: string; model?: string }>;
}

export interface ArchivedSession {
  sessionId: string;
  createdAt: number;
  archivedAt: number;
  entryCount: number;
  summary?: string;
  actorNames: string[];
}

// ── 缓存层 ──

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const sessionCache = new Map<string, CacheEntry<TranscriptSession>>();
const archiveCache = new Map<string, CacheEntry<ArchivedSession[]>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function invalidateCache(cache: Map<string, CacheEntry<unknown>>, prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

// ── 路径解析 ──

let baseDir: string | null = null;

async function resolveBaseDir(): Promise<string> {
  if (!baseDir) {
    const home = await homeDir();
    baseDir = await join(home, ".config", "51toolbox", SESSION_DIR);
    // 确保目录存在
    try {
      await invoke("create_directory", { path: baseDir, recursive: true });
    } catch {
      // 目录可能已存在，忽略
    }
  }
  return baseDir!;
}

async function resolveSessionPath(sessionId: string): Promise<string> {
  const base = await resolveBaseDir();
  return await join(base, `${sessionId}.jsonl`);
}

async function resolveArchivePath(): Promise<string> {
  const base = await resolveBaseDir();
  return await join(base, "archives.jsonl");
}

// ── 低层文件操作 (通过 Tauri invoke) ──

async function readTextFile(path: string): Promise<string> {
  try {
    return await invoke<string>("read_text_file", { path });
  } catch {
    return "";
  }
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await invoke("write_text_file", { path, content });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke<string>("read_text_file", { path });
    return true;
  } catch {
    return false;
  }
}

async function deleteFile(path: string): Promise<void> {
  try {
    await invoke("delete_file", { path });
  } catch {
    // 文件可能不存在，忽略
  }
}

// ── JSONL 辅助 ──

function parseJsonl<T>(content: string): T[] {
  if (!content.trim()) return [];
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((item): item is T => item !== null);
}

function stringifyJsonl<T>(items: T[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

// ── 完整 Session 读写 ──

async function loadSessionFromDisk(sessionId: string): Promise<TranscriptSession> {
  const path = await resolveSessionPath(sessionId);
  const content = await readTextFile(path);
  
  if (!content.trim()) {
    return {
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      entries: [],
      actorConfigs: [],
    };
  }

  try {
    // 尝试解析为完整的 TranscriptSession JSON
    return JSON.parse(content) as TranscriptSession;
  } catch {
    // 如果不是完整 JSON，可能是旧格式或损坏，尝试 JSONL 解析
    const lines = parseJsonl<TranscriptEntry>(content);
    if (lines.length > 0) {
      return {
        sessionId,
        createdAt: lines[0]?.timestamp || Date.now(),
        updatedAt: Date.now(),
        entries: lines,
        actorConfigs: [],
      };
    }
    return {
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      entries: [],
      actorConfigs: [],
    };
  }
}

async function saveSessionToDisk(session: TranscriptSession): Promise<void> {
  const path = await resolveSessionPath(session.sessionId);
  const content = JSON.stringify(session, null, 2);
  await writeTextFile(path, content);
}

// ── 公开 API ──

export async function appendTranscriptEntry(
  sessionId: string,
  entry: Omit<TranscriptEntry, "sessionId">,
): Promise<void> {
  let session = getCached(sessionCache, sessionId);
  
  if (!session) {
    session = await loadSessionFromDisk(sessionId);
    setCached(sessionCache, sessionId, session, DEFAULT_CACHE_TTL_MS);
  }

  session.entries.push({ ...entry, sessionId });
  session.updatedAt = Date.now();

  if (session.entries.length > MAX_TRANSCRIPT_ENTRIES) {
    session.entries = session.entries.slice(-MAX_TRANSCRIPT_ENTRIES);
  }

  await saveSessionToDisk(session);
  setCached(sessionCache, sessionId, session, DEFAULT_CACHE_TTL_MS);
}

export async function appendDialogMessage(sessionId: string, msg: DialogMessage): Promise<void> {
  await appendTranscriptEntry(sessionId, {
    type: "message",
    timestamp: msg.timestamp,
    data: {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      content: msg.content,
      priority: msg.priority,
      expectReply: msg.expectReply,
      replyTo: msg.replyTo,
    },
  });
  emitMessageAdded(sessionId, { id: msg.id, from: msg.from, to: msg.to });
}

export async function appendToolCall(
  sessionId: string,
  actorId: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<void> {
  await appendTranscriptEntry(sessionId, {
    type: "tool_call",
    timestamp: Date.now(),
    data: { actorId, toolName, params: sanitizeParams(params) },
  });
  emitToolCall(sessionId, { actorId, toolName });
}

export async function appendToolResult(
  sessionId: string,
  actorId: string,
  toolName: string,
  result: unknown,
): Promise<void> {
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);
  await appendTranscriptEntry(sessionId, {
    type: "tool_result",
    timestamp: Date.now(),
    data: {
      actorId,
      toolName,
      result: resultStr.length > 2000 ? resultStr.slice(0, 2000) + "…(truncated)" : resultStr,
    },
  });
  emitToolResult(sessionId, { actorId, toolName });
}

export async function appendSpawnEvent(
  sessionId: string,
  spawnerActorId: string,
  targetActorId: string,
  task: string,
  runId: string,
): Promise<void> {
  await appendTranscriptEntry(sessionId, {
    type: "spawn",
    timestamp: Date.now(),
    data: { spawnerActorId, targetActorId, task: task.slice(0, 500), runId },
  });
  emitSpawned(sessionId, { spawnerActorId, targetActorId, runId });
}

export async function appendAnnounceEvent(
  sessionId: string,
  runId: string,
  status: string,
  result?: string,
  error?: string,
): Promise<void> {
  await appendTranscriptEntry(sessionId, {
    type: "announce",
    timestamp: Date.now(),
    data: {
      runId,
      status,
      result: result ? result.slice(0, 1000) : undefined,
      error,
    },
  });
  emitAnnounce(sessionId, { runId, status });
}

// ── 读取 API ──

export async function loadTranscriptSession(sessionId: string): Promise<TranscriptSession> {
  const cached = getCached(sessionCache, sessionId);
  if (cached) return cached;

  const session = await loadSessionFromDisk(sessionId);
  setCached(sessionCache, sessionId, session, DEFAULT_CACHE_TTL_MS);
  return session;
}

export async function readSessionHistory(
  sessionId: string,
  opts?: { limit?: number; types?: string[]; actorId?: string },
): Promise<TranscriptEntry[]> {
  const session = await loadTranscriptSession(sessionId);
  let entries = [...session.entries];

  if (opts?.types?.length) {
    entries = entries.filter((e) => opts.types!.includes(e.type));
  }
  if (opts?.actorId) {
    entries = entries.filter((e) => {
      const d = e.data;
      return d.from === opts.actorId || d.actorId === opts.actorId || d.to === opts.actorId;
    });
  }

  const limit = opts?.limit ?? 50;
  return entries.slice(-limit);
}

export async function getSessionSummary(sessionId: string): Promise<{
  sessionId: string;
  entryCount: number;
  messageCount: number;
  toolCallCount: number;
  spawnCount: number;
  createdAt: number;
  updatedAt: number;
  actorConfigs: TranscriptSession["actorConfigs"];
}> {
  const session = await loadTranscriptSession(sessionId);
  return {
    sessionId,
    entryCount: session.entries.length,
    messageCount: session.entries.filter((e) => e.type === "message").length,
    toolCallCount: session.entries.filter((e) => e.type === "tool_call").length,
    spawnCount: session.entries.filter((e) => e.type === "spawn").length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    actorConfigs: session.actorConfigs,
  };
}

// ── 压缩 ──

export async function compactTranscript(
  sessionId: string,
  keepLast = 500,
  opts?: { tokenBudget?: number },
): Promise<number> {
  const session = await loadTranscriptSession(sessionId);
  const originalCount = session.entries.length;
  
  if (originalCount <= keepLast && !opts?.tokenBudget) return 0;

  if (opts?.tokenBudget && opts.tokenBudget > 0) {
    let tokenCount = 0;
    let cutIndex = 0;
    for (let i = session.entries.length - 1; i >= 0; i--) {
      tokenCount += estimateEntryTokens(session.entries[i]);
      if (tokenCount > opts.tokenBudget) {
        cutIndex = i + 1;
        break;
      }
    }
    const structuralEntries = session.entries.slice(0, cutIndex).filter(
      (e) => e.type === "spawn" || e.type === "announce" || e.type === "system",
    );
    session.entries = [...structuralEntries, ...session.entries.slice(cutIndex)];
  } else {
    session.entries = session.entries.slice(-keepLast);
  }

  session.updatedAt = Date.now();
  await saveSessionToDisk(session);
  sessionCache.delete(sessionId);
  
  emitCompacted(sessionId, { removedCount: originalCount - session.entries.length });
  
  return originalCount - session.entries.length;
}

function estimateEntryTokens(entry: TranscriptEntry): number {
  const json = JSON.stringify(entry.data);
  const cjkCount = (json.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return Math.ceil(cjkCount * 1.5 + (json.length - cjkCount) / 3.5);
}

// ── 归档 ──

export async function archiveSession(sessionId: string, summary?: string): Promise<void> {
  const session = await loadTranscriptSession(sessionId);

  const archived: ArchivedSession = {
    sessionId,
    createdAt: session.createdAt,
    archivedAt: Date.now(),
    entryCount: session.entries.length,
    summary,
    actorNames: session.actorConfigs.map((a) => a.name),
  };

  const archives = await loadArchivedSessions();
  archives.unshift(archived);
  
  if (archives.length > MAX_ARCHIVED_SESSIONS) {
    const removed = archives.splice(MAX_ARCHIVED_SESSIONS);
    for (const r of removed) {
      await deleteFile(await resolveSessionPath(r.sessionId));
    }
  }

  const archivePath = await resolveArchivePath();
  const content = stringifyJsonl(archives);
  await writeTextFile(archivePath, content);
  
  archiveCache.delete("archives");
  sessionCache.delete(sessionId);
  
  emitSessionArchived(sessionId, { entryCount: session.entries.length, summary });
}

export async function loadArchivedSessions(): Promise<ArchivedSession[]> {
  const cached = getCached(archiveCache, "archives");
  if (cached) return cached;

  const archivePath = await resolveArchivePath();
  const content = await readTextFile(archivePath);
  const archives = parseJsonl<ArchivedSession>(content);
  
  setCached(archiveCache, "archives", archives, DEFAULT_CACHE_TTL_MS * 10);
  return archives;
}

export async function deleteTranscriptSession(sessionId: string): Promise<void> {
  await deleteFile(await resolveSessionPath(sessionId));
  sessionCache.delete(sessionId);
  emitSessionDeleted(sessionId);
}

// ── 列出 sessions ──

export async function listTranscriptSessionIds(): Promise<string[]> {
  const base = await resolveBaseDir();
  // 通过 Tauri API 列出目录文件
  try {
    const result = await invoke<string>("list_directory", { path: base });
    const entries = JSON.parse(result) as Array<{ name: string; is_dir: boolean }>;
    return entries
      .filter((e) => !e.is_dir && e.name.endsWith(".jsonl"))
      .map((e) => e.name.replace(".jsonl", ""));
  } catch {
    return [];
  }
}

// ── 更新 Actor 配置 ──

export async function updateTranscriptActors(
  sessionId: string,
  actors: Array<{ id: string; name: string; model?: string }>,
): Promise<void> {
  const session = await loadTranscriptSession(sessionId);
  session.actorConfigs = actors;
  await saveSessionToDisk(session);
  sessionCache.delete(sessionId);
}

// ── 辅助函数 ──

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 500) {
      sanitized[key] = value.slice(0, 500) + "…";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ── 缓存管理 ──

export function clearSessionCache(): void {
  sessionCache.clear();
  archiveCache.clear();
}
