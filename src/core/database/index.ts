/**
 * 数据库层 — 基于 Rust Collection 命令的轻量级持久化
 *
 * 为不需要 SQLite 的场景提供 JSON 文件存储，
 * 同时为 Marks、Tags 等结构化数据提供统一的 CRUD 接口。
 *
 * 所有文件 I/O 统一通过 Rust invoke() 完成，Rust 侧使用 RwLock 避免并发冲突。
 */

import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";

/** 同步元数据接口 — 可选，由 SyncableCollection 使用 */
export interface SyncMeta {
  _version?: number;
  _dirty?: boolean;
  _syncedAt?: number;
  /** 软删除标记（SyncableCollection.softDelete 使用） */
  deleted?: boolean;
}

/** 通用 JSON 集合存储 */
export class JsonCollection<T extends { id: string }> {
  private name: string;
  private cache: T[] | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /** 加载所有数据 */
  async getAll(): Promise<T[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await invoke<string>("collection_get_all", { name: this.name });
      this.cache = JSON.parse(raw) as T[];
      return this.cache;
    } catch (e) {
      handleError(e, { context: `加载数据集 ${this.name}`, silent: true });
      this.cache = [];
      return [];
    }
  }

  /** 保存所有数据（内部使用，覆盖整个集合） */
  private async saveAll(items: T[]): Promise<void> {
    this.cache = items;
    await invoke("collection_set_all", {
      name: this.name,
      items: JSON.stringify(items),
    }).catch((e) =>
      handleError(e, { context: `保存数据集 ${this.name}` }),
    );
  }

  /** 通过 ID 获取单条 */
  async getById(id: string): Promise<T | undefined> {
    const all = await this.getAll();
    return all.find((item) => item.id === id);
  }

  /** 新增一条 */
  async create(item: T): Promise<T> {
    try {
      await invoke("collection_create", {
        name: this.name,
        item: JSON.stringify(item),
      });
      // 更新缓存（插入头部，与 Rust 行为一致）
      if (this.cache) {
        this.cache.unshift(item);
      } else {
        this.cache = [item];
      }
    } catch (e) {
      handleError(e, { context: `创建数据 ${this.name}` });
      // 回退到全量写入
      const all = await this.getAll();
      all.unshift(item);
      await this.saveAll(all);
    }
    return item;
  }

  /** 更新一条 */
  async update(id: string, partial: Partial<T>): Promise<T | undefined> {
    try {
      const raw = await invoke<string>("collection_update", {
        name: this.name,
        id,
        partial: JSON.stringify(partial),
      });
      const updated = JSON.parse(raw) as T;
      // 更新缓存
      if (this.cache) {
        const idx = this.cache.findIndex((item) => item.id === id);
        if (idx !== -1) this.cache[idx] = updated;
      }
      return updated;
    } catch (e) {
      handleError(e, { context: `更新数据 ${this.name}` });
      // 回退到缓存内操作 + 全量写入
      const all = await this.getAll();
      const idx = all.findIndex((item) => item.id === id);
      if (idx === -1) return undefined;
      all[idx] = { ...all[idx], ...partial };
      await this.saveAll(all);
      return all[idx];
    }
  }

  /** 删除一条 */
  async delete(id: string): Promise<boolean> {
    try {
      const deleted = await invoke<boolean>("collection_delete", {
        name: this.name,
        id,
      });
      // 更新缓存
      if (deleted && this.cache) {
        this.cache = this.cache.filter((item) => item.id !== id);
      }
      return deleted;
    } catch (e) {
      handleError(e, { context: `删除数据 ${this.name}` });
      // 回退
      const all = await this.getAll();
      const idx = all.findIndex((item) => item.id === id);
      if (idx === -1) return false;
      all.splice(idx, 1);
      await this.saveAll(all);
      return true;
    }
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
    } as Partial<T>);
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
