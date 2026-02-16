import { api } from "@/core/api/client";
import { load } from "@tauri-apps/plugin-store";
import type { SyncableCollection, SyncMeta } from "@/core/database/index";

export interface SyncItem {
  data_id: string;
  content: any;
  version: number;
  deleted: boolean;
}

export interface SyncPullResponse {
  items: Array<{
    data_id: string;
    content: any;
    version: number;
    deleted: boolean;
  }>;
  latest_version: number;
}

// ── 版本追踪（持久化到 Tauri Store） ──

let _syncVersionStore: Awaited<ReturnType<typeof load>> | null = null;
async function getSyncVersionStore() {
  if (!_syncVersionStore) {
    _syncVersionStore = await load("sync-versions.json", { autoSave: true });
  }
  return _syncVersionStore;
}

export async function getLastSyncVersion(dataType: string): Promise<number> {
  const store = await getSyncVersionStore();
  return (await store.get<number>(`version_${dataType}`)) ?? 0;
}

export async function setLastSyncVersion(dataType: string, version: number): Promise<void> {
  const store = await getSyncVersionStore();
  await store.set(`version_${dataType}`, version);
  await store.save();
}

// ── 底层网络操作 ──

export async function pullData(dataType: string, afterVersion: number = 0): Promise<SyncPullResponse | null> {
  try {
    return await api.get<SyncPullResponse>("/sync/pull", {
      data_type: dataType,
      after_version: afterVersion,
    });
  } catch (e) {
    console.error(`[Sync] Pull ${dataType} failed:`, e);
    return null;
  }
}

export async function pushData(dataType: string, items: SyncItem[]): Promise<boolean> {
  if (items.length === 0) return true;
  try {
    await api.post("/sync/push", { data_type: dataType, items });
    return true;
  } catch (e) {
    console.error(`[Sync] Push ${dataType} failed:`, e);
    return false;
  }
}

// ── 通用 Zustand Store 同步（bookmark-store, snippet-store） ──

export async function syncStore<T extends { id: string; version?: number; deleted?: boolean }>(opts: {
  dataType: string;
  getItems: () => T[];
  setItems: (items: T[]) => void;
  extractContent: (item: T) => any;
  buildItem: (data_id: string, content: any, version: number, deleted: boolean) => T;
}): Promise<void> {
  const { dataType, getItems, setItems, extractContent, buildItem } = opts;
  const lastVersion = await getLastSyncVersion(dataType);

  // 1. PULL
  const cloudData = await pullData(dataType, lastVersion);
  const localItems = [...getItems()];

  if (cloudData && cloudData.items.length > 0) {
    for (const cloudItem of cloudData.items) {
      const idx = localItems.findIndex((i) => i.id === cloudItem.data_id);
      const merged = buildItem(
        cloudItem.data_id,
        cloudItem.content,
        cloudItem.version,
        cloudItem.deleted,
      );

      if (idx >= 0) {
        if ((localItems[idx].version ?? 0) < cloudItem.version) {
          localItems[idx] = merged;
        }
      } else {
        localItems.push(merged);
      }
    }
    setItems(localItems);
  }

  // 2. PUSH（本地新于 lastVersion 的数据）
  const itemsToPush = localItems
    .filter((i) => (i.version ?? 0) > lastVersion)
    .map((i) => ({
      data_id: i.id,
      content: extractContent(i),
      version: i.version ?? 1,
      deleted: i.deleted ?? false,
    }));

  await pushData(dataType, itemsToPush);

  // 3. 更新版本号
  const allVersions = localItems.map((i) => i.version ?? 0);
  const newMax = Math.max(lastVersion, ...allVersions, cloudData?.latest_version ?? 0);
  await setLastSyncVersion(dataType, newMax);
}

// ── SyncableCollection 同步（marks, tags — 使用新的 dirty/mergeFromCloud API） ──

export async function syncSyncableCollection<T extends { id: string } & SyncMeta>(opts: {
  dataType: string;
  db: SyncableCollection<T>;
}): Promise<void> {
  const { dataType, db } = opts;
  const lastVersion = await getLastSyncVersion(dataType);

  // 1. PULL — 从云端拉取增量，合并到本地
  const cloudData = await pullData(dataType, lastVersion);
  if (cloudData && cloudData.items.length > 0) {
    await db.mergeFromCloud(cloudData.items);
  }

  // 2. PUSH — 推送本地 dirty 条目
  const dirtyItems = await db.getDirty();
  if (dirtyItems.length > 0) {
    const itemsToPush: SyncItem[] = dirtyItems.map((item) => {
      const { id, _version, _dirty, _syncedAt, ...content } = item as any;
      return {
        data_id: id,
        content,
        version: _version ?? Date.now(),
        deleted: content.deleted ?? false,
      };
    });

    const ok = await pushData(dataType, itemsToPush);
    if (ok) {
      await db.markSynced(dirtyItems.map((i) => i.id));
    }
  }

  // 3. 更新版本号
  const allItems = await db.getAll();
  const allVersions = allItems.map((i) => i._version ?? 0);
  const newMax = Math.max(
    lastVersion,
    ...allVersions,
    cloudData?.latest_version ?? 0,
  );
  await setLastSyncVersion(dataType, newMax);
}

// ── 保留旧 API 兼容（简单 JsonCollection 不带 dirty 追踪的同步方式） ──

export async function syncJsonCollection(opts: {
  dataType: string;
  db: {
    getAll: () => Promise<any[]>;
    update?: (id: string, data: any) => Promise<void>;
    create?: (data: any) => Promise<void>;
    invalidateCache: () => void;
  };
}): Promise<void> {
  const { dataType, db } = opts;
  const lastVersion = await getLastSyncVersion(dataType);
  const items = await db.getAll();

  // 1. PULL
  const cloudData = await pullData(dataType, lastVersion);
  if (cloudData && cloudData.items.length > 0) {
    for (const cloudItem of cloudData.items) {
      const local = items.find((i: any) => i.id === cloudItem.data_id);
      if (!local || (local.version ?? 0) < cloudItem.version) {
        const merged = {
          id: cloudItem.data_id,
          ...cloudItem.content,
          version: cloudItem.version,
          deleted: cloudItem.deleted,
          updatedAt: Date.now(),
        };
        if (local && db.update) {
          await db.update(merged.id, merged);
        } else if (!local && db.create) {
          await db.create(merged);
        }
      }
    }
    db.invalidateCache();
  }

  // 2. PUSH
  const itemsToPush = items
    .filter((i: any) => (i.version ?? 0) > lastVersion)
    .map((i: any) => {
      const { id, version, deleted, updatedAt, ...content } = i;
      return { data_id: id, content, version: version ?? 1, deleted: deleted ?? false };
    });

  await pushData(dataType, itemsToPush);

  // 3. 更新版本号
  const allVersions = items.map((i: any) => i.version ?? 0);
  const newMax = Math.max(lastVersion, ...allVersions, cloudData?.latest_version ?? 0);
  await setLastSyncVersion(dataType, newMax);
}
