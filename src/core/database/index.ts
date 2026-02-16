/**
 * 数据库层 — 基于 Tauri Store 的轻量级持久化
 *
 * 为不需要 SQLite 的场景提供 JSON 文件存储，
 * 同时为 Marks、Tags 等结构化数据提供统一的 CRUD 接口。
 *
 * 使用 tauri-plugin-fs 进行文件读写，数据以 JSON 格式存储在 AppData 目录。
 */

import {
  readTextFile,
  writeTextFile,
  mkdir,
  exists,
} from "@tauri-apps/plugin-fs";
import { BaseDirectory } from "@tauri-apps/plugin-fs";

const DB_DIR = "mtools-db";

/** 确保数据库目录存在 */
async function ensureDbDir(): Promise<void> {
  if (!(await exists(DB_DIR, { baseDir: BaseDirectory.AppData }))) {
    await mkdir(DB_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  }
}

/** 同步元数据接口 — 可选，由 SyncableCollection 使用 */
export interface SyncMeta {
  _version?: number;
  _dirty?: boolean;
  _syncedAt?: number;
}

/** 通用 JSON 集合存储 */
export class JsonCollection<T extends { id: string }> {
  private name: string;
  private cache: T[] | null = null;

  constructor(name: string) {
    this.name = name;
  }

  private get filePath(): string {
    return `${DB_DIR}/${this.name}.json`;
  }

  /** 加载所有数据 */
  async getAll(): Promise<T[]> {
    if (this.cache) return this.cache;
    await ensureDbDir();
    try {
      const raw = await readTextFile(this.filePath, {
        baseDir: BaseDirectory.AppData,
      });
      this.cache = JSON.parse(raw) as T[];
      return this.cache;
    } catch (e) {
      console.error(`[JsonCollection] Failed to load ${this.name}:`, e);
      this.cache = [];
      return [];
    }
  }

  /** 保存所有数据 */
  private async saveAll(items: T[]): Promise<void> {
    await ensureDbDir();
    this.cache = items;
    await writeTextFile(this.filePath, JSON.stringify(items, null, 2), {
      baseDir: BaseDirectory.AppData,
    }).catch((e) =>
      console.error(`[JsonCollection] Failed to save ${this.name}:`, e),
    );
  }

  /** 通过 ID 获取单条 */
  async getById(id: string): Promise<T | undefined> {
    const all = await this.getAll();
    return all.find((item) => item.id === id);
  }

  /** 新增一条 */
  async create(item: T): Promise<T> {
    const all = await this.getAll();
    all.unshift(item); // 新增的放最前
    await this.saveAll(all);
    return item;
  }

  /** 更新一条 */
  async update(id: string, partial: Partial<T>): Promise<T | undefined> {
    const all = await this.getAll();
    const idx = all.findIndex((item) => item.id === id);
    if (idx === -1) return undefined;
    all[idx] = { ...all[idx], ...partial };
    await this.saveAll(all);
    return all[idx];
  }

  /** 删除一条 */
  async delete(id: string): Promise<boolean> {
    const all = await this.getAll();
    const idx = all.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    all.splice(idx, 1);
    await this.saveAll(all);
    return true;
  }

  /** 批量删除 */
  async deleteMany(ids: string[]): Promise<number> {
    const all = await this.getAll();
    const idSet = new Set(ids);
    const filtered = all.filter((item) => !idSet.has(item.id));
    const deleted = all.length - filtered.length;
    if (deleted > 0) await this.saveAll(filtered);
    return deleted;
  }

  /** 查询（自定义过滤） */
  async query(predicate: (item: T) => boolean): Promise<T[]> {
    const all = await this.getAll();
    return all.filter(predicate);
  }

  /** 获取数量 */
  async count(): Promise<number> {
    const all = await this.getAll();
    return all.length;
  }

  /** 清空缓存（下次读取时重新从文件加载） */
  invalidateCache(): void {
    this.cache = null;
  }

  /** 批量设置（同步引擎 pull 后覆盖用） */
  async setAll(items: T[]): Promise<void> {
    await this.saveAll(items);
  }
}

/**
 * 支持同步的 JSON 集合 — 写操作自动维护 _version/_dirty/_syncedAt
 *
 * T 必须同时拥有 SyncMeta 中的字段（声明为可选）。
 * 适用于 Marks、Tags 等需要与服务端同步的数据集合。
 */
export class SyncableCollection<
  T extends { id: string } & SyncMeta,
> extends JsonCollection<T> {
  /** 新增一条，自动标记 dirty */
  override async create(item: T): Promise<T> {
    const now = Date.now();
    const syncItem = {
      ...item,
      _version: item._version ?? now,
      _dirty: true,
      _syncedAt: item._syncedAt ?? undefined,
    };
    return super.create(syncItem);
  }

  /** 更新一条，自动递增版本、标记 dirty */
  override async update(
    id: string,
    partial: Partial<T>,
  ): Promise<T | undefined> {
    const merged = {
      ...partial,
      _version: Date.now(),
      _dirty: true,
    } as Partial<T>;
    return super.update(id, merged);
  }

  /** 软删除（标记 deleted + dirty） */
  async softDelete(id: string): Promise<T | undefined> {
    return this.update(id, {
      deleted: true,
      _version: Date.now(),
      _dirty: true,
    } as unknown as Partial<T>);
  }

  /** 获取所有 dirty 条目（待推送） */
  async getDirty(): Promise<T[]> {
    return this.query((item) => item._dirty === true);
  }

  /** 同步完成后，清除 dirty 标记、更新 _syncedAt */
  async markSynced(ids: string[]): Promise<void> {
    const all = await this.getAll();
    const now = Date.now();
    let changed = false;
    for (const item of all) {
      if (ids.includes(item.id) && item._dirty) {
        item._dirty = false;
        item._syncedAt = now;
        changed = true;
      }
    }
    if (changed) {
      await this.setAll(all);
    }
  }

  /** 批量合并云端数据（pull 后调用），只合并版本更高的条目 */
  async mergeFromCloud(
    cloudItems: Array<{
      data_id: string;
      content: Record<string, unknown>;
      version: number;
      deleted: boolean;
    }>,
  ): Promise<number> {
    const all = await this.getAll();
    let merged = 0;

    for (const cloud of cloudItems) {
      const idx = all.findIndex((i) => i.id === cloud.data_id);
      const cloudVersion = cloud.version;

      if (idx >= 0) {
        const localVersion = all[idx]._version ?? 0;
        if (cloudVersion > localVersion) {
          all[idx] = {
            ...all[idx],
            ...cloud.content,
            id: cloud.data_id,
            _version: cloudVersion,
            _dirty: false,
            _syncedAt: Date.now(),
            deleted: cloud.deleted,
          } as T;
          merged++;
        }
      } else {
        all.unshift({
          ...cloud.content,
          id: cloud.data_id,
          _version: cloudVersion,
          _dirty: false,
          _syncedAt: Date.now(),
          deleted: cloud.deleted,
        } as T);
        merged++;
      }
    }

    if (merged > 0) {
      await this.setAll(all);
    }
    return merged;
  }
}
