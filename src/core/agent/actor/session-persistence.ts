/**
 * Session 持久化增强模块
 *
 * 对标 OpenClaw 的 session 持久化系统：
 * - 写入锁机制（防止并发写入）
 * - 原子写入（防止数据损坏）
 * - 磁盘预算管理（自动清理旧 session）
 * - 错误恢复机制
 */

import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";

const SESSION_DIR = "dialog-sessions";

// ═══════════════════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════════════════

export interface PersistenceConfig {
  /** 缓存 TTL (毫秒) */
  cacheTtlMs: number;
  /** 最大 session 条目数 */
  maxEntries: number;
  /** 最大 session 大小 (字节) */
  maxSessionBytes: number;
  /** 最大归档 session 数 */
  maxArchivedSessions: number;
  /** 磁盘预算最大值 (字节) */
  maxDiskBytes: number;
  /** 磁盘预算警戒线 (字节) */
  highWaterBytes: number;
  /** Session 过期时间 (毫秒) */
  sessionTtlMs: number;
  /** 是否启用磁盘预算检查 */
  enableDiskBudget: boolean;
  /** 是否启用写入锁 */
  enableWriteLock: boolean;
}

export const DEFAULT_PERSISTENCE_CONFIG: PersistenceConfig = {
  cacheTtlMs: 30_000,
  maxEntries: 2000,
  maxSessionBytes: 512 * 1024,
  maxArchivedSessions: 10,
  maxDiskBytes: 100 * 1024 * 1024, // 100MB
  highWaterBytes: 80 * 1024 * 1024, // 80MB
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 天
  enableDiskBudget: true,
  enableWriteLock: true,
};

let globalConfig: PersistenceConfig = { ...DEFAULT_PERSISTENCE_CONFIG };

export function updatePersistenceConfig(
  updates: Partial<PersistenceConfig>,
): void {
  globalConfig = { ...globalConfig, ...updates };
}

export function getPersistenceConfig(): PersistenceConfig {
  return { ...globalConfig };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 路径解析
// ═══════════════════════════════════════════════════════════════════════════════

let baseDir: string | null = null;

async function resolveBaseDir(): Promise<string> {
  if (!baseDir) {
    const home = await homeDir();
    baseDir = await join(home, ".config", "HiClow", SESSION_DIR);
    try {
      await invoke("create_directory", { path: baseDir, recursive: true });
    } catch {
      /* ignore */
    }
  }
  return baseDir!;
}

export async function resolveSessionPath(sessionId: string): Promise<string> {
  const base = await resolveBaseDir();
  return await join(base, `${sessionId}.json`);
}

export async function resolveArchivePath(): Promise<string> {
  const base = await resolveBaseDir();
  return await join(base, "archives.json");
}

export async function resolveIndexPath(): Promise<string> {
  const base = await resolveBaseDir();
  return await join(base, "index.json");
}

export async function resolveLockPath(sessionId: string): Promise<string> {
  const base = await resolveBaseDir();
  return await join(base, `.lock.${sessionId}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 文件操作 (底层)
// ═══════════════════════════════════════════════════════════════════════════════

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

async function deleteFile(path: string): Promise<void> {
  try {
    await invoke("delete_file", { path });
  } catch {
    /* ignore */
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke<string>("read_text_file", { path });
    return true;
  } catch {
    return false;
  }
}

async function listDirectory(
  path: string,
): Promise<Array<{ name: string; is_dir: boolean; size: number }>> {
  try {
    const result = await invoke<string>("list_directory", { path });
    return JSON.parse(result) as Array<{
      name: string;
      is_dir: boolean;
      size: number;
    }>;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 写入锁机制
// ═══════════════════════════════════════════════════════════════════════════════

interface LockInfo {
  sessionId: string;
  acquiredAt: number;
  expiresAt: number;
}

const activeLocks = new Map<string, LockInfo>();
const lockWaitQueue = new Map<string, Array<() => void>>();

async function acquireLock(
  sessionId: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const lockPath = await resolveLockPath(sessionId);
  const now = Date.now();
  const expiresAt = now + timeoutMs;

  // 检查是否已有锁
  const existing = activeLocks.get(sessionId);
  if (existing && now < existing.expiresAt) {
    return new Promise((resolve) => {
      let settled = false;
      const queue = lockWaitQueue.get(sessionId) ?? [];
      const callback = () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      };
      queue.push(callback);
      lockWaitQueue.set(sessionId, queue);

      setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = queue.indexOf(callback);
        if (idx >= 0) queue.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
    });
  }

  // 尝试获取锁（写入锁文件）
  try {
    const lockContent = JSON.stringify({
      sessionId,
      acquiredAt: now,
      expiresAt,
    });
    await writeTextFile(lockPath, lockContent);
    activeLocks.set(sessionId, { sessionId, acquiredAt: now, expiresAt });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(sessionId: string): void {
  activeLocks.delete(sessionId);

  // 通知等待队列中的下一个
  const queue = lockWaitQueue.get(sessionId);
  if (queue?.length) {
    const next = queue.shift();
    if (next) next();
  }
}

async function withLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!globalConfig.enableWriteLock) {
    return fn();
  }

  const acquired = await acquireLock(sessionId);
  if (!acquired) {
    throw new Error(`Failed to acquire lock for session ${sessionId}`);
  }

  try {
    return await fn();
  } finally {
    releaseLock(sessionId);
    const lockPath = await resolveLockPath(sessionId);
    await deleteFile(lockPath);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 原子写入
// ═══════════════════════════════════════════════════════════════════════════════

async function atomicWrite<T>(path: string, data: T): Promise<void> {
  const tempPath = `${path}.tmp.${Date.now()}`;
  const content = JSON.stringify(data, null, 2);

  try {
    // 写入临时文件
    await writeTextFile(tempPath, content);

    // 读取验证
    const verify = await readTextFile(tempPath);
    JSON.parse(verify); // 验证 JSON 有效

    // 删除原文件（如果存在）
    try {
      await deleteFile(path);
    } catch {
      /* ignore */
    }

    // 重命名临时文件为目标文件
    await invoke("move_file", { source: tempPath, destination: path });
  } catch (err) {
    // 写入失败，删除临时文件
    await deleteFile(tempPath);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session Index (用于快速列出所有 session)
// ═══════════════════════════════════════════════════════════════════════════════

export interface SessionIndex {
  sessions: Record<
    string,
    {
      sessionId: string;
      createdAt: number;
      updatedAt: number;
      entryCount: number;
      fileSize: number;
      archived: boolean;
    }
  >;
  lastUpdated: number;
}

let sessionIndexCache: SessionIndex | null = null;

async function loadIndex(): Promise<SessionIndex> {
  if (sessionIndexCache) return sessionIndexCache;

  const path = await resolveIndexPath();
  const content = await readTextFile(path);

  if (content) {
    try {
      sessionIndexCache = JSON.parse(content) as SessionIndex;
      return sessionIndexCache!;
    } catch {
      /* corrupt */
    }
  }

  sessionIndexCache = { sessions: {}, lastUpdated: Date.now() };
  return sessionIndexCache;
}

async function saveIndex(index: SessionIndex): Promise<void> {
  index.lastUpdated = Date.now();
  const path = await resolveIndexPath();
  await atomicWrite(path, index);
  sessionIndexCache = index;
}

async function updateIndexEntry(
  sessionId: string,
  updates: Partial<SessionIndex["sessions"][string]>,
): Promise<void> {
  const index = await loadIndex();
  const existing = index.sessions[sessionId];

  if (existing) {
    index.sessions[sessionId] = { ...existing, ...updates };
  } else {
    index.sessions[sessionId] = {
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      entryCount: 0,
      fileSize: 0,
      archived: false,
      ...updates,
    };
  }

  await saveIndex(index);
}

async function removeIndexEntry(sessionId: string): Promise<void> {
  const index = await loadIndex();
  delete index.sessions[sessionId];
  await saveIndex(index);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 磁盘预算管理
// ═══════════════════════════════════════════════════════════════════════════════

export interface DiskBudgetResult {
  freedBytes: number;
  deletedSessions: string[];
  warnings: string[];
}

async function calculateDiskUsage(): Promise<number> {
  const base = await resolveBaseDir();
  const entries = await listDirectory(base);

  let total = 0;
  for (const entry of entries) {
    if (!entry.is_dir && !entry.name.startsWith(".")) {
      total += entry.size;
    }
  }
  return total;
}

async function enforceDiskBudget(
  activeSessionId?: string,
): Promise<DiskBudgetResult> {
  if (!globalConfig.enableDiskBudget) {
    return { freedBytes: 0, deletedSessions: [], warnings: [] };
  }

  const currentUsage = await calculateDiskUsage();

  if (currentUsage < globalConfig.highWaterBytes) {
    return { freedBytes: 0, deletedSessions: [], warnings: [] };
  }

  const warnings: string[] = [];
  if (currentUsage >= globalConfig.maxDiskBytes) {
    warnings.push(
      `Disk usage ${currentUsage} bytes exceeds max ${globalConfig.maxDiskBytes} bytes`,
    );
  }

  // 加载索引并按更新时间排序
  const index = await loadIndex();
  const sessions = Object.values(index.sessions)
    .filter((s) => !s.archived && s.sessionId !== activeSessionId)
    .sort((a, b) => a.updatedAt - b.updatedAt);

  let freedBytes = 0;
  const deletedSessions: string[] = [];
  const now = Date.now();

  for (const session of sessions) {
    if (currentUsage - freedBytes <= globalConfig.highWaterBytes) break;

    // 检查是否过期
    const age = now - session.updatedAt;
    if (age < globalConfig.sessionTtlMs) continue;

    // 删除旧 session
    const sessionPath = await resolveSessionPath(session.sessionId);
    await deleteFile(sessionPath);
    await removeIndexEntry(session.sessionId);

    freedBytes += session.fileSize;
    deletedSessions.push(session.sessionId);
  }

  // 如果还不够，删除归档
  if (currentUsage - freedBytes > globalConfig.highWaterBytes) {
    const archives = Object.entries(index.sessions)
      .filter(([, s]) => s.archived)
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt);

    for (const [id, archive] of archives) {
      if (currentUsage - freedBytes <= globalConfig.highWaterBytes) break;

      const sessionPath = await resolveSessionPath(id);
      await deleteFile(sessionPath);
      await removeIndexEntry(id);

      freedBytes += archive.fileSize;
      deletedSessions.push(id);
    }
  }

  return { freedBytes, deletedSessions, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session 写入/读取
// ═══════════════════════════════════════════════════════════════════════════════

export interface TranscriptEntry {
  type:
    | "message"
    | "tool_call"
    | "tool_result"
    | "system"
    | "spawn"
    | "announce";
  timestamp: number;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface TranscriptSession {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  entries: TranscriptEntry[];
  actorConfigs: Array<{
    id: string;
    name: string;
    model?: string;
    maxIterations?: number;
    systemPrompt?: string;
    capabilities?: import("./types").AgentCapabilities;
    toolPolicy?: import("./types").ToolPolicy;
    executionPolicy?: import("./types").ExecutionPolicy;
    workspace?: string;
    timeoutSeconds?: number;
    idleLeaseSeconds?: number;
    thinkingLevel?: import("./types").ThinkingLevel;
  }>;
  snapshot?: Record<string, unknown>;
}

export interface ArchivedSession {
  sessionId: string;
  createdAt: number;
  archivedAt: number;
  entryCount: number;
  summary?: string;
  actorNames: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 缓存层
// ═══════════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const sessionCache = new Map<string, CacheEntry<TranscriptSession>>();
const archiveCache = new Map<string, CacheEntry<ArchivedSession[]>>();

function getCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttl: number,
): void {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════════════════════

export async function saveSession(session: TranscriptSession): Promise<void> {
  // 压缩条目
  if (session.entries.length > globalConfig.maxEntries) {
    session.entries = session.entries.slice(-globalConfig.maxEntries);
  }

  // 更新索引
  const fileSize = JSON.stringify(session).length;
  await updateIndexEntry(session.sessionId, {
    updatedAt: session.updatedAt,
    entryCount: session.entries.length,
    fileSize,
  });

  // 原子写入
  const path = await resolveSessionPath(session.sessionId);
  await withLock(session.sessionId, () => atomicWrite(path, session));

  // 更新缓存
  setCached(sessionCache, session.sessionId, session, globalConfig.cacheTtlMs);

  // 检查磁盘预算
  if (globalConfig.enableDiskBudget) {
    const budgetResult = await enforceDiskBudget(session.sessionId);
    if (budgetResult.warnings.length) {
      console.warn(
        "[SessionPersistence] Disk budget warnings:",
        budgetResult.warnings,
      );
    }
  }
}

export async function loadSession(
  sessionId: string,
): Promise<TranscriptSession | null> {
  // 检查缓存
  const cached = getCached(sessionCache, sessionId);
  if (cached) return cached;

  // 从磁盘加载
  const path = await resolveSessionPath(sessionId);
  const content = await readTextFile(path);

  if (!content) return null;

  try {
    const session = JSON.parse(content) as TranscriptSession;
    setCached(sessionCache, sessionId, session, globalConfig.cacheTtlMs);
    return session;
  } catch {
    return null;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const path = await resolveSessionPath(sessionId);
  await deleteFile(path);
  await removeIndexEntry(sessionId);
  sessionCache.delete(sessionId);
}

export async function listAllSessions(): Promise<string[]> {
  const index = await loadIndex();
  return Object.keys(index.sessions);
}

export async function getLatestActiveSessionId(): Promise<string | null> {
  const index = await loadIndex();
  const latest = Object.values(index.sessions)
    .filter((session) => !session.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return latest?.sessionId ?? null;
}

export async function archiveSession(
  sessionId: string,
  summary?: string,
): Promise<void> {
  const session = await loadSession(sessionId);
  if (!session) return;

  // 创建归档记录
  const archive: ArchivedSession = {
    sessionId,
    createdAt: session.createdAt,
    archivedAt: Date.now(),
    entryCount: session.entries.length,
    summary,
    actorNames: session.actorConfigs.map((a) => a.name),
  };

  // 加载现有归档
  const archivePath = await resolveArchivePath();
  let archives: ArchivedSession[] = [];
  const content = await readTextFile(archivePath);
  if (content) {
    try {
      archives = JSON.parse(content) as ArchivedSession[];
    } catch {
      /* corrupt */
    }
  }

  // 添加新归档
  archives.unshift(archive);

  // 限制数量
  if (archives.length > globalConfig.maxArchivedSessions) {
    const removed = archives.splice(globalConfig.maxArchivedSessions);
    for (const r of removed) {
      await deleteSession(r.sessionId);
    }
  }

  // 写入归档
  await atomicWrite(archivePath, archives);

  // 更新索引
  await updateIndexEntry(sessionId, { archived: true, fileSize: 0 });

  // 清理缓存
  sessionCache.delete(sessionId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════════

export function clearCache(): void {
  sessionCache.clear();
  archiveCache.clear();
}

export async function getDiskUsage(): Promise<{
  totalBytes: number;
  sessionCount: number;
  archivedCount: number;
}> {
  const index = await loadIndex();
  const sessions = Object.values(index.sessions);

  return {
    totalBytes: sessions.reduce((sum, s) => sum + s.fileSize, 0),
    sessionCount: sessions.filter((s) => !s.archived).length,
    archivedCount: sessions.filter((s) => s.archived).length,
  };
}
